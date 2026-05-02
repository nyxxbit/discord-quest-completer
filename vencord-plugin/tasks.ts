/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Per-task-type handlers. Mirrors the Tasks module in ../index.js,
 * minus the DOM render/dashboard concerns. Phases 3-4 ported here.
 *
 * Each handler is async and resolves when the task either completes
 * (target reached → finish()) or fails (skipped/timeout → failTask()).
 */

import { Logger } from "@utils/Logger";

import type { Patcher } from "./patcher";
import type { Traffic } from "./traffic";
import { isSkippableQuest } from "./traffic";
import type { DetectedTask, FakeGame, OrionRuntime, Quest, Stores, TaskInfo, TaskType } from "./types";
import { rnd, sanitize, sleep } from "./util";

const logger = new Logger("OrionQuests");

const HEARTBEAT_EVT = "QUESTS_SEND_HEARTBEAT_SUCCESS";
const MAX_TIME = 25 * 60 * 1000; // 25 minutes per task
const MAX_TASK_FAILURES = 5;

// blacklisted quest known to break enrollment
const BLACKLISTED_QUEST_ID = "1412491570820812933";

export interface TaskCallbacks {
    onProgress: (id: string, info: { name: string; type: TaskType; cur: number; max: number; status: string; actionRequired?: string | null; }) => void;
    onComplete: (q: Quest, t: TaskInfo) => Promise<void>;
}

export class TaskRunner {
    public skipped = new Set<string>();
    private stores: Stores;
    private traffic: Traffic;
    private patcher: Patcher;
    private runtime: OrionRuntime;
    private cb: TaskCallbacks;

    constructor(stores: Stores, traffic: Traffic, patcher: Patcher, runtime: OrionRuntime, cb: TaskCallbacks) {
        this.stores = stores;
        this.traffic = traffic;
        this.patcher = patcher;
        this.runtime = runtime;
        this.cb = cb;
    }

    /** Detect task type from quest config. Order matters — ACHIEVEMENT_IN_ACTIVITY before generic ACTIVITY. */
    detectType(cfg: any, applicationId?: string): DetectedTask | null {
        const taskKeys = Object.keys(cfg.tasks);
        const typeMap: Array<{ key: string; type: TaskType; }> = [
            { key: "PLAY", type: "GAME" },
            { key: "STREAM", type: "STREAM" },
            { key: "VIDEO", type: "WATCH_VIDEO" },
            { key: "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
            { key: "ACTIVITY", type: "ACTIVITY" },
        ];
        for (const { key, type } of typeMap) {
            const keyName = taskKeys.find(k => k.includes(key));
            if (keyName) return { type, keyName, target: cfg.tasks[keyName]?.target ?? 0 };
        }
        if (applicationId) {
            return { type: "GAME", keyName: "PLAY_ON_DESKTOP", target: cfg.tasks[taskKeys[0]]?.target ?? 0 };
        }
        return null;
    }

    /** Pull real exe metadata from Discord's app registry; falls back to synthetic paths. */
    async fetchGameData(appId: string | number, appName: string): Promise<any> {
        try {
            const res = await this.stores.API.get({ url: `/applications/public?application_ids=${appId}` });
            const appData = res?.body?.[0];
            const exeEntry = appData?.executables?.find((x: any) => x.os === "win32");
            const rawExe = exeEntry ? exeEntry.name.replace(">", "") : `${sanitize(appName)}.exe`;
            const cleanName = sanitize(appData?.name || appName);
            return {
                name: appData?.name || appName,
                icon: appData?.icon,
                exeName: rawExe,
                cmdLine: `C:\\Program Files\\${cleanName}\\${rawExe}`,
                exePath: `c:/program files/${cleanName.toLowerCase()}/${rawExe}`,
                id: appId,
            };
        } catch (e: any) {
            logger.debug(`[FetchGame] Fallback for ${appName}: ${e?.message ?? e}`);
            const cleanName = sanitize(appName);
            const safeExe = `${cleanName.replace(/\s+/g, "")}.exe`;
            return {
                name: appName, exeName: safeExe,
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
                platform: 0, location: 11, is_targeted: false,
                metadata_raw: null, metadata_sealed: null,
                traffic_metadata_raw: null, traffic_metadata_sealed: null,
            },
        });
    }

