/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * FIFO request queue with exponential backoff and rate-limit awareness.
 * Single serialized queue for quest progress/enrollment POSTs.
 *
 * Decisions:
 *   - 429 / 5xx → retryable, backoff with jitter, up to MAX_RETRIES.
 *   - 4xx (except 429) → reject to caller, who decides skip vs surface.
 *   - Global 429 freezes the whole queue; endpoint 429 reschedules just
 *     that request.
 *   - Per-task AbortSignal cancels queued/backoff work synchronously. A POST
 *     already on the wire is allowed to settle, but its continuation stays dead.
 */

import { Logger } from "@utils/Logger";

const logger = new Logger("OrionQuests");

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const rnd = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

export interface TrafficLogger {
    warn(...args: any[]): void;
    error(...args: any[]): void;
    debug(...args: any[]): void;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 408]);
const CLIENT_ERRORS = new Set([400, 403, 404, 409, 410]);
const MAX_RETRIES = 3;

type RequestPhase = "queued" | "inflight" | "backoff" | "settled";

interface QueuedRequest {
    url: string;
    body: unknown;
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    attempts: number;
    isActive: () => boolean;
    signal?: AbortSignal;
    abortListener?: () => void;
    retryTimer?: ReturnType<typeof setTimeout>;
    phase: RequestPhase;
}

interface ClassifiedError {
    isRetryable: boolean;
    isClientError: boolean;
    status: number | undefined;
    message: string;
}

function classify(error: any): ClassifiedError {
    const status = error?.status ?? error?.statusCode;
    return {
        isRetryable: RETRYABLE.has(status),
        isClientError: CLIENT_ERRORS.has(status),
        status,
        message: error?.message ?? error?.body?.message ?? `HTTP ${status ?? "UNKNOWN"}`,
    };
}

function cancelledError(): Error {
    const error = new Error("Task cancelled");
    error.name = "AbortError";
    return error;
}

export function isSkippableQuest(error: any): boolean {
    const status = error?.status;
    return status === 404 || status === 403 || status === 410;
}

export class Traffic {
    private queue: QueuedRequest[] = [];
    private processing = false;
    private API: any;
    private isRunning: () => boolean;
    private log: TrafficLogger;

    constructor(API: any, isRunning: () => boolean, log: TrafficLogger = logger) {
        this.API = API;
        this.isRunning = isRunning;
        this.log = log;
    }

    enqueue<T = any>(
        url: string,
        body: unknown,
        isActive: () => boolean = () => true,
        signal?: AbortSignal,
    ): Promise<T> {
        if (!this.isRunning()) return Promise.reject(new Error("Stopped"));
        if (!isActive() || signal?.aborted) return Promise.reject(cancelledError());

        return new Promise<T>((resolve, reject) => {
            const req: QueuedRequest = {
                url,
                body,
                resolve,
                reject,
                attempts: 0,
                isActive,
                signal,
                phase: "queued",
            };

            if (signal) {
                req.abortListener = () => {
                    // RestAPI.post does not expose a safe abort handle. Once a request is on the
                    // wire, keep the task generation reserved until the real request settles.
                    if (req.phase === "inflight" || req.phase === "settled") return;
                    this.rejectCancelled(req);
                };
                signal.addEventListener("abort", req.abortListener, { once: true });
            }

            this.queue.push(req);
            this.process();
        });
    }

    private requestIsActive(req: QueuedRequest): boolean {
        return this.isRunning() && req.isActive() && !req.signal?.aborted;
    }

    private detachAbort(req: QueuedRequest): void {
        if (req.signal && req.abortListener) {
            req.signal.removeEventListener("abort", req.abortListener);
            req.abortListener = undefined;
        }
        if (req.retryTimer) {
            clearTimeout(req.retryTimer);
            req.retryTimer = undefined;
        }
    }

    private settleResolve(req: QueuedRequest, value: any): void {
        if (req.phase === "settled") return;
        req.phase = "settled";
        this.detachAbort(req);
        req.resolve(value);
    }

    private settleReject(req: QueuedRequest, reason: any): void {
        if (req.phase === "settled") return;
        req.phase = "settled";
        this.detachAbort(req);
        req.reject(reason);
    }

    private rejectCancelled(req: QueuedRequest): void {
        this.settleReject(req, this.isRunning() ? cancelledError() : new Error("Shutdown"));
    }

    private async process(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            if (!this.isRunning()) {
                for (const req of this.queue) this.settleReject(req, new Error("Shutdown"));
                this.queue = [];
                this.processing = false;
                return;
            }

            const req = this.queue.shift()!;
            if (req.phase === "settled") continue;

            // A queued request belongs to the generation that enqueued it. Resume may create
            // a newer generation for the same quest, but the signal/predicate stay bound to the
            // old one and therefore can never become valid again.
            if (!this.requestIsActive(req)) {
                this.rejectCancelled(req);
                continue;
            }

            req.phase = "inflight";
            try {
                const res = await this.API.post({ url: req.url, body: req.body });
                // The request may already be on the wire when Pause happens. We cannot unsend it,
                // but its settled continuation must not publish progress or start later work.
                if (this.requestIsActive(req)) this.settleResolve(req, res);
                else this.rejectCancelled(req);
            } catch (e: any) {
                if (!this.requestIsActive(req)) {
                    this.rejectCancelled(req);
                    continue;
                }

                const err = classify(e);

                if (err.isRetryable && req.attempts < MAX_RETRIES) {
                    req.attempts++;
                    const delay = (e.body?.retry_after ?? Math.pow(2, req.attempts)) * 1000;
                    const isGlobal = e.body?.global === true;
                    this.log.warn(`[Network] Retry ${req.attempts}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s (HTTP ${err.status})`);
                    const retryJitter = rnd(200, 800);
                    req.phase = "backoff";

                    if (isGlobal) {
                        // The request's promise can be cancelled immediately through its signal,
                        // while the shared global pacing delay still applies to unrelated work.
                        this.queue.unshift(req);
                        await sleep(delay + retryJitter);
                    } else {
                        req.retryTimer = setTimeout(() => {
                            req.retryTimer = undefined;
                            if (req.phase === "settled") return;
                            if (this.requestIsActive(req)) {
                                req.phase = "queued";
                                this.queue.push(req);
                                this.process();
                            } else {
                                this.rejectCancelled(req);
                            }
                        }, delay + retryJitter);
                    }
                } else if (err.isClientError) {
                    this.log.debug(`[Network] HTTP ${err.status}: ${req.url}`);
                    this.settleReject(req, e);
                } else {
                    this.log.error(`[Network] Request to ${req.url} failed: ${err.message}`);
                    this.settleReject(req, e);
                }
            }

            await sleep(rnd(1200, 1800));
        }
        this.processing = false;
    }
}
