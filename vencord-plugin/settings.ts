/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Plugin settings — exposed in Vencord's plugin settings UI.
 * Persisted via Vencord's DataStore.
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    autoStart: {
        type: OptionType.BOOLEAN,
        description:
            "Start the engine automatically when the plugin loads. Otherwise use the /orion start slash command.",
        default: false,
    },

    tryToClaimReward: {
        type: OptionType.BOOLEAN,
        description:
            "Try to auto-claim rewards immediately on completion. May trigger a captcha — disable if you'd rather click CLAIM in Discord's Quests page manually.",
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
