/*
 * OrionQuests account-identity regression tests.
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/accountIdentity.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isConfirmedDifferentAccount } from "./accountIdentity";

test("a transient unknown identity is not an account change", () => {
    assert.equal(isConfirmedDifferentAccount(null, "user-a"), false);
});

test("the same confirmed identity is not an account change", () => {
    assert.equal(isConfirmedDifferentAccount("user-a", "user-a"), false);
});

test("only a different confirmed identity is an account change", () => {
    assert.equal(isConfirmedDifferentAccount("user-b", "user-a"), true);
});
