/*
 * OrionQuests per-quest lifecycle regression tests.
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/taskControl.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TaskControlRegistry, waitForTaskDelay } from "../taskControl";

test("pausing one quest cancels only that generation and its cleanup", async () => {
    const registry = new TaskControlRegistry();
    const a = registry.create("A");
    const b = registry.create("B");
    registry.markStarted("A", a.generation);
    registry.markStarted("B", b.generation);
    const cleaned: string[] = [];

    registry.addCleanup("A", a.generation, () => cleaned.push("A"));
    registry.addCleanup("B", b.generation, () => cleaned.push("B"));

    const result = registry.pause("A");

    assert.deepEqual(result, { ran: 1, failed: 0 });
    assert.deepEqual(cleaned, ["A"]);
    assert.equal(registry.isPaused("A"), true);
    assert.equal(registry.isActive("A", a.generation), false);
    assert.equal(registry.isActive("B", b.generation), true);
    await a.cancelled;
});

test("a started generation must settle before the same quest can be created again", () => {
    const registry = new TaskControlRegistry();
    const first = registry.create("A");
    registry.markStarted("A", first.generation);
    registry.pause("A");
    registry.resume("A");

    assert.throws(() => registry.create("A"), /unsettled task generation/);

    registry.release("A", first.generation);
    const replacement = registry.create("A");
    assert.notEqual(replacement.generation, first.generation);
    assert.equal(registry.isActive("A", replacement.generation), true);
});

test("normal settlement does not masquerade as cancellation or swallow rejection", async () => {
    const registry = new TaskControlRegistry();
    const control = registry.create("A");
    registry.markStarted("A", control.generation);
    let cancellationObserved = false;
    void control.cancelled.then(() => { cancellationObserved = true; });

    const work = Promise.reject(new Error("worker boom"));
    const settling = work.finally(() => registry.release("A", control.generation));

    await assert.rejects(Promise.race([settling, control.cancelled]), /worker boom/);
    await Promise.resolve();
    assert.equal(cancellationObserved, false);
    assert.equal(registry.get("A"), undefined);
});

test("normal release flushes a forgotten task cleanup", () => {
    const registry = new TaskControlRegistry();
    const control = registry.create("A");
    registry.markStarted("A", control.generation);
    let cleaned = 0;
    registry.addCleanup("A", control.generation, () => cleaned++);

    const result = registry.release("A", control.generation);

    assert.deepEqual(result, { ran: 1, failed: 0 });
    assert.equal(cleaned, 1);
    assert.equal(registry.get("A"), undefined);
});

test("pause then resume cannot revive the old generation", () => {
    const registry = new TaskControlRegistry();
    const old = registry.create("A");
    registry.markStarted("A", old.generation);

    registry.pause("A");
    assert.equal(registry.resume("A"), true);
    assert.equal(registry.isActive("A", old.generation), false);

    registry.release("A", old.generation);
    const replacement = registry.create("A");
    assert.notEqual(replacement.generation, old.generation);
    assert.equal(registry.isActive("A", replacement.generation), true);
});

test("pause can win again after resume while the old generation is still settling", () => {
    const registry = new TaskControlRegistry();
    const old = registry.create("A");
    registry.markStarted("A", old.generation);

    registry.pause("A");
    registry.resume("A");
    const secondPause = registry.pause("A");

    assert.deepEqual(secondPause, { ran: 0, failed: 0 });
    assert.equal(registry.isPaused("A"), true);
    assert.equal(registry.isActive("A", old.generation), false);
    assert.throws(() => registry.create("A"), /unsettled task generation/);

    registry.release("A", old.generation);
    assert.equal(registry.isPaused("A"), true);
});

test("pause can be restored after a resumed queued generation was already retired", () => {
    const registry = new TaskControlRegistry();
    const queued = registry.create("queued");

    registry.pause("queued");
    assert.equal(registry.get("queued"), undefined);
    registry.resume("queued");

    const secondPause = registry.pause("queued");
    assert.deepEqual(secondPause, { ran: 0, failed: 0 });
    assert.equal(registry.isPaused("queued"), true);
    assert.equal(registry.get("queued"), undefined);
    assert.equal(registry.isActive("queued", queued.generation), false);
});

test("a stale async continuation stays dead after pause and later replacement", async () => {
    const registry = new TaskControlRegistry();
    const old = registry.create("A");
    registry.markStarted("A", old.generation);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let staleForwardWork = 0;

    const oldWork = (async () => {
        await gate;
        if (registry.isActive("A", old.generation)) staleForwardWork++;
        registry.release("A", old.generation);
    })();

    registry.pause("A");
    registry.resume("A");
    assert.throws(() => registry.create("A"), /unsettled task generation/);

    release();
    await oldWork;
    const replacement = registry.create("A");

    assert.equal(staleForwardWork, 0);
    assert.equal(registry.isActive("A", replacement.generation), true);
});

test("queued work can be paused and retired before a worker starts it", () => {
    const registry = new TaskControlRegistry();
    const queued = registry.create("queued");

    const result = registry.pause("queued");

    assert.deepEqual(result, { ran: 0, failed: 0 });
    assert.equal(registry.isPaused("queued"), true);
    assert.equal(registry.isActive("queued", queued.generation), false);
    assert.equal(registry.get("queued"), undefined);

    registry.resume("queued");
    const replacement = registry.create("queued");
    assert.notEqual(replacement.generation, queued.generation);
});

test("task generation exposes the same abort signal used by pause", () => {
    const registry = new TaskControlRegistry();
    const control = registry.create("A");
    const signal = registry.signalFor("A", control.generation);

    assert.equal(signal, control.controller.signal);
    assert.equal(signal?.aborted, false);
    registry.pause("A");
    assert.equal(signal?.aborted, true);
});

test("task-owned delay wakes immediately when that generation is paused", async () => {
    const registry = new TaskControlRegistry();
    const control = registry.create("delay");
    registry.markStarted("delay", control.generation);

    const waiting = registry.waitForDelay("delay", control.generation, 60_000);
    registry.pause("delay");

    assert.equal(await waiting, false);
});

test("task-owned delay completes while the generation remains active", async () => {
    const registry = new TaskControlRegistry();
    const control = registry.create("delay");
    registry.markStarted("delay", control.generation);

    assert.equal(await registry.waitForDelay("delay", control.generation, 0), true);
});

test("standalone cancellable delay removes its abort listener and resolves false", async () => {
    const controller = new AbortController();
    const waiting = waitForTaskDelay(60_000, controller.signal);
    controller.abort();
    assert.equal(await waiting, false);
});

test("global stop keeps a started generation reserved until its work settles", () => {
    const registry = new TaskControlRegistry();
    const old = registry.create("A");
    registry.markStarted("A", old.generation);

    registry.cancelAll();

    assert.equal(registry.isActive("A", old.generation), false);
    assert.equal(registry.get("A"), old);
    assert.throws(() => registry.create("A"), /unsettled task generation/);

    registry.release("A", old.generation);
    assert.doesNotThrow(() => registry.create("A"));
});

test("pause resume stop start cannot overlap the old generation", () => {
    const registry = new TaskControlRegistry();
    const old = registry.create("A");
    registry.markStarted("A", old.generation);

    registry.pause("A");
    registry.resume("A");
    registry.cancelAll();

    assert.equal(registry.get("A"), old);
    assert.throws(() => registry.create("A"), /unsettled task generation/);

    registry.release("A", old.generation);
    const replacement = registry.create("A");
    assert.notEqual(replacement.generation, old.generation);
});

test("global stop retires queued generations that never started", () => {
    const registry = new TaskControlRegistry();
    const queued = registry.create("queued");

    registry.cancelAll();

    assert.equal(registry.isActive("queued", queued.generation), false);
    assert.equal(registry.get("queued"), undefined);
    assert.doesNotThrow(() => registry.create("queued"));
});

test("pause all is selective and resume all only clears paused state", () => {
    const registry = new TaskControlRegistry();
    const a = registry.create("A");
    const b = registry.create("B");
    const c = registry.create("C");
    registry.markStarted("A", a.generation);
    registry.markStarted("B", b.generation);
    registry.markStarted("C", c.generation);

    const result = registry.pauseAll(id => id !== "B");

    assert.equal(result.quests, 2);
    assert.equal(registry.isActive("A", a.generation), false);
    assert.equal(registry.isActive("B", b.generation), true);
    assert.equal(registry.isActive("C", c.generation), false);
    assert.deepEqual(new Set(registry.pausedIds()), new Set(["A", "C"]));

    assert.equal(registry.resumeAll(), 2);
    assert.equal(registry.isPaused("A"), false);
    assert.equal(registry.isPaused("C"), false);
    assert.equal(registry.isActive("A", a.generation), false);
    assert.equal(registry.isActive("B", b.generation), true);
});

test("clear paused returns exactly the session pause tombstones it removed", () => {
    const registry = new TaskControlRegistry();
    const a = registry.create("A");
    const b = registry.create("B");
    registry.markStarted("A", a.generation);
    registry.markStarted("B", b.generation);
    registry.pause("A");
    registry.pause("B");

    assert.deepEqual(new Set(registry.clearPaused()), new Set(["A", "B"]));
    assert.deepEqual(registry.pausedIds(), []);
});

test("global cancellation does not turn stopped quests into paused quests", () => {
    const registry = new TaskControlRegistry();
    const a = registry.create("A");
    const b = registry.create("B");
    registry.markStarted("A", a.generation);
    registry.markStarted("B", b.generation);

    registry.cancelAll();

    assert.equal(registry.isActive("A", a.generation), false);
    assert.equal(registry.isActive("B", b.generation), false);
    assert.deepEqual(registry.pausedIds(), []);
});

test("cleanup failures are contained and do not prevent sibling cleanups", () => {
    const registry = new TaskControlRegistry();
    const a = registry.create("A");
    registry.markStarted("A", a.generation);
    const calls: string[] = [];
    const errors: unknown[] = [];

    registry.addCleanup("A", a.generation, () => {
        calls.push("first");
        throw new Error("boom");
    });
    registry.addCleanup("A", a.generation, () => calls.push("second"));

    const result = registry.pause("A", error => errors.push(error));

    assert.deepEqual(result, { ran: 2, failed: 1 });
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(errors.length, 1);
});

test("expired or completed paused ids can be pruned without touching valid ids", () => {
    const registry = new TaskControlRegistry();
    const keep = registry.create("keep");
    const drop = registry.create("drop");
    registry.markStarted("keep", keep.generation);
    registry.markStarted("drop", drop.generation);
    registry.pause("keep");
    registry.pause("drop");

    const removed = registry.prunePaused(new Set(["keep"]));

    assert.deepEqual(removed, ["drop"]);
    assert.equal(registry.isPaused("keep"), true);
    assert.equal(registry.isPaused("drop"), false);
});
