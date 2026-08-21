/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Plugin entry. Registers metadata, lifecycle, Flux enrollment wake-up,
 * and the /orion slash command (start | stop | status | pause | resume).
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import definePlugin from "@utils/types";

import { setWatchForEnrollmentsHook } from "./hooks";
import {
    getCurrentUserId,
    getQuestStore,
    getUserStore,
    isEngineRunning,
    pauseAllQuests,
    pauseQuest,
    readDashboard,
    resetForAccountChange,
    resumeAllQuests,
    resumeQuest,
    startOrion,
    stopOrion,
    subscribeDashboard,
} from "./orion";
import { repairSuppressedPresence } from "./patcher";
import { resolveQuestTarget } from "./questTarget";
import { settings } from "./settings";

/*
 * Enrollment watcher.
 *
 * Discord has a dedicated QUESTS_ENROLL_SUCCESS Flux event. Watching QuestStore's generic
 * change listener and inferring enrollment from snapshots is weaker: fetch/hydration, progress,
 * claims, and enrollment all mutate the same store. The semantic success event tells us what
 * actually happened; the engine still reads QuestStore as the source of quest state.
 *
 * The watcher is armed on plugin load and /orion start when the setting is enabled, left armed
 * after a natural queue drain, and disarmed by explicit /orion stop or plugin disable. A short
 * deferred start lets the Flux/store dispatch settle before the engine scans QuestStore; the
 * delay is synchronization only, not evidence that an enrollment happened.
 */
let enrollmentWatcherArmed = false;
let enrollmentStartTimer: ReturnType<typeof setTimeout> | null = null;
let pendingEnrollmentWake = false;
let watchedUserStore: any = null;
let onCurrentUserChanged: (() => void) | null = null;
let knownAccountId: string | null = null;

/*
 * Vencord calls plugin start() synchronously and does not await a returned Promise before it
 * marks the plugin started and registers commands/Flux handlers. Async boot work therefore sits
 * behind an explicit generation. A valid enrollment event that arrives during that boot window
 * is remembered once and replayed only after the same generation becomes ready.
 */
let pluginLifecycleGeneration = 0;
let pluginActive = false;
let pluginReady = false;
let pluginInitialization: Promise<void> = Promise.resolve();
let pluginInitializationError: unknown = null;

function clearEnrollmentStartTimer(): void {
    if (enrollmentStartTimer) clearTimeout(enrollmentStartTimer);
    enrollmentStartTimer = null;
}

function scheduleEnrollmentStart(): void {
    if (!pluginActive || !pluginReady || !enrollmentWatcherArmed || !settings.store.watchForEnrollments || isEngineRunning()) return;

    const scheduledAccount = getCurrentUserId();
    if (!scheduledAccount) return;

    clearEnrollmentStartTimer();
    enrollmentStartTimer = setTimeout(() => {
        enrollmentStartTimer = null;
        if (!pluginActive || !pluginReady || !enrollmentWatcherArmed || !settings.store.watchForEnrollments) return;
        if (getCurrentUserId() !== scheduledAccount || isEngineRunning()) return;

        console.log("[OrionQuests] Quest enrollment succeeded in Discord, starting the engine.");
        startOrion();
    }, 150);
}

function flushPendingEnrollmentWake(): void {
    if (!pendingEnrollmentWake) return;
    pendingEnrollmentWake = false;
    if (enrollmentWatcherArmed) scheduleEnrollmentStart();
}

function armWatcher(): void {
    if (!settings.store.watchForEnrollments) return;
    enrollmentWatcherArmed = true;
    if (pluginReady) flushPendingEnrollmentWake();
}

function disarmWatcher(): void {
    enrollmentWatcherArmed = false;
    pendingEnrollmentWake = false;
    clearEnrollmentStartTimer();
}

function onEnrollmentSuccess(): void {
    if (!pluginActive || !settings.store.watchForEnrollments) return;

    // Flux handlers are registered before async plugin initialization finishes. Preserve exactly
    // one wake intent during that window; after initialization, a disarmed watcher means the user
    // explicitly stopped/disabled watching and the event must be ignored.
    if (!pluginReady) {
        pendingEnrollmentWake = true;
        return;
    }
    if (!enrollmentWatcherArmed) return;
    scheduleEnrollmentStart();
}

