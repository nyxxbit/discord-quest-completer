/*
 * OrionQuests task-config compatibility regression tests.
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/questConfig.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { selectQuestTaskConfig, taskEntries, taskForKey } from "./questConfig";

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
