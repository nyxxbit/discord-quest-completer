/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * FIFO request queue with exponential backoff and rate-limit awareness.
 * Single egress point for every quest-related HTTP call.
 *
 * Mirrors the Traffic module in ../index.js. Decisions:
 *   - 429 / 5xx → retryable, backoff with jitter, up to MAX_RETRIES.
 *   - 4xx (except 429) → reject to caller, who decides skip vs surface.
 *   - Global 429 freezes the whole queue; endpoint 429 reschedules just
 *     that request.
 */

import { Logger } from "@utils/Logger";

import { rnd, sleep } from "./util";

const logger = new Logger("OrionQuests");

const RETRYABLE = new Set([429, 500, 502, 503, 504, 408]);
const CLIENT_ERRORS = new Set([400, 403, 404, 409, 410]);
const MAX_RETRIES = 3;

interface QueuedRequest {
    url: string;
    body: unknown;
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    attempts: number;
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

export function isSkippableQuest(error: any): boolean {
    const status = error?.status;
    return status === 404 || status === 403 || status === 410;
}

export class Traffic {
    private queue: QueuedRequest[] = [];
    private processing = false;
    private API: any;
    private isRunning: () => boolean;

    constructor(API: any, isRunning: () => boolean) {
        this.API = API;
        this.isRunning = isRunning;
    }

    enqueue<T = any>(url: string, body: unknown): Promise<T> {
        if (!this.isRunning()) return Promise.reject(new Error("Stopped"));
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ url, body, resolve, reject, attempts: 0 });
            this.process();
        });
    }

    private async process(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            if (!this.isRunning()) {
                this.queue.forEach(req => req.reject(new Error("Shutdown")));
                this.queue = [];
                this.processing = false;
                return;
            }

            const req = this.queue.shift()!;
            try {
                const res = await this.API.post({ url: req.url, body: req.body });
                req.resolve(res);
            } catch (e: any) {
                const err = classify(e);

                if (err.isRetryable && req.attempts < MAX_RETRIES) {
                    req.attempts++;
                    const delay = (e.body?.retry_after ?? Math.pow(2, req.attempts)) * 1000;
                    const isGlobal = e.body?.global === true;
                    logger.warn(`[Network] Retry ${req.attempts}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s (HTTP ${err.status})`);
                    const retryJitter = rnd(200, 800);
                    if (isGlobal) {
                        // freeze queue on global rate limits
                        this.queue.unshift(req);
                        await sleep(delay + retryJitter);
                    } else {
                        // non-blocking retry for endpoint-specific limits
                        setTimeout(() => {
                            if (this.isRunning()) {
                                this.queue.push(req);
                                this.process();
                            }
                        }, delay + retryJitter);
                    }
                } else if (err.isClientError) {
                    logger.debug(`[Network] HTTP ${err.status}: ${req.url}`);
                    req.reject(e);
                } else {
                    logger.error(`[Network] Request to ${req.url} failed: ${err.message}`);
                    req.reject(e);
                }
            }

            await sleep(rnd(1200, 1800));
        }
        this.processing = false;
    }
}
