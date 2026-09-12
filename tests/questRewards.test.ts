/*
 * OrionQuests Orb reward parsing tests.
 * Run from a Vencord checkout:
 * pnpm exec tsx --test src/userplugins/discord-quest-completer/tests/questRewards.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatOrbBalance, formatOrbReward, orbBalance, questOrbReward, totalOrbReward } from "../questRewards";

const orbQuest = (rewards: any[]) => ({ rewardsConfig: { rewards } });

test("reads the Orb payout and the Nitro figure beside it", () => {
    const config = orbQuest([{ type: 4, orbQuantity: 240, premiumOrbQuantity: 288 }]);

    assert.deepEqual(questOrbReward(config), { orbs: 240, premiumOrbs: 288 });
});

test("falls back to the base payout when Discord sends no premium figure", () => {
    assert.deepEqual(questOrbReward(orbQuest([{ type: 4, orbQuantity: 150 }])), { orbs: 150, premiumOrbs: 150 });
    assert.deepEqual(
        questOrbReward(orbQuest([{ type: 4, orbQuantity: 150, premiumOrbQuantity: null }])),
        { orbs: 150, premiumOrbs: 150 }
    );
});

test("sums every reward entry, not just the first one", () => {
    const config = orbQuest([
        { type: 1, messages: { name: "In-game item" } },
        { type: 4, orbQuantity: 100, premiumOrbQuantity: 120 },
        { type: 4, orbQuantity: 50 },
    ]);

    assert.deepEqual(questOrbReward(config), { orbs: 150, premiumOrbs: 170 });
});

test("a quest that pays no Orbs reports none", () => {
    assert.equal(questOrbReward(orbQuest([{ type: 3, messages: { name: "Avatar decoration" } }])), null);
    assert.equal(questOrbReward(orbQuest([])), null);
    assert.equal(questOrbReward({}), null);
    assert.equal(questOrbReward(undefined), null);
});

test("junk quantities are ignored rather than printed", () => {
    const config = orbQuest([
        { type: 4, orbQuantity: "240" },
        { type: 4, orbQuantity: Number.NaN },
        { type: 4, orbQuantity: -10 },
    ]);

    assert.equal(questOrbReward(config), null);
});

test("a negative premium figure does not drag the Nitro total below the base one", () => {
    const config = orbQuest([{ type: 4, orbQuantity: 200, premiumOrbQuantity: -5 }]);

    assert.deepEqual(questOrbReward(config), { orbs: 200, premiumOrbs: 200 });
});

test("totals skip quests without Orbs and report nothing when none pay any", () => {
    assert.deepEqual(
        totalOrbReward([{ orbs: 240, premiumOrbs: 288 }, null, { orbs: 60, premiumOrbs: 60 }]),
        { orbs: 300, premiumOrbs: 348 }
    );
    assert.equal(totalOrbReward([null, null]), null);
    assert.equal(totalOrbReward([]), null);
});

test("the Nitro figure is only named when it differs", () => {
    assert.equal(formatOrbReward({ orbs: 240, premiumOrbs: 288 }), "240 Orbs (288 with Nitro)");
    assert.equal(formatOrbReward({ orbs: 240, premiumOrbs: 240 }), "240 Orbs");
    assert.equal(formatOrbReward(null), "");
});

test("an account balance is any whole non-negative number, zero included", () => {
    assert.equal(orbBalance(3240), 3240);
    assert.equal(orbBalance(0), 0);
    assert.equal(orbBalance(-1), null);
    assert.equal(orbBalance(12.5), null);
    assert.equal(orbBalance("3240"), null);
    assert.equal(orbBalance(null), null);
    assert.equal(orbBalance(undefined), null);
});

test("a balance prints as Orbs and an unknown one prints nothing", () => {
    assert.equal(formatOrbBalance(3240), "3240 Orbs");
    assert.equal(formatOrbBalance(0), "0 Orbs");
    assert.equal(formatOrbBalance(null), "");
});
