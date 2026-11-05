/*
 * OrionQuests shared game-session lifecycle tests (issue #96).
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/gameSession.test.ts
 *
 * runSharedGameSession is what makes accepted quests of one application run off a single spoofed
 * process instead of one each. It opens the process once before the members and closes it once
 * after the last one settles, so a member that pauses or finishes early cannot tear down a
 * process a sibling still needs. These lock in that lifecycle.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runSharedGameSession } from "../gameSession";

const tick = () => new Promise<void>(r => setTimeout(r, 0));

test("the shared process opens once before the members and closes once after", async () => {
    const events: string[] = [];
    await runSharedGameSession(
        [
            { run: async () => { events.push("A"); } },
            { run: async () => { events.push("B"); } },
        ],
        { open: async () => { events.push("open"); }, close: () => { events.push("close"); } },
    );

    assert.equal(events[0], "open", "the process is materialised before any member runs");
    assert.equal(events[events.length - 1], "close", "and torn down after every member settles");
    assert.equal(events.filter(e => e === "open").length, 1);
    assert.equal(events.filter(e => e === "close").length, 1);
});

test("a member that pauses early does not tear the process down for a sibling that still needs it", async () => {
    // The lifecycle race Herzchens flagged on #97: one member would acquire the process first and
    // another drop it while a sibling was still mid-setup. The group owns the one process now, so
    // a member leaving early must leave it standing for the sibling that is still running.
    let live = 0;
    let siblingSawProcess = false;
    const session = { open: async () => { live++; }, close: () => { live--; } };

    const paused = { run: async () => { /* paused immediately; a member never touches the process */ } };
    const stillRunning = { run: async () => { await tick(); await tick(); siblingSawProcess = live === 1; } };

    await runSharedGameSession([paused, stillRunning], session);

    assert.equal(siblingSawProcess, true, "the process stayed up for the member still running");
    assert.equal(live, 0, "and was torn down exactly once at the end");
});

test("the process is torn down even if a member throws", async () => {
    let live = 0;
    const session = { open: async () => { live++; }, close: () => { live--; } };

    await runSharedGameSession(
        [{ run: async () => { throw new Error("member blew up"); } }],
        session,
    );

    assert.equal(live, 0, "allSettled contains the rejection and close still runs");
});

test("members run concurrently, not one after another", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });

    const members = [
        { run: async () => { started.push("A"); await gate; } },
        { run: async () => { started.push("B"); } },
    ];

    const done = runSharedGameSession(members, { open: async () => { }, close: () => { } });
    await tick();
    assert.deepEqual([...started].sort(), ["A", "B"], "B started without waiting for A to finish");

    release();
    await done;
});
