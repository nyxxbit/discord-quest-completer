/*
 * OrionQuests userscript <-> plugin parity.
 *
 * index.js is the standalone userscript and carries its own copy of the pure helpers that the
 * plugin keeps in the tested .ts modules. Nothing imports index.js, so that copy has no
 * regression net and can drift from the .ts the rest of the suite proves. This harness reads the
 * real function bodies straight out of index.js and runs them against the plugin's real
 * functions over one shared corpus, so a drift on either side fails here instead of reaching a
 * user.
 *
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/parity.userscript.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isQuestExpired, recordOutcome as tsRecordOutcome, summarizeRun as tsSummarizeRun } from "../questConfig";
import { questOrbReward } from "../questRewards";
import type { QuestOutcome } from "../types";

const SRC = readFileSync(fileURLToPath(new URL("../index.js", import.meta.url)), "utf8");

/**
 * Read one balanced expression out of the source starting at `start`, skipping string and
 * comment contents so brackets inside them do not throw the depth off. Stops at the first
 * top-level `;`. Good enough for the plain arrow helpers extracted below (no regex literals).
 */
function readBalanced(src: string, start: number): string {
    let i = start, depth = 0, started = false, inStr: string | null = null, out = "";
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (!inStr && c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") out += src[i++]; continue; }
        if (!inStr && c === "/" && n === "*") {
            out += "/*"; i += 2;
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) out += src[i++];
            out += "*/"; i += 2; continue;
        }
        out += c;
        if (inStr) { if (c === inStr && src[i - 1] !== "\\") inStr = null; i++; continue; }
        if (c === '"' || c === "'" || c === "`") { inStr = c; i++; continue; }
        if (c === "(" || c === "{" || c === "[") { depth++; started = true; }
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === ";" && depth === 0 && started) break;
        i++;
    }
    return out;
}

/** The source text of a `const <name> = ...;` arrow in index.js, as written. */
function body(name: string): string {
    const marker = `const ${name} = `;
    const idx = SRC.indexOf(marker);
    assert.notEqual(idx, -1, `parity: '${name}' not found in index.js (did the userscript change shape?)`);
    return readBalanced(SRC, idx + marker.length).replace(/;\s*$/, "");
}

// Materialise the real userscript helpers as a CommonJS module and require them synchronously,
// so each body runs exactly as written in index.js with no eval, and no top-level await (which
// this suite transpiles to CJS, where it is invalid). notExpired reads the IIFE's Mods global, so
// it comes back as a factory that takes the Mods to run against.
const modPath = join(mkdtempSync(join(tmpdir(), "orion-parity-")), "helpers.cjs");
writeFileSync(modPath, [
    "module.exports = {",
    `    notExpiredWith: Mods => (${body("notExpired")}),`,
    `    orbReward: ${body("orbReward")},`,
    `    recordOutcome: ${body("recordOutcome")},`,
    `    summarizeRun: ${body("summarizeRun")},`,
    `    parseDiscordSaysErrorBody: ${body("parseDiscordSaysErrorBody")},`,
    "};",
].join("\n"));

const us = createRequire(import.meta.url)(modPath) as {
    notExpiredWith: (mods: { QuestStore: any; }) => (q: any) => boolean;
    orbReward: (config: any) => { orbs: number; premium: number; } | null;
    recordOutcome: (m: Map<string, string>, id: string, o: string) => void;
    summarizeRun: (m: Map<string, string>) => { finished: number; blocked: number; failed: number; line: string; playDone: boolean; };
    parseDiscordSaysErrorBody: (body: unknown) => any;
};

test("every pure helper we rely on still extracts from index.js", () => {
    for (const fn of [us.notExpiredWith, us.orbReward, us.recordOutcome, us.summarizeRun, us.parseDiscordSaysErrorBody]) assert.equal(typeof fn, "function");
});

test("userscript Discord Says wire contract carries quest_id and preserves JSON errors", () => {
    assert.ok(
        SRC.includes("JSON.stringify({ progress: t.target, quest_id: q.id })"),
        "userscript progress payload lost quest_id",
    );

    const parsed = us.parseDiscordSaysErrorBody(
        '{"status":"error","message":"quest_id missing in request body"}',
    );
    assert.deepEqual(parsed, { status: "error", message: "quest_id missing in request body" });
    assert.equal(us.parseDiscordSaysErrorBody("not-json"), "not-json");

    const alreadyParsed = { code: 50165, message: "age gated" };
    assert.equal(us.parseDiscordSaysErrorBody(alreadyParsed), alreadyParsed);
});

