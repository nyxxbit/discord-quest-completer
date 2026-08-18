/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Main orchestration. Loads stores via Vencord's webpack helpers,
 * runs the cycle loop that JIT-enrolls and dispatches handlers per
 * task type, and surfaces progress through the dashboard registry.
 */

import { SettingsStore } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { findByProps, findStore } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { setAchievementBypassHook } from "./hooks";
import { Patcher } from "./patcher";
import { selectQuestTaskConfig } from "./questConfig";
import { settings } from "./settings";
import { TaskControlRegistry, type TaskLifecycle } from "./taskControl";
import { TaskRunner } from "./tasks";
import { isSkippableQuest, Traffic } from "./traffic";
import type { OrionRuntime, Quest, Stores, TaskInfo, TaskType } from "./types";
import { debug, rnd, sleep, trafficMetadataSealed } from "./util";

const logger = new Logger("OrionQuests");
const IS_DESKTOP = IS_DISCORD_DESKTOP || IS_VESKTOP;

const Sound = {
    play(type: "tick" | "done"): void {
        if (!settings.store.playSound) return;
        try {
            const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.type = "sine";
            const t0 = ctx.currentTime;
            if (type === "done") {
                o.frequency.setValueAtTime(523.25, t0);
                o.frequency.setValueAtTime(659.25, t0 + 0.12);
                o.frequency.setValueAtTime(783.99, t0 + 0.24);
                g.gain.setValueAtTime(0.55, t0);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
                o.start(t0); o.stop(t0 + 0.6);
            } else {
                o.frequency.value = 880;
                g.gain.setValueAtTime(0.45, t0);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
                o.start(t0); o.stop(t0 + 0.2);
            }
        } catch (_) { /* audio unavailable */ }
    }
};

export interface DashboardEntry {
    id: string;
    name: string;
    type: TaskType;
    cur: number;
    max: number;
    status: string;
    claimable?: boolean;
    actionRequired?: string | null;
    reason?: string | null;
}

export interface QuestPauseResult {
    changed: boolean;
    cleanupFailures: number;
}

export interface QuestPauseAllResult {
    changed: number;
    cleanupFailures: number;
}

const RUNTIME: OrionRuntime = {
    running: false,
    cleanups: new Set<() => void>(),
    skipped: new Set<string>(),
};

let nextRunId = 0;
let activeRunId = 0;
let activeRuntime: OrionRuntime | null = null;
const taskControls = new TaskControlRegistry();

const dashboard = new Map<string, DashboardEntry>();
const dashboardListeners = new Set<() => void>();
let stores: Stores | null = null;
let patcher: Patcher | null = null;
let traffic: Traffic | null = null;
let tasks: TaskRunner | null = null;
let questStore: any = null;
let userStore: any = null;
let sessionOwnerUserId: string | null = null;
let accountResetInProgress = false;

function isRunActive(runId: number, runRuntime: OrionRuntime): boolean {
    return RUNTIME.running
        && runRuntime.running
        && activeRunId === runId
        && activeRuntime === runRuntime;
}

type ControlledTaskInfo = TaskInfo & { generation?: number; accountId?: string; };

function isTaskActive(runId: number, runRuntime: OrionRuntime, t: ControlledTaskInfo): boolean {
    if (t.accountId && getCurrentUserId() !== t.accountId) return false;
    return t.generation != null
        && isRunActive(runId, runRuntime)
        && taskControls.isActive(t.id, t.generation);
}

async function waitForControlledTaskDelay(
    runId: number,
    runRuntime: OrionRuntime,
    t: ControlledTaskInfo,
    ms: number,
): Promise<boolean> {
    if (!isTaskActive(runId, runRuntime, t) || t.generation == null) return false;
    const completed = await taskControls.waitForDelay(t.id, t.generation, ms);
    return completed && isTaskActive(runId, runRuntime, t);
}

function logTaskCleanupError(questId: string, error: unknown): void {
    logger.error(`[Task] Cleanup for quest ${questId} threw:`, error);
}

const hideActivityPath = () => `plugins.${settings.pluginName}.hideActivity`;
const onHideActivityChanged = () => patcher?.syncPresenceSuppression();

