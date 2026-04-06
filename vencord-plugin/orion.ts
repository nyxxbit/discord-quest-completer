/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Core orchestration. This file is the Vencord-side equivalent of
 * the main() loop and loadModules() in ../index.js. Phase 1 only:
 * resolves Discord stores via Vencord's webpack helpers and lists
 * incomplete quests. Quest execution (VIDEO/GAME/STREAM/ACTIVITY/
 * ACHIEVEMENT handlers) is intentionally not yet ported — that
 * comes in Phase 3+.
 */

import { Logger } from "@utils/Logger";
import { findStore } from "@webpack";

import { settings } from "./settings";

const logger = new Logger("OrionQuests");

// Runtime state — equivalent to RUNTIME in ../index.js
const RUNTIME = {
    running: false,
    cleanups: new Set<() => void>(),
};

// Resolved Discord internal stores
interface OrionStores {
    QuestStore: any;
    RunStore: any;
    StreamStore: any | undefined;
    ChanStore: any | undefined;
    GuildChanStore: any | undefined;
}

let stores: OrionStores | null = null;

function loadStores(): OrionStores {
    // Vencord's findStore looks up Flux stores by their displayName.
    // This replaces the manual webpackChunkdiscord_app extraction
    // and constructor.displayName scan from the userscript version.
    const QuestStore = findStore("QuestStore");
    const RunStore = findStore("RunningGameStore");
    const StreamStore = findStore("StreamerActiveStreamMetadataStore");
    const ChanStore = findStore("ChannelStore");
    const GuildChanStore = findStore("GuildChannelStore");

    if (!QuestStore) throw new Error("QuestStore not found via findStore");
    if (!RunStore) throw new Error("RunningGameStore not found via findStore");

    // StreamStore / ChanStore / GuildChanStore are optional —
    // certain quest types degrade gracefully if missing.
    if (!StreamStore) logger.warn("StreamStore not found — STREAM quests will be limited");
    if (!ChanStore) logger.warn("ChannelStore not found — ACTIVITY quests may not find a channel");
    if (!GuildChanStore) logger.warn("GuildChannelStore not found — ACTIVITY guild fallback unavailable");

    return { QuestStore, RunStore, StreamStore, ChanStore, GuildChanStore };
}

// Defensive iteration — Discord's QuestStore.quests has been a Map
// historically, but the shape can shift between updates.
function getQuestsArray(questStore: any): any[] {
    const q = questStore?.quests;
    if (!q) return [];
    if (typeof q.values === "function") return Array.from(q.values());
    if (Array.isArray(q)) return q;
    return Object.values(q);
}

function listIncompleteQuests(): any[] {
    if (!stores) return [];
    const now = Date.now();
    return getQuestsArray(stores.QuestStore).filter((q: any) => {
        const expiresAt = new Date(q?.config?.expiresAt ?? 0).getTime();
        return (
            expiresAt > now &&
            !q?.userStatus?.completedAt &&
            !q?.userStatus?.dismissedAt
        );
    });
}

export async function startOrion(): Promise<void> {
    if (RUNTIME.running) {
        logger.warn("Already running, ignoring start()");
        return;
    }
    RUNTIME.running = true;

    logger.info("Starting OrionQuests (Phase 1 scaffold)");

    if (settings.store.verboseLogging) {
        logger.info("Settings:", {
            tryToClaimReward: settings.store.tryToClaimReward,
            hideActivity: settings.store.hideActivity,
            gameConcurrency: settings.store.gameConcurrency,
            videoConcurrency: settings.store.videoConcurrency,
        });
    }

    try {
        stores = loadStores();
        logger.info("Discord stores loaded:", {
            QuestStore: !!stores.QuestStore,
            RunStore: !!stores.RunStore,
            StreamStore: !!stores.StreamStore,
            ChanStore: !!stores.ChanStore,
            GuildChanStore: !!stores.GuildChanStore,
        });

        const incomplete = listIncompleteQuests();
        logger.info(`Found ${incomplete.length} incomplete quests`);

        for (const q of incomplete) {
            const name = q?.config?.messages?.questName ?? q?.id ?? "(unknown)";
            const tasks = Object.keys(q?.config?.taskConfig?.tasks ?? {});
            logger.info(`  • ${name} — task types: ${tasks.join(", ") || "(none)"}`);
        }

        logger.info(
            "Phase 1 scaffold complete. Quest execution is not yet implemented — " +
                "use the userscript version (../index.js) for actual completion."
        );
    } catch (e) {
        RUNTIME.running = false;
        stores = null;
        throw e;
    }
}

export function stopOrion(): void {
    if (!RUNTIME.running) return;
    RUNTIME.running = false;

    let failed = 0;
    for (const cleanup of RUNTIME.cleanups) {
        try {
            cleanup();
        } catch (e) {
            failed++;
            logger.error("Cleanup function threw:", e);
        }
    }
    RUNTIME.cleanups.clear();
    stores = null;

    logger.info(
        `Stopped. ${failed > 0 ? `${failed} cleanup(s) threw — see errors above.` : "All cleanups flushed cleanly."}`
    );
}
