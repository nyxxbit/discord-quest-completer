/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Plugin entry. Registers metadata, the start/stop lifecycle, and
 * the /orion slash command (start | stop | status).
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import definePlugin from "@utils/types";

import { setWatchForEnrollmentsHook } from "./hooks";
import { getQuestStore, isEngineRunning, listQuests, readDashboard, startOrion, stopOrion, subscribeDashboard } from "./orion";
import { repairSuppressedPresence } from "./patcher";
import { settings } from "./settings";

/*
 * Enrollment watcher.
 *
 * Owned here, not in orion.ts, and that is the whole design. The engine tears itself down
 * whenever the queue drains (startOrion's finally calls stopOrion), so a watcher living
 * inside that lifecycle would switch itself off the moment it succeeded, and a "was this a
 * real stop" flag on stopOrion would leave every future caller to get that right. Here the
 * lifetime is structural: the watcher exists while the plugin is enabled, and nothing else
 * can take it down by accident.
 *
 * Armed by /orion start and by plugin load, disarmed by /orion stop and by the plugin being
 * disabled. A queue that drains on its own leaves it armed, an explicit stop does not: stop
 * is the user's "quit doing things" button, and an engine that restarts itself after being
 * told to stop is the surprise this feature must not have.
 */
let watchedStore: any = null;
let onQuestsChanged: (() => void) | null = null;
let knownEnrolled = new Set<string>();

function enrolledQuestIds(): Set<string> {
    const ids = new Set<string>();
    for (const q of listQuests()) {
        if (q.userStatus?.enrolledAt) ids.add(q.id);
    }
    return ids;
}

function armWatcher(): void {
    if (onQuestsChanged || !settings.store.watchForEnrollments) return;

    const store = getQuestStore();
    if (typeof store?.addChangeListener !== "function") {
        console.warn("[OrionQuests] QuestStore not found, the enrollment watcher is off for this session.");
        return;
    }

    // Seed from what is already accepted. Without this the first store event after arming
    // reads every existing enrollment as new and starts the engine the user never asked for.
    knownEnrolled = enrolledQuestIds();

    onQuestsChanged = () => {
        // The store emits for progress ticks, dismissals, claims and anything else it holds.
        // Only a quest that gained enrolledAt since the last look means "the user just
        // accepted something", and waking the engine on unrelated churn is exactly what
        // would make this feature unpredictable.
        const current = enrolledQuestIds();
        let accepted: string | null = null;
        for (const id of current) {
            if (!knownEnrolled.has(id)) { accepted = id; break; }
        }
        knownEnrolled = current;

        if (!accepted || isEngineRunning()) return;
        console.log(`[OrionQuests] Quest ${accepted} accepted in Discord, starting the engine.`);
        // fire and forget, same as ensureStart: teardown is startOrion's own finally
        startOrion();
    };

    watchedStore = store;
    watchedStore.addChangeListener(onQuestsChanged);
}

function disarmWatcher(): void {
    if (onQuestsChanged && watchedStore) {
        try { watchedStore.removeChangeListener(onQuestsChanged); }
        catch (e) { console.error("[OrionQuests] Failed to detach the enrollment watcher:", e); }
    }
    // cleared even if the detach threw: holding a listener we can no longer remove is worse
    // than dropping the reference, and re-arming attaches a fresh one
    onQuestsChanged = null;
    watchedStore = null;
    knownEnrolled.clear();
}

// No local `isRunning` mirror: a second flag can disagree with the engine, and when it did,
// /orion stop refused to stop an engine that was still up. startOrion() sets the engine flag
// synchronously before its first await, so this reads true immediately after the call below.
async function ensureStart(): Promise<string> {
    // re-arms even when the engine is already up, so a start after an explicit stop always
    // leaves the watcher in the state the setting asks for
    armWatcher();
    if (isEngineRunning()) return "Already running.";
    // fire and forget. The main loop awaits internally, teardown is handled by startOrion's finally
    startOrion();
    return "Started.";
}

function ensureStop(): string {
    const wasWatching = onQuestsChanged !== null;
    disarmWatcher();
    if (!isEngineRunning()) return wasWatching ? "Not running. Stopped watching for accepted quests." : "Not running.";
    stopOrion();
    return wasWatching ? "Stopped, and no longer watching for accepted quests." : "Stopped.";
}

