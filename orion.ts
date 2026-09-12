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

import { isConfirmedDifferentAccount } from "./accountIdentity";
import { companionFailure, COMPANION_EVENT_CODES, emitCompanionEvent } from "./companionEvents";
import { setAchievementBypassHook } from "./hooks";
import { Patcher } from "./patcher";
import { questBlocker, recordOutcome, selectQuestTaskConfig, summarizeRun, taskEntries } from "./questConfig";
import { orbBalance } from "./questRewards";
import { schedulerLaneForTaskType, schedulerMetadata, type SchedulerLane, type SchedulerSnapshot, type SchedulerTaskView } from "./schedulerMetadata";
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
    outcomes: new Map(),
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
let virtualCurrencyStore: any = null;
let sessionOwnerUserId: string | null = null;
/**
 * Why the last run ended, when it ended on its own rather than by the user stopping it.
 * `/orion start` answers before the first scan has happened, so a run with nothing to do
 * reported success and was over a moment later, with the reason only in the console and no
 * dashboard log to fall back on in the plugin (issue #66).
 */
let lastRunOutcome: string | null = null;
let accountResetInProgress = false;
let dashboardDispatchDepth = 0;
let stopQueued = false;

function retryableHttpStatus(error: any): boolean {
    const status = error?.status ?? error?.statusCode ?? error?.httpStatus;
    return status === 408 || status === 429 || status >= 500;
}

function failureFromError(error: any, terminal: boolean, retryable: boolean, reason: string): ReturnType<typeof companionFailure> {
    const rawStatus = error?.status ?? error?.statusCode ?? error?.httpStatus;
    const rawCode = error?.body?.code ?? error?.code;
    return companionFailure({
        terminal,
        retryable,
        httpStatus: Number.isFinite(rawStatus) ? Number(rawStatus) : null,
        upstreamCode: typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : null,
        reason,
    });
}

function isRunActive(runId: number, runRuntime: OrionRuntime): boolean {
    return !stopQueued
        && RUNTIME.running
        && runRuntime.running
        && activeRunId === runId
        && activeRuntime === runRuntime;
}

type ControlledTaskInfo = TaskInfo & { generation?: number; accountId?: string; };

