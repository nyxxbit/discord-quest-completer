/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Pure helpers for Discord's legacy taskConfig and current taskConfigV2 shapes.
 */

import type { DetectedTask, QuestOutcome, RunSummary, TaskType } from "./types";

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

/** Console task keys. Discord groups these as CONSOLE and no desktop client can drive them. */
export const CONSOLE_ONLY_KEYS = new Set(["PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"]);

export interface TaskKeyRule {
    match: (key: string) => boolean;
    /** Exact keys that win outright, whatever order the server listed them in. */
    prefer?: string[];
}

/**
 * Pick which task key of a quest this client should drive.
 *
 * Most quests offer several: 38 of the 66 on a live account carry two or three, always a desktop
 * key beside console or mobile variants. Matching by prefix and taking whichever the server
 * happened to list first works only for as long as the server keeps listing the desktop one
 * first. If that order ever changes, Orion picks PLAY_ON_XBOX, injects a desktop process for it,
 * reads progress under a key Discord never credits, and looks healthy until it times out
 * 25 minutes later. So prefer the exact key and never match a console one.
 */
export function selectTaskKey(keys: string[], rule: TaskKeyRule): string | undefined {
    if (rule.prefer) {
        const exact = keys.find(key => rule.prefer!.includes(key));
        if (exact) return exact;
    }
    return keys.find(key => rule.match(key) && !CONSOLE_ONLY_KEYS.has(key));
}

/** True when a quest offers nothing but console tasks, so this client cannot run it at all. */
export function isConsoleOnly(keys: string[]): boolean {
    return keys.length > 0 && keys.every(key => CONSOLE_ONLY_KEYS.has(key));
}

/**
 * Task keys Discord validates somewhere this tool cannot reach, mapped to why.
 *
 * ACHIEVEMENT_IN_GAME arrived on the Battlefield 6 Multiplayer quest and is not
 * ACHIEVEMENT_IN_ACTIVITY: there is no embedded activity behind it and no discordsays backend to
 * report progress to, so the bypass in tasks.ts has nothing to authorize against. The quest asks
 * for an achievement inside the retail game, with the game linked to the account, which is a real
 * play session by design.
 *
 * Naming the key here rather than letting it fall through to "unsupported task type" is the
 * difference between a user reporting a bug and a user reading why the quest was left alone.
 */
export const UNAUTOMATABLE_KEYS = new Map<string, string>([
    ["ACHIEVEMENT_IN_GAME", "That needs the game linked to your account and an achievement earned inside the game itself, which nothing running in Discord can do for you."],
]);

export interface TaskFamilyRule extends TaskKeyRule {
    type: TaskType;
}

/**
 * Which family of task to drive when a quest offers more than one, in priority order.
 *
 * STREAM comes after GAME and VIDEO because STREAM cannot finish. Discord's
 * getActivelyProgressingStreamOnDesktopQuests requires a real Go Live and a second person in the
 * voice channel before it reads the stream metadata the engine fakes, so a STREAM task only ever
 * reaches its no-heartbeat watchdog. Read off Stable 1.0.9255 and Canary 1.0.1148; the working
 * through is in docs/ARCHITECTURE.md and issue #75. Ordering it above GAME sent a quest offering
 * both to the one path that cannot complete.
 *
 * The two exact rules stay in front: ACHIEVEMENT_IN_ACTIVITY and PLAY_ACTIVITY would otherwise be
 * swallowed by the PLAY prefix and run as a game.
 */
