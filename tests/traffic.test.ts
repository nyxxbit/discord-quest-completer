/*
 * OrionQuests per-request cancellation regression tests.
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/traffic.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Traffic } from "../traffic";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const silentLogger = {
    warn() { },
    error() { },
    debug() { },
};

test("a queued task request aborts synchronously and never reaches API.post", async () => {
    const first = deferred<void>();
    const calls: string[] = [];
    const API = {
        post: async ({ url }: { url: string; }) => {
            calls.push(url);
            if (url === "/first") await first.promise;
            return { body: {} };
        },
    };
    const traffic = new Traffic(API, () => true, silentLogger);
    const secondController = new AbortController();

    const firstRequest = traffic.enqueue("/first", {});
    const secondRequest = traffic.enqueue("/second", {}, () => true, secondController.signal);
    secondController.abort();

    await assert.rejects(secondRequest, (error: any) => error?.name === "AbortError");
    assert.deepEqual(calls, ["/first"]);

    first.resolve();
    await firstRequest;
    assert.deepEqual(calls, ["/first"]);
});

test("an in-flight request stays reserved until the real POST settles", async () => {
    const response = deferred<void>();
    let attempts = 0;
    const controller = new AbortController();
    const API = {
        post: async () => {
            attempts++;
            await response.promise;
            return { body: { progress: 123 } };
        },
    };
    const traffic = new Traffic(API, () => true, silentLogger);

    const request = traffic.enqueue("/in-flight", {}, () => true, controller.signal);
    while (attempts === 0) await Promise.resolve();

    let settled = false;
    void request.catch(() => { settled = true; });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    // RestAPI.post cannot be unsent. Cancellation blocks its continuation but does not pretend
    // the generation has settled before the real network promise returns.
    assert.equal(settled, false);

    response.resolve();
    await assert.rejects(request, (error: any) => error?.name === "AbortError");
    assert.equal(attempts, 1);
});

test("an endpoint retry cannot be revived by pause then resume", async () => {
    const retryScheduled = deferred<void>();
    let attempts = 0;
    const controller = new AbortController();
    const API = {
        post: async () => {
            attempts++;
            if (attempts === 1) throw { status: 429, body: { retry_after: 60, global: false } };
            return { body: {} };
        },
    };
    const log = {
        ...silentLogger,
        warn() { retryScheduled.resolve(); },
    };
    const traffic = new Traffic(API, () => true, log);

    const request = traffic.enqueue("/retry", {}, () => true, controller.signal);
    await retryScheduled.promise;
    controller.abort();

    await assert.rejects(request, (error: any) => error?.name === "AbortError");
    assert.equal(attempts, 1);
});

test("endpoint retry timer is cleared when its task is cancelled", async () => {
    const retryScheduled = deferred<void>();
    let attempts = 0;
    const controller = new AbortController();
    const API = {
        post: async () => {
            attempts++;
            throw { status: 429, body: { retry_after: 60, global: false } };
        },
    };
    const traffic = new Traffic(API, () => true, {
        ...silentLogger,
        warn() { retryScheduled.resolve(); },
    });

    const request = traffic.enqueue("/long-retry", {}, () => true, controller.signal);
    await retryScheduled.promise;
    controller.abort();

    await assert.rejects(request, (error: any) => error?.name === "AbortError");
    await Promise.resolve();
    assert.equal(attempts, 1);
});

test("global 429 keeps shared pacing but cancels the owning request immediately", async () => {
    const retryScheduled = deferred<void>();
    let attempts = 0;
    const controller = new AbortController();
    const API = {
        post: async () => {
            attempts++;
            if (attempts === 1) throw { status: 429, body: { retry_after: 0, global: true } };
            return { body: {} };
        },
    };
    const traffic = new Traffic(API, () => true, {
        ...silentLogger,
        warn() { retryScheduled.resolve(); },
    });

    const request = traffic.enqueue("/global-retry", {}, () => true, controller.signal);
    await retryScheduled.promise;
    controller.abort();

    await assert.rejects(request, (error: any) => error?.name === "AbortError");
    assert.equal(attempts, 1);
});

test("a stale liveness predicate still blocks a queued request without an AbortSignal", async () => {
    const first = deferred<void>();
    const calls: string[] = [];
    let active = true;
    const API = {
        post: async ({ url }: { url: string; }) => {
            calls.push(url);
            if (url === "/first") await first.promise;
            return { body: {} };
        },
    };
    const traffic = new Traffic(API, () => true, silentLogger);

    const firstRequest = traffic.enqueue("/first", {});
    const secondRequest = traffic.enqueue("/predicate", {}, () => active);
    active = false;
    first.resolve();

    await firstRequest;
    await assert.rejects(secondRequest, (error: any) => error?.name === "AbortError");
    assert.deepEqual(calls, ["/first"]);
});