function isTaskActive(runId: number, runRuntime: OrionRuntime, t: ControlledTaskInfo): boolean {
    if (t.accountId && isConfirmedDifferentAccount(getCurrentUserId(), t.accountId)) return false;
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

function schedulerTaskViews(): SchedulerTaskView[] {
    const views: SchedulerTaskView[] = [];
    for (const entry of dashboard.values()) {
        const control = taskControls.get(entry.id);
        if (!control) continue;
        const lane = schedulerLaneForTaskType(entry.type);
        views.push({
            questId: entry.id,
            lane,
            active: control.active,
            started: control.started,
        });
    }
    return views;
}

export function readSchedulerSnapshot(): SchedulerSnapshot {
    reconcileSessionAccount();
    return schedulerMetadata.snapshot(schedulerTaskViews());
}

export function subscribeSchedulerState(listener: () => void): () => void {
    return schedulerMetadata.subscribe(listener);
}

export function getQuestStore(): any {
    if (!questStore) questStore = findStore("QuestStore") || findStore("QuestsStore");
    return questStore;
}

export function getUserStore(): any {
    if (!userStore) userStore = findStore("UserStore");
    return userStore;
}

export function getVirtualCurrencyStore(): any {
    if (!virtualCurrencyStore) virtualCurrencyStore = findStore("VirtualCurrencyStore");
    return virtualCurrencyStore;
}

/**
 * Orbs on the account. VirtualCurrencyStore holds the figure Discord's own Orb pill shows once
 * the client has fetched it, so that is read first. Before then it is null and one GET of the
 * balance endpoint fills it in. Nothing polls; this runs only when a status is asked for.
 */
export async function readOrbBalance(): Promise<number | null> {
    const stored = orbBalance(getVirtualCurrencyStore()?.balance);
    if (stored !== null) return stored;

    const API = (RestAPI as any) || findByProps("get", "post", "del");
    if (!API) throw new Error("RestAPI not found");
    const res = await API.get({ url: "/users/@me/virtual-currency/balance" });
    return orbBalance(res?.body?.balance);
}

export function getCurrentUserId(): string | null {
    try {
        return getUserStore()?.getCurrentUser?.()?.id ?? null;
    } catch {
        return null;
    }
}

function emitDashboard(): void {
    dashboardDispatchDepth++;
    try {
        for (const fn of dashboardListeners) {
            try { fn(); } catch (e: any) { debug(logger, `[System] Dashboard listener threw: ${e?.message}`); }
        }
    } finally {
        dashboardDispatchDepth--;
        schedulerMetadata.notify();
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
    emitCompanionEvent({
        code: COMPANION_EVENT_CODES.SYSTEM_ACCOUNT_CHANGED,
        category: "system",
        level: "warning",
        message: "Discord account changed; Orion is clearing account-scoped runtime state.",
    });

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
    // null only means the identity is unknown at this observation point. Do not destroy a healthy
    // session until Discord gives us a different confirmed non-null user id.
    if (!current) return null;

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

export function getLastRunOutcome(): string | null {
    return lastRunOutcome;
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
    if (!reconcileSessionAccount()) return false;
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
    if (!reconcileSessionAccount()) return 0;
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

function futureDate(raw: any): Date | null {
    try {
        if (!raw) return null;
        const when = raw instanceof Date ? raw : new Date(raw);
        return isNaN(when.getTime()) || when.getTime() <= Date.now() ? null : when;
    } catch {
        return null;
    }
}

function enrollmentBlockedUntil(questStoreForRun: any): Date | null {
    return futureDate(questStoreForRun?.questEnrollmentBlockedUntil);
}

/**
 * Discord returns this beside questEnrollmentBlockedUntil on the quest list fetch, and its own
 * client refuses to start any unfinished quest while it is set. It is the harsher of the two:
 * enrollment being blocked stops new quests, access being suspended stops everything. Orion used
 * to read only the first, so a suspended account kept enrolling and heartbeating into failures
 * and the user got a pile of generic errors instead of being told what had happened.
 */
function questAccessSuspendedUntil(questStoreForRun: any): Date | null {
    const store = questStoreForRun;
    if (!store) return null;
    const explicit = futureDate(store.questAccessSuspendedUntil);
    if (explicit) return explicit;
    // The boolean is derived from the same value, but read it too: a suspension with no readable
    // end date must still stop the run rather than fall through as "not suspended".
    return store.isQuestAccessSuspended === true ? new Date(0) : null;
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
    lane: SchedulerLane,
    limit: number,
    runId: number,
    runRuntime: OrionRuntime,
): Promise<void> {
    if (scheduled.length === 0) return;

    const effectiveLimit = Math.max(1, limit);
    const laneToken = schedulerMetadata.beginLane(lane, effectiveLimit);
    const executing = new Set<Promise<void>>();

    try {
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
            if (executing.size >= effectiveLimit) await Promise.race(executing);
        }

        await Promise.all(executing);
    } finally {
        schedulerMetadata.endLane(lane, laneToken);
    }
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
    // The one place the run knows a quest finished because of its own work. Everything the
    // wrap-up says about this run is counted from here, failTask and the blocker below.
    recordOutcome(runRuntime.outcomes, q.id, "completed");
    emitCompanionEvent({
        code: COMPANION_EVENT_CODES.TASK_COMPLETED,
        category: "task",
        level: "success",
        message: `Task completed for "${t.name}".`,
        questId: q.id,
        questName: t.name,
        taskType: t.type,
    });
    logger.info(`[Task] Completed "${t.name}"!`);
    Sound.play("tick");

    try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Orion: Quest Completed", { body: t.name, tag: `orion-${q.id}` });
        }
    } catch (e: any) { debug(logger, `[System] Notification: ${e?.message}`); }

    if (settings.store.tryToClaimReward) {
        try {
            if (!await waitForControlledTaskDelay(runId, runRuntime, controlled, rnd(2500, 6000))) return;
            const claimRes: any = await runTasks.claimReward(q.id);
            if (!isTaskActive(runId, runRuntime, controlled)) return;
            if (claimRes?.body?.claimed_at) {
                logger.info(`[Claim] Reward for "${t.name}" claimed automatically!`);
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.CLAIM_SUCCEEDED,
                    category: "claim",
                    level: "success",
                    message: `Reward claimed automatically for "${t.name}".`,
                    questId: q.id,
                    questName: t.name,
                    taskType: t.type,
                });
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
            if (needsCaptcha) {
                const reason = "Captcha required; claim the reward in Discord's UI";
                logger.warn(`[Claim] Captcha required for "${t.name}". Use Discord's UI button.`);
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.CLAIM_ACTION_REQUIRED,
                    category: "claim",
                    level: "warning",
                    message: `Reward claim for "${t.name}" requires user action in Discord.`,
                    questId: q.id,
                    questName: t.name,
                    taskType: t.type,
                    reason,
                });
            } else {
                const reason = String(e?.body?.message ?? e?.message ?? "Claim request failed");
                logger.error(`[Claim] Auto-claim failed for "${t.name}": ${reason}`);
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.CLAIM_FAILED,
                    category: "claim",
                    level: "error",
                    message: `Automatic reward claim failed for "${t.name}".`,
                    questId: q.id,
                    questName: t.name,
                    taskType: t.type,
                    reason,
                    failure: failureFromError(e, true, retryableHttpStatus(e), reason),
                });
            }
        }
    }

    if (isTaskActive(runId, runRuntime, controlled)) {
        setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true });
    }
}

