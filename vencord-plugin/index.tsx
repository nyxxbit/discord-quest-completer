/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Plugin entry. Registers metadata, the start/stop lifecycle, and
 * the /orion slash command (start | stop | status).
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import definePlugin from "@utils/types";

import { readDashboard, startOrion, stopOrion } from "./orion";
import { settings } from "./settings";

let isRunning = false;

async function ensureStart(): Promise<string> {
    if (isRunning) return "Already running.";
    isRunning = true;
    // fire and forget — main loop awaits internally; lifecycle handled by stopOrion()
    startOrion().finally(() => { isRunning = false; });
    return "Started.";
}

function ensureStop(): string {
    if (!isRunning) return "Not running.";
    stopOrion();
    isRunning = false;
    return "Stopped.";
}

function statusSummary(): string {
    const entries = readDashboard();
    if (!isRunning && entries.length === 0) return "Idle. Use `/orion start` to begin.";
    if (entries.length === 0) return isRunning ? "Running. No active tasks yet." : "Idle.";
    const lines = entries.map(e => {
        const pct = e.max > 0 ? Math.min(100, (e.cur / e.max) * 100).toFixed(0) : "?";
        return `• ${e.name} — ${e.status} (${pct}%)`;
    });
    return [`${isRunning ? "Running" : "Stopped"}, ${entries.length} task(s):`, ...lines].join("\n");
}

export default definePlugin({
    name: "OrionQuests",
    description:
        "Auto-complete every Discord Quest in seconds — game, video, stream, activity, and achievement quests.",
    authors: [{ name: "nyxxbit", id: 0n }],
    settings,

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
        try {
            if (settings.store.autoStart) {
                await ensureStart();
            } else {
                console.log("[OrionQuests] Plugin loaded. Use `/orion start` to begin (or enable Auto Start in settings).");
            }
        } catch (e) {
            console.error("[OrionQuests] Failed to start:", e);
        }
    },

    stop() {
        try { ensureStop(); }
        catch (e) { console.error("[OrionQuests] Failed to stop cleanly:", e); }
    },
});