export function subscribeDashboard(fn: () => void): () => void {
    dashboardListeners.add(fn);
    return () => dashboardListeners.delete(fn);
}

export function getQuestStore(): any {
    if (!questStore) questStore = findStore("QuestStore") || findStore("QuestsStore");
    return questStore;
}

export function getUserStore(): any {
    if (!userStore) userStore = findStore("UserStore");
    return userStore;
}

export function getCurrentUserId(): string | null {
    try {
        return getUserStore()?.getCurrentUser?.()?.id ?? null;
    } catch {
        return null;
    }
}

function emitDashboard(): void {
    for (const fn of dashboardListeners) {
        try { fn(); } catch (e: any) { debug(logger, `[UI] listener threw: ${e?.message}`); }
    }
}

function setEntry(id: string, partial: Partial<DashboardEntry> & { name: string; type: TaskType; cur: number; max: number; status: string; }): void {
    if (!RUNTIME.running && (partial.status === "RUNNING" || partial.status === "QUEUE")) return;

    const prev = dashboard.get(id) ?? { id, claimable: false, actionRequired: null, reason: null } as DashboardEntry;
    const carried = partial.status === "FAILED" || "reason" in partial ? {} : { reason: null };
    dashboard.set(id, { ...prev, id, ...partial, ...carried });
    emitDashboard();
}

function removeEntry(id: string): void {
    dashboard.delete(id);
    emitDashboard();
}

/** Clear every object owned by the previous Discord account without observer re-entry. */
export function resetForAccountChange(): void {
    if (accountResetInProgress) return;
    accountResetInProgress = true;

    try {
        // Observable account-owned state goes first. stopOrion() emits synchronously, and a
        // dashboard subscriber is allowed to readDashboard() from that callback. Leaving the old
        // owner/dashboard visible until after stop would make that read detect the same account
        // mismatch and recursively enter this teardown while patcher/stores were still live.
        sessionOwnerUserId = null;
        taskControls.clearPaused();
        dashboard.clear();

        if (RUNTIME.running || activeRuntime || patcher || stores) stopOrion();
        else emitDashboard();
    } finally {
        accountResetInProgress = false;
    }
}

/** Lazy fallback for account transitions even if the UserStore listener is unavailable/delayed. */
function reconcileSessionAccount(): string | null {
    const current = getCurrentUserId();
    if (!current) {
        if (sessionOwnerUserId !== null && !accountResetInProgress) resetForAccountChange();
        return null;
    }

    if (sessionOwnerUserId !== null && sessionOwnerUserId !== current && !accountResetInProgress) {
        resetForAccountChange();
    }
    if (sessionOwnerUserId === null) sessionOwnerUserId = current;
    return current;
}

export function readDashboard(): DashboardEntry[] {
    reconcileSessionAccount();
    return Array.from(dashboard.values());
}

export function isEngineRunning(): boolean {
    // This is also a public/command-facing read. Reconcile here so an account switch cannot leave
    // callers observing `true` during the gap before UserStore's change listener runs.
    reconcileSessionAccount();
    return RUNTIME.running;
}

export function isQuestPaused(questId: string): boolean {
    reconcileSessionAccount();
    return taskControls.isPaused(questId);
}

export function pauseQuest(questId: string): QuestPauseResult {
    if (!reconcileSessionAccount()) return { changed: false, cleanupFailures: 0 };

    const entry = dashboard.get(questId);
    if (!entry || (entry.status !== "RUNNING" && entry.status !== "QUEUE")) {
        return { changed: false, cleanupFailures: 0 };
    }

    const result = taskControls.pause(questId, error => logTaskCleanupError(questId, error));
    if (!result) return { changed: false, cleanupFailures: 0 };

    dashboard.set(questId, {
        ...entry,
        status: "PAUSED",
        actionRequired: null,
        reason: null,
    });
    emitDashboard();
    return { changed: true, cleanupFailures: result.failed };
}

