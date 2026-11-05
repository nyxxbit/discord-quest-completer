/*
 * OrionQuests shared game-session refcount tests (issue #96).
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/gameSession.test.ts
 *
 * GameSessionRefs is what makes accepted quests of one application run off a single spoofed
 * process instead of one each. The Patcher calls acquire() before materialising a process and
 * release() before tearing one down; these lock in the invariant it relies on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GameSessionRefs } from "../gameSession";

test("same-app siblings share one process; only the last release tears it down", () => {
    const refs = new GameSessionRefs();

    assert.equal(refs.acquire("app1"), true, "first quest of the app materialises the process");
    assert.equal(refs.acquire("app1"), false, "second shares it");
    assert.equal(refs.acquire("app1"), false, "third shares it");

    assert.equal(refs.release("app1"), false, "two siblings still need it");
    assert.equal(refs.release("app1"), false, "one sibling still needs it");
    assert.equal(refs.release("app1"), true, "last member done: tear the process down");
});

test("distinct applications are independent", () => {
    const refs = new GameSessionRefs();

    assert.equal(refs.acquire("app1"), true);
    assert.equal(refs.acquire("app2"), true, "a different app gets its own process");
    assert.equal(refs.release("app1"), true, "releasing one app does not touch the other");
    assert.equal(refs.release("app2"), true);
});

test("an unbalanced release never underflows and the count returns cleanly to zero", () => {
    const refs = new GameSessionRefs();

    assert.equal(refs.release("ghost"), false, "releasing something never acquired is a no-op");

    refs.acquire("app1");
    assert.equal(refs.release("app1"), true);
    assert.equal(refs.release("app1"), false, "a second release must not tear down again or go negative");

    assert.equal(refs.acquire("app1"), true, "a fresh acquire after a clean zero materialises again");
});

test("clear() drops every hold so the next acquire starts over", () => {
    const refs = new GameSessionRefs();

    refs.acquire("app1");
    refs.acquire("app1");
    refs.acquire("app2");
    refs.clear();

    assert.equal(refs.acquire("app1"), true, "app1 restarts from zero after clear");
    assert.equal(refs.acquire("app2"), true, "app2 restarts from zero after clear");
    assert.equal(refs.release("app1"), true);
    assert.equal(refs.release("app2"), true);
});