const QUEST_LIST_EVT = "QUESTS_FETCH_CURRENT_QUESTS_SUCCESS";
const QUEST_LIST_WAIT_MS = 25000;

/**
 * Wait for Discord to fetch its quest list before the first cycle reads the store.
 *
 * Vencord starts plugins well before Discord has any quests. Measured on Stable 1.0.9255 with a
 * cold launch: Vencord started OrionQuests at +3.5s, the engine ran cycle #1 at +4.0s, and
 * QuestStore went from empty to 71 quests at +5.4s. With Auto Start on, that first cycle read an
 * empty store and reported "All available quests are completed", so nothing ever ran until the
 * user reloaded or typed /orion start by hand. That is issue #74.
 *
 * Discord dispatches QUESTS_FETCH_CURRENT_QUESTS_SUCCESS when the list lands, so wait on that
 * rather than on a fixed delay. An already-populated store skips the wait entirely, which is the
 * normal case for a manual start. If the event never arrives the run continues anyway: an empty
 * list is reported honestly by the caller instead of being dressed up as "everything is done".
 */
function awaitQuestList(runId: number, runRuntime: OrionRuntime, runStores: Stores): Promise<void> {
    if (getQuestsArray(runStores.QuestStore).length > 0) return Promise.resolve();

    logger.info("[Startup] Discord has not sent its quest list yet. Waiting for it before the first cycle.");
    emitCompanionEvent({
        code: COMPANION_EVENT_CODES.STARTUP_QUEST_LIST_WAITING,
        category: "startup",
        level: "info",
        message: "Waiting for Discord to provide the current Quest list before the first cycle.",
    });
    const waitingSince = Date.now();

    return new Promise<void>(resolve => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let poll: ReturnType<typeof setInterval> | null = null;

        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (poll) clearInterval(poll);
            try { runStores.Dispatcher?.unsubscribe?.(QUEST_LIST_EVT, onFetched); }
            catch (e) { debug(logger, `[Startup] Failed to detach the quest list listener: ${(e as any)?.message ?? e}`); }
            const found = getQuestsArray(runStores.QuestStore).length;
            // Stop/account-switch invalidates this run synchronously. A fetch that settles in the
            // same turn must still clean up its listener/timers, but it must not publish an event
            // for a generation Orion no longer owns.
            if (isRunActive(runId, runRuntime) && found > 0) {
                const elapsed = Date.now() - waitingSince;
                logger.info(`[Startup] Quest list arrived after ${elapsed}ms, ${found} quest(s).`);
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.STARTUP_QUEST_LIST_ARRIVED,
                    category: "startup",
                    level: "info",
                    message: `Discord provided ${found} Quest(s) after ${elapsed}ms.`,
                });
            }
            resolve();
        };

        // The dispatch carries the quests, but the store is what the cycle reads, so let the
        // reducer run first and then let the poll below observe the store it wrote.
        const onFetched = () => { if (getQuestsArray(runStores.QuestStore).length > 0) finish(); };

        try { runStores.Dispatcher?.subscribe?.(QUEST_LIST_EVT, onFetched); }
        catch (e) { debug(logger, `[Startup] Could not listen for the quest list fetch: ${(e as any)?.message ?? e}`); }

        // Covers a fetch that landed between the check above and the subscription, a Stop during
        // the wait, and a client that dispatches under a name this build does not use.
        poll = setInterval(() => {
            if (!isRunActive(runId, runRuntime) || getQuestsArray(runStores.QuestStore).length > 0) finish();
        }, 250);

        timer = setTimeout(() => {
            if (!isRunActive(runId, runRuntime)) {
                finish();
                return;
            }
            const seconds = Math.round(QUEST_LIST_WAIT_MS / 1000);
            logger.warn(`[Startup] Discord had not sent a quest list after ${seconds}s. Continuing with what the store holds.`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.STARTUP_QUEST_LIST_TIMEOUT,
                category: "startup",
                level: "warning",
                message: `Discord had not provided a Quest list after ${seconds}s; Orion is continuing with current store state.`,
            });
            finish();
        }, QUEST_LIST_WAIT_MS);
    });
}

