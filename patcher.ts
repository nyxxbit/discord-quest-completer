/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Monkey-patches Discord's RunningGameStore so the client believes a
 * game process is running. Mirrors the Patcher module in ./index.js.
 *
 * The fake game appears in `getRunningGames()` and the RPC dispatch
 * makes it show as "Playing X" in the friends list (unless suppressed
 * via the hideActivity setting).
 */

import { Logger } from "@utils/Logger";

import type { FakeGame, Stores } from "./types";

const logger = new Logger("OrionQuests");

const GAME_DISPATCH = "RUNNING_GAMES_CHANGE";
const RPC_DISPATCH = "LOCAL_ACTIVITY_UPDATE";

// Overriding getRunningGames alone is no longer enough. Canary derives quest eligibility
// from the "visible"/"candidate" views, and a game absent from those never gets a heartbeat
// scheduled — the quest sits at 0% forever (issue #43). Older builds don't expose all of
// these, so each is patched only if present.
const PATCHED_METHODS = [
    "getRunningGames", "getGameForPID", "getVisibleGame",
    "getVisibleRunningGames", "getRunningDiscordApplicationIds", "getCandidateGames",
] as const;

export class Patcher {
    private games: FakeGame[] = [];
    private real: Record<string, any> = {};
    private active = false;
    private hideActivity = false;
    private stores: Stores;

    constructor(stores: Stores, hideActivity: boolean) {
        this.stores = stores;
        this.hideActivity = hideActivity;
        // stash originals so we can restore them on cleanup
        for (const name of PATCHED_METHODS) {
            if (typeof stores.RunStore[name] === "function") this.real[name] = stores.RunStore[name];
        }
        const absent = PATCHED_METHODS.filter(n => !this.real[n]);
        if (absent.length) logger.debug(`[Patcher] Store lacks ${absent.join(", ")} — not patching those.`);
    }

    private toggle(on: boolean): void {
        const S = this.stores.RunStore;
        const real = this.real;

        if (on && !this.active) {
            S.getRunningGames = () => [...real.getRunningGames.call(S), ...this.games];
            S.getGameForPID = (pid: number) =>
                this.games.find(g => g.pid === pid) || real.getGameForPID.call(S, pid);

            // our game wins as "the" visible one — that's the whole point of the spoof
            if (real.getVisibleGame) S.getVisibleGame = () => this.games[0] ?? real.getVisibleGame.call(S);
            if (real.getVisibleRunningGames) S.getVisibleRunningGames = () => [...real.getVisibleRunningGames.call(S), ...this.games];
            if (real.getCandidateGames) S.getCandidateGames = () => [...real.getCandidateGames.call(S), ...this.games];
            if (real.getRunningDiscordApplicationIds) {
                S.getRunningDiscordApplicationIds = () => {
                    const ids = real.getRunningDiscordApplicationIds.call(S);
                    const ours = this.games.map(g => String(g.id));
                    // shape varies by build — preserve whichever collection came back
                    return ids instanceof Set ? new Set([...ids, ...ours]) : [...(ids ?? []), ...ours];
                };
            }
            this.active = true;
        } else if (!on && this.active) {
            for (const [name, fn] of Object.entries(real)) S[name] = fn;
            this.active = false;
        }
    }

    add(g: FakeGame): void {
        if (this.games.some(x => x.pid === g.pid)) return;
        this.games.push(g);
        this.toggle(true);
        this.dispatch([g], []);
        this.rpc(g);
    }

    remove(g: FakeGame): void {
        const before = this.games.length;
        this.games = this.games.filter(x => x.pid !== g.pid);
        if (this.games.length === before) return;

        this.dispatch([], [g]);
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
            logger.debug(`[Patcher] dispatch failed: ${e?.message}`);
        }
    }

    private rpc(g: FakeGame | null): void {
        if (this.hideActivity && g) return;
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
            logger.debug(`[Patcher] rpc dispatch failed: ${e?.message}`);
        }
    }

    clean(): void {
        this.games = [];
        this.toggle(false);
        this.rpc(null);
    }
}