function armAccountWatcher(): void {
    if (onCurrentUserChanged) return;
    const store = getUserStore();
    if (typeof store?.addChangeListener !== "function") {
        console.warn("[OrionQuests] UserStore has no change listener; account changes fall back to runtime checks.");
        return;
    }

    knownAccountId = getCurrentUserId();
    onCurrentUserChanged = () => {
        const current = getCurrentUserId();
        // A transient null means the identity is unknown, not that a different user was observed.
        // Keep the last confirmed account id until UserStore gives us another non-null identity.
        if (current == null) return;
        if (current === knownAccountId) return;
        knownAccountId = current;

        // A delayed enrollment from the previous account must never wake the engine for the next.
        pendingEnrollmentWake = false;
        clearEnrollmentStartTimer();
        resetForAccountChange();
    };
    watchedUserStore = store;
    watchedUserStore.addChangeListener(onCurrentUserChanged);
}

function disarmAccountWatcher(): void {
    if (onCurrentUserChanged && watchedUserStore) {
        try { watchedUserStore.removeChangeListener(onCurrentUserChanged); }
        catch (e) { console.error("[OrionQuests] Failed to detach the account watcher:", e); }
    }
    onCurrentUserChanged = null;
    watchedUserStore = null;
    knownAccountId = null;
}

// No local engine-running mirror: startOrion() publishes its own state synchronously, so a
// second boolean could only disagree with the source of truth.
async function ensureStart(): Promise<string> {
    // Re-arm even if the engine is already running. A start after an explicit stop restores the
    // watcher lifetime requested by the setting.
    armWatcher();
    if (isEngineRunning()) return "Already running.";
    startOrion();
    return "Started.";
}

function ensureStop(): string {
    const wasWatching = enrollmentWatcherArmed;
    disarmWatcher();
    if (!isEngineRunning()) return wasWatching ? "Not running. Stopped watching for accepted quests." : "Not running.";
    stopOrion();
    return wasWatching ? "Stopped, and no longer watching for accepted quests." : "Stopped.";
}

async function initializePlugin(generation: number): Promise<void> {
    try {
        // Repair may touch DataStore/UserSettings asynchronously. Nothing after it is allowed
        // to re-arm a plugin generation Vencord has already stopped or replaced.
        await repairSuppressedPresence();
        if (!pluginActive || generation !== pluginLifecycleGeneration) return;

        armAccountWatcher();
        setWatchForEnrollmentsHook(enabled => {
            if (enabled) armWatcher();
            else disarmWatcher();
        });

        pluginReady = true;
        if (settings.store.autoStart) {
            await ensureStart();
        } else {
            armWatcher();
            console.log("[OrionQuests] Plugin loaded. Use `/orion start` to begin (or enable Auto Start in settings).");
        }
        flushPendingEnrollmentWake();
    } catch (error) {
        if (pluginActive && generation === pluginLifecycleGeneration) {
            pluginInitializationError = error;
            pluginReady = false;
        }
        console.error("[OrionQuests] Failed to initialize:", error);
    }
}

async function waitForPluginInitialization(): Promise<void> {
    const generation = pluginLifecycleGeneration;
    const initialization = pluginInitialization;
    await initialization;

    if (!pluginActive || !pluginReady || generation !== pluginLifecycleGeneration || initialization !== pluginInitialization) {
        throw new Error("OrionQuests plugin initialization was stopped or superseded.");
    }
    if (pluginInitializationError) {
        throw pluginInitializationError instanceof Error
            ? pluginInitializationError
            : new Error("OrionQuests plugin initialization failed.");
    }
}

async function ensureReadyStart(): Promise<string> {
    await waitForPluginInitialization();
    return ensureStart();
}

async function ensureReadyStop(): Promise<string> {
    await waitForPluginInitialization();
    return ensureStop();
}

function statusSummary(): string {
    const running = isEngineRunning();
    const entries = readDashboard();
    if (!running && entries.length === 0) return "Idle. Use `/orion start` to begin.";
    if (entries.length === 0) return running ? "Running. No active tasks yet." : "Idle.";

    const tally = new Map<string, number>();
    for (const e of entries) tally.set(e.status, (tally.get(e.status) ?? 0) + 1);
    const breakdown = [...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([status, n]) => `${n} ${status.toLowerCase()}`)
        .join(", ");

    const store = getQuestStore();
    const stillUnclaimed = (e: { id: string; claimable?: boolean; }) => {
        if (!e.claimable) return false;
        try {
            const q = store?.getQuest?.(e.id);
            return q ? !q.userStatus?.claimedAt : true;
        } catch {
            return true;
        }
    };
    const claimable = entries.filter(stillUnclaimed).length;

    const lines = entries.map(e => {
        const pct = e.max > 0 ? Math.min(100, (e.cur / e.max) * 100).toFixed(0) : "?";
        const waiting = e.actionRequired === "ENROLL"
            ? ", waiting for you to accept it in Discord's Quests page"
            : "";
        const why = e.status === "FAILED" && e.reason ? `, ${e.reason}` : "";
        const reward = stillUnclaimed(e) ? ", reward not claimed yet" : "";
        return `• ${e.name}: ${e.status} (${pct}%)${waiting}${why}${reward}`;
    });

    const header = `${running ? "Running" : "Stopped"}, ${entries.length} task(s): ${breakdown}`;
    const footer = claimable > 0
        ? [`${claimable} reward(s) waiting. Claim them on Discord's Quests page, or turn on "Try to claim reward" to have Orion attempt it (claiming often triggers a captcha).`]
        : [];
    return [header, ...lines, ...footer].join("\n");
}

