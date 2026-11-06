import assert from "node:assert/strict";
import test from "node:test";

import { discordSaysProgressBody, discordSaysResponseError } from "../discordSays";

test("Discord Says progress body carries the quest id required by the backend", () => {
    assert.deepEqual(
        JSON.parse(discordSaysProgressBody(7, "1552038438684074094")),
        { progress: 7, quest_id: "1552038438684074094" },
    );
});

test("Discord Says errors preserve a JSON backend message and status", () => {
    const error = discordSaysResponseError("discordsays progress", {
        status: 400,
        body: JSON.stringify({ status: "error", message: "quest_id missing in request body" }),
    });

    assert.equal(error.status, 400);
    assert.equal(error.message, "quest_id missing in request body");
    assert.deepEqual(error.body, { status: "error", message: "quest_id missing in request body" });
});

test("Discord Says errors keep useful non-JSON and error-field details", () => {
    assert.equal(
        discordSaysResponseError("discordsays authorize", { status: 502, body: "upstream unavailable" }).message,
        "upstream unavailable",
    );
    assert.equal(
        discordSaysResponseError("discordsays authorize", {
            status: 0,
            body: JSON.stringify({ error: "network down" }),
        }).message,
        "network down",
    );
    assert.equal(
        discordSaysResponseError("discordsays authorize", { status: 403, body: "" }).message,
        "discordsays authorize 403",
    );
});