export function pauseAllQuests(): QuestPauseAllResult {
    reconcileSessionAccount();
    let changed = 0;
    let cleanupFailures = 0;
    const ids = Array.from(dashboard.values())
        .filter(entry => entry.status === "RUNNING" || entry.status === "QUEUE")
        .map(entry => entry.id);

    for (const id of ids) {
        const result = pauseQuest(id);
        if (!result.changed) continue;
        changed++;
        cleanupFailures += result.cleanupFailures;
    }
    return { changed, cleanupFailures };
}

export function resumeQuest(questId: string): boolean {
    reconcileSessionAccount();
    if (!taskControls.resume(questId)) return false;

    // Keep a visible/pauseable row until the scheduler creates the replacement generation.
    // Removing it opened a window where Pause -> Resume -> Pause could not express the last
    // Pause until the quest had already become RUNNING again. A QUEUE row with no TaskControl is
    // intentionally interpreted below as "eligible for the next cycle".
    const entry = dashboard.get(questId);
    if (entry?.status === "PAUSED") {
        dashboard.set(questId, {
            ...entry,
            status: "QUEUE",
            actionRequired: null,
            reason: null,
        });
        emitDashboard();
    }
    return true;
}

export function resumeAllQuests(): number {
    reconcileSessionAccount();
    const ids = taskControls.pausedIds();
    let changed = 0;
    for (const id of ids) if (resumeQuest(id)) changed++;
    return changed;
}

export function listQuests(): Quest[] {
    return getQuestsArray(getQuestStore());
}

function loadStores(): Stores {
    const QuestStore = getQuestStore();
    const RunStore = findStore("RunningGameStore");
    const StreamStore = findStore("ApplicationStreamingStore");
    const ChanStore = findStore("ChannelStore");
    const GuildChanStore = findStore("GuildChannelStore");
    const UserStore = getUserStore();
    const Dispatcher = (FluxDispatcher as any) || findByProps("dispatch", "subscribe", "flushWaitQueue");
    const API = (RestAPI as any) || findByProps("get", "post", "del");

    if (!QuestStore) throw new Error("QuestStore not found");
    if (!RunStore) throw new Error("RunningGameStore not found");
    if (!UserStore) throw new Error("UserStore not found");
    if (!Dispatcher) throw new Error("FluxDispatcher not found");
    if (!API) throw new Error("RestAPI not found");

    if (!StreamStore) logger.warn("StreamStore not found, STREAM quests will be limited");
    if (!ChanStore) logger.warn("ChannelStore not found, ACTIVITY quests may not find a channel");
    if (!GuildChanStore) logger.warn("GuildChannelStore not found, ACTIVITY guild fallback unavailable");

    return { QuestStore, RunStore, StreamStore, ChanStore, GuildChanStore, UserStore, Dispatcher, API };
}

function enrollmentBlockedUntil(questStoreForRun: any): Date | null {
    try {
        const raw = questStoreForRun?.questEnrollmentBlockedUntil;
        if (!raw) return null;
        const when = raw instanceof Date ? raw : new Date(raw);
        return isNaN(when.getTime()) || when.getTime() <= Date.now() ? null : when;
    } catch {
        return null;
    }
}

function getQuestsArray(store: any): Quest[] {
    const q = store?.quests;
    if (!q) return [];
    if (typeof q.values === "function") return Array.from(q.values()) as Quest[];
    if (Array.isArray(q)) return q as Quest[];
    return Object.values(q) as Quest[];
}

interface ScheduledTask {
    run: () => Promise<void>;
    isActive: () => boolean;
}

async function runConcurrent(
    scheduled: ScheduledTask[],
    limit: number,
    runId: number,
    runRuntime: OrionRuntime,
): Promise<void> {
    const executing = new Set<Promise<void>>();

    for (const task of scheduled) {
        if (!isRunActive(runId, runRuntime)) break;
        if (!task.isActive()) continue;

        let p!: Promise<void>;
        p = task.run()
            .catch(error => logger.error("[Task] Worker rejected unexpectedly:", error))
            .finally(() => executing.delete(p));
        executing.add(p);

        await sleep(rnd(1500, 4000));
        if (!isRunActive(runId, runRuntime)) break;
        if (executing.size >= Math.max(1, limit)) await Promise.race(executing);
    }

    await Promise.all(executing);
}

