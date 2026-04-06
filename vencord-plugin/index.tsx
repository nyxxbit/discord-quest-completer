/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Part of https://github.com/nyxxbit/discord-quest-completer
 *
 * This is the Vencord port of Orion (originally a paste-into-console
 * userscript). Plugin entrypoint — registers metadata, settings, and
 * the start/stop lifecycle. Actual orchestration lives in ./orion.ts.
 */

import definePlugin from "@utils/types";

import { startOrion, stopOrion } from "./orion";
import { settings } from "./settings";

export default definePlugin({
    name: "OrionQuests",
    description:
        "Auto-complete every Discord Quest in seconds — game, video, stream, activity, and achievement quests.",
    authors: [{ name: "nyxxbit", id: 0n }],
    settings,

    async start() {
        try {
            await startOrion();
        } catch (e) {
            console.error("[OrionQuests] Failed to start:", e);
        }
    },

    stop() {
        try {
            stopOrion();
        } catch (e) {
            console.error("[OrionQuests] Failed to stop cleanly:", e);
        }
    },
});
