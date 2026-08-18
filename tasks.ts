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

import { cleanupCreatedOAuthGrants } from "./oauthLifecycle";
import type { Patcher } from "./patcher";
import { taskEntries, taskForKey } from "./questConfig";
import { settings } from "./settings";
import type { TaskLifecycle } from "./taskControl";
import type { Traffic } from "./traffic";
import type { DetectedTask, FakeGame, OrionRuntime, Quest, Stores, TaskInfo, TaskType } from "./types";
import { debug, rnd, sanitize, sleep, trafficMetadataSealed } from "./util";

const logger = new Logger("OrionQuests");

const Native = VencordNative.pluginHelpers.OrionQuests as PluginNative<typeof import("./native")>;

const HEARTBEAT_EVT = "QUESTS_SEND_HEARTBEAT_SUCCESS";
const MAX_TIME = 25 * 60 * 1000;
const HEARTBEAT_GRACE = 90 * 1000;
const MAX_TASK_FAILURES = 5;

type ControlledTaskInfo = TaskInfo & { generation?: number; };

const BLACKLISTED_QUEST_ID = "1412491570820812933";

export interface BypassResult {
    ok: boolean;
    reason: string | null;
}

export interface TaskCallbacks {
    onProgress: (id: string, info: { name: string; type: TaskType; cur: number; max: number; status: string; actionRequired?: string | null; reason?: string | null; }) => void;
    onComplete: (q: Quest, t: TaskInfo) => Promise<void>;
}

export class TaskRunner {
    public skipped = new Set<string>();
    public consentSkipped = new Set<string>();
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
        const typeMap: Array<{ match: (k: string) => boolean; type: TaskType; }> = [
            { match: k => k === "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
            { match: k => k === "PLAY_ACTIVITY", type: "ACTIVITY" },
            { match: k => k.startsWith("STREAM"), type: "STREAM" },
            { match: k => k.includes("VIDEO"), type: "WATCH_VIDEO" },
            { match: k => k.startsWith("PLAY"), type: "GAME" },
            { match: k => k.includes("ACTIVITY"), type: "ACTIVITY" },
        ];

        for (const { match, type } of typeMap) {
            const entry = entries.find(([key]) => match(key));
            if (entry) {
                const [keyName, task] = entry;
                return {
                    type,
                    keyName,
                    target: task?.target ?? 0,
                    appId: this.appIdFor(cfg, keyName, applicationId),
                };
            }
        }

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
            debug(logger, `[FetchGame] Fallback for ${appName}: ${e?.message ?? e}`);
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

    failTask(q: Quest, t: TaskInfo, reason: string): void {
        if (!this.isTaskActive(t)) return;
        this.cb.onProgress(q.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "FAILED", reason });
        logger.error(`[Task] Aborted "${t.name}": ${reason}`);
        this.skipped.add(q.id);
    }

    async VIDEO(q: Quest, t: TaskInfo, s: any): Promise<void> {
        if (!this.isTaskActive(t)) return;

        let cur = this.readProgress(s, t.keyName);
        let failCount = 0;
        this.cb.onProgress(q.id, { name: t.name, type: "WATCH_VIDEO", cur, max: t.target, status: "RUNNING" });
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
                    return this.failTask(q, t, `Client Error ${e.status}`);
                }
                if (failCount >= MAX_TASK_FAILURES) return this.failTask(q, t, "Too many network failures");
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
            let safetyTimer: number | undefined;
            let watchdogTimer: number | undefined;
            let subscribed = false;
            let beats = 0;

            const finish = () => {
                if (cleaned) return;
                cleaned = true;
                clearTimeout(safetyTimer);
                clearTimeout(watchdogTimer);
                try { cleanupHook(); } catch (e: any) { debug(logger, `[Task] Cleanup: ${e?.message}`); }
                if (subscribed) {
                    try { this.stores.Dispatcher?.unsubscribe(HEARTBEAT_EVT, check); }
                    catch (e: any) { debug(logger, `[Dispatcher] Unsubscribe failed: ${e?.message}`); }
                }
                this.removeCleanup(t, abort);
            };

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
            logger.info(`[Task] Started ${type}: ${gameData.name}`);

