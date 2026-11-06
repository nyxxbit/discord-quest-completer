/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Per-task-type handlers. Mirrors the Tasks module in ./index.js,
 * minus the DOM render/dashboard concerns. Phases 3-4 ported here.
 */

import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";

import {
    companionFailure,
    COMPANION_EVENT_CODES,
    emitCompanionEvent,
    type CompanionEventFailure,
} from "./companionEvents";
import { discordSaysResponseError } from "./discordSays";
import { HeartbeatWatchdog } from "./heartbeatWatchdog";
import { cleanupCreatedOAuthGrants } from "./oauthLifecycle";
import type { Patcher } from "./patcher";
import { isConsoleOnly, isQuestExpired, pickExecutable, recordOutcome, selectTaskFamily, taskEntries, taskForKey } from "./questConfig";
import { settings } from "./settings";
import type { TaskLifecycle } from "./taskControl";
import type { Traffic } from "./traffic";
import type { DetectedTask, FakeGame, OrionRuntime, Quest, Stores, TaskInfo, TaskType } from "./types";
import { debug, rnd, sanitize, sleep, trafficMetadataSealed } from "./util";

const logger = new Logger("OrionQuests");

const Native = VencordNative.pluginHelpers.OrionQuests as PluginNative<typeof import("./native")>;

const HEARTBEAT_EVT = "QUESTS_SEND_HEARTBEAT_SUCCESS";
/*
 * Discord dispatches this when its own heartbeat POST fails, carrying the error and the quest id.
 * The QuestStore reducer only records it when a streamKey is present, so a PLAY_ON_DESKTOP
 * failure leaves no trace in any store and used to reach us only as 90 seconds of silence.
 * Subscribing to the dispatch itself catches every task type and gives the real reason.
 */
const HEARTBEAT_FAIL_EVT = "QUESTS_SEND_HEARTBEAT_FAILURE";

interface HeartbeatErrorDetails {
    text: string;
    status: number | null;
    upstreamCode: string | number | null;
    retryable: boolean;
}

/**
 * Preserve the structured parts of Discord's heartbeat failure before the existing watchdog/log
 * path flattens them into prose. The prose remains for humans; companion consumers never parse it.
 */
function heartbeatErrorDetails(payload: any): HeartbeatErrorDetails {
    const e = payload?.error ?? payload;
    const parts: string[] = [];
    const rawStatus = e?.status ?? e?.httpStatus;
    const status = Number.isFinite(rawStatus) ? Number(rawStatus) : null;
    if (status != null) parts.push(`HTTP ${status}`);
    const rawCode = e?.body?.code ?? e?.code;
    const upstreamCode = typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : null;
    if (upstreamCode != null && upstreamCode !== status) parts.push(`code ${upstreamCode}`);
    const message = e?.body?.message ?? e?.message;
    if (message) parts.push(String(message));
    if (!parts.length) {
        try { parts.push(JSON.stringify(e).slice(0, 160)); } catch { parts.push(String(e)); }
    }
    return {
        text: parts.join(", ") || "no detail",
        status,
        upstreamCode,
        retryable: status == null || status === 408 || status === 429 || status >= 500,
    };
}

function errorFailure(
    error: any,
    options: { terminal: boolean; retryable: boolean; attempt?: number | null; maxAttempts?: number | null; reason?: string | null; },
): CompanionEventFailure {
    const rawStatus = error?.status ?? error?.statusCode ?? error?.httpStatus;
    const rawCode = error?.body?.code ?? error?.code;
    const message = options.reason ?? error?.body?.message ?? error?.message ?? null;
    return companionFailure({
        terminal: options.terminal,
        retryable: options.retryable,
        attempt: options.attempt,
        maxAttempts: options.maxAttempts,
        httpStatus: Number.isFinite(rawStatus) ? Number(rawStatus) : null,
        upstreamCode: typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : null,
        reason: message == null ? null : String(message),
    });
}

const MAX_TIME = 25 * 60 * 1000;
const HEARTBEAT_GRACE = 90 * 1000;
const MAX_TASK_FAILURES = 5;

type ControlledTaskInfo = TaskInfo & { generation?: number; accountId?: string; };

const BLACKLISTED_QUEST_ID = "1412491570820812933";

export interface BypassResult {
    ok: boolean;
    reason: string | null;
    failure?: CompanionEventFailure;
    disabled?: boolean;
    retryLater?: boolean;
}

interface AchievementFallbackEvent {
    level: "info" | "warning";
    message: string;
    reason?: string;
    failure?: CompanionEventFailure;
}

export interface TaskCallbacks {
    onProgress: (id: string, info: { name: string; type: TaskType; cur: number; max: number; status: string; actionRequired?: string | null; reason?: string | null; }) => void;
    onComplete: (q: Quest, t: TaskInfo) => Promise<void>;
}

export class TaskRunner {
    public skipped = new Set<string>();
    public consentSkipped = new Set<string>();
    /** Quests left out only because Orb-only was on, so turning it off can put them back. */
    public orbFilterSkipped = new Set<string>();
    private stores: Stores;
    private traffic: Traffic;
    private patcher: Patcher;
    private runtime: OrionRuntime;
    private cb: TaskCallbacks;
    private lifecycle?: TaskLifecycle;
    private streamReal: any;
    private streamSpoofs = new Map<string, { id: string | number; pid: number; sourceName: string; }>();