function statusSummary(): string {
    const running = isEngineRunning();
    const entries = readDashboard();
    if (!running && entries.length === 0) return "Idle. Use `/orion start` to begin.";
    if (entries.length === 0) return running ? "Running. No active tasks yet." : "Idle.";

    // A bare task count answers "is it alive" and nothing else. The breakdown is what someone
    // actually wants to know at a glance, and it is already sitting in the entries.
    const tally = new Map<string, number>();
    for (const e of entries) tally.set(e.status, (tally.get(e.status) ?? 0) + 1);
    const breakdown = [...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([status, n]) => `${n} ${status.toLowerCase()}`)
        .join(", ");

    // The claimable flag is written once when the quest finishes and never revisited, so a
    // reward claimed afterwards in Discord's own Quests page would leave it stale and the
    // status would keep advertising a reward that is already collected. Ask the store, which
    // is the thing that actually knows, and fall back to the flag if the quest is not there.
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
        // The userscript parks a quest as PENDING and its dashboard draws an ENROLL button.
        // There is no dashboard here, so a bare "PENDING (0%)" would read as a stall with no
        // way to tell what unblocks it. Say what the quest is waiting for instead.
        const waiting = e.actionRequired === "ENROLL"
            ? ", waiting for you to accept it in Discord's Quests page"
            : "";
        // A bare FAILED tells you nothing about what to do next, and the reason was already
        // being computed and thrown away here. The log has it, but a status line someone reads
        // in a channel should not require going to the console to be actionable.
        const why = e.status === "FAILED" && e.reason ? `, ${e.reason}` : "";
        // The engine marks a finished quest claimable and nothing ever read the flag, so a
        // reward sitting unclaimed looked exactly like one already collected.
        const reward = stillUnclaimed(e) ? ", reward not claimed yet" : "";
        return `• ${e.name}: ${e.status} (${pct}%)${waiting}${why}${reward}`;
    });

    const header = `${running ? "Running" : "Stopped"}, ${entries.length} task(s): ${breakdown}`;
    const footer = claimable > 0
        ? [`${claimable} reward(s) waiting. Claim them on Discord's Quests page, or turn on "Try to claim reward" to have Orion attempt it (claiming often triggers a captcha).`]
        : [];
    return [header, ...lines, ...footer].join("\n");
}

export default definePlugin({
    name: "OrionQuests",
    description:
        "Auto-completes Discord Quests: game, video, stream, activity, and achievement.",
    authors: [{ name: "syntt_", id: 1419678867005767783n }],
    // UserSettingsAPI is not enabled by default, and getUserSetting() throws outright
    // for plugins that don't declare it. patcher.ts needs it to flip showCurrentGame
    // off for the hideActivity setting.
    dependencies: ["UserSettingsAPI"],
    settings,

    // Narrow companion surface for UI plugins. State comes directly from Orion's runtime,
    // and control reuses the same watcher-aware start/stop paths as the slash command.
    getEngineRunning(): boolean {
        return isEngineRunning();
    },

    subscribeEngineRunning(listener: () => void): () => void {
        return subscribeDashboard(listener);
    },

    async controlEngine(action: "start" | "stop"): Promise<string> {
        if (action === "start") return ensureStart();
        if (action === "stop") return ensureStop();
        throw new Error(`Unsupported Orion engine action: ${String(action)}`);
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
                    ],
                },
            ],
            execute: async (args, ctx) => {
                const action = args.find(a => a.name === "action")?.value;
                let response: string;
                if (action === "start") response = await ensureStart();
                else if (action === "stop") response = ensureStop();
                else response = statusSummary();
                sendBotMessage(ctx.channel.id, { content: `**Orion**\n\`\`\`\n${response}\n\`\`\`` });
            },
        },
    ],

    async start() {
        // Before anything else, undo a presence suppression a previous session left behind.
        // Runs on plugin load rather than on engine start, so a user who reloaded mid-run gets
        // their Game Activity setting back without having to run another quest.
        await repairSuppressedPresence();

        try {
            // Flipping the setting off has to reach an already-armed watcher, and flipping it
            // on should not make the user restart the plugin to get one.
            setWatchForEnrollmentsHook(enabled => {
                if (enabled) armWatcher();
                else disarmWatcher();
            });

            if (settings.store.autoStart) {
                await ensureStart();
            } else {
                armWatcher();
                console.log("[OrionQuests] Plugin loaded. Use `/orion start` to begin (or enable Auto Start in settings).");
            }
        } catch (e) {
            console.error("[OrionQuests] Failed to start:", e);
        }
    },

    stop() {
        // Drop the settings bridge first: a toggle arriving mid-teardown would otherwise
        // re-arm the watcher the next line is about to remove.
        setWatchForEnrollmentsHook(null);
        try { ensureStop(); }
        catch (e) { console.error("[OrionQuests] Failed to stop cleanly:", e); }
    },
});