export const TASK_FAMILY_ORDER: TaskFamilyRule[] = [
    { match: key => key === "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
    { match: key => key === "PLAY_ACTIVITY", type: "ACTIVITY" },
    { match: key => key.includes("VIDEO"), type: "WATCH_VIDEO", prefer: ["WATCH_VIDEO"] },
    { match: key => key.startsWith("PLAY"), type: "GAME", prefer: ["PLAY_ON_DESKTOP"] },
    { match: key => key.startsWith("STREAM"), type: "STREAM", prefer: ["STREAM_ON_DESKTOP"] },
    { match: key => key.includes("ACTIVITY"), type: "ACTIVITY" },
];

/** The family and key this client should drive for a quest, or undefined if it can drive none. */
export function selectTaskFamily(keys: string[]): { type: TaskType; keyName: string; } | undefined {
    for (const rule of TASK_FAMILY_ORDER) {
        const keyName = selectTaskKey(keys, rule);
        if (keyName) return { type: rule.type, keyName };
    }
    return undefined;
}

export interface QuestRunnability {
    /** Quest name as Discord worded it, used only for the log line. */
    name: string;
    /** True when selectQuestTaskConfig returned a config with a tasks object. */
    hasTaskConfig: boolean;
    /** Task keys the quest offers, in whatever order the server listed them. */
    keys: string[];
    /** What detectType made of the quest, or null when it made nothing of it. */
    detected: DetectedTask | null;
    /** IS_DESKTOP. The web client cannot spoof a game process or a stream. */
    isDesktop: boolean;
}

/**
 * Why this client cannot drive a quest, as the sentence to log, or null when it can drive it.
 *
 * The engine used to answer this inline with five separate guards, four of which logged and
 * continued without marking the quest skipped. activeQuests only filters on the skipped set, so
 * those four handed the same quest back on the next cycle and the run looped on it until the
 * user paused. Issue #78 is that loop: a Battlefield 6 quest that needs the game linked and
 * actually played, rescanned once a cycle forever. Answering here keeps the decision and the
 * marking in one place, so a new reason cannot be added without the caller skipping the quest.
 *
 * Every reason is permanent for the life of a run, which is what makes skipping safe: the task
 * config, the desktop-ness of the client and the target do not change while the engine runs, and
 * a fresh start re-evaluates all of them.
 */
export function questBlocker(q: QuestRunnability): string | null {
    if (!q.hasTaskConfig) return `"${q.name}" has no usable task config, so there is nothing to drive.`;

    if (!q.detected) {
        if (!q.keys.length) return `"${q.name}" lists no tasks at all, so there is nothing to drive.`;
        if (isConsoleOnly(q.keys)) return `"${q.name}" is console-only (${q.keys.join(", ")}), so no desktop client can run it.`;

        // The reason belongs to one key, so a quest carrying several says which one it explains
        // rather than attaching the sentence to the whole list.
        const named = q.keys.find(key => UNAUTOMATABLE_KEYS.has(key));
        if (named) {
            return q.keys.length === 1
                ? `"${q.name}" offers only ${named}. ${UNAUTOMATABLE_KEYS.get(named)}`
                : `"${q.name}" offers ${q.keys.join(", ")}, and none of them run here. The one we know about is ${named}. ${UNAUTOMATABLE_KEYS.get(named)}`;
        }

        return `"${q.name}" uses an unsupported task type (${q.keys.join(", ")}).`;
    }

    const { type, target, appId } = q.detected;

    if (!q.isDesktop && (type === "GAME" || type === "STREAM")) {
        return `"${q.name}" needs the desktop app for its ${type} task.`;
    }
    if (target <= 0) return `"${q.name}" has an invalid target (${target}).`;
    if ((type === "GAME" || type === "STREAM") && !appId) {
        return `"${q.name}" has no application id in its config, so the game cannot be spoofed.`;
    }

    return null;
}

/**
 * Record what happened to a quest, at the point the run decides it.
 *
 * Completed wins over an earlier blocked or failed: a quest this client could not drive and the
 * user then finished by hand is finished, and must not be counted in both columns.
 */
export function recordOutcome(outcomes: Map<string, QuestOutcome>, id: string, outcome: QuestOutcome): void {
    if (outcomes.get(id) === "completed") return;
    outcomes.set(id, outcome);
}

/**
 * The wrap-up for a run with nothing left to do.
 *
 * failTask puts a quest in the skipped set as surely as questBlocker does, so a run whose only
 * quest died in a handler emptied the active list with nothing marked unrunnable and announced
 * that every quest was completed, with the done sound. Counting outcomes instead of quests that
 * gained completedAt fixes both that and the quest counted as finished and skipped at once.
 */
export function summarizeRun(outcomes: Map<string, QuestOutcome>): RunSummary {
    let finished = 0, blocked = 0, filtered = 0, failed = 0;
    for (const outcome of outcomes.values()) {
        if (outcome === "completed") finished++;
        else if (outcome === "blocked") blocked++;
        else if (outcome === "filtered") filtered++;
        else failed++;
    }

    // A filtered quest has to keep this run off the "all completed" line. A run where Orb-only
    // left out every quest there was did nothing, and announcing that as everything completed,
    // with the done sound, is the same false success failTask used to produce.
    if (!blocked && !filtered && !failed) {
        return { finished, blocked, filtered, failed, line: "All available quests are completed!", playDone: true };
    }

    const parts: string[] = [];
    if (finished) parts.push(`${finished} quest(s) finished`);
    if (blocked) parts.push(`${blocked} skipped because this client cannot drive them`);
    if (filtered) parts.push(`${filtered} left out because they pay no Orbs`);
    if (failed) parts.push(`${failed} failed`);
    return { finished, blocked, filtered, failed, line: `Nothing left to run. ${parts.join(", ")}.`, playDone: finished > 0 };
}

/**
 * Message lines for quests that share one game.
 *
 * Several quests can be the same game (same application id, usually one quest offered per
 * region). They all progress at once: Discord credits play time to every enrolled quest of that
 * game while it runs once, so they finish together even though the scheduler only ever drives
 * one at a time. Issue #95 read that as the concurrency limit being bypassed, so the run says
 * plainly that it is not. Only GAME quests share this way, since the shared signal is play time;
 * WATCH_VIDEO, STREAM, ACTIVITY and ACHIEVEMENT each progress per quest.
 */
export function summarizeSharedGameQuests(
    tasks: ReadonlyArray<{ appId: string | number; name: string; type: string; }>,
): string[] {
    const groups = new Map<string, { name: string; count: number; }>();
    for (const t of tasks) {
        if (t.type !== "GAME") continue;
        const key = String(t.appId ?? "");
        if (!key || key === "0") continue;
        const g = groups.get(key);
        if (g) g.count++;
        else groups.set(key, { name: t.name, count: 1 });
    }

    const lines: string[] = [];
    for (const { name, count } of groups.values()) {
        if (count < 2) continue;
        lines.push(`${count} "${name}" quests are the same game, so Discord credits all ${count} while it runs once and they finish together. The limit still drives one at a time.`);
    }
    return lines;
}

/**
 * Choose which win32 executable to claim for a spoofed game, and where to say it lives.
 *
 * Discord's `executables[]` entries are not always a bare file name, which is what the old
 * code assumed. Live data on 2026-09-21: Dragonheir's first win32 entry is
 * "dragonheir silent gods/dragonheir.exe" and Marvel Rivals' is "win64/marvel-win64-test.exe".
 * Taking entry zero and pasting it after "C:\Program Files\<Game>\" doubled the game folder,
 * mixed the separators, and left a slash inside the string reported as the executable name,
 * which no real process report contains. It also claimed an internal test build for a game
 * that ships a different binary.
 *
 * `relPath` is relative to Program Files and always uses forward slashes; the caller decides
 * the separator and the case.
 */
export function pickExecutable(executables: unknown, cleanName: string): { exeName: string; relPath: string; } {
    const loose = (v: string): string => v.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const fallbackExe = `${cleanName.replace(/\s+/g, "")}.exe`;

    const win32 = (Array.isArray(executables) ? executables : [])
        .filter((x: any) => x?.os === "win32" && typeof x.name === "string" && x.name.length > 0)
        .map((x: any) => x.name.replace(">", "").replace(/\\/g, "/"));
    if (win32.length === 0) return { exeName: fallbackExe, relPath: `${cleanName}/${fallbackExe}` };

    // Discord does not return this array in a stable order. Marvel Rivals came back as
    // [test, shipping, marvel, launcher] and then as [test, launcher, marvel, shipping] minutes
    // apart on 2026-09-21, so "take the first win32 entry" reported a different executable for
    // the same game from one run to the next. Rank them instead, and break ties by name, so the
    // same app always produces the same answer.
    const rank = (n: string): string => [
        /(^|[-_./ ])test([-_. ]|\.exe$)/i.test(n) ? "1" : "0",   // an internal build
        /launcher/i.test(n) ? "1" : "0",                          // the launcher, not the game
        n.includes("/") ? "1" : "0",                              // needs a directory guessed
        n,
    ].join("");
    const chosen = win32.slice().sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0))[0];
    const parts = chosen.split("/").filter(Boolean);
    const exeName = parts[parts.length - 1];
    const dirs = parts.slice(0, -1);

    // Discord sometimes spells the game folder into the entry itself. Prepending our own copy
    // on top of that is what produced ".../dragonheir silent gods/dragonheir silent gods/...".
    const alreadyRooted = dirs.length > 0 && loose(dirs[0]) === loose(cleanName);
    return { exeName, relPath: (alreadyRooted ? parts : [cleanName, ...parts]).join("/") };
}
