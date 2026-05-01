/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Monkey-patches Discord's RunningGameStore so the client believes a
 * game process is running. Mirrors the Patcher module in ../index.js.
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

export class Patcher {
    private games: FakeGame[] = [];
    private realGames: any = null;
    private realPID: any = null;
    private active = false;
    private hideActivity = false;
    private stores: Stores;

    constructor(stores: Stores, hideActivity: boolean) {
        this.stores = stores;
        this.hideActivity = hideActivity;
        // stash originals so we can restore them on cleanup
        this.realGames = stores.RunStore.getRunningGames;
        this.realPID = stores.RunStore.getGameForPID;
    }

    private toggle(on: boolean): void {
        if (on && !this.active) {
            const { RunStore } = this.stores;
            RunStore.getRunningGames = () => [...this.realGames.call(RunStore), ...this.games];
            RunStore.getGameForPID = (pid: number) =>
                this.games.find(g => g.pid === pid) || this.realPID.call(RunStore, pid);
            this.active = true;
        } else if (!on && this.active) {
            this.stores.RunStore.getRunningGames = this.realGames;
            this.stores.RunStore.getGameForPID = this.realPID;
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
