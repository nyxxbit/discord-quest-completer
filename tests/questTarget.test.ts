/*
 * OrionQuests quest-target regression tests.
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/questTarget.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveQuestTarget } from "../questTarget";

const candidates = [
    { id: "100", name: "Where Winds Meet" },
    { id: "200", name: "Genshin Impact" },
    { id: "300", name: "Where Winds Return" },
];

test("exact quest id resolves without depending on the display name", () => {
    const result = resolveQuestTarget("200", candidates);
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.candidate.name, "Genshin Impact");
});

test("exact quest name is case insensitive", () => {
    const result = resolveQuestTarget("genshin impact", candidates);
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.candidate.id, "200");
});

test("a short unique fragment resolves so users do not need to type the full quest name", () => {
    const result = resolveQuestTarget("genshin", candidates);
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.candidate.id, "200");
});

test("ambiguous fragments never guess a quest", () => {
    const result = resolveQuestTarget("where winds", candidates);
    assert.equal(result.kind, "ambiguous");
    if (result.kind === "ambiguous") assert.deepEqual(result.candidates.map(x => x.id), ["100", "300"]);
});

test("unknown and blank targets are not found", () => {
    assert.deepEqual(resolveQuestTarget("missing", candidates), { kind: "not-found" });
    assert.deepEqual(resolveQuestTarget("   ", candidates), { kind: "not-found" });
});
