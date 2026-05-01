/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Main orchestration. Loads stores via Vencord's webpack helpers,
 * runs the cycle loop that JIT-enrolls and dispatches handlers per
 * task type, and surfaces progress through the dashboard registry.
 */

import { Logger } from "@utils/Logger";
import { findByProps, findStore } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { Patcher } from "./patcher";
import { settings } from "./settings";
import { TaskRunner } from "./tasks";
import { Traffic } from "./traffic";
import type { OrionRuntime, Quest, Stores, TaskInfo, TaskType } from "./types";
import { rnd, sleep } from "./util";

const logger = new Logger("OrionQuests");

// Status of a task as surfaced to UI consumers (dashboard, slash commands).
export interface DashboardEntry {
    id: string;
    name: string;
    type: TaskType;
    cur: number;
    max: number;
    status: string;
    claimable?: boolean;
    actionRequired?: string | null;
}

const RUNTIME: OrionRuntime = {
    running: false,
    cleanups: new Set<() => void>(),
    skipped: new Set<string>(),
};

const dashboard = new Map<string, DashboardEntry>();
const dashboardListeners = new Set<() => void>();
let stores: Stores | null = null;
let patcher: Patcher | null = null;
let traffic: Traffic | null = null;
let tasks: TaskRunner | null = null;

/** Public read access for the React dashboard component. */
export function subscribeDashboard(fn: () => void): () => void {
    dashboardListeners.add(fn);
    return () => dashboardListeners.delete(fn);
}
export function readDashboard(): DashboardEntry[] {
    return Array.from(dashboard.values());
}
function emitDashboard(): void {
    for (const fn of dashboardListeners) {
        try { fn(); } catch (e: any) { logger.debug(`[UI] listener threw: ${e?.message}`); }
    }
}
function setEntry(id: string, partial: Partial<DashboardEntry> & { name: string; type: TaskType; cur: number; max: number; status: string; }): void {
    const prev = dashboard.get(id) ?? { id, claimable: false, actionRequired: null } as DashboardEntry;
    dashboard.set(id, { ...prev, id, ...partial });
    emitDashboard();
}
function removeEntry(id: string): void {
    dashboard.delete(id);
    emitDashboard();
}

function loadStores(): Stores {
    const QuestStore = findStore("QuestStore") || findStore("QuestsStore");
    const RunStore = findStore("RunningGameStore");
    const StreamStore = findStore("ApplicationStreamingStore");
    const ChanStore = findStore("ChannelStore");
    const GuildChanStore = findStore("GuildChannelStore");
    const Dispatcher = (FluxDispatcher as any) || findByProps("dispatch", "subscribe", "flushWaitQueue");
    const API = (RestAPI as any) || findByProps("get", "post", "del");

    if (!QuestStore) throw new Error("QuestStore not found");
    if (!RunStore) throw new Error("RunningGameStore not found");
    if (!Dispatcher) throw new Error("FluxDispatcher not found");
    if (!API) throw new Error("RestAPI not found");

    if (!StreamStore) logger.warn("StreamStore not found — STREAM quests will be limited");
    if (!ChanStore) logger.warn("ChannelStore not found — ACTIVITY quests may not find a channel");
    if (!GuildChanStore) logger.warn("GuildChannelStore not found — ACTIVITY guild fallback unavailable");

    return { QuestStore, RunStore, StreamStore, ChanStore, GuildChanStore, Dispatcher, API };
}

function getQuestsArray(questStore: any): Quest[] {
    const q = questStore?.quests;
    if (!q) return [];
    if (typeof q.values === "function") return Array.from(q.values()) as Quest[];
    if (Array.isArray(q)) return q as Quest[];
    return Object.values(q) as Quest[];
}

/** Run async tasks concurrently up to a specified limit, with stagger to avoid bursts. */
async function runConcurrent(taskFns: Array<() => Promise<any>>, limit: number): Promise<any[]> {
    const executing = new Set<Promise<any>>();
    for (const fn of taskFns) {
        if (!RUNTIME.running) break;
        const p = fn().finally(() => executing.delete(p));
        executing.add(p);
        await sleep(rnd(1500, 4000));
        if (executing.size >= limit) await Promise.race(executing);
    }
    return Promise.allSettled(executing);
}

async function onTaskComplete(q: Quest, t: TaskInfo): Promise<void> {
    setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
    logger.info(`[Task] Completed "${t.name}"!`);

    // browser notification
    try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Orion: Quest Completed", {
                body: t.name,
                tag: `orion-${q.id}`,
            });
        }
    } catch (e: any) { logger.debug(`[Notification] ${e?.message}`); }

    if (settings.store.tryToClaimReward && tasks) {
        try {
            await sleep(rnd(2500, 6000));
            if (!RUNTIME.running) return;
            const claimRes: any = await tasks.claimReward(q.id);
            if (claimRes?.body?.claimed_at) {
                logger.info(`[Claim] Reward for "${t.name}" claimed automatically!`);
                setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                setTimeout(() => removeEntry(q.id), 2000);
                return;
            }
        } catch (e: any) {
            const needsCaptcha = e?.body?.captcha_key || e?.body?.captcha_sitekey;
            if (needsCaptcha) {
                logger.warn(`[Claim] Captcha required for "${t.name}". Use Discord's UI button.`);
            } else {
                logger.error(`[Claim] Auto-claim failed for "${t.name}": ${e?.body?.message ?? e?.message}`);
            }
        }
    }

    setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true });
}

