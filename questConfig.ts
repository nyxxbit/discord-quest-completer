/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Pure helpers for Discord's legacy taskConfig and current taskConfigV2 shapes.
 */

export function taskEntries(tasks: unknown): Array<[string, any]> {
    if (!tasks) return [];
    if (tasks instanceof Map) return Array.from(tasks.entries()) as Array<[string, any]>;
    if (typeof tasks === "object") return Object.entries(tasks as Record<string, any>);
    return [];
}

export function taskForKey(config: any, key: string): any | undefined {
    const tasks = config?.tasks;
    if (tasks instanceof Map) return tasks.get(key);
    return tasks?.[key];
}

/**
 * Discord's current taskConfigV2 is authoritative when it contains tasks. Some payloads keep
 * the legacy taskConfig beside it for compatibility, so nullish-coalescing legacy first can
 * silently route a quest through stale task/app metadata. Fall back to legacy only when V2 is
 * absent or carries no task entries.
 */
export function selectQuestTaskConfig(config: any): any | null {
    const current = config?.taskConfigV2;
    if (taskEntries(current?.tasks).length > 0) return current;

    const legacy = config?.taskConfig;
    if (taskEntries(legacy?.tasks).length > 0) return legacy;

    return current ?? legacy ?? null;
}