// ---- orbReward <-> questOrbReward -------------------------------------------------------------
// index.js returns { orbs, premium }; the .ts returns { orbs, premiumOrbs }. Same numbers.
const ORB_CORPUS: any[] = [
    {},
    { rewardsConfig: {} },
    { rewardsConfig: { rewards: [] } },
    { rewardsConfig: { rewards: [{ type: 1 }] } },
    { rewardsConfig: { rewards: [{ orbQuantity: 5 }] } },
    { rewardsConfig: { rewards: [{ orbQuantity: 5, premiumOrbQuantity: 7 }] } },
    { rewardsConfig: { rewards: [{ type: 1 }, { orbQuantity: 5 }, { orbQuantity: 3 }] } },
    { rewardsConfig: { rewards: [{ orbQuantity: 0 }, { orbQuantity: 4 }] } },
    { rewardsConfig: { rewards: [{ orbQuantity: -1 }] } },
];

test("orbReward agrees with questOrbReward on every reward shape", () => {
    for (const config of ORB_CORPUS) {
        const mine = us.orbReward(config);
        const ts = questOrbReward(config);
        if (ts === null) { assert.equal(mine, null, `expected null for ${JSON.stringify(config)}`); continue; }
        assert.ok(mine, `userscript returned null where plugin paid ${ts.orbs} for ${JSON.stringify(config)}`);
        assert.equal(mine!.orbs, ts.orbs, `orbs differ for ${JSON.stringify(config)}`);
        assert.equal(mine!.premium, ts.premiumOrbs, `premium differs for ${JSON.stringify(config)}`);
    }
});

// ---- recordOutcome + summarizeRun <-> the .ts -------------------------------------------------
// 'filtered' is a plugin-only outcome (Orb-only setting); the userscript never records it, so the
// shared corpus stays within the outcomes both engines produce.
const OUTCOME_CORPUS: Array<Array<[string, QuestOutcome]>> = [
    [],
    [["a", "completed"]],
    [["a", "failed"]],
    [["a", "blocked"]],
    [["a", "completed"], ["b", "blocked"]],
    [["a", "completed"], ["b", "failed"], ["c", "completed"]],
    [["a", "blocked"], ["a", "completed"]],
    [["a", "completed"], ["a", "failed"]],
];

test("recordOutcome + summarizeRun agree with the plugin on counts, wording and the done sound", () => {
    for (const seq of OUTCOME_CORPUS) {
        const mine = new Map<string, string>();
        const ts = new Map<string, QuestOutcome>();
        for (const [id, o] of seq) { us.recordOutcome(mine, id, o); tsRecordOutcome(ts, id, o); }
        const a = us.summarizeRun(mine);
        const b = tsSummarizeRun(ts);
        const where = JSON.stringify(seq);
        assert.equal(a.finished, b.finished, `finished differ for ${where}`);
        assert.equal(a.blocked, b.blocked, `blocked differ for ${where}`);
        assert.equal(a.failed, b.failed, `failed differ for ${where}`);
        assert.equal(a.line, b.line, `line differs for ${where}`);
        assert.equal(a.playDone, b.playDone, `playDone differs for ${where}`);
    }
});

// ---- notExpired <-> isQuestExpired ------------------------------------------------------------
// Each store shape drives a different branch of both functions: Discord's own verdict either way,
// an accessor that throws (falls through to the timestamp), and no accessor at all.
const STORES: Array<{ label: string; store: any; }> = [
    { label: "no accessor", store: {} },
    { label: "Discord says expired", store: { isQuestExpired: () => true } },
    { label: "Discord says live", store: { isQuestExpired: () => false } },
    { label: "accessor throws", store: { isQuestExpired: () => { throw new Error("boom"); } } },
];

const QUESTS: Array<{ label: string; q: any; }> = [
    { label: "future date", q: { id: "1", config: { expiresAt: new Date(Date.now() + 864e5).toISOString() } } },
    { label: "past date", q: { id: "2", config: { expiresAt: new Date(Date.now() - 864e5).toISOString() } } },
    { label: "unparseable date", q: { id: "3", config: { expiresAt: "not a date" } } },
    { label: "no expiresAt", q: { id: "4", config: {} } },
    { label: "no config", q: { id: "5" } },
];

test("notExpired agrees with the plugin's isQuestExpired on every store and quest shape", () => {
    const mismatches: string[] = [];
    for (const { label: s, store } of STORES) {
        const notExpired = us.notExpiredWith({ QuestStore: store });
        for (const { label: l, q } of QUESTS) {
            const mine = notExpired(q), plugin = !isQuestExpired(store, q);
            if (mine !== plugin) mismatches.push(`${s} / ${l}: userscript live=${mine}, plugin live=${plugin}`);
        }
    }
    assert.deepEqual(mismatches, [], `userscript and plugin disagree on expiry:\n  ${mismatches.join("\n  ")}`);
});