function formatCandidates(names: string[]): string {
    const shown = names.slice(0, 6);
    const suffix = names.length > shown.length ? `, +${names.length - shown.length} more` : "";
    return `${shown.map(name => `"${name}"`).join(", ")}${suffix}`;
}

function resolveCommandQuest(rawTarget: string, status: "pause" | "resume"): { id: string; name: string; } | string {
    const allowedStatuses = status === "pause" ? new Set(["RUNNING", "QUEUE"]) : new Set(["PAUSED"]);
    const candidates = readDashboard()
        .filter(entry => allowedStatuses.has(entry.status))
        .map(entry => ({ id: entry.id, name: entry.name }));

    const resolution = resolveQuestTarget(rawTarget, candidates);
    if (resolution.kind === "match") return resolution.candidate;
    if (resolution.kind === "ambiguous") {
        return `Quest target is ambiguous. Matches: ${formatCandidates(resolution.candidates.map(candidate => candidate.name))}.`;
    }

    if (candidates.length === 0) {
        return status === "pause" ? "No queued or running quests can be paused." : "No paused quests can be resumed.";
    }
    return `No ${status === "pause" ? "queued/running" : "paused"} quest matched "${rawTarget}". Current candidates: ${formatCandidates(candidates.map(candidate => candidate.name))}.`;
}

function ensurePause(rawTarget?: string): string {
    if (!rawTarget?.trim()) {
        const result = pauseAllQuests();
        if (result.changed === 0) return "No queued or running quests to pause.";
        const warning = result.cleanupFailures > 0 ? ` ${result.cleanupFailures} cleanup(s) threw; see the console.` : "";
        return `Paused ${result.changed} quest(s).${warning}`;
    }

    const target = resolveCommandQuest(rawTarget, "pause");
    if (typeof target === "string") return target;

    const result = pauseQuest(target.id);
    if (!result.changed) return `"${target.name}" is no longer queued or running.`;
    const warning = result.cleanupFailures > 0 ? ` ${result.cleanupFailures} cleanup(s) threw; see the console.` : "";
    return `Paused "${target.name}".${warning}`;
}

function ensureResume(rawTarget?: string): string {
    if (!rawTarget?.trim()) {
        const changed = resumeAllQuests();
        return changed > 0 ? `Resumed ${changed} quest(s); they are eligible again on the next cycle.` : "No paused quests to resume.";
    }

    const target = resolveCommandQuest(rawTarget, "resume");
    if (typeof target === "string") return target;

    return resumeQuest(target.id)
        ? `Resumed "${target.name}"; it is eligible again on the next cycle.`
        : `"${target.name}" is no longer paused.`;
}

async function ensureReadyPause(rawTarget?: string): Promise<string> {
    await waitForPluginInitialization();
    return ensurePause(rawTarget);
}

async function ensureReadyResume(rawTarget?: string): Promise<string> {
    await waitForPluginInitialization();
    return ensureResume(rawTarget);
}

type CompanionQuestState = "running" | "queued" | "paused" | "stopped";
type CompanionControlSnapshot = {
    running: boolean;
    quests: Record<string, CompanionQuestState>;
};

function companionQuestState(status: string): CompanionQuestState | null {
    if (status === "RUNNING") return "running";
    if (status === "QUEUE") return "queued";
    if (status === "PAUSED") return "paused";
    if (status === "STOPPED") return "stopped";
    return null;
}

function companionSnapshot(): CompanionControlSnapshot {
    const quests: Record<string, CompanionQuestState> = {};
    for (const entry of readDashboard()) {
        const state = companionQuestState(entry.status);
        if (state) quests[entry.id] = state;
    }
    return { running: isEngineRunning(), quests };
}

async function controlQuestById(questId: string, action: "pause" | "resume"): Promise<string> {
    await waitForPluginInitialization();
    const id = questId.trim();
    if (!id) throw new Error("Quest id is required.");

    const entry = readDashboard().find(candidate => candidate.id === id);
    const name = entry?.name ?? id;

    if (action === "pause") {
        const result = pauseQuest(id);
        if (!result.changed) return `"${name}" is no longer queued or running.`;
        const warning = result.cleanupFailures > 0 ? ` ${result.cleanupFailures} cleanup(s) threw; see the console.` : "";
        return `Paused "${name}".${warning}`;
    }

    return resumeQuest(id)
        ? `Resumed "${name}"; it is eligible again on the next cycle.`
        : `"${name}" is no longer paused.`;
}