    constructor(
        stores: Stores,
        traffic: Traffic,
        patcher: Patcher,
        runtime: OrionRuntime,
        cb: TaskCallbacks,
        lifecycle?: TaskLifecycle,
    ) {
        this.stores = stores;
        this.traffic = traffic;
        this.patcher = patcher;
        this.runtime = runtime;
        this.cb = cb;
        this.lifecycle = lifecycle;
        this.streamReal = stores.StreamStore?.getStreamerActiveStreamMetadata;
    }

    private isTaskActive(t: ControlledTaskInfo): boolean {
        if (!this.runtime.running) return false;
        if (t.generation == null || !this.lifecycle) return true;
        return this.lifecycle.isActive(t.id, t.generation);
    }

    /** Bind queue/backoff cancellation to the exact task generation, not a polling clock. */
    private enqueue<T = any>(t: ControlledTaskInfo, url: string, body: unknown): Promise<T> {
        const signal = t.generation != null && this.lifecycle
            ? this.lifecycle.signalFor(t.id, t.generation) ?? undefined
            : undefined;
        return this.traffic.enqueue<T>(url, body, () => this.isTaskActive(t), signal);
    }

    private addCleanup(t: ControlledTaskInfo, cleanup: () => void): boolean {
        if (t.generation != null && this.lifecycle) {
            return this.lifecycle.addCleanup(t.id, t.generation, cleanup);
        }
        this.runtime.cleanups.add(cleanup);
        return true;
    }

    private removeCleanup(t: ControlledTaskInfo, cleanup: () => void): void {
        if (t.generation != null && this.lifecycle) {
            this.lifecycle.removeCleanup(t.id, t.generation, cleanup);
            return;
        }
        this.runtime.cleanups.delete(cleanup);
    }

    private async wait(t: ControlledTaskInfo, ms: number): Promise<boolean> {
        if (!this.isTaskActive(t)) return false;
        if (t.generation != null && this.lifecycle) {
            return this.lifecycle.waitForDelay(t.id, t.generation, ms);
        }
        await sleep(ms);
        return this.isTaskActive(t);
    }

    /**
     * Hold a finished quest's spoofed process for a randomised tail before dropping it.
     *
     * A real play session does not end on the second the quest target is reached: the player
     * keeps the game open, or leaves it running and walks away, and the overshoot is different
     * every time. Orion used to remove the process on the exact heartbeat that crossed the
     * target, which makes the session length a constant equal to the quest requirement, on
     * every quest, forever. That is a gap in the emulation rather than a feature anyone chose.
     *
     * The tail costs no quest traffic. Discord terminates its own heartbeat as soon as it sees
     * completedAt and sends the terminal beat itself, so what the tail extends is the presence
     * the account shows, and nothing else. It is cancellable: Stop drops the process at once.
     */
    private async linger(t: ControlledTaskInfo, type: TaskType, gameName: string): Promise<void> {
        const maxMinutes = Number(settings.store.playSessionTail ?? 0);
        if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) return;

