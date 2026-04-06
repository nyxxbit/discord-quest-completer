/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Plugin settings — exposed in Vencord's plugin settings UI.
 * These map 1:1 to the CONFIG object in the userscript version
 * (../index.js), but are persisted via Vencord's DataStore instead
 * of being hardcoded.
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    tryToClaimReward: {
        type: OptionType.BOOLEAN,
        description:
            "Try to auto-claim rewards immediately on completion. May trigger a captcha — disable if you'd rather click CLAIM in the dashboard manually.",
        default: false,
    },

    hideActivity: {
        type: OptionType.BOOLEAN,
        description:
            "Suppress 'Playing ...' status from your friends list while game quests are running.",
        default: false,
    },

    gameConcurrency: {
        type: OptionType.SLIDER,
        description:
            "Parallel game quests. Values above 1 risk detection — keep at 1 unless you know what you're doing.",
        markers: [1, 2, 3],
        stickToMarkers: true,
        default: 1,
    },

    videoConcurrency: {
        type: OptionType.SLIDER,
        description:
            "Parallel video quests. Higher values finish faster but make more API calls.",
        markers: [1, 2, 3, 4],
        stickToMarkers: true,
        default: 2,
    },

    verboseLogging: {
        type: OptionType.BOOLEAN,
        description:
            "Show debug-level logs in the browser console (useful for troubleshooting Discord changes).",
        default: false,
    },
});