    failTask(q: Quest, t: TaskInfo, reason: string): void {
        this.cb.onProgress(q.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "FAILED" });
        logger.error(`[Task] Aborted "${t.name}": ${reason}`);
        this.skipped.add(q.id);
    }

    /** WATCH_VIDEO: send fake video-progress timestamps until Discord marks the quest done. */
    async VIDEO(q: Quest, t: TaskInfo, s: any): Promise<void> {
        let cur: number = s?.progress?.[t.keyName]?.value ?? s?.progress?.[t.type]?.value ?? 0;
        let failCount = 0;

        this.cb.onProgress(q.id, { name: t.name, type: "WATCH_VIDEO", cur, max: t.target, status: "RUNNING" });

        const startTime = Date.now();

        // initial buffer ping
        if (cur === 0) {
            await sleep(rnd(200, 350));
            cur = 0.2 + Math.random() * 0.05;
            try {
                await this.traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: Number(cur.toFixed(6)) });
            } catch (e: any) {
                logger.debug(`[Video] Initial ping failed: ${e?.message}`);
            }
        }

        while (cur < t.target && this.runtime.running) {
            const delayMs = rnd(7000, 9500);
            await sleep(delayMs);
            const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
            cur += elapsedSec;
            const payloadTs = Number(Math.min(t.target, cur).toFixed(6));

            try {
                const r: any = await this.traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: payloadTs });
                const serverVal: number | undefined = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.WATCH_VIDEO?.value;
                if (serverVal !== undefined && serverVal > cur) cur = Math.min(t.target, serverVal);
                if (r?.body?.completed_at) break;
                failCount = 0;
            } catch (e: any) {
                failCount++;
                if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                    logger.warn(`[Task] Video quest unavailable (HTTP ${e.status}). Skipping.`);
                    return this.failTask(q, t, `Client Error ${e.status}`);
                }
                if (failCount >= MAX_TASK_FAILURES) {
                    return this.failTask(q, t, "Too many network failures");
                }
            }
            this.cb.onProgress(q.id, { name: t.name, type: "WATCH_VIDEO", cur, max: t.target, status: "RUNNING" });
            if (Date.now() - startTime > MAX_TIME) {
                return this.failTask(q, t, "Timeout exceeded");
            }
        }
        if (this.runtime.running) await this.cb.onComplete(q, t);
    }

    /** GAME / STREAM share an injection path: fake process + heartbeat subscription. */
    async generic(q: Quest, t: TaskInfo, type: TaskType, key: string): Promise<void> {
        if (!this.runtime.running) return;
        const gameData = await this.fetchGameData(t.appId, t.name);

        return new Promise<void>(resolve => {
            const pid = rnd(2500, 12500) * 4; // multiples of 4 (Windows NT kernel alignment)
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
                windowHandle: 0, fullscreenType: 0, overlay: true, sandboxed: false,
                hidden: false, isLauncher: false,
            };

            let cleanupHook: () => void;
            let cleaned = false;
            let safetyTimer: number | undefined;

            if (type === "STREAM") {
                const real = this.stores.StreamStore?.getStreamerActiveStreamMetadata;
                if (this.stores.StreamStore) {
                    this.stores.StreamStore.getStreamerActiveStreamMetadata = () => ({
                        id: gameData.id, pid, sourceName: gameData.name,
                    });
                }
                cleanupHook = () => {
                    if (this.stores.StreamStore && real) {
                        this.stores.StreamStore.getStreamerActiveStreamMetadata = real;
                    }
                };
            } else {
                this.patcher.add(game);
                cleanupHook = () => this.patcher.remove(game);
            }

            this.cb.onProgress(q.id, { name: t.name, type, cur: 0, max: t.target, status: "RUNNING" });
            logger.info(`[Task] Started ${type}: ${gameData.name}`);

            const finish = () => {
                if (cleaned) return;
                cleaned = true;
                clearTimeout(safetyTimer);
                try { cleanupHook(); } catch (e: any) { logger.debug(`[Task] Cleanup: ${e?.message}`); }
                try { this.stores.Dispatcher?.unsubscribe(HEARTBEAT_EVT, check); } catch (e: any) { logger.debug(`[Dispatcher] Unsubscribe failed: ${e?.message}`); }
                this.runtime.cleanups.delete(finish);
            };

            safetyTimer = setTimeout(() => {
                if (this.runtime.running) this.failTask(q, t, "Timeout exceeded (25m)");
                finish();
                resolve();
            }, MAX_TIME) as unknown as number;

            const check = (d: any) => {
                if (!this.runtime.running) { finish(); resolve(); return; }
                if (d?.questId !== q.id) return;
                const prog = d.userStatus?.progress?.[key]?.value ?? d.userStatus?.streamProgressSeconds ?? 0;
                this.cb.onProgress(q.id, { name: t.name, type, cur: prog, max: t.target, status: "RUNNING" });
                if (prog >= t.target) {
                    finish();
                    this.cb.onComplete(q, t).finally(() => resolve());
                }
            };

            this.stores.Dispatcher?.subscribe(HEARTBEAT_EVT, check);
            this.runtime.cleanups.add(finish);
        });
    }

    GAME(q: Quest, t: TaskInfo): Promise<void> { return this.generic(q, t, "GAME", "PLAY_ON_DESKTOP"); }
    STREAM(q: Quest, t: TaskInfo): Promise<void> { return this.generic(q, t, "STREAM", "STREAM_ON_DESKTOP"); }

    /** ACTIVITY: heartbeat against a voice channel to simulate participation. */
    async ACTIVITY(q: Quest, t: TaskInfo): Promise<void> {
        const chan = this.findChannel();
        if (!chan) return this.failTask(q, t, "No voice channel found");
        const key = `call:${chan}:${rnd(1000, 9999)}`;
        let cur = 0;
        let failCount = 0;
        this.cb.onProgress(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
        const startTime = Date.now();

        while (cur < t.target && this.runtime.running) {
            try {
                const r: any = await this.traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: false });
                cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.PLAY_ACTIVITY?.value ?? cur + 20;
                this.cb.onProgress(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
                failCount = 0;
                if (cur >= t.target) {
                    try { await this.traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: true }); }
                    catch (e: any) { logger.debug(`[ACTIVITY] Final heartbeat failed: ${e?.message}`); }
                    break;
                }
            } catch (e: any) {
                failCount++;
                if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                    logger.warn(`[Task] Activity quest unavailable (HTTP ${e.status}). Skipping.`);
                    return this.failTask(q, t, `Client Error ${e.status}`);
                }
                if (failCount >= MAX_TASK_FAILURES) return this.failTask(q, t, "Too many network failures");
            }
            if (Date.now() - startTime > MAX_TIME) return this.failTask(q, t, "Timeout exceeded");
            await sleep(rnd(19000, 22000));
        }
        if (this.runtime.running && cur >= t.target) await this.cb.onComplete(q, t);
    }

    /** ACHIEVEMENT_IN_ACTIVITY: try heartbeat spoofing; fall back to passive event monitoring. */
    async ACHIEVEMENT(q: Quest, t: TaskInfo): Promise<void> {
        this.cb.onProgress(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING" });

        const chan = this.findChannel();
        if (chan) {
            const key = `call:${chan}:${rnd(1000, 9999)}`;
            let cur = 0;
            let failCount = 0;
            logger.info(`[Task] Attempting heartbeat spoofing for "${t.name}"...`);

            while (cur < t.target && this.runtime.running) {
                try {
                    const r: any = await this.traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: false });
                    cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? cur;
                    this.cb.onProgress(q.id, { name: t.name, type: "ACHIEVEMENT", cur, max: t.target, status: "RUNNING" });
                    failCount = 0;
                    if (cur >= t.target) {
                        try { await this.traffic.enqueue(`/quests/${q.id}/heartbeat`, { stream_key: key, terminal: true }); }
                        catch { /* noop */ }
                        break;
                    }
                } catch (e: any) {
                    failCount++;
                    if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                        logger.warn(`[Achievement] Heartbeat rejected (HTTP ${e.status}). Falling back to passive mode.`);
                        break;
                    }
                    if (failCount >= MAX_TASK_FAILURES) {
                        logger.warn(`[Achievement] Too many failures. Falling back to passive mode.`);
                        break;
                    }
                }
                await sleep(rnd(19000, 22000));
            }

            if (cur >= t.target && this.runtime.running) return this.cb.onComplete(q, t);
        }

        // fallback: passive mode — wait for user to complete the activity manually
        if (!this.runtime.running) return;
        logger.warn(`[Task] Action required: Join Activity to earn "${t.name}"`);
        this.cb.onProgress(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING", actionRequired: "MANUAL" });

        return new Promise<void>(resolve => {
            let cleaned = false;
            let safetyTimer: number | undefined;
            const finish = () => {
                if (cleaned) return;
                cleaned = true;
                clearTimeout(safetyTimer);
                try { this.stores.Dispatcher?.unsubscribe(HEARTBEAT_EVT, check); } catch { /* noop */ }
                this.runtime.cleanups.delete(finish);
            };
            safetyTimer = setTimeout(() => {
                if (this.runtime.running) this.failTask(q, t, "Timeout - achievement not earned");
                finish();
                resolve();
            }, MAX_TIME) as unknown as number;
            const check = (d: any) => {
                if (!this.runtime.running) { finish(); resolve(); return; }
                if (d?.questId !== q.id) return;
                const prog = d.userStatus?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? 0;
                this.cb.onProgress(q.id, { name: t.name, type: "ACHIEVEMENT", cur: prog, max: t.target, status: "RUNNING" });
                if (prog >= t.target) {
                    finish();
                    this.cb.onComplete(q, t).finally(() => resolve());
                }
            };
            this.stores.Dispatcher?.subscribe(HEARTBEAT_EVT, check);
            this.runtime.cleanups.add(finish);
        });
    }

    private findChannel(): string | null {
        try {
            const dmChan = this.stores.ChanStore?.getSortedPrivateChannels()?.[0]?.id;
            if (dmChan) return dmChan;
            const guilds = this.stores.GuildChanStore?.getAllGuilds() ?? {};
            for (const g of Object.values<any>(guilds)) {
                const voiceChan = g?.VOCAL?.[0]?.channel?.id;
                if (voiceChan) return voiceChan;
            }
            return null;
        } catch (e: any) {
            logger.debug(`[Task] Channel lookup error: ${e?.message}`);
            return null;
        }
    }

    /** Filter quests for execution: exclude completed, expired, blacklisted, and previously-skipped. */
    activeQuests(quests: Quest[]): Quest[] {
        const now = Date.now();
        return quests.filter(q =>
            !q.userStatus?.completedAt
            && new Date(q.config?.expiresAt ?? 0).getTime() > now
            && q.id !== BLACKLISTED_QUEST_ID
            && !this.skipped.has(q.id)
        );
    }
}

export { BLACKLISTED_QUEST_ID, MAX_TASK_FAILURES, MAX_TIME };
