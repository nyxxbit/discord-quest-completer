/*
 * OrionQuests OAuth cleanup regression tests.
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/oauthLifecycle.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { cleanupCreatedOAuthGrants } from "../oauthLifecycle";

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test("cleanup deletes only same-app grants created after the snapshot", async () => {
    const deleted: string[] = [];
    const outcome = await cleanupCreatedOAuthGrants({
        accountId: "user-1",
        appId: "app-A",
        preGrantIds: new Set(["existing-A"]),
        getCurrentAccountId: () => "user-1",
        listGrants: async () => [
            { id: "existing-A", application: { id: "app-A" } },
            { id: "created-A", application: { id: "app-A" } },
            { id: "created-B", application: { id: "app-B" } },
        ],
        deleteGrant: async id => { deleted.push(id); },
    });

    assert.deepEqual(outcome, { status: "cleaned", deleted: 1 });
    assert.deepEqual(deleted, ["created-A"]);
});

test("cleanup never lists grants after the account already changed", async () => {
    let listed = false;
    const outcome = await cleanupCreatedOAuthGrants({
        accountId: "old-user",
        appId: "app-A",
        preGrantIds: new Set(),
        getCurrentAccountId: () => "new-user",
        listGrants: async () => { listed = true; return []; },
        deleteGrant: async () => { throw new Error("must not delete"); },
    });

    assert.deepEqual(outcome, { status: "account-changed", deleted: 0 });
    assert.equal(listed, false);
});

test("account switch while grant listing is in flight prevents every DELETE", async () => {
    const listing = deferred<Array<{ id: string; application: { id: string; }; }>>();
    let account = "old-user";
    const deleted: string[] = [];

    const cleanup = cleanupCreatedOAuthGrants({
        accountId: "old-user",
        appId: "app-A",
        preGrantIds: new Set(),
        getCurrentAccountId: () => account,
        listGrants: () => listing.promise,
        deleteGrant: async id => { deleted.push(id); },
    });

    account = "new-user";
    listing.resolve([{ id: "created-A", application: { id: "app-A" } }]);

    assert.deepEqual(await cleanup, { status: "account-changed", deleted: 0 });
    assert.deepEqual(deleted, []);
});

test("account switch between grant deletions stops before touching the next grant", async () => {
    let account = "user-1";
    const deleted: string[] = [];

    const outcome = await cleanupCreatedOAuthGrants({
        accountId: "user-1",
        appId: "app-A",
        preGrantIds: new Set(),
        getCurrentAccountId: () => account,
        listGrants: async () => [
            { id: "first", application: { id: "app-A" } },
            { id: "second", application: { id: "app-A" } },
        ],
        deleteGrant: async id => {
            deleted.push(id);
            account = "user-2";
        },
    });

    assert.deepEqual(outcome, { status: "account-changed", deleted: 1 });
    assert.deepEqual(deleted, ["first"]);
});
