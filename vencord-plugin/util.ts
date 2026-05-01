/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 */

export const sleep = (ms: number): Promise<void> =>
    new Promise(r => setTimeout(r, ms));

export const rnd = (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min;

export function sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, " ");
}

// Discord's quest reward type → human label
export const REWARD_LABELS: Record<number, string> = {
    1: "In-Game Item",
    3: "Avatar Decoration",
    4: "Orbs",
};