        const maxMs = Math.round(maxMinutes * 60 * 1000);
        const tailMs = rnd(Math.round(maxMs * 0.4), maxMs);
        debug(logger, `[Task] Holding ${type} "${gameName}" for ${Math.round(tailMs / 1000)}s after completion.`);
        await this.wait(t, tailMs);
    }

    private syncStreamSpoof(): void {
        if (!this.stores.StreamStore) return;

        let latest: { id: string | number; pid: number; sourceName: string; } | undefined;
        for (const spoof of this.streamSpoofs.values()) latest = spoof;

        if (!latest) {
            this.stores.StreamStore.getStreamerActiveStreamMetadata = this.streamReal;
            return;
        }

        const current = latest;
        this.stores.StreamStore.getStreamerActiveStreamMetadata = () => ({
            id: current.id,
            pid: current.pid,
            sourceName: current.sourceName,
        });
    }

    private emitTaskStarted(q: Quest, t: TaskInfo, type: TaskType): void {
        emitCompanionEvent({
            code: COMPANION_EVENT_CODES.TASK_STARTED,
            category: "task",
            level: "info",
            message: `Started ${type} task for "${t.name}".`,
            questId: q.id,
            questName: t.name,
            taskType: type,
        });
    }

    appIdFor(cfg: any, keyName: string, legacyAppId?: string): string | null {
        return taskForKey(cfg, keyName)?.applications?.[0]?.id ?? legacyAppId ?? null;
    }

    readProgress(userStatus: any, key: string): number {
        const p = userStatus?.progress;
        const entry = p instanceof Map ? p.get(key) : p?.[key];
        return entry?.value ?? userStatus?.streamProgressSeconds ?? 0;
    }

    detectType(cfg: any, applicationId?: string): DetectedTask | null {
        const entries = taskEntries(cfg?.tasks);
        const keys = entries.map(([key]) => key);
        const family = selectTaskFamily(keys);
        if (family) {
            const task = entries.find(([key]) => key === family.keyName)?.[1];
            return {
                type: family.type,
                keyName: family.keyName,
                target: task?.target ?? 0,
                appId: this.appIdFor(cfg, family.keyName, applicationId),
            };
        }

        // Every key was a console one, so there is nothing this client can do with the quest.
        // Say that rather than falling through to the desktop guess below.
        if (isConsoleOnly(keys)) return null;

        if (applicationId && entries.length > 0) {
            return {
                type: "GAME",
                keyName: "PLAY_ON_DESKTOP",
                target: entries[0][1]?.target ?? 0,
                appId: applicationId,
            };
        }
        return null;
    }

    async fetchGameData(appId: string | number, appName: string): Promise<any> {
        try {
            const res = await this.stores.API.get({ url: `/applications/public?application_ids=${appId}` });
            const appData = res?.body?.[0];
            const cleanName = sanitize(appData?.name || appName);
            const { exeName, relPath } = pickExecutable(appData?.executables, cleanName);
            return {
                name: appData?.name || appName,
                icon: appData?.icon,
                exeName,
                cmdLine: `C:\\Program Files\\${relPath.replace(/\//g, "\\")}`,
                exePath: `c:/program files/${relPath.toLowerCase()}`,
                id: appId,
            };
        } catch (e: any) {
            debug(logger, `[Task] Game metadata fallback for ${appName}: ${e?.message ?? e}`);
            const cleanName = sanitize(appName);
            const safeExe = `${cleanName.replace(/\s+/g, "")}.exe`;
            return {
                name: appName,
                exeName: safeExe,
                cmdLine: `C:\\Program Files\\${cleanName}\\${safeExe}`,
                exePath: `c:/program files/${cleanName.toLowerCase()}/${safeExe}`,
                id: appId,
            };
        }
    }

    async claimReward(questId: string): Promise<any> {
        return this.stores.API.post({
            url: `/quests/${questId}/claim-reward`,
            body: {
                platform: 0,
                location: 11,
                is_targeted: false,
                metadata_sealed: null,
                traffic_metadata_sealed: trafficMetadataSealed(this.stores.QuestStore, questId),
            },
        });
    }

    failTask(q: Quest, t: TaskInfo, reason: string, failure?: CompanionEventFailure): void {
        if (!this.isTaskActive(t)) return;
        this.cb.onProgress(q.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "FAILED", reason });
        emitCompanionEvent({
            code: COMPANION_EVENT_CODES.TASK_FAILED,
            category: "task",
            level: "error",
            message: `Task failed for "${t.name}".`,
            questId: q.id,
            questName: t.name,
            taskType: t.type,
            reason,
            ...(failure ? { failure } : {}),
        });
        logger.error(`[Task] Aborted "${t.name}": ${reason}`);
        this.skipped.add(q.id);
        // activeQuests reads the skipped set and nothing else, so a quest that died here leaves
        // the rotation exactly like one this client never could drive. The wrap-up has to tell
        // the two apart, or a run whose only quest failed announces that everything completed.
        recordOutcome(this.runtime.outcomes, q.id, "failed");
    }

    async VIDEO(q: Quest, t: TaskInfo, s: any): Promise<void> {
        if (!this.isTaskActive(t)) return;

        let cur = this.readProgress(s, t.keyName);
        let failCount = 0;
        this.cb.onProgress(q.id, { name: t.name, type: "WATCH_VIDEO", cur, max: t.target, status: "RUNNING" });
        if (!this.isTaskActive(t)) return;
        this.emitTaskStarted(q, t, "WATCH_VIDEO");
        const startTime = Date.now();

        while (cur < t.target && this.isTaskActive(t)) {
            const delayMs = rnd(7000, 9500);
            if (!await this.wait(t, delayMs)) return;

            const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
            cur += elapsedSec;
            const payloadTs = Number(Math.min(t.target, cur).toFixed(6));

            try {
                const r: any = await this.enqueue(t, `/quests/${q.id}/video-progress`, { timestamp: payloadTs });
                if (!this.isTaskActive(t)) return;
                const serverVal: number | undefined = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.WATCH_VIDEO?.value;
                if (serverVal !== undefined && serverVal > cur) cur = Math.min(t.target, serverVal);
                if (r?.body?.completed_at) break;
                failCount = 0;
            } catch (e: any) {
                if (!this.isTaskActive(t)) return;
                failCount++;
                if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                    logger.warn(`[Task] Video quest unavailable (HTTP ${e.status}). Skipping.`);
                    return this.failTask(q, t, `Client Error ${e.status}`, errorFailure(e, {
                        terminal: true,
                        retryable: false,
                        reason: `Client Error ${e.status}`,
                    }));
                }
                if (failCount >= MAX_TASK_FAILURES) {
                    return this.failTask(q, t, "Too many network failures", errorFailure(e, {
                        terminal: true,
                        retryable: true,
                        attempt: failCount,
                        maxAttempts: MAX_TASK_FAILURES,
                        reason: "Too many network failures",
                    }));
                }
            }

            if (!this.isTaskActive(t)) return;
            this.cb.onProgress(q.id, { name: t.name, type: "WATCH_VIDEO", cur, max: t.target, status: "RUNNING" });
            if (Date.now() - startTime > MAX_TIME) return this.failTask(q, t, "Timeout exceeded");
        }

        if (this.isTaskActive(t)) await this.cb.onComplete(q, t);
    }

    async generic(q: Quest, t: TaskInfo, type: TaskType, fallbackKey: string): Promise<void> {
        if (!this.isTaskActive(t)) return;
        const key = t.keyName || fallbackKey;
        const gameData = await this.fetchGameData(t.appId, t.name);
        if (!this.isTaskActive(t)) return;

        return new Promise<void>(resolve => {
            if (!this.isTaskActive(t)) { resolve(); return; }

            const pid = rnd(2500, 12500) * 4;
            const game: FakeGame = {
                id: gameData.id,
                name: gameData.name,
                icon: gameData.icon,
                pid,
                pidPath: [pid],
                processName: gameData.name,
                start: Date.now(),
                exeName: gameData.exeName,
                exePath: gameData.exePath,
                cmdLine: gameData.cmdLine,
                executables: [{ os: "win32", name: gameData.exeName, is_launcher: false }],
                windowHandle: 0,
                fullscreenType: 0,
                overlay: true,
                sandboxed: false,
                hidden: false,
                isLauncher: false,
            };

            let cleanupHook: () => void = () => { };
            let cleaned = false;
            let spoofReleased = false;
            let safetyTimer: number | undefined;
            let subscribed = false;
            // Created below, after the spoof is installed, but cleanup can run before that.
            let watchdog: HeartbeatWatchdog | null = null;
            let heartbeatConsecutiveFailures = 0;
            let lastHeartbeatFailure: HeartbeatErrorDetails | null = null;

            // Stopping the watching and releasing the spoof used to be one step. They are
            // separate because a completed quest holds the fake process a little longer than it
            // needs it, and the watchdog must not be alive for that window: Discord terminates
            // its own heartbeat the moment it sees completedAt, so every beat the watchdog
            // would wait for after completion is one that is never going to arrive.
            const stopWatching = () => {
                if (cleaned) return;
                cleaned = true;
                clearTimeout(safetyTimer);
                watchdog?.stop();
                if (subscribed) {
                    try { this.stores.Dispatcher?.unsubscribe(HEARTBEAT_EVT, check); }
                    catch (e: any) { debug(logger, `[System] Dispatcher unsubscribe failed: ${e?.message}`); }
                    try { this.stores.Dispatcher?.unsubscribe(HEARTBEAT_FAIL_EVT, onFail); }
                    catch (e: any) { debug(logger, `[System] Dispatcher unsubscribe failed: ${e?.message}`); }
                }
            };

            const releaseSpoof = () => {
                if (spoofReleased) return;
                spoofReleased = true;
                try { cleanupHook(); } catch (e: any) { debug(logger, `[Task] Cleanup: ${e?.message}`); }
                this.removeCleanup(t, abort);
            };

            const finish = () => { stopWatching(); releaseSpoof(); };

            const abort = () => { finish(); resolve(); };

            // Install the task-owned cleanup immediately after the resource appears. If Pause
            // lands in this narrow setup window, addCleanup fails and we roll the resource back
            // ourselves instead of leaving a fake process/stream behind with no owner.
            if (type === "STREAM") {
                if (this.stores.StreamStore) {
                    this.streamSpoofs.set(q.id, { id: gameData.id, pid, sourceName: gameData.name });
                    this.syncStreamSpoof();
                }
                cleanupHook = () => {
                    if (!this.stores.StreamStore) return;
                    this.streamSpoofs.delete(q.id);
                    this.syncStreamSpoof();
                };
            } else {
                this.patcher.add(game);
                cleanupHook = () => this.patcher.remove(game);
            }

            if (!this.addCleanup(t, abort)) {
                abort();
                return;
            }

            const seeded = this.readProgress(q.userStatus, key);
            this.cb.onProgress(q.id, { name: t.name, type, cur: seeded, max: t.target, status: "RUNNING" });
            // Dashboard listeners are synchronous. A listener can pause/stop this exact generation
            // from the progress publication above, which runs its cleanup before control returns.
            // Never let that dead continuation recreate a watchdog/subscription or publish started.
            if (!this.isTaskActive(t)) {
                finish();
                resolve();
                return;
            }
            this.emitTaskStarted(q, t, type);
            logger.info(`[Task] Started ${type}: ${gameData.name}`);

            safetyTimer = setTimeout(() => {
                if (this.isTaskActive(t)) this.failTask(q, t, "Timeout exceeded (25m)");
                finish();
                resolve();
            }, MAX_TIME) as unknown as number;

            watchdog = new HeartbeatWatchdog({
                questName: t.name,
                graceMs: HEARTBEAT_GRACE,
                maxConsecutiveFailures: MAX_TASK_FAILURES,
                setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
                clearTimer: id => clearTimeout(id),
                onFailureNoted: message => debug(logger, message),
                onGiveUp: verdict => {
                    if (cleaned || !this.isTaskActive(t)) return;
                    const latest = lastHeartbeatFailure;
                    const failure = companionFailure({
                        terminal: true,
                        retryable: latest?.retryable ?? false,
                        attempt: heartbeatConsecutiveFailures || null,
                        maxAttempts: latest ? MAX_TASK_FAILURES : null,
                        httpStatus: latest?.status,
                        upstreamCode: latest?.upstreamCode,
                        reason: verdict.reason,
                    });
                    emitCompanionEvent({
                        code: COMPANION_EVENT_CODES.HEARTBEAT_GIVE_UP,
                        category: "network",
                        level: "error",
                        message: `Heartbeat reporting stopped for "${t.name}"; the task is giving up.`,
                        questId: q.id,
                        questName: t.name,
                        taskType: type,
                        reason: verdict.reason,
                        failure,
                    });
                    logger.error(verdict.message);
                    this.failTask(q, t, verdict.reason, failure);
                    finish();
                    resolve();
                },
            });
            watchdog.start();

            const check = (d: any) => {
                if (!this.isTaskActive(t)) { finish(); resolve(); return; }
                if (d?.questId !== q.id) return;
                heartbeatConsecutiveFailures = 0;
                lastHeartbeatFailure = null;
                watchdog?.beat();
                const prog = this.readProgress(d.userStatus, key);
                this.cb.onProgress(q.id, { name: t.name, type, cur: prog, max: t.target, status: "RUNNING" });
                if (prog >= t.target) {
                    stopWatching();
                    if (!this.isTaskActive(t)) { releaseSpoof(); resolve(); return; }
                    this.cb.onComplete(q, t)
                        .then(() => this.linger(t, type, gameData.name))
                        .finally(() => { releaseSpoof(); resolve(); });
                }
            };

            // Discord does not retry a failed heartbeat, it just sends the next one on its own
            // 60s tick, so one failure is not a verdict and must not be treated as silence.
            // The watchdog decides what to do with it; consecutive failures are what give up.
            const onFail = (d: any) => {
                if (!this.isTaskActive(t)) { finish(); resolve(); return; }
                if (d?.questId !== q.id) return;
                const details = heartbeatErrorDetails(d);
                heartbeatConsecutiveFailures++;
                lastHeartbeatFailure = details;
                watchdog?.fail(details.text);
                if (heartbeatConsecutiveFailures >= MAX_TASK_FAILURES || cleaned || !this.isTaskActive(t)) return;
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.HEARTBEAT_FAILURE,
                    category: "network",
                    level: "warning",
                    message: `Discord heartbeat attempt failed for "${t.name}"; Orion is still waiting for the next heartbeat.`,
                    questId: q.id,
                    questName: t.name,
                    taskType: type,
                    failure: companionFailure({
                        terminal: false,
                        retryable: details.retryable,
                        attempt: heartbeatConsecutiveFailures,
                        maxAttempts: MAX_TASK_FAILURES,
                        httpStatus: details.status,
                        upstreamCode: details.upstreamCode,
                        reason: details.text,
                    }),
                });
            };

            try {
                this.stores.Dispatcher?.subscribe(HEARTBEAT_EVT, check);
                this.stores.Dispatcher?.subscribe(HEARTBEAT_FAIL_EVT, onFail);
                subscribed = true;
            } catch (e: any) {
                if (this.isTaskActive(t)) this.failTask(q, t, `Heartbeat subscription failed: ${e?.message ?? e}`);
                abort();
            }
        });
    }

    GAME(q: Quest, t: TaskInfo): Promise<void> { return this.generic(q, t, "GAME", "PLAY_ON_DESKTOP"); }
    STREAM(q: Quest, t: TaskInfo): Promise<void> { return this.generic(q, t, "STREAM", "STREAM_ON_DESKTOP"); }

    async ACTIVITY(q: Quest, t: TaskInfo): Promise<void> {
        if (!this.isTaskActive(t)) return;

        const key = this.streamKey();
        if (!key) return this.failTask(q, t, "No voice channel found");
        const beat = { stream_key: key, application_id: String(t.appId || ""), terminal: false };
        let cur = this.readProgress(q.userStatus, t.keyName);
        let failCount = 0;
        let stalledBeats = 0;
        this.cb.onProgress(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
        if (!this.isTaskActive(t)) return;
        this.emitTaskStarted(q, t, "ACTIVITY");
        const startTime = Date.now();

        while (cur < t.target && this.isTaskActive(t)) {
            try {
                const r: any = await this.enqueue(t, `/quests/${q.id}/heartbeat`, beat);
                if (!this.isTaskActive(t)) return;
                const reported = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.PLAY_ACTIVITY?.value;
                if (typeof reported === "number") { cur = reported; stalledBeats = 0; }
                else if (++stalledBeats >= MAX_TASK_FAILURES) return this.failTask(q, t, "Discord credited no progress");
                this.cb.onProgress(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
                failCount = 0;
                if (cur >= t.target) {
                    try {
                        await this.enqueue(t, `/quests/${q.id}/heartbeat`, { ...beat, terminal: true });
                    } catch (e: any) {
                        if (this.isTaskActive(t)) debug(logger, `[Task] Final ACTIVITY heartbeat failed: ${e?.message}`);
                    }
                    break;
                }
            } catch (e: any) {
                if (!this.isTaskActive(t)) return;
                failCount++;
                if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                    logger.warn(`[Task] Activity quest unavailable (HTTP ${e.status}). Skipping.`);
                    return this.failTask(q, t, `Client Error ${e.status}`, errorFailure(e, {
                        terminal: true,
                        retryable: false,
                        reason: `Client Error ${e.status}`,
                    }));
                }
                if (failCount >= MAX_TASK_FAILURES) {
                    return this.failTask(q, t, "Too many network failures", errorFailure(e, {
                        terminal: true,
                        retryable: true,
                        attempt: failCount,
                        maxAttempts: MAX_TASK_FAILURES,
                        reason: "Too many network failures",
                    }));
                }
            }
            if (!this.isTaskActive(t)) return;
            if (Date.now() - startTime > MAX_TIME) return this.failTask(q, t, "Timeout exceeded");
            if (!await this.wait(t, rnd(19000, 22000))) return;
        }

        if (this.isTaskActive(t) && cur >= t.target) await this.cb.onComplete(q, t);
    }

    async bypassAchievement(q: Quest, t: ControlledTaskInfo, fallback?: AchievementFallbackEvent): Promise<BypassResult> {
        let reason: string | null = null;
        if (!this.isTaskActive(t)) return { ok: false, reason };

        // A fallback event means Orion is actually taking the OAuth branch. Checking consent here,
        // before publishing it or validating bypass-only metadata, prevents companions from being
        // told that a fallback will run when the user explicitly disabled that path.
        if (!settings.store.achievementBypass) {
            reason = "Achievement bypass is off in settings";
            logger.info(`[Bypass] Achievement OAuth bypass is off in settings; skipping "${t.name}". Enable it in OrionQuests settings if you want it.`);
            return { ok: false, reason, disabled: true };
        }

        if (fallback) {
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.ACHIEVEMENT_FALLBACK,
                category: "achievement",
                level: fallback.level,
                message: fallback.message,
                questId: q.id,
                questName: t.name,
                taskType: t.type,
                ...(fallback.reason ? { reason: fallback.reason } : {}),
                ...(fallback.failure ? { failure: fallback.failure } : {}),
            });
        }

        const accountId = t.accountId ?? null;
        if (!accountId) {
            reason = "this task has no confirmed Discord account owner, so Orion refused to create an OAuth grant";
            logger.warn(`[Bypass] ${reason}.`);
            return { ok: false, reason };
        }

        const getCurrentAccountId = (): string | null => {
            try { return this.stores.UserStore?.getCurrentUser?.()?.id ?? null; }
            catch { return null; }
        };
        const requireConfirmedOwner = (stage: string, retryIfUnknown: boolean): BypassResult | null => {
            const currentAccountId = getCurrentAccountId();
            if (currentAccountId === accountId) return null;
            reason = currentAccountId == null
                ? `Discord account identity is temporarily unavailable ${stage}, so Orion refused to touch OAuth state`
                : `the Discord account changed ${stage}, so Orion stopped the OAuth flow`;
            logger.warn(`[Bypass] ${reason}.`);
            return { ok: false, reason, retryLater: currentAccountId == null && retryIfUnknown };
        };

        const appId = String(t.appId || q.config?.application?.id || "");
        if (!appId) {
            reason = "this quest carries no application id, so there is nothing to authorize against";
            const failure = companionFailure({ terminal: true, retryable: false, reason });
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.BYPASS_FAILED,
                category: "bypass",
                level: "warning",
                message: `Discord Says bypass could not start for "${t.name}".`,
                questId: q.id,
                questName: t.name,
                taskType: t.type,
                reason,
                failure,
            });
            return { ok: false, reason, failure };
        }
        if (!/^\d+$/.test(appId)) {
            reason = `the quest's application id ("${appId}") is not numeric, so it was refused before any request went out`;
            const failure = companionFailure({ terminal: true, retryable: false, reason });
            logger.warn(`[Bypass] Refusing non-numeric appId "${appId}".`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.BYPASS_FAILED,
                category: "bypass",
                level: "warning",
                message: `Discord Says bypass refused invalid application metadata for "${t.name}".`,
                questId: q.id,
                questName: t.name,
                taskType: t.type,
                reason,
                failure,
            });
            return { ok: false, reason, failure };
        }

        const beforeSnapshotOwner = requireConfirmedOwner("before the grant snapshot", true);
        if (beforeSnapshotOwner) return beforeSnapshotOwner;

        let preGrantIds: Set<string> | undefined;
        try {
            const before: any = await this.stores.API.get({ url: "/oauth2/tokens" });
            if (!this.isTaskActive(t)) return { ok: false, reason };
            const afterSnapshotOwner = requireConfirmedOwner("after the grant snapshot", true);
            if (afterSnapshotOwner) return afterSnapshotOwner;
            preGrantIds = new Set((before?.body || [])
                .filter((tk: any) => tk.application?.id === appId)
                .map((tk: any) => tk.id));
        } catch (e: any) {
            if (!this.isTaskActive(t)) return { ok: false, reason };
            const snapshotFailureOwner = requireConfirmedOwner("after the grant snapshot failed", true);
            if (snapshotFailureOwner) return snapshotFailureOwner;
            reason = "Orion could not snapshot existing OAuth grants, so the bypass was aborted before authorization";
            const failure = errorFailure(e, { terminal: true, retryable: false, reason });
            logger.warn(`[Bypass] Couldn't snapshot existing grants; aborting so we never leave an un-revocable authorization: ${e?.message}`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.BYPASS_FAILED,
                category: "bypass",
                level: "warning",
                message: `Discord Says bypass stopped before authorization for "${t.name}".`,
                questId: q.id,
                questName: t.name,
                taskType: t.type,
                reason,
                failure,
            });
            return { ok: false, reason, failure };
        }

        let authorizationStarted = false;
        try {
            if (!this.isTaskActive(t)) return { ok: false, reason };
            if (!settings.store.achievementBypass) {
                reason = "Achievement bypass is off in settings";
                logger.info(`[Bypass] Achievement OAuth bypass was disabled before authorization; not authorizing "${t.name}".`);
                return { ok: false, reason, disabled: true };
            }
            const beforeAuthorizeOwner = requireConfirmedOwner("before authorization", true);
            if (beforeAuthorizeOwner) return beforeAuthorizeOwner;
            logger.info(`[Bypass] Trying Discord Says auth flow for "${t.name}"...`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.BYPASS_STARTED,
                category: "bypass",
                level: "info",
                message: `Discord Says bypass started for "${t.name}".`,
                questId: q.id,
                questName: t.name,
                taskType: t.type,
            });

            const authRequest = this.stores.API.post({
                url: "/oauth2/authorize",
                query: {
                    response_type: "code",
                    client_id: appId,
                    scope: "identify applications.commands applications.entitlements"
                },
                body: {
                    permissions: "0",
                    authorize: true,
                    integration_type: 1,
                    location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
                }
            });
            authorizationStarted = true;
            const authRes: any = await authRequest;
            if (!this.isTaskActive(t)) return { ok: false, reason };
            const location: string | undefined = authRes?.body?.location;
            if (!location) throw new Error("no location in /oauth2/authorize response");
            const authCode = new URL(location).searchParams.get("code");
            if (!authCode) throw new Error("no code in authorize location");

            if (!this.isTaskActive(t)) return { ok: false, reason };
            const ticketRes: any = await this.stores.API.post({ url: `/applications/${appId}/proxy-tickets`, body: {} });
            if (!this.isTaskActive(t)) return { ok: false, reason };
            const proxyTicket: string | undefined = ticketRes?.body?.ticket;
            if (!proxyTicket) throw new Error("no proxy ticket");

            const referrer = `https://${appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;

            if (!this.isTaskActive(t)) return { ok: false, reason };
            const dsAuthRes = await Native.discordsaysAuthorize({ appId, questId: q.id, authCode, referrer });
            if (!this.isTaskActive(t)) return { ok: false, reason };
            if (!dsAuthRes.ok) {
                throw discordSaysResponseError("discordsays authorize", dsAuthRes);
            }
            let dsToken: string | undefined;
            try { dsToken = (JSON.parse(dsAuthRes.body) as { token?: string }).token; }
            catch { throw new Error("discordsays returned non-JSON: " + String(dsAuthRes.body).slice(0, 120)); }
            if (!dsToken) throw new Error("no discordsays token");

            if (!this.isTaskActive(t)) return { ok: false, reason };
            const progRes = await Native.discordsaysProgress({ appId, questId: q.id, token: dsToken, target: t.target, referrer });
            if (!this.isTaskActive(t)) return { ok: false, reason };
            if (!progRes.ok) {
                throw discordSaysResponseError("discordsays progress", progRes);
            }

            logger.info(`[Bypass] Success. "${t.name}" completed via Discord Says.`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.BYPASS_SUCCEEDED,
                category: "bypass",
                level: "success",
                message: `Discord Says bypass completed "${t.name}".`,
                questId: q.id,
                questName: t.name,
                taskType: t.type,
            });
            return { ok: true, reason: null };
        } catch (e: any) {
            if (!this.isTaskActive(t)) return { ok: false, reason };
            const code = e?.body?.code ?? e?.code;
            if (code === 50165) {
                reason = "the activity is age-gated or delisted, so Discord refuses the proxy ticket on this account";
                const failure = errorFailure(e, { terminal: true, retryable: false, reason });
                logger.warn(`[Bypass] "${t.name}" can't be launched (age-gated or delisted). Discord blocks the proxy ticket, so there is nothing we can do.`);
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.BYPASS_FAILED,
                    category: "bypass",
                    level: "warning",
                    message: `Discord Says bypass is unavailable for "${t.name}" on this account.`,
                    questId: q.id,
                    questName: t.name,
                    taskType: t.type,
                    reason,
                    failure,
                });
                return { ok: false, reason, failure };
            }
            const parts: string[] = [];
            if (e?.status) parts.push(`HTTP ${e.status}`);
            if (code) parts.push(`code ${code}`);
            if (e?.body?.message) parts.push(e.body.message);
            else if (e?.message) parts.push(e.message);
            else if (typeof e === "string") parts.push(e);
            else if (e) { try { parts.push(JSON.stringify(e).slice(0, 200)); } catch { parts.push(String(e)); } }
            reason = `the Discord Says bypass failed (${parts.join(", ") || "unknown error"})`;
            const failure = errorFailure(e, {
                terminal: true,
                retryable: e?.status === 408 || e?.status === 429 || e?.status >= 500,
                reason,
            });
            logger.warn(`[Bypass] Failed: ${parts.join(", ") || "unknown"}`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.BYPASS_FAILED,
                category: "bypass",
                level: "warning",
                message: `Discord Says bypass failed for "${t.name}".`,
                questId: q.id,
                questName: t.name,
                taskType: t.type,
                reason,
                failure,
            });
            return { ok: false, reason, failure };
        } finally {
            if (!preGrantIds) {
                logger.warn(`[Bypass] OAuth cleanup for "${t.name}" had no pre-authorization grant snapshot; nothing was revoked.`);
            } else if (authorizationStarted) {
                try {
                    const cleanup = await cleanupCreatedOAuthGrants({
                        accountId,
                        appId,
                        preGrantIds,
                        getCurrentAccountId,
                        listGrants: async () => {
                            const after: any = await this.stores.API.get({ url: "/oauth2/tokens" });
                            return after?.body || [];
                        },
                        deleteGrant: async id => {
                            await this.stores.API.del({ url: `/oauth2/tokens/${id}` });
                        },
                    });
                    if (cleanup.status === "account-changed") {
                        logger.warn(`[Bypass] Account changed while cleaning up "${t.name}"; stopped OAuth grant cleanup rather than touching the new account.`);
                    } else if (cleanup.status === "account-unavailable") {
                        logger.warn(`[Bypass] Account identity was unavailable while cleaning up "${t.name}"; stopped OAuth grant cleanup rather than touching unconfirmed OAuth state.`);
                    }
                } catch (e: any) {
                    debug(logger, `[Bypass] Deauthorize cleanup non-fatal: ${e?.message}`);
                }
            }
        }
    }

    async ACHIEVEMENT(q: Quest, t: TaskInfo): Promise<void> {
        if (!this.isTaskActive(t)) return;

        let cur = this.readProgress(q.userStatus, t.keyName);
        this.cb.onProgress(q.id, { name: t.name, type: "ACHIEVEMENT", cur, max: t.target, status: "RUNNING" });
        if (!this.isTaskActive(t)) return;
        this.emitTaskStarted(q, t, "ACHIEVEMENT");

        let fallback: AchievementFallbackEvent | undefined;
        const key = this.streamKey();
        if (key) {
            const beat = { stream_key: key, application_id: String(t.appId || ""), terminal: false };
            let failCount = 0;
            logger.info(`[Task] Attempting heartbeat spoofing for "${t.name}"...`);

            while (cur < t.target && this.isTaskActive(t)) {
                try {
                    const r: any = await this.enqueue(t, `/quests/${q.id}/heartbeat`, beat);
                    if (!this.isTaskActive(t)) return;
                    cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? cur;
                    this.cb.onProgress(q.id, { name: t.name, type: "ACHIEVEMENT", cur, max: t.target, status: "RUNNING" });
                    failCount = 0;
                    if (cur >= t.target) {
                        try {
                            await this.enqueue(t, `/quests/${q.id}/heartbeat`, { ...beat, terminal: true });
                        } catch {
                            if (!this.isTaskActive(t)) return;
                        }
                        break;
                    }
                } catch (e: any) {
                    if (!this.isTaskActive(t)) return;
                    failCount++;
                    if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                        logger.warn(`[Achievement] Heartbeat rejected (HTTP ${e.status}).`);
                        fallback = {
                            level: "warning",
                            message: `Achievement heartbeat was rejected for "${t.name}"; Orion will try the Discord Says bypass.`,
                            failure: errorFailure(e, {
                                terminal: false,
                                retryable: false,
                                attempt: failCount,
                                maxAttempts: failCount,
                                reason: `Heartbeat rejected (HTTP ${e.status})`,
                            }),
                        };
                        break;
                    }
                    if (failCount >= MAX_TASK_FAILURES) {
                        logger.warn("[Achievement] Too many heartbeat failures.");
                        fallback = {
                            level: "warning",
                            message: `Achievement heartbeat retries were exhausted for "${t.name}"; Orion will try the Discord Says bypass.`,
                            failure: errorFailure(e, {
                                terminal: false,
                                retryable: true,
                                attempt: failCount,
                                maxAttempts: MAX_TASK_FAILURES,
                                reason: "Achievement heartbeat attempts exhausted",
                            }),
                        };
                        break;
                    }
                }
                if (!await this.wait(t, rnd(19000, 22000))) return;
            }

            if (cur >= t.target && this.isTaskActive(t)) return this.cb.onComplete(q, t);
        } else {
            fallback = {
                level: "info",
                message: `No voice-channel stream key was available for "${t.name}"; Orion will try the Discord Says bypass.`,
                reason: "No voice channel stream key available for the heartbeat path",
            };
        }

        if (!this.isTaskActive(t)) return;
        const bypass = await this.bypassAchievement(q, t, fallback);
        if (!this.isTaskActive(t)) return;
        if (bypass.ok) return this.cb.onComplete(q, t);

        if (bypass.disabled) {
            this.consentSkipped.add(q.id);
            return this.failTask(q, t, bypass.reason ?? "Achievement bypass is off in settings");
        }

        if (bypass.retryLater) {
            this.cb.onProgress(q.id, {
                name: t.name,
                type: t.type,
                cur,
                max: t.target,
                status: "QUEUE",
                reason: bypass.reason,
            });
            logger.info(`[Task] Deferring "${t.name}" until Discord reports the current account again.`);
            return;
        }

        logger.warn(`[Task] Skipping "${t.name}". No auto-completion path worked (heartbeat rejected, bypass blocked). Likely age-gated/delisted on your account.`);
        return this.failTask(q, t, bypass.reason ?? "no auto-completion path worked", bypass.failure);
    }

    retryConsentSkipped(): number {
        let restored = 0;
        for (const id of this.consentSkipped) {
            if (!this.skipped.delete(id)) continue;
            // The quest is going back into the rotation, so the failure recorded while consent
            // was off must not survive into the wrap-up counts.
            this.runtime.outcomes.delete(id);
            restored++;
        }
        this.consentSkipped.clear();
        return restored;
    }

    /** The Orb-only counterpart of retryConsentSkipped, for when the setting is turned off. */
    retryOrbFilterSkipped(): number {
        let restored = 0;
        for (const id of this.orbFilterSkipped) {
            if (!this.skipped.delete(id)) continue;
            this.runtime.outcomes.delete(id);
            restored++;
        }
        this.orbFilterSkipped.clear();
        return restored;
    }

    private streamKey(): string | null {
        try {
            const ownerId = this.stores.UserStore?.getCurrentUser?.()?.id;
            if (!ownerId) return null;

            const dmChan = this.stores.ChanStore?.getSortedPrivateChannels()?.[0]?.id;
            if (dmChan) return `call:${dmChan}:${ownerId}`;

            const guilds = this.stores.GuildChanStore?.getAllGuilds() ?? {};
            for (const g of Object.values<any>(guilds)) {
                const voiceChan = g?.VOCAL?.[0]?.channel;
                if (voiceChan?.id) {
                    const guildId = voiceChan.guild_id ?? g?.id;
                    if (guildId) return `guild:${guildId}:${voiceChan.id}:${ownerId}`;
                }
            }
            return null;
        } catch (e: any) {
            debug(logger, `[Task] Stream key lookup error: ${e?.message}`);
            return null;
        }
    }

    activeQuests(quests: Quest[]): Quest[] {
        return quests.filter(q =>
            !q.userStatus?.completedAt
            && !isQuestExpired(this.stores.QuestStore, q)
            && q.id !== BLACKLISTED_QUEST_ID
            && !this.skipped.has(q.id)
        );
    }
}

export { BLACKLISTED_QUEST_ID, MAX_TASK_FAILURES, MAX_TIME };