async function mainLoop(): Promise<void> {
    let loopCount = 1;
    while (RUNTIME.running) {
        try {
            logger.info(`[Cycle] Starting loop #${loopCount}...`);
            const all = getQuestsArray(stores!.QuestStore);
            const active = tasks!.activeQuests(all);

            if (!active.length) {
                logger.info("[System] All available quests are completed!");
                break;
            }

            const queues: { video: Array<() => Promise<any>>; game: Array<() => Promise<any>>; } = { video: [], game: [] };

            for (const q of active) {
                try {
                    const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                    if (!cfg?.tasks || typeof cfg.tasks !== "object") {
                        logger.warn(`[Quest] ${q.id} has invalid task config. Skipping.`);
                        continue;
                    }
                    const detected = tasks!.detectType(cfg, q.config?.application?.id);
                    if (!detected) {
                        logger.warn(`[Quest] Unknown task type: ${q.config?.messages?.questName ?? q.id}`);
                        continue;
                    }
                    const { type, keyName, target } = detected;
                    if (target <= 0) {
                        logger.warn(`[Quest] Invalid target (${target}) for ${q.id}. Skipping.`);
                        continue;
                    }
                    const t: TaskInfo = {
                        id: q.id,
                        appId: q.config?.application?.id ?? 0,
                        name: q.config?.messages?.questName ?? "Unknown Quest",
                        target, type, keyName,
                    };

                    // skip if already running
                    if (dashboard.get(q.id)?.status === "RUNNING") continue;

                    setEntry(t.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "QUEUE" });

                    const taskFn = async () => {
                        // JIT enrollment
                        if (!q.userStatus?.enrolledAt) {
                            logger.info(`[Enroll] Accepting quest: ${t.name}`);
                            try {
                                await traffic!.enqueue(`/quests/${q.id}/enroll`, { location: 11, is_targeted: false });
                                await sleep(rnd(800, 1500));
                            } catch (e: any) {
                                if (e?.status === 404 || e?.status === 403 || e?.status === 410) {
                                    RUNTIME.skipped.add(q.id);
                                    tasks!.skipped.add(q.id);
                                    logger.warn(`[Enroll] ${t.name} unavailable (${e.status}). Skipping.`);
                                } else {
                                    logger.error(`[Enroll] Failed for ${t.name}: ${e?.message}`);
                                }
                                return tasks!.failTask(q, t, "Enrollment failed");
                            }
                        }
                        if (type === "WATCH_VIDEO") return tasks!.VIDEO(q, t, q.userStatus);
                        if (type === "ACHIEVEMENT") return tasks!.ACHIEVEMENT(q, t);
                        if (type === "STREAM") return tasks!.STREAM(q, t);
                        if (type === "ACTIVITY") return tasks!.ACTIVITY(q, t);
                        return tasks!.GAME(q, t);
                    };

                    if (type === "WATCH_VIDEO") queues.video.push(taskFn);
                    else queues.game.push(taskFn);
                } catch (e: any) {
                    logger.error(`[Quest] Error processing ${q.id}: ${e?.message}`);
                }
            }

            const total = queues.video.length + queues.game.length;
            if (total > 0) {
                logger.info(`[Cycle] Processing: ${queues.video.length} videos, ${queues.game.length} games.`);
                const pGames = runConcurrent(queues.game, settings.store.gameConcurrency ?? 1);
                const pVideos = runConcurrent(queues.video, settings.store.videoConcurrency ?? 2);
                await Promise.all([pGames, pVideos]);
            } else {
                await sleep(rnd(4000, 6000));
            }

            if (!RUNTIME.running) break;
            logger.info(`[Cycle] Loop #${loopCount} complete. Waiting before rescan...`);
            await sleep(rnd(2500, 4500));
            loopCount++;
        } catch (e: any) {
            logger.error(`[Cycle] Error in loop #${loopCount}: ${e?.message ?? e}`);
            await sleep(3000);
            loopCount++;
        }
    }
}

export async function startOrion(): Promise<void> {
    if (RUNTIME.running) {
        logger.warn("Already running, ignoring start()");
        return;
    }
    RUNTIME.running = true;

    logger.info("Starting OrionQuests");

    try {
        stores = loadStores();
        patcher = new Patcher(stores, !!settings.store.hideActivity);
        traffic = new Traffic(stores.API, () => RUNTIME.running);
        tasks = new TaskRunner(stores, traffic, patcher, RUNTIME, {
            onProgress: (id, info) => setEntry(id, info),
            onComplete: onTaskComplete,
        });

        try {
            if (typeof Notification !== "undefined" && Notification.permission === "default") {
                Notification.requestPermission();
            }
        } catch (e: any) { logger.debug(`[Notification] permission request failed: ${e?.message}`); }

        await mainLoop();
    } catch (e: any) {
        logger.error("Fatal:", e);
        RUNTIME.running = false;
    } finally {
        // mainLoop exits when nothing left to do; teardown unconditionally
        stopOrion();
    }
}

export function stopOrion(): void {
    if (!RUNTIME.running && !patcher && !stores) return;
    RUNTIME.running = false;

    let failed = 0;
    for (const cleanup of RUNTIME.cleanups) {
        try { cleanup(); }
        catch (e: any) { failed++; logger.error("Cleanup function threw:", e); }
    }
    RUNTIME.cleanups.clear();

    try { patcher?.clean(); } catch (e: any) { logger.error("Patcher cleanup threw:", e); }
    patcher = null;
    stores = null;
    traffic = null;
    tasks = null;

    logger.info(`Stopped. ${failed > 0 ? `${failed} cleanup(s) threw — see errors above.` : "All cleanups flushed cleanly."}`);
}