async function onTaskComplete(
    runId: number,
    runRuntime: OrionRuntime,
    runTasks: TaskRunner,
    q: Quest,
    t: TaskInfo,
): Promise<void> {
    const controlled = t as ControlledTaskInfo;
    if (!isTaskActive(runId, runRuntime, controlled)) return;

    setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
    logger.info(`[Task] Completed "${t.name}"!`);
    Sound.play("tick");

    try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Orion: Quest Completed", { body: t.name, tag: `orion-${q.id}` });
        }
    } catch (e: any) { debug(logger, `[Notification] ${e?.message}`); }

    if (settings.store.tryToClaimReward) {
        try {
            if (!await waitForControlledTaskDelay(runId, runRuntime, controlled, rnd(2500, 6000))) return;
            const claimRes: any = await runTasks.claimReward(q.id);
            if (!isTaskActive(runId, runRuntime, controlled)) return;
            if (claimRes?.body?.claimed_at) {
                logger.info(`[Claim] Reward for "${t.name}" claimed automatically!`);
                setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                const claimedEntry = dashboard.get(q.id);
                setTimeout(() => {
                    if (dashboard.get(q.id) === claimedEntry) removeEntry(q.id);
                }, 2000);
                return;
            }
        } catch (e: any) {
            if (!isTaskActive(runId, runRuntime, controlled)) return;
            const needsCaptcha = e?.body?.captcha_key || e?.body?.captcha_sitekey;
            if (needsCaptcha) logger.warn(`[Claim] Captcha required for "${t.name}". Use Discord's UI button.`);
            else logger.error(`[Claim] Auto-claim failed for "${t.name}": ${e?.body?.message ?? e?.message}`);
        }
    }

    if (isTaskActive(runId, runRuntime, controlled)) {
        setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true });
    }
}