async function mainLoop(
    runId: number,
    runRuntime: OrionRuntime,
    runStores: Stores,
    runTasks: TaskRunner,
    runTraffic: Traffic,
    runUserId: string,
): Promise<void> {
    await awaitQuestList(runId, runRuntime, runStores);

    let loopCount = 1;
    while (isRunActive(runId, runRuntime)) {
        try {
            const currentUserId = getCurrentUserId();
            if (currentUserId == null) {
                // Unknown identity is not an account switch. Do not schedule fresh work until
                // UserStore gives us a confirmed user again, but keep the healthy run/session.
                await sleep(1000);
                continue;
            }
            if (currentUserId !== runUserId) {
                logger.warn("[System] Discord account changed while Orion was running. Stopping and clearing account-scoped session state.");
                lastRunOutcome = "the Discord account changed, so the run was stopped and its state cleared.";
                resetForAccountChange();
                return;
            }

            logger.info(`[Cycle] Starting loop #${loopCount}...`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.CYCLE_STARTED,
                category: "cycle",
                level: "info",
                message: `Starting Quest scan cycle #${loopCount}.`,
            });

            const suspendedUntil = questAccessSuspendedUntil(runStores.QuestStore);
            if (suspendedUntil) {
                const when = suspendedUntil.getTime() === 0 ? "for now" : `until ${suspendedUntil.toLocaleString()}`;
                logger.error(`[System] Discord has suspended quest access on this account ${when}. Its own client refuses to start a quest in this state, so Orion stops too.`);
                lastRunOutcome = `Discord has suspended quest access on this account ${when}, so nothing was started.`;
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.SYSTEM_QUEST_ACCESS_SUSPENDED,
                    category: "system",
                    level: "error",
                    message: `Discord has suspended Quest access on this account ${when}; Orion is stopping.`,
                    reason: lastRunOutcome,
                });
                break;
            }

            const blockedUntil = enrollmentBlockedUntil(runStores.QuestStore);
            if (blockedUntil) {
                logger.error(`[System] Discord has blocked quest enrollment on this account until ${blockedUntil.toLocaleString()}. Stopping instead of retrying.`);
                lastRunOutcome = `Discord has blocked quest enrollment on this account until ${blockedUntil.toLocaleString()}, so nothing was started.`;
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.SYSTEM_ENROLLMENT_BLOCKED,
                    category: "system",
                    level: "error",
                    message: `Discord has blocked Quest enrollment on this account until ${blockedUntil.toLocaleString()}; Orion is stopping.`,
                    reason: lastRunOutcome,
                });
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
                // An empty store and a store full of finished quests are different situations and
                // used to produce the same sentence, which is how issue #74 read as "Orion says
                // everything is done" when Discord had simply not sent the list yet.
                if (!all.length) {
                    logger.warn("[System] Discord has not given this client a quest list, so there is nothing to run. Reload Discord and try again.");
                    lastRunOutcome = "Discord never sent a quest list to this client, so there was nothing to run.";
                    emitCompanionEvent({
                        code: COMPANION_EVENT_CODES.SYSTEM_QUEST_LIST_MISSING,
                        category: "system",
                        level: "warning",
                        message: "Discord did not provide a Quest list, so Orion has nothing to run.",
                        reason: lastRunOutcome,
                    });
                    break;
                }
                // Saying "all completed" here is how a quest this client skipped, or one that
                // died in a handler, used to read as a finished one. The counts come from what
                // the run recorded as it went, not from which quests gained completedAt while
                // it was alive, which cannot tell Orion's work from the user's.
                const summary = summarizeRun(runRuntime.outcomes);
                logger.info(`[System] ${summary.line}`);
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.SYSTEM_RUN_SUMMARY,
                    category: "system",
                    level: summary.failed > 0 ? "warning" : "info",
                    message: summary.line,
                });
                if (summary.blocked || summary.failed) {
                    const parts: string[] = [];
                    if (summary.finished) parts.push(`${summary.finished} quest(s) finished`);
                    if (summary.blocked) parts.push(`${summary.blocked} were skipped because this client cannot drive them`);
                    if (summary.failed) parts.push(`${summary.failed} failed`);
                    lastRunOutcome = `${parts.join(", ")}.`;
                } else {
                    lastRunOutcome = loopCount === 1
                        ? "every quest you can run is already finished, so there was nothing to farm."
                        : "every quest it could run is now finished.";
                }
                if (summary.playDone) Sound.play("done");
                break;
            }

            const queues: { video: ScheduledTask[]; game: ScheduledTask[]; } = { video: [], game: [] };

            for (const q of active) {
                if (!isRunActive(runId, runRuntime)) break;

                try {
                    if (taskControls.isPaused(q.id)) continue;
                    if (taskControls.get(q.id)) continue;

                    const cfg = selectQuestTaskConfig(q.config);
                    const questName = q.config?.messages?.questName ?? q.id;
                    const hasTaskConfig = !!cfg?.tasks && typeof cfg.tasks === "object";
                    const detected = hasTaskConfig ? runTasks.detectType(cfg, q.config?.application?.id) : null;
                    const blocker = questBlocker({
                        name: questName,
                        hasTaskConfig,
                        keys: taskEntries(cfg?.tasks).map(([key]) => key),
                        detected,
                        isDesktop: IS_DESKTOP,
                    });
                    if (blocker) {
                        logger.warn(`[Quest] ${blocker} Skipping it for the rest of this run.`);
                        emitCompanionEvent({
                            code: COMPANION_EVENT_CODES.QUEST_BLOCKED,
                            category: "quest",
                            level: "info",
                            message: `Orion left "${questName}" out of this run because this client cannot drive it.`,
                            questId: q.id,
                            questName,
                            taskType: detected?.type,
                            reason: blocker,
                        });
                        // Marking the quest skipped is the whole point: activeQuests filters on
                        // this set, and without it the same quest comes back every cycle and the
                        // run loops on it until the user pauses (issue #78).
                        runRuntime.skipped.add(q.id);
                        runTasks.skipped.add(q.id);
                        recordOutcome(runRuntime.outcomes, q.id, "blocked");
                        continue;
                    }

                    // questBlocker returns a sentence for every null detection, so by here it is set.
                    const { type, keyName, target, appId } = detected!;

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
                            emitCompanionEvent({
                                code: COMPANION_EVENT_CODES.ENROLL_WAITING,
                                category: "enroll",
                                level: "info",
                                message: `Waiting for you to accept "${t.name}" in Discord.`,
                                questId: q.id,
                                questName: t.name,
                                taskType: t.type,
                                reason: "Auto-enroll is disabled",
                            });
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
                            emitCompanionEvent({
                                code: COMPANION_EVENT_CODES.ENROLL_STARTED,
                                category: "enroll",
                                level: "info",
                                message: `Accepting "${t.name}" through Discord's Quest API.`,
                                questId: q.id,
                                questName: t.name,
                                taskType: t.type,
                            });
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
                                const skippable = isSkippableQuest(e);
                                if (skippable) {
                                    runRuntime.skipped.add(q.id);
                                    runTasks.skipped.add(q.id);
                                    logger.warn(`[Enroll] ${t.name} unavailable (${e.status}). Skipping.`);
                                } else {
                                    logger.error(`[Enroll] Failed for ${t.name}: ${e?.message}`);
                                }
                                const reason = skippable ? `Quest unavailable (HTTP ${e?.status ?? "unknown"})` : "Enrollment failed";
                                const failure = failureFromError(e, true, retryableHttpStatus(e), reason);
                                emitCompanionEvent({
                                    code: COMPANION_EVENT_CODES.ENROLL_FAILED,
                                    category: "enroll",
                                    level: skippable ? "warning" : "error",
                                    message: `Enrollment failed for "${t.name}".`,
                                    questId: q.id,
                                    questName: t.name,
                                    taskType: t.type,
                                    reason,
                                    failure,
                                });
                                return runTasks.failTask(q, t, "Enrollment failed", failure);
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
                            schedulerMetadata.notify();

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
                                        const reason = "Unexpected task error; see console";
                                        setEntry(q.id, {
                                            name: t.name,
                                            type: t.type,
                                            cur: current?.cur ?? 0,
                                            max: t.target,
                                            status: "FAILED",
                                            reason,
                                        });
                                        emitCompanionEvent({
                                            code: COMPANION_EVENT_CODES.TASK_FAILED,
                                            category: "task",
                                            level: "error",
                                            message: `Task failed unexpectedly for "${t.name}".`,
                                            questId: q.id,
                                            questName: t.name,
                                            taskType: t.type,
                                            reason,
                                            failure: failureFromError(error, true, retryableHttpStatus(error), reason),
                                        });
                                        runRuntime.skipped.add(q.id);
                                        runTasks.skipped.add(q.id);
                                        // This path skips the quest without going through
                                        // failTask, so it has to record the outcome itself.
                                        recordOutcome(runRuntime.outcomes, q.id, "failed");
                                    }
                                }
                                throw error;
                            });

                            const settling = work.finally(() => {
                                taskControls.release(q.id, control.generation, error => logTaskCleanupError(q.id, error));
                                schedulerMetadata.notify();
                            });
                            await Promise.race([settling, control.cancelled]);
                        },
                    };

                    queues[schedulerLaneForTaskType(type)].push(scheduled);
                } catch (e: any) {
                    if (isRunActive(runId, runRuntime)) logger.error(`[Quest] Error processing ${q.id}: ${e?.message}`);
                }
            }

            const total = queues.video.length + queues.game.length;
            if (total > 0 && isRunActive(runId, runRuntime)) {
                logger.info(`[Cycle] Processing: ${queues.video.length} videos, ${queues.game.length} games.`);
                emitCompanionEvent({
                    code: COMPANION_EVENT_CODES.CYCLE_PROCESSING,
                    category: "cycle",
                    level: "info",
                    message: `Cycle #${loopCount} is processing ${queues.video.length} video task(s) and ${queues.game.length} game-lane task(s).`,
                });
                await Promise.all([
                    runConcurrent(queues.game, "game", settings.store.gameConcurrency ?? 1, runId, runRuntime),
                    runConcurrent(queues.video, "video", settings.store.videoConcurrency ?? 2, runId, runRuntime),
                ]);
            } else if (isRunActive(runId, runRuntime)) {
                await sleep(rnd(4000, 6000));
            }

            if (!isRunActive(runId, runRuntime)) break;
            logger.info(`[Cycle] Loop #${loopCount} complete. Waiting before rescan...`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.CYCLE_COMPLETED,
                category: "cycle",
                level: "info",
                message: `Quest scan cycle #${loopCount} completed.`,
            });
            await sleep(rnd(2500, 4500));
            if (!isRunActive(runId, runRuntime)) break;
            loopCount++;
        } catch (e: any) {
            if (!isRunActive(runId, runRuntime)) break;
            const reason = String(e?.message ?? e);
            logger.error(`[Cycle] Error in loop #${loopCount}: ${reason}`);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.CYCLE_FAILED,
                category: "cycle",
                level: "error",
                message: `Quest scan cycle #${loopCount} failed and will be retried.`,
                reason,
                failure: failureFromError(e, false, true, reason),
            });
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
    // A new run owns the outcome from here on, so the previous one's reason cannot be read back
    // as if it described this start.
    lastRunOutcome = null;

    const startingUserId = reconcileSessionAccount();
    if (!startingUserId) {
        logger.error("Cannot start OrionQuests: current Discord user is unavailable.");
        lastRunOutcome = "Discord did not report a logged-in user, so the engine could not start.";
        emitCompanionEvent({
            code: COMPANION_EVENT_CODES.ENGINE_START_FAILED,
            category: "system",
            level: "error",
            message: "Orion could not start because Discord did not report a logged-in user.",
            reason: lastRunOutcome,
            failure: companionFailure({ terminal: true, retryable: true, reason: lastRunOutcome }),
        });
        return;
    }

    schedulerMetadata.clear();
    const runId = ++nextRunId;
    const runRuntime: OrionRuntime = {
        running: true,
        cleanups: new Set<() => void>(),
        skipped: new Set<string>(),
        outcomes: new Map(),
    };

    activeRunId = runId;
    activeRuntime = runRuntime;
    RUNTIME.running = true;
    RUNTIME.cleanups = runRuntime.cleanups;
    RUNTIME.skipped = runRuntime.skipped;
    RUNTIME.outcomes = runRuntime.outcomes;

    for (const [id, e] of dashboard) {
        if (e.status !== "RUNNING" && e.status !== "QUEUE" && e.status !== "PAUSED") dashboard.delete(id);
    }
    emitCompanionEvent({
        code: COMPANION_EVENT_CODES.ENGINE_STARTED,
        category: "system",
        level: "info",
        message: "Orion engine started.",
    });
    emitDashboard();
    if (!isRunActive(runId, runRuntime)) return;
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
                && !isConfirmedDifferentAccount(getCurrentUserId(), runUserId)
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
                // Null-tolerant, for the same reason isRunActive and taskLifecycle.isActive are:
                // a momentary blank identity is an observation gap, not a different user. Strict
                // equality here dropped the FAILED row that failTask had just written while
                // failTask still added the quest to `skipped`, leaving a RUNNING row with no
                // control behind it, which the scheduler then refuses to touch for the rest of
                // the run. Two of the four account predicates were converted; these two were not.
                if (isRunActive(runId, runRuntime) && !isConfirmedDifferentAccount(getCurrentUserId(), runUserId)) {
                    setEntry(id, info);
                }
            },
            onComplete: (q, t) => onTaskComplete(runId, runRuntime, runTasks, q, t),
        }, taskLifecycle);

        stores = runStores;
        patcher = runPatcher;
        traffic = runTraffic;
        tasks = runTasks;

        setAchievementBypassHook(enabled => {
            if (!enabled || !isRunActive(runId, runRuntime)) return;
            if (isConfirmedDifferentAccount(getCurrentUserId(), runUserId)) return;
            const restored = runTasks.retryConsentSkipped();
            if (restored > 0) logger.info(`[System] Achievement bypass enabled, retrying ${restored} skipped quest(s) on the next cycle.`);
        });

        try {
            if (typeof Notification !== "undefined" && Notification.permission === "default") {
                Notification.requestPermission();
            }
        } catch (e: any) { debug(logger, `[System] Notification permission request failed: ${e?.message}`); }

        await mainLoop(runId, runRuntime, runStores, runTasks, runTraffic, runUserId);
    } catch (e: any) {
        if (activeRunId === runId && activeRuntime === runRuntime) {
            const reason = String(e?.message ?? e);
            logger.error("Fatal:", e);
            emitCompanionEvent({
                code: COMPANION_EVENT_CODES.ENGINE_FAILED,
                category: "system",
                level: "error",
                message: "Orion encountered a fatal error after publishing the engine as running.",
                reason,
                failure: failureFromError(e, true, retryableHttpStatus(e), reason),
            });
            runRuntime.running = false;
            RUNTIME.running = false;
        } else {
            debug(logger, `[System] Stale run ${runId} exited after it had already been replaced: ${e?.message ?? e}`);
        }
    } finally {
        if (activeRunId === runId && activeRuntime === runRuntime) stopOrion();
    }
}

