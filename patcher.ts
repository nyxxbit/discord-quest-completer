/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Monkey-patches Discord's RunningGameStore so the client believes a
 * game process is running. Mirrors the Patcher module in ./index.js.
 *
 * The fake game appears in `getRunningGames()` and the RPC dispatch
 * makes it show as "Playing X" in the friends list (unless suppressed
 * via the hideActivity setting).
 *
 * hideActivity note: skipping our own LOCAL_ACTIVITY_UPDATE dispatch is
 * NOT enough to hide the status. Discord derives the "Playing X" presence
 * from the store itself: LocalActivityStore/ActivityTrackingStore read
 * getVisibleRunningGames()/getVisibleGame(), which we patch below for
 * quest eligibility (issue #43). So the only way to stay invisible while
 * keeping the spoof is to turn off Discord's own status.showCurrentGame
 * for the duration and restore it on cleanup.
 */

import * as DataStore from "@api/DataStore";
import { getUserSettingLazy } from "@api/UserSettings";
import { Logger } from "@utils/Logger";

import { COMPANION_EVENT_CODES, emitCompanionEvent } from "./companionEvents";
import { GameSessionRefs } from "./gameSession";
import type { FakeGame, Stores } from "./types";
import { debug } from "./util";

const logger = new Logger("OrionQuests");

const GAME_DISPATCH = "RUNNING_GAMES_CHANGE";
const RPC_DISPATCH = "LOCAL_ACTIVITY_UPDATE";

// Same user setting Vencord's GameActivityToggle drives. Resolved lazily on first
// property access, which throws unless the plugin declares the UserSettingsAPI
// dependency (see index.tsx) and the setting still exists on this build.
// `!` like Vencord's own GameActivityToggle: the proxy is always truthy, so a null check
// buys nothing: a missing setting shows up as a throw on first access instead.
const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

// Breadcrumb written before showCurrentGame is turned off and deleted once it is put back.
// If it is still there when the plugin loads, the previous session ended without cleanup.
const SUPPRESSION_KEY = "OrionQuests_suppressedPresence";

/**
 * Put showCurrentGame back if a previous session died with it off.
 *
 * Cleanup is not guaranteed to run: `stop()` is skipped on a page reload, and a reload is
 * the first thing most people try when something looks stuck. Without this, the account
 * setting stays off with no engine running and nothing left holding the old value, which
 * is a change to the user's Discord that Orion made and never undid.
 *
 * Called from the plugin's start(), not from startOrion(), so it repairs on plugin load
 * rather than requiring the user to run another quest first.
 */
export async function repairSuppressedPresence(): Promise<void> {
    try {
        if (!await DataStore.get(SUPPRESSION_KEY)) return;
        await ShowCurrentGame.updateSetting(true);
        await DataStore.del(SUPPRESSION_KEY);
        logger.info("[Patcher] Previous session ended without restoring your Game Activity setting. Turned it back on.");
        emitCompanionEvent({
            code: COMPANION_EVENT_CODES.PATCHER_PRESENCE_RESTORED,
            category: "patcher",
            level: "info",
            message: "Orion restored Discord's Game Activity setting after an unclean previous session.",
        });
    } catch (e: any) {
        const reason = String(e?.message ?? e ?? "unknown error");
        logger.warn(`[Patcher] Could not restore showCurrentGame from a previous session: ${reason}`);
        emitCompanionEvent({
            code: COMPANION_EVENT_CODES.PATCHER_PRESENCE_RESTORE_FAILED,
            category: "patcher",
            level: "warning",
            message: "Orion could not restore Discord's Game Activity setting from the previous session.",
            reason,
        });
    }
}

// Overriding getRunningGames alone is no longer enough. Canary derives quest eligibility
// from the "visible"/"candidate" views, and a game absent from those never gets a heartbeat
// scheduled, so the quest sits at 0% forever (issue #43). Older builds don't expose all of
// these, so each is patched only if present.
const PATCHED_METHODS = [
    "getRunningGames", "getGameForPID", "getVisibleGame",
    "getVisibleRunningGames", "getRunningDiscordApplicationIds", "getCandidateGames",
] as const;

export class Patcher {
    private games: FakeGame[] = [];
    // One process per application. Sibling quests of the same game (issue #96) each add and
    // remove their own FakeGame, but only the first add materialises a process and only the
    // last remove tears it down. Keyed by application id because the siblings pass distinct pids.
    private readonly refs = new GameSessionRefs();
    private real: Record<string, any> = {};
    private active = false;
    /** Read live, since the user can flip the setting while the engine is running. */
    private hideActivity: () => boolean;
    /** Value of status.showCurrentGame before we forced it off; null = not suppressed. */
    private savedShowCurrentGame: boolean | null = null;
    private stores: Stores;

    constructor(stores: Stores, hideActivity: () => boolean) {
        this.stores = stores;
        this.hideActivity = hideActivity;
        // stash originals so we can restore them on cleanup
        for (const name of PATCHED_METHODS) {
            if (typeof stores.RunStore[name] === "function") this.real[name] = stores.RunStore[name];
        }
        const absent = PATCHED_METHODS.filter(n => !this.real[n]);
        if (absent.length) debug(logger, `[Patcher] Store lacks ${absent.join(", ")}, not patching those.`);
    }

    private toggle(on: boolean): void {
        const S = this.stores.RunStore;
        const real = this.real;

        if (on && !this.active) {
            S.getRunningGames = () => [...real.getRunningGames.call(S), ...this.games];
            S.getGameForPID = (pid: number) =>
                this.games.find(g => g.pid === pid) || real.getGameForPID.call(S, pid);

            // our game wins as "the" visible one, which is the whole point of the spoof
            if (real.getVisibleGame) S.getVisibleGame = () => this.games[0] ?? real.getVisibleGame.call(S);
            if (real.getVisibleRunningGames) S.getVisibleRunningGames = () => [...real.getVisibleRunningGames.call(S), ...this.games];
            if (real.getCandidateGames) S.getCandidateGames = () => [...real.getCandidateGames.call(S), ...this.games];
            if (real.getRunningDiscordApplicationIds) {
                S.getRunningDiscordApplicationIds = () => {
                    const ids = real.getRunningDiscordApplicationIds.call(S);
                    const ours = this.games.map(g => String(g.id));
                    // shape varies by build, so preserve whichever collection came back
                    return ids instanceof Set ? new Set([...ids, ...ours]) : [...(ids ?? []), ...ours];
                };
            }
            this.active = true;
        } else if (!on && this.active) {
            for (const [name, fn] of Object.entries(real)) S[name] = fn;
            this.active = false;
        }
    }

    /**
     * Force status.showCurrentGame off while a fake game is up and hideActivity is on,
     * restore it once the last one goes away. Called on every add/remove, and directly by
     * the engine when the setting itself changes. Waiting for the next add/remove meant a
     * toggle during a game quest did nothing for up to 25 minutes, which reads as broken.
     * Idempotent: the savedShowCurrentGame guard makes a repeat call a no-op.
     */
    syncPresenceSuppression(): void {
        const shouldSuppress = this.hideActivity() && this.games.length > 0;

        // ShowCurrentGame is a lazy proxy, so it's always truthy. The throw only
        // surfaces on first property access (missing setting, or the UserSettingsAPI
        // dependency not enabled). Hence try/catch rather than a null check.
        if (shouldSuppress && this.savedShowCurrentGame === null) {
            try {
                this.savedShowCurrentGame = ShowCurrentGame.getSetting();
                if (this.savedShowCurrentGame) {
                    // Record the intent before acting on it. Cleanup only runs if the renderer
                    // lives long enough, and a plain page reload skips it entirely, which used
                    // to leave the account setting off with nothing left to restore it. With
                    // the breadcrumb on disk, repairSuppressedPresence() puts it back the next
                    // time the plugin loads. Verified: reload mid-run left it off before this.
                    DataStore.set(SUPPRESSION_KEY, true)
                        .catch((e: any) => debug(logger, `[Patcher] Could not record the suppression breadcrumb: ${e?.message}`));
                    ShowCurrentGame.updateSetting(false)
                        .catch((e: any) => logger.warn(`[Patcher] Could not turn showCurrentGame off, activity stays visible: ${e?.message}`));
                }
            } catch (e: any) {
                this.savedShowCurrentGame = null;
                logger.warn(`[Patcher] status.showCurrentGame unavailable, cannot hide activity: ${e?.message}`);
            }
        } else if (!shouldSuppress && this.savedShowCurrentGame !== null) {
            const restore = this.savedShowCurrentGame;
            this.savedShowCurrentGame = null;
            if (restore) {
                try {
                    ShowCurrentGame.updateSetting(true)
                        .then(() => DataStore.del(SUPPRESSION_KEY))
                        .catch((e: any) => logger.error("[Patcher] Failed to restore showCurrentGame. Re-enable 'Display current activity as a status message' in Discord settings:", e));
                } catch (e: any) {
                    logger.error("[Patcher] Failed to restore showCurrentGame. Re-enable 'Display current activity as a status message' in Discord settings:", e);
                }
            } else {
                DataStore.del(SUPPRESSION_KEY).catch(() => { });
            }
        }
    }

    add(g: FakeGame): void {
        if (!this.refs.acquire(String(g.id))) return; // a sibling already spoofed this app

        this.games.push(g);
        this.toggle(true);
        this.syncPresenceSuppression();
        this.dispatch([g], []);
        this.rpc(g);
    }

    remove(g: FakeGame): void {
        if (!this.refs.release(String(g.id))) return; // a sibling still needs it, or never held

        // Siblings passed distinct pids, so drop the one process this app did materialise, by id.
        const idx = this.games.findIndex(x => String(x.id) === String(g.id));
        if (idx === -1) return;
        const [materialised] = this.games.splice(idx, 1);

        this.dispatch([], [materialised]);
        this.syncPresenceSuppression();
        if (!this.games.length) {
            this.toggle(false);
            this.rpc(null);
        } else {
            this.rpc(this.games[0]);
        }
    }

    private dispatch(added: FakeGame[], removed: FakeGame[]): void {
        try {
            this.stores.Dispatcher?.dispatch({
                type: GAME_DISPATCH,
                added,
                removed,
                games: this.stores.RunStore.getRunningGames(),
            });
        } catch (e: any) {
            debug(logger, `[Patcher] dispatch failed: ${e?.message}`);
        }
    }

    private rpc(g: FakeGame | null): void {
        if (this.hideActivity() && g) return;
        try {
            this.stores.Dispatcher?.dispatch({
                type: RPC_DISPATCH,
                socketId: null,
                pid: g ? g.pid : 9999,
                activity: g
                    ? {
                          application_id: g.id,
                          name: g.name,
                          type: 0,
                          details: null,
                          state: null,
                          timestamps: { start: g.start },
                          icon: g.icon,
                          assets: null,
                      }
                    : null,
            });
        } catch (e: any) {
            debug(logger, `[Patcher] rpc dispatch failed: ${e?.message}`);
        }
    }

    clean(): void {
        this.games = [];
        this.refs.clear();
        this.toggle(false);
        // games emptied first, so this always restores showCurrentGame
        this.syncPresenceSuppression();
        this.rpc(null);
    }
}
