/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * One spoofed process per application, shared across its accepted quests (issue #96).
 *
 * Sibling quests of the same game each acquire and release a hold on their application's
 * process. Only the first hold materialises a process and only the last one released tears it
 * down, so two or three quests of one app run off a single session instead of one each. Pure
 * bookkeeping, kept out of the Patcher so it can be exercised without a Discord to patch.
 */

export class GameSessionRefs {
    private readonly counts = new Map<string, number>();

    /** Record a hold on `id`'s process. True only for the first hold: materialise it now. */
    acquire(id: string): boolean {
        const held = this.counts.get(id) ?? 0;
        this.counts.set(id, held + 1);
        return held === 0;
    }

    /** Drop a hold on `id`'s process. True only for the last hold released: tear it down now. */
    release(id: string): boolean {
        const held = this.counts.get(id) ?? 0;
        if (held === 0) return false; // never held, or already torn down
        if (held > 1) { this.counts.set(id, held - 1); return false; } // a sibling still needs it
        this.counts.delete(id);
        return true;
    }

    clear(): void {
        this.counts.clear();
    }
}