export function stopOrion(): void {
    const runRuntime = activeRuntime;
    if (!RUNTIME.running && !patcher && !stores && !runRuntime) return;

    // Dashboard subscribers run synchronously. If one asks Orion to stop while it is observing
    // a state publication, mark the run dead immediately so producer liveness guards fire, but
    // defer destructive cleanup until that producer stack has finished committing its fact/event.
    if (dashboardDispatchDepth > 0) {
        if (!stopQueued) {
            stopQueued = true;
            queueMicrotask(() => {
                stopQueued = false;
                stopOrion();
            });
        }
        return;
    }
    stopQueued = false;

    activeRunId = 0;
    activeRuntime = null;
    RUNTIME.running = false;
    if (runRuntime) runRuntime.running = false;
    schedulerMetadata.clear();

    let failed = 0;
    taskControls.cancelAll(error => {
        failed++;
        logger.error("[System] Task cleanup threw:", error);
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
    RUNTIME.outcomes = new Map();

    SettingsStore.removeChangeListener(hideActivityPath(), onHideActivityChanged);

    for (const [id, e] of dashboard) {
        if (e.status === "RUNNING" || e.status === "QUEUE" || e.status === "PENDING") {
            dashboard.set(id, { ...e, status: "STOPPED", actionRequired: null });
        }
    }

    setAchievementBypassHook(null);

    try { patcher?.clean(); }
    catch (e: any) {
        failed++;
        logger.error("Patcher cleanup threw:", e);
    }
    patcher = null;
    stores = null;
    traffic = null;
    tasks = null;

    const stopMessage = failed > 0 ? `${failed} cleanup(s) threw, see errors above.` : "All cleanups flushed cleanly.";
    logger.info(`Stopped. ${stopMessage}`);
    emitCompanionEvent({
        code: COMPANION_EVENT_CODES.ENGINE_STOPPED,
        category: "system",
        level: failed > 0 ? "warning" : "info",
        message: `Orion engine stopped. ${stopMessage}`,
        ...(lastRunOutcome ? { reason: lastRunOutcome } : {}),
    });
    // Notify control-state consumers only after all old run-owned globals/resources are gone. A
    // subscriber may synchronously start a new run from this callback without the old stop path
    // subsequently cleaning or nulling the new run's state.
    emitDashboard();
}