export default definePlugin({
    name: "OrionQuests",
    description:
        "Auto-completes Discord Quests: game, video, stream, activity, and achievement.",
    authors: [{ name: "syntt_", id: 1419678867005767783n }],
    dependencies: ["UserSettingsAPI"],
    settings,

    // The QuestStore handler for this Flux event is the same semantic success path Discord's
    // own enroll action dispatches. Generic store changes are deliberately not treated as enrolls.
    flux: {
        QUESTS_ENROLL_SUCCESS(event: { enrolledQuestUserStatus?: unknown; }): void {
            if (!event?.enrolledQuestUserStatus) return;
            onEnrollmentSuccess();
        },
    },

    // Stable companion surface for UI plugins. It exposes only lifecycle/control state and
    // delegates every mutation back through Orion's own watcher-aware, generation-safe paths.
    // The legacy engine-only methods stay available so older QuestUI builds remain compatible.
    getEngineRunning(): boolean {
        return isEngineRunning();
    },

    subscribeEngineRunning(listener: () => void): () => void {
        return subscribeDashboard(listener);
    },

    getControlSnapshot(): CompanionControlSnapshot {
        return companionSnapshot();
    },

    subscribeControlState(listener: () => void): () => void {
        return subscribeDashboard(listener);
    },

    async controlEngine(action: "start" | "stop"): Promise<string> {
        if (action === "start") return ensureReadyStart();
        if (action === "stop") return ensureReadyStop();
        throw new Error(`Unsupported Orion engine action: ${String(action)}`);
    },

    async controlAll(action: "pause" | "resume"): Promise<string> {
        if (action === "pause") return ensureReadyPause();
        if (action === "resume") return ensureReadyResume();
        throw new Error(`Unsupported Orion global task action: ${String(action)}`);
    },

    async controlQuest(questId: string, action: "pause" | "resume"): Promise<string> {
        if (action !== "pause" && action !== "resume") {
            throw new Error(`Unsupported Orion quest action: ${String(action)}`);
        }
        return controlQuestById(questId, action);
    },

    commands: [
        {
            name: "orion",
            description: "Control the OrionQuests engine",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "action",
                    description: "Action to perform",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                    choices: [
                        { name: "start", value: "start", label: "Start the engine" },
                        { name: "stop", value: "stop", label: "Stop the engine" },
                        { name: "status", value: "status", label: "Show running tasks" },
                        { name: "pause", value: "pause", label: "Pause one quest, or all when quest is omitted" },
                        { name: "resume", value: "resume", label: "Resume one quest, or all when quest is omitted" },
                    ],
                },
                {
                    name: "quest",
                    description: "Quest name, unique name fragment, or ID for pause/resume; omit for all",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],
            execute: async (args, ctx) => {
                const action = String(args.find(a => a.name === "action")?.value ?? "status");
                const quest = args.find(a => a.name === "quest")?.value;
                const target = quest == null ? undefined : String(quest);

                let response: string;
                try {
                    if (target && action !== "pause" && action !== "resume") {
                        response = "The quest option only applies to pause or resume.";
                    } else if (action === "start") response = await ensureReadyStart();
                    else if (action === "stop") response = await ensureReadyStop();
                    else if (action === "pause") response = await ensureReadyPause(target);
                    else if (action === "resume") response = await ensureReadyResume(target);
                    else response = statusSummary();
                } catch (error) {
                    response = `Control unavailable: ${error instanceof Error ? error.message : String(error)}`;
                }
                sendBotMessage(ctx.channel.id, { content: `**Orion**\n\`\`\`\n${response}\n\`\`\`` });
            },
        },
    ],

    start() {
        const generation = ++pluginLifecycleGeneration;
        pluginActive = true;
        pluginReady = false;
        pendingEnrollmentWake = false;
        pluginInitializationError = null;
        pluginInitialization = initializePlugin(generation);
    },

    stop() {
        // Invalidate async initialization before teardown. Vencord does not await plugin start().
        pluginActive = false;
        pluginReady = false;
        pendingEnrollmentWake = false;
        pluginLifecycleGeneration++;
        setWatchForEnrollmentsHook(null);
        disarmAccountWatcher();
        try { ensureStop(); }
        catch (e) { console.error("[OrionQuests] Failed to stop cleanly:", e); }
    },
});