            safetyTimer = setTimeout(() => {
                if (this.isTaskActive(t)) this.failTask(q, t, "Timeout exceeded (25m)");
                finish();
                resolve();
            }, MAX_TIME) as unknown as number;

            const armWatchdog = () => {
                clearTimeout(watchdogTimer);
                watchdogTimer = setTimeout(() => {
                    if (cleaned || !this.isTaskActive(t)) return;
                    logger.error(beats === 0
                        ? `[Task] Discord never reported progress for "${t.name}". It is not accepting the injected process on this client, so there is nothing to wait for.`
                        : `[Task] Discord stopped reporting progress for "${t.name}" after ${beats} update(s). Giving up instead of idling.`);
                    this.failTask(q, t, "No heartbeat from Discord");
                    finish();
                    resolve();
                }, HEARTBEAT_GRACE) as unknown as number;
            };
            armWatchdog();

            const check = (d: any) => {
                if (!this.isTaskActive(t)) { finish(); resolve(); return; }
                if (d?.questId !== q.id) return;
                beats++;
                armWatchdog();
                const prog = this.readProgress(d.userStatus, key);
                this.cb.onProgress(q.id, { name: t.name, type, cur: prog, max: t.target, status: "RUNNING" });
                if (prog >= t.target) {
                    finish();
                    if (!this.isTaskActive(t)) { resolve(); return; }
                    this.cb.onComplete(q, t).finally(() => resolve());
                }
            };