async function mainLoop(
    runId: number,
    runRuntime: OrionRuntime,
    runStores: Stores,
    runTasks: TaskRunner,
    runTraffic: Traffic,
    runUserId: string,
): Promise<void> {
    let loopCount = 1;
    while (isRunActive(runId, runRuntime)) {
        try {
            if (getCurrentUserId() !== runUserId) {
                logger.warn("[System] Discord account changed while Orion was running. Stopping and clearing account-scoped session state.");
                resetForAccountChange();
                return;
            }

            logger.info(`[Cycle] Starting loop #${loopCount}...`);

            const blockedUntil = enrollmentBlockedUntil(runStores.QuestStore);
            if (blockedUntil) {
                logger.error(`[System] Discord has blocked quest enrollment on this account until ${blockedUntil.toLocaleString()}. Stopping instead of retrying.`);
                break;
            }

            const all = getQuestsArray(runStores.QuestStore);
            const active = runTasks.activeQuests(all);
            const activeIds = new Set(active.map(q => q.id));

            for (const id of taskControls.prunePaused(activeIds)) {
                if (dashboard.get(id)?.status === "PAUSED") removeEntry(id);
            }

            // A resumed quest is represented by QUEUE without a TaskControl until the scheduler
            // reaches it. If it completed/expired before that happens, retire that intent row too.
            for (const [id, entry] of Array.from(dashboard.entries())) {
                if (entry.status === "QUEUE" && !taskControls.get(id) && !activeIds.has(id)) removeEntry(id);
            }

            if (!active.length) {
                logger.info("[System] All available quests are completed!");
                Sound.play("done");
                break;
            }

            const queues: { video: ScheduledTask[]; game: ScheduledTask[]; } = { video: [], game: [] };

            for (const q of active) {
                if (!isRunActive(runId, runRuntime)) break;

                try {
                    if (taskControls.isPaused(q.id)) continue;
                    if (taskControls.get(q.id)) continue;

                    const cfg = selectQuestTaskConfig(q.config);
                    if (!cfg?.tasks || typeof cfg.tasks !== "object") {
                        logger.warn(`[Quest] ${q.id} has invalid task config. Skipping.`);
                        continue;
                    }

                    const detected = runTasks.detectType(cfg, q.config?.application?.id);
                    if (!detected) {
                        logger.warn(`[Quest] Unknown task type: ${q.config?.messages?.questName ?? q.id}`);
                        continue;
                    }
                    if (!IS_DESKTOP && (detected.type === "GAME" || detected.type === "STREAM")) {
                        logger.warn(`[Quest] "${q.config?.messages?.questName ?? q.id}" requires desktop app. Skipping.`);
                        continue;
                    }

                    const { type, keyName, target, appId } = detected;
                    if (target <= 0) {
                        logger.warn(`[Quest] Invalid target (${target}) for ${q.id}. Skipping.`);
                        continue;
                    }
                    if ((type === "GAME" || type === "STREAM") && !appId) {
                        logger.warn(`[Quest] "${q.config?.messages?.questName ?? q.id}" has no application id in its config, so the game cannot be spoofed. Skipping.`);
                        runRuntime.skipped.add(q.id);
                        runTasks.skipped.add(q.id);
                        continue;
                    }

                    // RUNNING without a control is never expected after the worker recovery below,
                    // so keep that guard strict. QUEUE is different: Resume intentionally leaves a
                    // control-free QUEUE row so the next cycle can create its replacement generation.
                    const existingStatus = dashboard.get(q.id)?.status;
                    if (existingStatus === "RUNNING") continue;

                    const t: ControlledTaskInfo = {
                        id: q.id,
                        appId: appId ?? 0,
                        name: q.config?.messages?.questName ?? "Unknown Quest",
                        target,
                        type,
                        keyName,
                        accountId: runUserId,
                    };

                    if (!q.userStatus?.enrolledAt && !settings.store.autoEnroll) {
                        if (dashboard.get(q.id)?.status !== "PENDING") {
                            logger.info(`[Enroll] Auto-enroll is off, waiting for you to accept "${t.name}" in Discord.`);
                        }
                        setEntry(t.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "PENDING", actionRequired: "ENROLL" });
                        continue;
                    }

                    const control = taskControls.create(q.id);
                    t.generation = control.generation;
                    setEntry(t.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "QUEUE", actionRequired: null });

                    const executeTask = async () => {
                        if (!isTaskActive(runId, runRuntime, t)) return;

                        if (!q.userStatus?.enrolledAt) {
                            logger.info(`[Enroll] Accepting quest: ${t.name}`);
                            try {
                                await runTraffic.enqueue(`/quests/${q.id}/enroll`, {
                                    location: 11,
                                    is_targeted: false,
                                    metadata_sealed: null,
                                    traffic_metadata_sealed: trafficMetadataSealed(runStores.QuestStore, q.id),
                                }, () => isTaskActive(runId, runRuntime, t), control.controller.signal);
                                if (!isTaskActive(runId, runRuntime, t)) return;
                                if (!await waitForControlledTaskDelay(runId, runRuntime, t, rnd(800, 1500))) return;
                            } catch (e: any) {
                                if (!isTaskActive(runId, runRuntime, t)) return;
                                if (isSkippableQuest(e)) {
                                    runRuntime.skipped.add(q.id);
                                    runTasks.skipped.add(q.id);
                                    logger.warn(`[Enroll] ${t.name} unavailable (${e.status}). Skipping.`);
                                } else {
                                    logger.error(`[Enroll] Failed for ${t.name}: ${e?.message}`);
                                }
                                return runTasks.failTask(q, t, "Enrollment failed");
                            }
                        }

                        if (!isTaskActive(runId, runRuntime, t)) return;
                        if (type === "WATCH_VIDEO") return runTasks.VIDEO(q, t, q.userStatus);
                        if (type === "ACHIEVEMENT") return runTasks.ACHIEVEMENT(q, t);
                        if (type === "STREAM") return runTasks.STREAM(q, t);
                        if (type === "ACTIVITY") return runTasks.ACTIVITY(q, t);
                        return runTasks.GAME(q, t);
                    };

                    const scheduled: ScheduledTask = {
                        isActive: () => isTaskActive(runId, runRuntime, t),
                        run: async () => {
                            if (!taskControls.markStarted(q.id, control.generation)) return;

                            const work = executeTask().catch(error => {
                                // A handler exception must not leave a RUNNING/QUEUE tombstone after
                                // release() removes the control, because the next cycle would then
                                // skip the quest forever. Cancellation is excluded by liveness, and
                                // terminal results already written by a handler are left untouched.
                                if (isTaskActive(runId, runRuntime, t)) {
                                    const current = dashboard.get(q.id);
                                    const terminal = current?.status === "COMPLETED"
                                        || current?.status === "CLAIMED"
                                        || current?.status === "FAILED";
                                    if (!terminal) {
                                        setEntry(q.id, {
                                            name: t.name,
                                            type: t.type,
                                            cur: current?.cur ?? 0,
                                            max: t.target,
                                            status: "FAILED",
                                            reason: "Unexpected task error; see console",
                                        });
                                        runRuntime.skipped.add(q.id);
                                        runTasks.skipped.add(q.id);
                                    }
                                }
                                throw error;
                            });

                            const settling = work.finally(() => {
                                taskControls.release(q.id, control.generation, error => logTaskCleanupError(q.id, error));
                            });
                            await Promise.race([settling, control.cancelled]);
                        },
                    };

                    if (type === "WATCH_VIDEO") queues.video.push(scheduled);
                    else queues.game.push(scheduled);
                } catch (e: any) {
                    if (isRunActive(runId, runRuntime)) logger.error(`[Quest] Error processing ${q.id}: ${e?.message}`);
                }
            }

            const total = queues.video.length + queues.game.length;
            if (total > 0 && isRunActive(runId, runRuntime)) {
                logger.info(`[Cycle] Processing: ${queues.video.length} videos, ${queues.game.length} games.`);
                await Promise.all([
                    runConcurrent(queues.game, settings.store.gameConcurrency ?? 1, runId, runRuntime),
                    runConcurrent(queues.video, settings.store.videoConcurrency ?? 2, runId, runRuntime),
                ]);
            } else if (isRunActive(runId, runRuntime)) {
                await sleep(rnd(4000, 6000));
            }

            if (!isRunActive(runId, runRuntime)) break;
            logger.info(`[Cycle] Loop #${loopCount} complete. Waiting before rescan...`);
            await sleep(rnd(2500, 4500));
            if (!isRunActive(runId, runRuntime)) break;
            loopCount++;
        } catch (e: any) {
            if (!isRunActive(runId, runRuntime)) break;
            logger.error(`[Cycle] Error in loop #${loopCount}: ${e?.message ?? e}`);
            await sleep(3000);
            if (!isRunActive(runId, runRuntime)) break;
            loopCount++;
        }
    }
}

