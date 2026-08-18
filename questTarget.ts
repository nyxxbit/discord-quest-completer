/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Pure quest-target resolution for the /orion pause/resume command.
 */

export interface QuestTargetCandidate {
    id: string;
    name: string;
}

export type QuestTargetResolution =
    | { kind: "match"; candidate: QuestTargetCandidate; }
    | { kind: "ambiguous"; candidates: QuestTargetCandidate[]; }
    | { kind: "not-found"; };

/**
 * Resolve a human-entered target without ever guessing between multiple quests.
 * Exact ids/names win; otherwise a case-insensitive unique name fragment is accepted.
 */
export function resolveQuestTarget(
    rawTarget: string,
    candidates: QuestTargetCandidate[],
): QuestTargetResolution {
    const target = rawTarget.trim();
    if (!target) return { kind: "not-found" };

    const exactId = candidates.find(candidate => candidate.id === target);
    if (exactId) return { kind: "match", candidate: exactId };

    const normalized = target.toLowerCase();
    const exactNames = candidates.filter(candidate => candidate.name.toLowerCase() === normalized);
    if (exactNames.length === 1) return { kind: "match", candidate: exactNames[0] };
    if (exactNames.length > 1) return { kind: "ambiguous", candidates: exactNames };

    const partial = candidates.filter(candidate => candidate.name.toLowerCase().includes(normalized));
    if (partial.length === 1) return { kind: "match", candidate: partial[0] };
    if (partial.length > 1) return { kind: "ambiguous", candidates: partial };

    return { kind: "not-found" };
}