            try {
                this.stores.Dispatcher?.subscribe(HEARTBEAT_EVT, check);
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
                        if (this.isTaskActive(t)) debug(logger, `[ACTIVITY] Final heartbeat failed: ${e?.message}`);
                    }
                    break;
                }
            } catch (e: any) {
                if (!this.isTaskActive(t)) return;
                failCount++;
                if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                    logger.warn(`[Task] Activity quest unavailable (HTTP ${e.status}). Skipping.`);
                    return this.failTask(q, t, `Client Error ${e.status}`);
                }
                if (failCount >= MAX_TASK_FAILURES) return this.failTask(q, t, "Too many network failures");
            }
            if (!this.isTaskActive(t)) return;
            if (Date.now() - startTime > MAX_TIME) return this.failTask(q, t, "Timeout exceeded");
            if (!await this.wait(t, rnd(19000, 22000))) return;
        }

        if (this.isTaskActive(t) && cur >= t.target) await this.cb.onComplete(q, t);
    }

    async bypassAchievement(q: Quest, t: TaskInfo): Promise<BypassResult> {
        let reason: string | null = null;
        if (!this.isTaskActive(t)) return { ok: false, reason };

        const accountId = this.stores.UserStore?.getCurrentUser?.()?.id ?? null;
        const appId = String(t.appId || q.config?.application?.id || "");
        if (!appId) {
            reason = "this quest carries no application id, so there is nothing to authorize against";
            return { ok: false, reason };
        }
        if (!settings.store.achievementBypass) {
            logger.info(`[Bypass] Achievement OAuth bypass is off in settings; skipping "${t.name}". Enable it in OrionQuests settings if you want it.`);
            return { ok: false, reason };
        }
        if (!/^\d+$/.test(appId)) {
            reason = `the quest's application id ("${appId}") is not numeric, so it was refused before any request went out`;
            logger.warn(`[Bypass] Refusing non-numeric appId "${appId}".`);
            return { ok: false, reason };
        }

        let preGrantIds: Set<string> | undefined;
        try {
            const before: any = await this.stores.API.get({ url: "/oauth2/tokens" });
            if (!this.isTaskActive(t)) return { ok: false, reason };
            preGrantIds = new Set((before?.body || [])
                .filter((tk: any) => tk.application?.id === appId)
                .map((tk: any) => tk.id));
        } catch (e: any) {
            if (!this.isTaskActive(t)) return { ok: false, reason };
            logger.warn(`[Bypass] Couldn't snapshot existing grants; aborting so we never leave an un-revocable authorization: ${e?.message}`);
            return { ok: false, reason };
        }

        try {
            if (!this.isTaskActive(t)) return { ok: false, reason };
            logger.info(`[Bypass] Trying Discord Says auth flow for "${t.name}"...`);

            const authRes: any = await this.stores.API.post({
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
            if (!dsAuthRes.ok) throw new Error(`discordsays authorize ${dsAuthRes.status}`);
            let dsToken: string | undefined;
            try { dsToken = (JSON.parse(dsAuthRes.body) as { token?: string }).token; }
            catch { throw new Error("discordsays returned non-JSON: " + String(dsAuthRes.body).slice(0, 120)); }
            if (!dsToken) throw new Error("no discordsays token");

            if (!this.isTaskActive(t)) return { ok: false, reason };
            const progRes = await Native.discordsaysProgress({ appId, questId: q.id, token: dsToken, target: t.target, referrer });
            if (!this.isTaskActive(t)) return { ok: false, reason };
            if (!progRes.ok) throw new Error(`discordsays progress ${progRes.status}`);

            logger.info(`[Bypass] Success. "${t.name}" completed via Discord Says.`);
            return { ok: true, reason: null };
        } catch (e: any) {
            if (!this.isTaskActive(t)) return { ok: false, reason };
            const code = e?.body?.code;
            if (code === 50165) {
                reason = "the activity is age-gated or delisted, so Discord refuses the proxy ticket on this account";
                logger.warn(`[Bypass] "${t.name}" can't be launched (age-gated or delisted). Discord blocks the proxy ticket, so there is nothing we can do.`);
                return { ok: false, reason };
            }
            const parts: string[] = [];
            if (e?.status) parts.push(`HTTP ${e.status}`);
            if (code) parts.push(`code ${code}`);
            if (e?.body?.message) parts.push(e.body.message);
            else if (e?.message) parts.push(e.message);
            else if (typeof e === "string") parts.push(e);
            else if (e) { try { parts.push(JSON.stringify(e).slice(0, 200)); } catch { parts.push(String(e)); } }
            reason = `the Discord Says bypass failed (${parts.join(", ") || "unknown error"})`;
            logger.warn(`[Bypass] Failed: ${parts.join(", ") || "unknown"}`);
            return { ok: false, reason };
        } finally {
            // Compensating cleanup is intentionally allowed after task cancellation because a
            // request already on the wire may have created a grant. Account identity is checked
            // around every awaited cleanup boundary so an old task cannot touch the next user's
            // OAuth state after a Discord account switch.
            if (preGrantIds && accountId) {
                try {
                    const cleanup = await cleanupCreatedOAuthGrants({
                        accountId,
                        appId,
                        preGrantIds,
                        getCurrentAccountId: () => this.stores.UserStore?.getCurrentUser?.()?.id ?? null,
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
                        logger.warn(`[Achievement] Heartbeat rejected (HTTP ${e.status}). Falling back to bypass.`);
                        break;
                    }
                    if (failCount >= MAX_TASK_FAILURES) {
                        logger.warn(`[Achievement] Too many failures. Falling back to bypass.`);
                        break;
                    }
                }
                if (!await this.wait(t, rnd(19000, 22000))) return;
            }

            if (cur >= t.target && this.isTaskActive(t)) return this.cb.onComplete(q, t);
        }

        if (!this.isTaskActive(t)) return;
        const bypass = await this.bypassAchievement(q, t);
        if (!this.isTaskActive(t)) return;
        if (bypass.ok) return this.cb.onComplete(q, t);

        if (!settings.store.achievementBypass) {
            this.consentSkipped.add(q.id);
            return this.failTask(q, t, "Achievement bypass is off in settings");
        }

        logger.warn(`[Task] Skipping "${t.name}". No auto-completion path worked (heartbeat rejected, bypass blocked). Likely age-gated/delisted on your account.`);
        return this.failTask(q, t, bypass.reason ?? "no auto-completion path worked");
    }

    retryConsentSkipped(): number {
        let restored = 0;
        for (const id of this.consentSkipped) if (this.skipped.delete(id)) restored++;
        this.consentSkipped.clear();
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