export async function startOrion(): Promise<void> {
    if (RUNTIME.running) {
        logger.warn("Already running, ignoring start()");
        return;
    }

    // Reconcile account-owned session state before marking a new run active. Doing this after
    // activeRunId/RUNTIME are published could make the reconciliation stop the brand-new run and
    // then let its start continuation keep going.
    const startingUserId = reconcileSessionAccount();
    if (!startingUserId) {
        logger.error("Cannot start OrionQuests: current Discord user is unavailable.");
        return;
    }

    const runId = ++nextRunId;
    const runRuntime: OrionRuntime = {
        running: true,
        cleanups: new Set<() => void>(),
        skipped: new Set<string>(),
    };

    activeRunId = runId;
    activeRuntime = runRuntime;
    RUNTIME.running = true;
    RUNTIME.cleanups = runRuntime.cleanups;
    RUNTIME.skipped = runRuntime.skipped;

    for (const [id, e] of dashboard) {
        if (e.status !== "RUNNING" && e.status !== "QUEUE" && e.status !== "PAUSED") dashboard.delete(id);
    }
    emitDashboard();
    logger.info("Starting OrionQuests");

    try {
        const runStores = loadStores();
        const runUserId = runStores.UserStore?.getCurrentUser?.()?.id ?? null;
        if (!runUserId || runUserId !== startingUserId) {
            throw new Error("Discord account changed while Orion was starting");
        }

        const taskLifecycle: TaskLifecycle = {
            isActive: (questId, generation) =>
                isRunActive(runId, runRuntime)
                && getCurrentUserId() === runUserId
                && taskControls.isActive(questId, generation),
            signalFor: (questId, generation) => taskControls.signalFor(questId, generation),
            addCleanup: (questId, generation, cleanup) =>
                taskControls.addCleanup(questId, generation, cleanup),
            removeCleanup: (questId, generation, cleanup) =>
                taskControls.removeCleanup(questId, generation, cleanup),
            waitForDelay: (questId, generation, ms) =>
                taskControls.waitForDelay(questId, generation, ms),
        };

        const runPatcher = new Patcher(runStores, () => !!settings.store.hideActivity);
        SettingsStore.addChangeListener(hideActivityPath(), onHideActivityChanged);
        const runTraffic = new Traffic(runStores.API, () => isRunActive(runId, runRuntime), {
            warn: (...args) => logger.warn(...args),
            error: (...args) => logger.error(...args),
            debug: (...args) => debug(logger, ...args),
        });
        let runTasks!: TaskRunner;
        runTasks = new TaskRunner(runStores, runTraffic, runPatcher, runRuntime, {
            onProgress: (id, info) => {
                if (isRunActive(runId, runRuntime) && getCurrentUserId() === runUserId) setEntry(id, info);
            },
            onComplete: (q, t) => onTaskComplete(runId, runRuntime, runTasks, q, t),
        }, taskLifecycle);

        stores = runStores;
        patcher = runPatcher;
        traffic = runTraffic;
        tasks = runTasks;

        setAchievementBypassHook(enabled => {
            if (!enabled || !isRunActive(runId, runRuntime) || getCurrentUserId() !== runUserId) return;
            const restored = runTasks.retryConsentSkipped();
            if (restored > 0) logger.info(`[Settings] Achievement bypass enabled, retrying ${restored} skipped quest(s) on the next cycle.`);
        });

        try {
            if (typeof Notification !== "undefined" && Notification.permission === "default") {
                Notification.requestPermission();
            }
        } catch (e: any) { debug(logger, `[Notification] permission request failed: ${e?.message}`); }

        await mainLoop(runId, runRuntime, runStores, runTasks, runTraffic, runUserId);
    } catch (e: any) {
        if (activeRunId === runId && activeRuntime === runRuntime) {
            logger.error("Fatal:", e);
            runRuntime.running = false;
            RUNTIME.running = false;
        } else {
            debug(logger, `[Lifecycle] Stale run ${runId} exited after it had already been replaced: ${e?.message ?? e}`);
        }
    } finally {
        if (activeRunId === runId && activeRuntime === runRuntime) stopOrion();
    }
}

