/*
 * OrionQuests task-config compatibility regression tests.
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/questConfig.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { questBlocker, recordOutcome, selectQuestTaskConfig, summarizeRun, summarizeSharedGameQuests, taskEntries, taskForKey, UNAUTOMATABLE_KEYS } from "../questConfig";
import type { DetectedTask, QuestOutcome } from "../types";

test("taskConfigV2 wins when Discord keeps both current and legacy configs", () => {
    const legacy = { tasks: { PLAY_ON_DESKTOP: { target: 10 } } };
    const current = { tasks: { WATCH_VIDEO: { target: 20 } } };

    assert.equal(selectQuestTaskConfig({ taskConfig: legacy, taskConfigV2: current }), current);
});

test("legacy taskConfig remains a fallback when V2 has no tasks", () => {
    const legacy = { tasks: { PLAY_ON_DESKTOP: { target: 10 } } };

    assert.equal(selectQuestTaskConfig({ taskConfig: legacy, taskConfigV2: { tasks: {} } }), legacy);
});

test("task helpers preserve Map-shaped Discord store data", () => {
    const tasks = new Map<string, any>([
        ["PLAY_ACTIVITY", { target: 30, applications: [{ id: "123" }] }],
    ]);
    const config = { tasks };

    assert.deepEqual(taskEntries(tasks), [["PLAY_ACTIVITY", tasks.get("PLAY_ACTIVITY")]]);
    assert.equal(taskForKey(config, "PLAY_ACTIVITY"), tasks.get("PLAY_ACTIVITY"));
});

const RUNNABLE: DetectedTask = { type: "GAME", keyName: "PLAY_ON_DESKTOP", target: 60, appId: "1" };

function blocker(over: Partial<Parameters<typeof questBlocker>[0]> = {}) {
    return questBlocker({
        name: "Battlefield 6 Multiplayer",
        hasTaskConfig: true,
        keys: ["PLAY_ON_DESKTOP"],
        detected: RUNNABLE,
        isDesktop: true,
        ...over,
    });
}

test("a runnable quest is not blocked", () => {
    assert.equal(blocker(), null);
});

test("an undetectable task type is reported as unsupported and names the keys", () => {
    // Issue #78: the log said "Unknown task type" and the engine then handed the quest back on
    // every cycle. The wording has to say what the quest offered, or the report cannot be acted on.
    const message = blocker({ keys: ["COMPLETE_BATTLEFIELD_6_MULTIPLAYER"], detected: null });

    assert.ok(message, "an undetectable quest must be blocked, not retried");
    assert.match(message, /unsupported task type/);
    assert.match(message, /COMPLETE_BATTLEFIELD_6_MULTIPLAYER/);
    assert.doesNotMatch(message, /[Uu]nknown/);
});

test("a console-only quest says so instead of calling the type unsupported", () => {
    const message = blocker({ keys: ["PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"], detected: null });

    assert.match(String(message), /console-only/);
});

test("a quest with no tasks at all is blocked", () => {
    assert.match(String(blocker({ keys: [], detected: null })), /no tasks at all/);
    assert.match(String(blocker({ hasTaskConfig: false, keys: [], detected: null })), /no usable task config/);
});

test("the web client is blocked from game and stream quests, but not from video ones", () => {
    assert.match(String(blocker({ isDesktop: false })), /needs the desktop app/);
    assert.match(String(blocker({ isDesktop: false, detected: { ...RUNNABLE, type: "STREAM" } })), /needs the desktop app/);
    assert.equal(blocker({ isDesktop: false, detected: { ...RUNNABLE, type: "WATCH_VIDEO" } }), null);
});

test("a quest that cannot be driven is blocked on target and on a missing application id", () => {
    assert.match(String(blocker({ detected: { ...RUNNABLE, target: 0 } })), /invalid target \(0\)/);
    assert.match(String(blocker({ detected: { ...RUNNABLE, appId: null } })), /no application id/);
    // A video quest needs no application id, so it must survive that check.
    assert.equal(blocker({ detected: { ...RUNNABLE, type: "WATCH_VIDEO", appId: null } }), null);
});

test("a key Discord validates outside the client is named, not called unsupported", () => {
    // ACHIEVEMENT_IN_GAME, read off a live account on the Battlefield 6 Multiplayer quest of
    // issue #78. It matches no family rule, so detectType returns null and the quest used to be
    // logged as an unknown task type once a cycle forever.
    const message = String(blocker({ keys: ["ACHIEVEMENT_IN_GAME"], detected: null }));

    assert.match(message, /offers only ACHIEVEMENT_IN_GAME/);
    assert.match(message, /linked to your account/);
    assert.doesNotMatch(message, /unsupported task type/);
});

test("a known key beside an unknown one says which of them the reason is about", () => {
    const message = String(blocker({ keys: ["ACHIEVEMENT_IN_GAME", "SOMETHING_NEW"], detected: null }));

    assert.match(message, /SOMETHING_NEW/);
    assert.match(message, /The one we know about is ACHIEVEMENT_IN_GAME/);
    // "offers only" beside two keys would be wrong, and the reason covers one of them.
    assert.doesNotMatch(message, /offers only/);
});

test("a key nobody has documented still falls back to the unsupported wording", () => {
    assert.match(String(blocker({ keys: ["SOMETHING_NEW"], detected: null })), /unsupported task type \(SOMETHING_NEW\)/);
});

test("the unautomatable set explains every key it holds", () => {
    for (const [key, why] of UNAUTOMATABLE_KEYS) {
        assert.ok(key.length > 0);
        assert.ok(why.length > 20, `${key} needs a reason a user can read`);
    }
});

const outcomesOf = (...entries: Array<[string, QuestOutcome]>) => {
    const outcomes = new Map<string, QuestOutcome>();
    for (const [id, outcome] of entries) recordOutcome(outcomes, id, outcome);
    return outcomes;
};

test("a run whose only quest failed does not report that everything is completed", () => {
    // failTask puts the quest in the skipped set, so the next cycle finds nothing active.
    // Reading that as success is what played the done sound over a run that farmed nothing.
    const summary = summarizeRun(outcomesOf(["q1", "failed"]));

    assert.equal(summary.finished, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.playDone, false);
    assert.doesNotMatch(summary.line, /All available quests are completed/);
    assert.match(summary.line, /1 failed/);
});

test("a quest blocked by Orion and then finished by hand is counted once", () => {
    const outcomes = outcomesOf(["q1", "blocked"], ["q1", "completed"]);
    const summary = summarizeRun(outcomes);

    assert.equal(summary.finished, 1);
    assert.equal(summary.blocked, 0);
    assert.equal(outcomes.size, 1);
});

test("a later failure never overwrites a quest this run completed", () => {
    assert.equal(summarizeRun(outcomesOf(["q1", "completed"], ["q1", "failed"])).finished, 1);
});

test("a run that farmed one quest and skipped another reports both and keeps the sound", () => {
    const summary = summarizeRun(outcomesOf(["q1", "completed"], ["q2", "blocked"]));

    assert.equal(summary.playDone, true);
    assert.match(summary.line, /1 quest\(s\) finished/);
    assert.match(summary.line, /1 skipped because this client cannot drive them/);
});

test("a run with nothing to report keeps the original completion line", () => {
    const summary = summarizeRun(outcomesOf());

    assert.equal(summary.line, "All available quests are completed!");
    assert.equal(summary.playDone, true);
});

test("a run where Orb-only left out every quest does not claim it completed them", () => {
    // Every quest the account had paid no Orbs, so the run did nothing. Reading an outcome map
    // with nothing blocked and nothing failed as success is how the done sound played over a run
    // that farmed nothing, which is exactly what summarizeRun exists to stop.
    const summary = summarizeRun(outcomesOf(["q1", "filtered"], ["q2", "filtered"]));

    assert.equal(summary.finished, 0);
    assert.equal(summary.filtered, 2);
    assert.equal(summary.playDone, false);
    assert.doesNotMatch(summary.line, /All available quests are completed/);
    assert.match(summary.line, /2 left out because they pay no Orbs/);
});

test("a quest left out by Orb-only is neither a failure nor a quest this client cannot drive", () => {
    const summary = summarizeRun(outcomesOf(["q1", "completed"], ["q2", "filtered"]));

    assert.equal(summary.failed, 0);
    assert.equal(summary.blocked, 0);
    assert.equal(summary.filtered, 1);
    assert.doesNotMatch(summary.line, /failed|cannot drive/);
});

test("a run that farmed Orb quests and left the rest out reports both and keeps the sound", () => {
    const summary = summarizeRun(outcomesOf(["q1", "completed"], ["q2", "completed"], ["q3", "filtered"]));

    assert.equal(summary.playDone, true);
    assert.match(summary.line, /2 quest\(s\) finished/);
    assert.match(summary.line, /1 left out because they pay no Orbs/);
});

test("a quest put back after Orb-only is turned off and then finished counts once, as finished", () => {
    const outcomes = outcomesOf(["q1", "filtered"], ["q1", "completed"]);
    const summary = summarizeRun(outcomes);

    assert.equal(outcomes.size, 1);
    assert.equal(summary.finished, 1);
    assert.equal(summary.filtered, 0);
});

test("a filter recorded after a completion never overwrites it", () => {
    assert.equal(summarizeRun(outcomesOf(["q1", "completed"], ["q1", "filtered"])).finished, 1);
});

// Issue #95: several quests that are the same game progress together because Discord credits
// every enrolled quest of a game while it runs once. The run announces that so it does not read
// as the concurrency limit being bypassed.
const game = (appId: string | number, name: string) => ({ appId, name, type: "GAME" });

test("same-game quests produce one line naming the count", () => {
    const lines = summarizeSharedGameQuests([game(100, "Clean Crew"), game(100, "Clean Crew"), game(100, "Clean Crew")]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^3 "Clean Crew" quests are the same game/);
    assert.match(lines[0], /drives one at a time/);
});

test("distinct games never share, and a lone quest says nothing", () => {
    assert.deepEqual(summarizeSharedGameQuests([game(1, "A"), game(2, "B"), game(3, "C")]), []);
    assert.deepEqual(summarizeSharedGameQuests([game(1, "A")]), []);
});

test("non-GAME task types do not share progress by game", () => {
    assert.deepEqual(summarizeSharedGameQuests([{ appId: 7, name: "Clip", type: "WATCH_VIDEO" }, { appId: 7, name: "Clip", type: "WATCH_VIDEO" }]), []);
    assert.deepEqual(summarizeSharedGameQuests([{ appId: 8, name: "Str", type: "STREAM" }, { appId: 8, name: "Str", type: "STREAM" }]), []);
});

test("appId 0 or empty is not a shared game", () => {
    assert.deepEqual(summarizeSharedGameQuests([game(0, "No App"), game(0, "No App"), game("", "Blank"), game("", "Blank")]), []);
});

test("two separate shared games each get their own line", () => {
    const lines = summarizeSharedGameQuests([game(1, "A"), game(1, "A"), game(2, "B"), game(2, "B"), game(3, "C")]);
    assert.equal(lines.length, 2);
    assert.ok(lines.some(l => l.startsWith('2 "A"')));
    assert.ok(lines.some(l => l.startsWith('2 "B"')));
});