export function stopOrion(): void {
    const runRuntime = activeRuntime;
    if (!RUNTIME.running && !patcher && !stores && !runRuntime) return;

    activeRunId = 0;
    activeRuntime = null;
    RUNTIME.running = false;
    if (runRuntime) runRuntime.running = false;

    let failed = 0;
    taskControls.cancelAll(error => {
        failed++;
        logger.error("[Stop] Task cleanup threw:", error);
    });

    // Task-scoped cleanup lives only in TaskControlRegistry. This set is reserved for genuinely
    // run-scoped/fallback cleanup, avoiding double ownership and double execution on Stop.
    const cleanups = runRuntime?.cleanups ?? RUNTIME.cleanups;
    for (const cleanup of Array.from(cleanups)) {
        try { cleanup(); }
        catch (e: any) { failed++; logger.error("Cleanup function threw:", e); }
    }
    cleanups.clear();
    RUNTIME.cleanups = new Set<() => void>();
    RUNTIME.skipped = new Set<string>();

    SettingsStore.removeChangeListener(hideActivityPath(), onHideActivityChanged);

    for (const [id, e] of dashboard) {
        if (e.status === "RUNNING" || e.status === "QUEUE" || e.status === "PENDING") {
            dashboard.set(id, { ...e, status: "STOPPED", actionRequired: null });
        }
    }
    emitDashboard();

    setAchievementBypassHook(null);

    try { patcher?.clean(); } catch (e: any) { logger.error("Patcher cleanup threw:", e); }
    patcher = null;
    stores = null;
    traffic = null;
    tasks = null;

    logger.info(`Stopped. ${failed > 0 ? `${failed} cleanup(s) threw, see errors above.` : "All cleanups flushed cleanly."}`);
}
