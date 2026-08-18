# Orion

[![Version](https://img.shields.io/badge/v4.10.6-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://github.com/nyxxbit/discord-quest-completer/releases/latest)
[![Stars](https://img.shields.io/github/stars/nyxxbit/discord-quest-completer?style=for-the-badge&color=faa61a)](https://github.com/nyxxbit/discord-quest-completer/stargazers)
[![License](https://img.shields.io/badge/MIT-green?style=for-the-badge)](LICENSE)

Completes Discord Quests without playing them. It reads the quests you're eligible for, tells Discord you're doing the thing the quest asks for, and waits for Discord to credit the progress.

It handles all five quest types: play a game, stream a game, watch a video, join an activity, and earn an achievement inside an activity. That last one is the reason this project exists, and none of the other tools listed at the bottom of this page do it.

Two ways to run it. A single userscript you paste into DevTools, or a Vencord plugin that starts with Discord. Same engine, kept in sync, in this repo.

> [!CAUTION]
> **Discord has been enforcing against quest automation since April 2026.** People have had system messages land on their account after running automation, any automation, not only this. Enforcement can hit the whole account and not just the quest reward. That is the trade you are making.
>
> **The achievement bypass is the riskiest part of this tool, by a distance.** To complete an `ACHIEVEMENT_IN_ACTIVITY` quest it runs a real OAuth2 authorization against the quest's application on your account (scopes `identify applications.commands applications.entitlements`), mints a proxy ticket, posts forged progress to the activity backend on `discordsays.com`, then revokes the grant it created. That is forging progress with your logged-in account, which is precisely the behaviour being enforced against. It asks before every authorization: the userscript shows a confirm dialog, the plugin keeps it behind a setting that is off until you turn it on. What goes to `discordsays.com` is the app's OAuth code, the proxy ticket, and a progress number. Never your token, email, or password. If you would mind losing the account, don't run this on it.

## Which download you want

The [latest release](https://github.com/nyxxbit/discord-quest-completer/releases/latest) ships four files and most people need one or two of them.

| File | What it is | Who it's for |
|---|---|---|
| `index.js` | The userscript. Paste into DevTools, no install. | Anyone comfortable opening the console. Needs Vencord on Discord Stable, see below. |
| `orion-relay-vX.zip` | A small localhost HTTP listener on `127.0.0.1:43210`. PowerShell and Python versions. | Only if you want achievement quests **and** you're using the userscript without the plugin. Explained under [Achievement quests](#achievement-quests). |
| `orion-vencord-bundle-vX.zip` | Copies a prebuilt Vencord over an existing Vencord install. `INSTALL.cmd`, no build tools. | Someone non-technical who already has Vencord and wants this working in one double-click. Freezes their Vencord version, see the note below. |
| `orion-devbuild-installer-vX.zip` | Builds Vencord from source with the plugin in it, as a real git clone. | Same person, but they want Vencord to keep auto-updating. Takes 5 to 15 minutes and downloads roughly 300 MB. Pulls Node 22 and Git via winget if missing. |

The two installers exist because copying a prebuilt Vencord over someone's install has to disable Vencord's updater to be safe. `orion-vencord-bundle` accepts that and freezes the version. `orion-devbuild-installer` avoids it by building from a git checkout, so Vencord updates itself normally and the plugin is recompiled back in each time. Both are Windows only and both include a README.

If you already build Vencord yourself, skip the installers and see [`docs/VENCORD-PLUGIN.md`](docs/VENCORD-PLUGIN.md). With nin0's `UserpluginInstaller`, paste this repo's URL into its Install Plugin field and it clones, builds, and self-updates from there.

## Quick start, userscript

1. Open Discord. [Canary](https://canary.discord.com/download) has the console enabled already.
2. `Ctrl + Shift + I`, Console tab.
3. Paste [`index.js`](index.js) and press Enter.

A quest picker appears. Choose what to run and hit start. `Shift + .` hides and shows the dashboard, and STOP ends the run and undoes everything it patched.

<details>
<summary>Enabling the console on Discord Stable</summary>

Close Discord, edit `%appdata%/discord/settings.json`:

```json
{ "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING": true }
```

Restart Discord.
</details>

## What it does per quest type

Orion reads Discord's own webpack stores and drives Discord's own authenticated API client. It does not talk to any server of ours; there isn't one.

| Quest task | How it's completed |
|---|---|
| `PLAY_ON_DESKTOP` | Injects a fake running process into `RunningGameStore`, built from the app's real metadata. Discord then sends the quest heartbeats itself and Orion reads the progress off the replies. |
| `STREAM_ON_DESKTOP` | Same idea, plus a spoofed `getStreamerActiveStreamMetadata` so Discord believes a stream is live. |
| `WATCH_VIDEO`, `WATCH_VIDEO_ON_MOBILE` | Posts video progress timestamps on a randomized interval, with the fractional values a real player would send. |
| `PLAY_ACTIVITY` | Heartbeats against a voice channel stream key. |
| `ACHIEVEMENT_IN_ACTIVITY` | Tries the heartbeat first. Discord rejects those with a 403, because the activity backend validates them rather than the client, so it falls back to the OAuth path described below. |

Where the quest's application id lives moved in July 2026, from `config.application.id` to per task at `config.taskConfigV2.tasks.<KEY>.applications[0].id`. Reading the old path fails silently rather than loudly, which is what broke every tool in this space at once. See [#43](https://github.com/nyxxbit/discord-quest-completer/issues/43).

## Achievement quests

These can't be faked client side, so completing one means authorizing the quest's app on your account and reporting progress to `discordsays.com` directly. Read the caution at the top before using it.

Discord's renderer blocks requests to `discordsays.com` outright via CSP, so the request has to leave the renderer. Orion tries, in order:

1. The localhost relay on `127.0.0.1:43210`, if it's running. Discord's CSP allows loopback, so this works with no client mod at all.
2. The Vencord plugin's native module, which runs the request in Electron's main process where CSP doesn't apply.
3. A direct `fetch`, which only works on Discord in a browser.

So on desktop you need either the relay or the plugin. There is no renderer-only way around this; that was tested to exhaustion.

Quests for age-gated or delisted activities are skipped instead of retried. Discord answers `/proxy-tickets` with a 403 and code `50165` for those, and they can't be launched by hand either until you age-verify.

## Settings

The userscript asks at start, in the picker: which quests to run, filters by reward type (Orbs, Avatar Decoration, In-Game, Other), auto-enroll (on), auto-claim (off, because claiming often triggers a captcha), a completion sound (off), and randomized idle gaps between quests (off).

Two things are edited in the `CONFIG` object at the top of `index.js` instead:

```js
const CONFIG = {
    HIDE_ACTIVITY: false,   // turn Discord's "Display current activity as a status
                            // message" off while quests run, and restore it after
    MAX_LOG_ITEMS: 60,      // lines kept in the dashboard log
};
```

The plugin has the same options as real settings, plus auto-start, per-type concurrency, and the achievement bypass toggle. They're documented in [`docs/VENCORD-PLUGIN.md`](docs/VENCORD-PLUGIN.md).

## When things go wrong

| Situation | What happens |
|---|---|
| 429 or 5xx | Exponential backoff and re-queue, up to 3 retries. Global and per-endpoint limits are tracked separately. |
| 404 or 403 on enroll | Quest goes on a skip list and the run continues. |
| 5 consecutive failures on one task | That task is abandoned, the rest keep going. |
| A game quest gets no heartbeat for 90s | Aborted with a reason, instead of sitting there until the timeout. |
| 25 minutes on one task | Hard stop, next quest. |
| Auto-claim fails | A CLAIM button appears on the task card. |
| A crash | The re-entry lock is released and every patch is reverted, so you can paste again without reloading. |

Stopping is meant to leave nothing behind. The patched store methods are restored, the fake process is removed, the OAuth grant from an achievement quest is revoked, and any Discord setting it changed is put back.

## Compatibility

Vanilla Discord **Stable** is only partly usable. A Stable build changed the webpack runtime so `webpackChunkdiscord_app.push` stopped exposing the live module cache after boot, which the userscript needs ([#20](https://github.com/nyxxbit/discord-quest-completer/issues/20)). Three ways around it: run the userscript with Vencord installed and it uses Vencord's Webpack API instead, install the plugin, or use Canary or PTB where the native path still works.

In a browser or on mobile through a script-injection extension, video and activity quests work. Game and stream quests are filtered out, because they require the desktop client to exist at all.

## Architecture

`index.js` is one IIFE with no build step and no dependencies. The plugin is TypeScript at the repo root, because Vencord's `UserpluginInstaller` clones a repo straight into `src/userplugins` and only reads `index.tsx` and `native.ts` from its top level.

Stores are found by class name (`constructor.displayName`), the Dispatcher by its shape, and the API client by having a `.del` method, so nothing depends on minified paths that change every build. That handles Discord renaming things. It does not handle Discord *moving* things, which is what #43 was.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the full internal tour.

## Other tools

Worth knowing about, and worth knowing their state. All three were last updated before the July 2026 change described above, and none has shipped since.

- [markterence/discord-quest-completer](https://github.com/markterence/discord-quest-completer), a native Windows app that creates dummy executables so Discord's process detection sees a game, without touching the client. Structurally the most durable approach of the four, since it doesn't read Discord internals. Play quests only, Windows only. Last updated March 2026.
- [nicola02nb/completeDiscordQuest](https://github.com/nicola02nb/completeDiscordQuest), a Vencord plugin descended from [aamiaa's original snippet](https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb) that started this whole space. Covers everything except achievement quests. Last updated April 2026 and currently broken by the application id change, tracked in its own issue #23.
- [nvckai/Discord-Web-Auto-Quest-Extension](https://github.com/nvckai/Discord-Web-Auto-Quest-Extension), a Chrome extension, easiest to install, video quests. Last updated April 2026.

Being the one that still works today is a function of being maintained, not of being cleverer. This approach reads Discord's internals, so any Discord update can break it, and one did. The dummy-executable approach doesn't have that failure mode.

## Contributing

Bug reports, PRs and docs all welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the checklist and the code style, and there are issue templates for bugs and feature requests. If you're reporting a bug, the Discord build number from the very bottom of Discord's settings saves a round trip.

---

## Changelog

### v4.10.7
- **The Vencord plugin can pause or resume one quest without stopping unrelated concurrent work** ([#64](https://github.com/nyxxbit/discord-quest-completer/issues/64)). `/orion action:pause quest:<target>` cancels that queued/running task generation and its own cleanup only; omitting `quest` pauses every current queued/running quest. `resume` clears the same session pause state for one quest or all of them and lets Discord's already-recorded progress continue on the next eligible cycle. Targets accept an exact quest id, an exact name, or a unique case-insensitive name fragment and refuse ambiguous fragments instead of guessing. The cancellation boundary is per generation: task-owned delays and queued/429-backoff traffic stop promptly, GAME/STREAM cleanup is quest-scoped, and an old generation can never become active again after Resume. A request already handed to Discord's `RestAPI` cannot be unsent, so the replacement generation waits until that call or compensating OAuth cleanup really settles. Pause state survives Orion Stop → Start for the same Discord account, resets on account change/reload, and a rapid Pause → Resume → Pause keeps the final Pause intent even while the old generation is still settling. The same lifecycle audit also makes unexpected worker exceptions retire as `FAILED` instead of leaving a phantom `RUNNING` row, and makes account-switch teardown safe against synchronous dashboard observers. The standalone `index.js` userscript is unchanged.

### v4.10.6
- **A stopped achievement quest kept working through the rest of its OAuth chain** ([#62](https://github.com/nyxxbit/discord-quest-completer/pull/62), by [@Herzchens](https://github.com/Herzchens), closing the second half of [#60](https://github.com/nyxxbit/discord-quest-completer/issues/60)). The bypass is a sequence of awaited requests, and only the first of them checked whether the engine was still running. A stop landing inside any later stage let the continuation wake up and start the next one anyway, so a stopped run could still authorize the app, take a proxy ticket, post progress, or report a completion for a run that no longer existed. Every stage now re-checks after its await. Requests already on the wire are still allowed to settle, and the grant cleanup deliberately still runs after a stop, because a request issued before the stop may have created an authorization that has to be revoked. Reproduced on the wire by holding the first request of the chain, stopping, then releasing it: before the fix the stopped run went on to `POST /oauth2/authorize` 1.7 seconds after the stop, after it the chain made no further calls at all.
- **A failed achievement quest could report another quest's error, or none at all.** Reported by [@Herzchens](https://github.com/Herzchens) in [#61](https://github.com/nyxxbit/discord-quest-completer/issues/61), against the diagnostics added in v4.10.1. The bypass kept its reason in a field on the task runner, and every task on that runner shares it. Achievement tasks queue in the same worker pool as games, so with `gameConcurrency` above 1 two of them overlap, and the loser is the one that finishes first: it records why it gave up, then waits out the grant-cleanup request while the other task enters the bypass and resets the field, and reads back nothing. Its row falls back to `no auto-completion path worked` with the real error discarded, which is precisely the blanket message v4.10.1 set out to remove. Reproduced live on two quests failing with distinguishable error codes, with the second task's entry held until the first had recorded its reason: before the fix the first quest reported `no auto-completion path worked` while the second kept its own code, after it each reports its own. The reason now comes back as the return value, so it belongs to the attempt that produced it. The userscript runs its game queue serially, so the race cannot happen there today, but the same shared field was sitting in it and is gone from both engines. While in that code, the guard that rejects a non-numeric application id also stopped returning with no reason at all, which surfaced as the same generic text.
- **`docs/ARCHITECTURE.md` claimed the traffic queue was the single egress point for every quest call.** It never was. The queue only issues `POST`, so it carries enrollment, heartbeats and video progress, while game metadata lookups, reward claims, the whole OAuth and discordsays chain, and the relay all go out directly. Flagged by [@Herzchens](https://github.com/Herzchens) while reviewing [#60](https://github.com/nyxxbit/discord-quest-completer/issues/60). The section now lists both sides and says which new calls belong in the queue.

### v4.10.5
- **Stopping a game quest and starting again could silently kill the new run.** Reported by [@Herzchens](https://github.com/Herzchens) in [#60](https://github.com/nyxxbit/discord-quest-completer/issues/60). Before injecting a fake process, Orion fetches the app's metadata over the network, and it only checked whether the engine was still running *before* that request, never after. Stop landing inside that window let the old task wake up afterwards and patch the store on behalf of a run that had already torn down. That is worse than it sounds, because each run's patcher records the store methods it considers real when it is created: a stale run installing on top of a newer one and then restoring its own snapshot takes the newer run's patches with it. Reproduced live with two overlapping runs: run A held inside the metadata request and stopped, run B started and spoofed normally, then A resumed and B's fake game vanished from `RunningGameStore` with the store back to its unpatched state, leaving B running a quest Discord could no longer see. With the check added after the await, B's spoof survives A resuming and only goes away on its own stop. Fixed in both engines.

### v4.10.4
- **A stopped run could keep working after you started a new one** ([#58](https://github.com/nyxxbit/discord-quest-completer/pull/58), by [@Herzchens](https://github.com/Herzchens)). The plugin tracked "is the engine up" with a single module-level flag. A video or activity task can still be sitting inside a sleep when you run `/orion stop`, and if you started again before it woke, that flag was back to `true` and the old task simply carried on as though its own run had never ended. The old run's teardown could also stop the new one. Each start now gets its own runtime and generation id, and every callback is bound to the generation that created it. Reproduced on the wire before merging: stop a video quest mid-sleep, start a second run that cannot see that quest, and the old run still posted progress for it twice, at 15 and 24 seconds after the restart. With the fix, none.
- **The installer verified the wrong Discord when you only have PTB or Canary** ([#57](https://github.com/nyxxbit/discord-quest-completer/pull/57), by [@Herzchens](https://github.com/Herzchens)). It detects the flavor correctly and patches the right one, but the post-inject check always looked in `%LOCALAPPDATA%\Discord`. On a machine without Stable it found nothing, decided the patch had failed, and rolled back a perfectly good install. Confirmed against the real filesystem for all four layouts: Canary-only and PTB-only rolled back before the fix and verify cleanly after, Stable is unaffected.
- **`UPDATE.cmd` never actually updated Orion.** It pulled Vencord, then copied the plugin back out of the `plugin\` folder inside the zip you originally extracted, so it reinstalled the same version every time and quietly pinned you to whatever release you first downloaded ([#56](https://github.com/nyxxbit/discord-quest-completer/issues/56)). The installer now clones the plugin as its own git checkout and `UPDATE.cmd` pulls it, so new releases arrive without re-downloading anything. Existing installs are converted the first time you run the new `UPDATE.cmd`. Both fall back to the bundled copy if GitHub is unreachable, and say so.

### v4.10.3
- **The `orion-vencord-bundle` zip now ships the full GPL text and says where its source is.** That bundle is a compiled build of Vencord with our plugin inside it, and Vencord is GPL-3.0-or-later, so handing someone the zip is conveying GPL software. It already carried Vencord's copyright and licensing notice, which esbuild emits into `dist/*.LEGAL.txt`, but not the full licence text that GPL section 4 asks you to convey alongside the program, and nothing in it stated where the corresponding source could be had. The zip now includes `LICENSE-VENCORD.txt` and a README section naming the licence, the upstream repository and the exact build command used, and the packaging script refuses to build a bundle missing any of that.
- **Correcting how the v4.9.9 and v4.10.0 bundle problem was described.** Those release notes, and the notices left on both releases, said a GPL-3.0 plugin had ended up inside an MIT artifact. That framing was wrong. The bundle has never been MIT: it is a Vencord distribution, so it has always been GPL-3.0-or-later. Only our own plugin inside it is MIT, and it stays MIT. There was therefore no licence incompatibility. What was actually wrong is that a third party's plugin was compiled in and distributed without their permission and without attribution, which is a violation on its own terms and is still ours. The remedy does not change and neither does anything a user should do.

### v4.10.2
- **`/orion status` says what is finished and what is still owed to you.** It opened with a bare task count and each row was just a status and a percentage, so the two things people actually check, how much is left and whether a reward is sitting unclaimed, were the two things it did not answer ([#56](https://github.com/nyxxbit/discord-quest-completer/issues/56)). The header now breaks the tasks down by status, a completed quest whose reward has not been collected says so, and a footer tells you how many are waiting and where to claim them. The engine had been marking finished quests `claimable` since the dashboard was written and nothing ever read the flag. It is also not trusted on its own: the flag is written once when the quest finishes, so claiming the reward yourself in Discord afterwards would leave it stale, and the status checks the quest store before saying a reward is outstanding.

### v4.10.1
- **`/orion status` says why a task failed.** A row read `FAILED (0%)` and nothing else, so the only way to find out what happened was to open the console, and for the plugin there is no dashboard log to fall back on. The reason was already being computed and handed to `failTask`; it just never reached the status line. Failed rows now carry it, and the achievement path reports the specific cause instead of a blanket "cannot auto-complete": an age-gated or delisted activity, a bypass that failed with the HTTP status and error code, a missing application id, or the bypass setting being off. The reason is scoped to `FAILED` and cleared on any later row for the same quest, so it cannot end up explaining a state the quest is no longer in.
- **The `orion-vencord-bundle` zips for v4.9.9 and v4.10.0 shipped a plugin that is not ours.** The bundle is built from whatever sits in the source clone's `src/userplugins`, and a copy of [QuestUI](https://github.com/Herzchens/QuestUI) had been installed there for testing, so it was compiled into `renderer.js` and `vencordDesktopRenderer.js` inside both zips. QuestUI is GPL-3.0-or-later and our bundle is MIT, so those two artifacts redistributed someone else's plugin under the wrong licence and without their say. Nothing about it was harmful to run and no other artifact was affected: the userscript, the relay and the devbuild installer are all clean, and so is v4.9.8 and everything before it. The packaging script now scans the built bundle for foreign plugin markers and refuses to package rather than trusting the clone to be clean.

### v4.10.0
This release came out of reading what Discord's own client puts on the wire and diffing it against what Orion sends. Every item below was captured at the network layer on a live client, and the real-client side of each comparison came from a genuine game running on the same machine, not from reasoning about the code.

- **Orion's enrollments and claims were missing a field every real one carries.** Discord's quest list ships a server-sealed attribution blob per fetch, and the client hands it straight back on `/enroll` and `/claim-reward` as `traffic_metadata_sealed`. Orion sent neither sealed field, so every enrollment and every claim it ever made was distinguishable from a real one by a field that was sitting unused on the quest record the whole time. Both requests now carry it. Nothing is forged here: it is the server's own value going back where it came from, which is exactly what the real client does. The claim body also stopped sending `metadata_raw` and `traffic_metadata_raw`, two fields Discord never sends, so extra keys were identifying it just as much as the missing ones. Both bodies now match the real client's key set exactly.
- **The stream key advertised a four digit number where a user id belongs.** Discord builds these as `call:<channelId>:<ownerId>` or `guild:<guildId>:<channelId>:<ownerId>`, and its own decoder reads the trailing component back as the stream owner. Orion built `call:<channelId>:<rnd(1000, 9999)>`, so every `ACTIVITY` and `ACHIEVEMENT` heartbeat carried a four digit owner, and a guild voice channel was sent under the `call:` prefix, which decodes as a DM channel id. Fixed in both engines: real snowflake, correct prefix for the channel type.
- **Those same heartbeats were missing `application_id`.** Discord's heartbeat always sends it. Orion sent only `stream_key` and `terminal`.
- **Orion now stops when Discord has blocked enrollment on the account.** The quest list carries `quest_enrollment_blocked_until` and Orion never read it, so a blocked account kept requesting against an endpoint already refusing it, which is the worst available response to being flagged. Checked at the top of every cycle, since the block can land mid-run. Costs no extra request: the value is on the store the client already populates.
- **Activity quests were being run as game quests, and never finished.** Task detection matched `k.includes("PLAY")` before anything else, and `"PLAY_ACTIVITY".includes("PLAY")` is true, so a `PLAY_ACTIVITY` quest was routed to the `GAME` handler: it injected a fake process and then waited for heartbeats Discord does not send for an activity task. The `ACTIVITY` handler was unreachable for its own quest type. Detection now matches the exact keys before the loose prefixes, and the prefixes still catch platform variants like `PLAY_ON_XBOX` and anything new Discord adds. Confirmed both ways on a live client: before the fix the engine logged `Started GAME` and injected a spoofed process; after it, the activity handler runs and sends its own heartbeats.
- **`ACTIVITY` no longer invents progress.** When the heartbeat reply carried no progress the loop fell back to `cur + 20`, so a server crediting nothing still walked the counter to target and the quest was reported complete on the strength of numbers Orion made up. It now only advances on a number Discord actually returned, and gives up after five silent beats. Measured after the routing fix made the handler reachable: five beats, then `Discord credited no progress`, instead of counting itself to a target nothing had credited.

One thing found in the same pass is **not** fixed, because it cannot be. A real game's heartbeat carries `executable_fingerprint`, a native attestation of the running binary; a spoofed game has no process to attest and the field is simply absent. Its `executable_path` differs in shape too. Discord accepted and credited both kinds of heartbeat during testing, so this is not enforced at request time today, but `PLAY_ON_DESKTOP` and `STREAM_ON_DESKTOP` spoofing is distinguishable from real play at the request level and no amount of client-side work changes that.

### v4.9.9
- **Video polling goes back to Discord's own cadence.** v4.8 halved the interval to 3.5-4.75s and the changelog claimed that cut each video quest's wall clock in half. It did not. Progress advances by real elapsed time, so a quest takes `target` seconds either way and the shorter interval only doubled the number of requests. Measured on a live 68 second quest before the revert: 73 seconds of wall clock across 18 requests. Back to 7-9.5s, which is what a real player sends and roughly half the traffic for the same result. The synthetic first ping went with it: it fired 200-350ms in with a timestamp of 0.200-0.250, so every video quest from every user opened with a value inside the same 50ms window, which is a pattern rather than a player. Measured after, on a quest still at zero server-side progress, which is the only state that ping ever fired in: the first request leaves 9.38s in carrying a timestamp of 7.729948, and a 25 second quest finished in four requests.
- **A page reload no longer leaves your Game Activity setting turned off.** With hide-activity on, Orion turns Discord's own "Display current activity as a status message" off for the duration and restores it on stop. Cleanup only runs if the renderer survives, and a plain reload skips it, which is a problem because reloading is the first thing most people try when something looks stuck. Reproduced: reload mid-run and the setting stayed off with no engine running and nothing left holding the old value. The plugin now writes a breadcrumb before turning it off and repairs it when the plugin next loads, so it comes back without needing another quest. The userscript, which persists nothing by design, attempts the restore on `pagehide` and says plainly at suppression time what to re-enable if the client goes away first.
- **The plugin can start itself when you accept a quest** &mdash; new `Watch for enrollments` setting, off by default. While the engine is idle the plugin subscribes to `QuestStore` and starts a run when a quest gains `enrolledAt`, so accepting a quest in Discord's Quests page is enough on its own. The watcher is owned by the plugin rather than the engine, because the engine tears itself down whenever the queue drains and a watcher living inside that lifecycle would switch itself off the moment it succeeded: it is armed by plugin load and `/orion start`, left armed when a run ends on its own, and disarmed by `/orion stop` and by disabling the plugin, since an explicit stop should not be undone by the engine restarting itself. It only reacts to a quest that gained `enrolledAt` since the last look, not to any store change, so progress ticks and dismissals don't wake it. Worth being clear about what turning it on means: the engine can then start while you are away from the keyboard, which is a change in exposure under Discord's quest-automation enforcement rather than only a convenience. It also does not narrow what a run picks up, so pair it with auto-enroll off unless you want one accepted quest to wake a run that enrolls in everything else ([#47](https://github.com/nyxxbit/discord-quest-completer/issues/47)).
- **Auto-enroll is a setting in the plugin now** &mdash; the plugin always JIT-enrolled every available quest, so there was no way to run only the ones you accepted yourself; the userscript has had that toggle since the picker landed in v4.5, and this is a port of it rather than a new design. With it off, a quest you have not accepted is left untouched and listed as `PENDING` instead of being queued, and because the cycle re-reads the quest list every few seconds it starts on its own the moment you accept it in Discord, with no restart and no state that outlives the run. Default is on, so nothing changes unless you turn it off. `/orion status` also says what a pending quest is waiting for: the userscript can afford a bare `PENDING` because its dashboard draws an ENROLL button next to the row, and the plugin has no dashboard to draw one on ([#47](https://github.com/nyxxbit/discord-quest-completer/issues/47)).

### v4.9.8
- **Fix: hide-activity never hid anything** &mdash; both engines implemented it by skipping their own `LOCAL_ACTIVITY_UPDATE` dispatch, but that event only carries RPC-socket activities. Discord builds the "Playing X" presence from the running-game store itself (`LocalActivityStore` / `ActivityTrackingStore` read `getVisibleGame` / `getVisibleRunningGames`), which is exactly what the Patcher started overriding in v4.9.6 to get heartbeats flowing again ([#43](https://github.com/nyxxbit/discord-quest-completer/issues/43)) &mdash; so since that release the spoof itself published the status and the toggle was a no-op. Both engines now turn Discord's own `status.showCurrentGame` off while a fake game is up and restore the previous value on cleanup, leaving the store spoof (and therefore quest eligibility) untouched. The friends-list entry reads "Not Sharing" while quests run and progress advances normally. The plugin goes through Vencord's `UserSettingsAPI`, which it now declares as a dependency &mdash; `getUserSetting()` throws for plugins that don't, and that API is not enabled by default; the userscript reaches the protobuf settings directly, since a console script has no plugin manifest to declare anything with. The plugin also read the setting once at engine start, so toggling it mid-run did nothing until stop/start; it is read live now, and the plugin acts on the change the moment it is made. Reading it live is necessary but not sufficient: suppression is recomputed when a fake game is added or removed, and a game quest holds one for up to 25 minutes, so a toggle mid-quest would still have sat there doing nothing. The plugin subscribes to the setting and re-evaluates on the spot, detaching the listener on stop. Known limitation: if Discord is force-killed mid-run, cleanup never runs and the setting stays off until re-enabled by hand.
- **Fix: stopping a quest part-way locked it out of every later start** &mdash; the plugin's dashboard registry is module state that outlives the engine, and `stopOrion()` never touched it, so a quest interrupted by `/orion stop` kept an entry reading `RUNNING`. The cycle loop skips quests in that state, so the queue came up empty on every subsequent `/orion start` while `/orion status` still reported the phantom task. In-flight entries are retired to `STOPPED` on shutdown, late progress updates can no longer re-mark a quest as running once the engine is down, and rows from earlier runs are pruned at start instead of at stop so results stay readable after a run. Auditing the rest of the plugin's module state for the same pattern turned up five more, two of which could hang the cycle loop outright: a rate-limited request rescheduled past a shutdown was dropped without settling its promise, so the awaiting task waited forever (the userscript already rejected with `Shutdown` here &mdash; the port had lost that branch); and a stopped `GAME`/`STREAM` task never resolved at all, because the shutdown cleanup cleared the very timers that would have resolved it, leaving the loop parked and the engine's own teardown unreachable. Either hang then desynced the slash command's private `isRunning` flag from the engine, at which point `/orion stop` answered "Not running." while the engine was still up &mdash; it now reads the engine directly. Also fixed in both engines: two overlapping `STREAM` tasks stashed each other's spoofed `getStreamerActiveStreamMetadata` and one of them restored a fake permanently, so the original is captured once and the spoof refcounted.
- **Fix: userscript lifecycle and transport-fallback issues** &mdash; the `>` dashboard hotkey registered a document-level listener that shutdown never detached, so it outlived the dashboard and stacked one more copy on every paste, each closing over a dead overlay. Clicking **STOP** and pasting again within a second was also a dead end: the re-entry guard stayed held for the full grace period, so the new paste was refused with "Already running." while the overlay it had just re-shown was removed a moment later by the old timer, leaving nothing on screen; the guard is released immediately now, and the teardown holds references to its own nodes so it can no longer delete a newer dashboard's stylesheet. The manual **CLAIM REWARD** button could stick at "WAITING..." for the rest of the session when the claim endpoint answered 2xx without `claimed_at` &mdash; neither the success branch nor the catch fired, so the state was never reset. The localhost-relay probe cached its answer for the whole run in both directions, so a relay started mid-run was never picked up and one that died was still used; it now re-probes on a one-minute TTL and drops the cached answer if the relay stops responding mid-POST, letting the next transport take over. The `DiscordNative` fallback no longer speculatively invokes `fileManager.fetchURL` or `processUtils.fetch` &mdash; neither is an HTTP client, and calling privileged IPC with a POST-shaped argument risks side effects the return-shape check cannot detect. Quest ids are now escaped where they reach `innerHTML`, matching the rule already applied to quest and reward names.
- **Fix (plugin): `Verbose logging` did nothing at all** &mdash; the setting was defined but never read anywhere in the plugin. Vencord's `Logger.debug` always calls `console.debug`, which browsers hide unless the console is switched to Verbose, so every debug line was emitted regardless of the toggle and whether you saw it came down to a DevTools filter. Debug output now goes through one gate: with the setting on it is raised to info level, where it shows by default; with it off nothing changes from before.
- **Fix (plugin): enabling `Try achievement bypass` mid-run left already-skipped quests skipped** &mdash; when the bypass is off the plugin logs "enable it in settings if you want it" and marks the quest skipped, in the same set used for quests that genuinely cannot be completed. Acting on that message did nothing until a full stop/start, because `activeQuests()` filters that set for the life of the run. A refusal for want of consent is now recorded separately from a real failure, and switching the setting on returns those quests to the queue for the next cycle.
- **Concurrency sliders now say when they apply** &mdash; both are read when a cycle starts, so a change affects the next batch rather than tasks already running. Behaviour is unchanged; it just wasn't written down anywhere.
- Adds `hooks.ts`, a dependency-free bridge that lets a settings change reach the running engine. `settings.ts` cannot import `orion.ts` directly &mdash; that closes an import cycle &mdash; and the engine clears its handlers on stop so a hook never outlives the run it belongs to.

### v4.9.7
- **The repo installs as a Vencord userplugin now** &mdash; paste `https://github.com/nyxxbit/discord-quest-completer` into nin0's `UserpluginInstaller` and it clones, builds and self-updates from there, no manual clone or file copying ([#42](https://github.com/nyxxbit/discord-quest-completer/issues/42)). That installer does a plain `git clone` into `src/userplugins`, and Vencord's build only reads `index.ts(x)` and `native.ts` from the top level of a plugin folder, so the plugin sources had to move out of `vencord-plugin/` and up to the repo root; a subdirectory layout cannot work with either. `vencord-plugin/README.md` moved to [`docs/VENCORD-PLUGIN.md`](docs/VENCORD-PLUGIN.md). The userscript keeps its path and its raw URL and is not part of the plugin build &mdash; both esbuild and the installer resolve `index.tsx` ahead of `index.js`. A CI job now clones Vencord, checks this repo out the way the installer would, builds, and asserts the plugin reached the renderer and main-process bundles with the slash command registered and no userscript leakage; it builds against Vencord's default branch weekly, so an upstream change that breaks the plugin shows up there instead of in a bug report. The quest engine itself is unchanged this release.

### v4.9.6
- **Fix: game quests never progressed** &mdash; Discord's `taskConfigV2` moved the application off the quest config and onto each task (`tasks.PLAY_ON_DESKTOP.applications[0].id`); `config.application.id` no longer exists, so every game/stream quest fell through to a `?? 0` fallback and injected a process claiming to be application `0`. Discord could never match that to the quest, so it never sent a single heartbeat and the quest sat at 0% ([#43](https://github.com/nyxxbit/discord-quest-completer/issues/43)). This hit Canary first and has since reached Stable. Canary also derives quest eligibility from `getVisibleGame` / `getVisibleRunningGames` / `getRunningDiscordApplicationIds` / `getCandidateGames`, which the old patch left empty &mdash; all four are now patched when present and restored on cleanup. Two things had been hiding the failure: the dashboard ticker incremented progress locally every second regardless of heartbeats, so a quest earning nothing still showed a bar climbing to 100%, and nothing failed until the 25-minute timer. The ticker now extrapolates only from the last real heartbeat, so it can't run past what Discord reported, and a game/stream task with no heartbeat inside 90s aborts with a clear message. Progress also reads the task key detected from the config instead of a hardcoded `PLAY_ON_DESKTOP` (so `PLAY_ON_DESKTOP_V2` resolves) and seeds from the server's stored value on start. The legacy `config.application.id` path remains as a fallback for clients that haven't picked up the change yet.
- **Fix: the achievement bypass was dead for the same reason** &mdash; `bypassAchievement` still read `config.application.id` directly and returned early when it resolved to nothing, so every `ACHIEVEMENT_IN_ACTIVITY` quest fell straight through to "Cannot auto-complete" without ever attempting the Discord Says flow. It now uses the application id already resolved for the task, keeping the legacy read as a fallback and the numeric guard unchanged. Verified end to end against live quests on both engines: the userscript completes the quest through the localhost relay, the Vencord plugin through its native module, and in both cases the temporary OAuth grant is revoked afterwards while pre-existing authorizations are left untouched.
- **Fix: a game/stream quest that stalled after its first heartbeat still idled for 25 minutes** &mdash; the no-heartbeat watchdog only checked once, so it caught a quest that never started but not one that stopped partway. It is now re-armed on every heartbeat and reports which case it hit.
- **Fix (plugin): quests skipped for a missing application id were re-announced every cycle** &mdash; the skip was recorded in a set that nothing reads, so the same quest was re-detected and re-logged every few seconds. It now goes into the set `activeQuests()` actually filters on.

### v4.9.5
- **Fix: the Vencord installer bundle no longer breaks Vencord's updater** &mdash; The bundle was shipping a build compiled in git-updater mode (`Standalone: false`) into `%APPDATA%\Vencord`, which has no git repo, so Vencord threw `not a git repository` every launch and showed "can't check for updates" ([#39](https://github.com/nyxxbit/discord-quest-completer/issues/39)). The plugin was never the cause; it was the build flags. The bundle is now built `--standalone --disable-updater`, which turns the updater off cleanly (no error, and no risk of the standalone HTTP updater silently reverting the dist to vanilla and deleting the plugin). Honest tradeoff, now documented: Vencord is frozen at the bundled version; to get updates back, reinstall official Vencord and re-run the installer. `INSTALL.cmd` now backs up your existing Vencord build to `dist.orion-backup` first so it's undoable. Userscript and plugin source are unchanged this release; only the installer bundle differs. Root cause was pinned by a senior review panel that read the Vencord updater internals.

### v4.9.4
- **Deeper security pass on the ACHIEVEMENT bypass** &mdash; A multi-angle audit following [#38](https://github.com/nyxxbit/discord-quest-completer/issues/38) surfaced more to address. The bypass now requires **explicit consent before authorizing any app**: the userscript shows a popup with the app name, the OAuth scopes, and a note that it revokes right after (defaults to decline, so an idle prompt never authorizes); the Vencord plugin gates it behind an off-by-default setting. A failed grant snapshot now **aborts before authorizing** instead of authorizing without a way to revoke. `redirect: "error"` on every `discordsays.com` fetch (userscript and native module) so a 3xx can't bounce the auth token to another host. The native module validates the `questId` and `Referer`, not only the `appId`. The relay reflects CORS only to Discord origins, drops non-allowlisted headers, caps the body size, and checks the `Host`. **Also fixed a stored-DOM-injection bug** &mdash; a crafted quest or reward name could inject markup into the dashboard; all server-controlled strings are now escaped. Plus assorted hardening: guarded JSON parsing of activity responses, NaN-safe quest expiry, and listener/audio/shutdown leak fixes. `docs/ARCHITECTURE.md` rewritten to match the current engine.

### v4.9.3
- **Security hardening of the ACHIEVEMENT bypass** &mdash; From a detailed security report ([#38](https://github.com/nyxxbit/discord-quest-completer/issues/38)). The OAuth grant cleanup now runs in a `finally` block, so a failed bypass never leaves the quest's app authorized on your account, and it only revokes the grant Orion created (diffed against a pre-flow snapshot of your existing grants) so it won't touch an authorization that already existed before the run. The localhost relay no longer follows redirects and rejects any host or path outside the two `discordsays.com` endpoints it needs. The userscript and the Vencord native module both validate the application id is numeric before building any URL (closes the SSRF angle). The README now spells out the full OAuth lifecycle and the account-level ban risk. The non-tech installer bundle is English-only now (`INSTALL.cmd`).

### v4.9.2
- **Cleaner picker when the options panel is open** &mdash; Clicking the gear now hides the quest list and the START/DESELECT buttons while the options are showing, so the panel isn't buried under a long quest list. Click the gear again to bring them back. Minor CSS spacing fixes too. Thanks to @TirOFlanc in [#37](https://github.com/nyxxbit/discord-quest-completer/pull/37).

### v4.9.1
- **Fix: Vencord plugin skipped GAME/STREAM quests on desktop** &mdash; The plugin detected "desktop" by probing `window.DiscordNative`, which isn't reliably visible from the plugin's execution context. Game quests were wrongly skipped with `requires desktop app. Skipping.` even on Discord Desktop, while the userscript handled them fine. Switched to Vencord's build-time `IS_DISCORD_DESKTOP` / `IS_VESKTOP` globals. Resolves [#35](https://github.com/nyxxbit/discord-quest-completer/issues/35).

### v4.9
- **`ACHIEVEMENT_IN_ACTIVITY` auto-bypass works on stock Discord Desktop** &mdash; no Vencord, no BetterDiscord, no client mod. The trick is a tiny localhost HTTP relay ([`tools/orion-relay/`](tools/orion-relay/)) that the userscript probes on boot. Discord's CSP allows `connect-src http://127.0.0.1:*` (for RPC with games); the relay forwards POSTs to `*.discordsays.com` from outside the browser sandbox. One PowerShell script + one `.cmd` launcher, ~100 lines total. Download from the release page, double-click to start, leave the window open, paste the userscript. Done.
- **Transport picker priority** &mdash; `_bypassPost` now tries (1) Orion Relay on `127.0.0.1:43210`, (2) Vencord plugin via `VencordNative.pluginHelpers.OrionQuests`, (3) `DiscordNative` HTTP probes (best-effort for future Discord builds), (4) direct `fetch` (web Discord). First hit wins.

### v4.8.2
- **Userscript hands off discordsays POSTs to the Vencord plugin when installed** &mdash; New `_bypassPost` transport picker. On Discord Desktop with Vencord + OrionQuests plugin installed, the userscript console script now detects `VencordNative.pluginHelpers.OrionQuests` and routes the CSP-blocked POSTs through the plugin's native module instead of failing. So `ACHIEVEMENT_IN_ACTIVITY` auto-completes from the standalone userscript too, as long as the Vencord plugin is also installed. Also probes `DiscordNative.http`, `DiscordNative.fileManager.fetchURL`, and a few sibling paths as a best-effort fallback in case a future Discord build exposes generic HTTP. On web Discord (no Vencord, no CSP), direct `fetch` works.

### v4.8.1
- **Honest CSP error message + Vencord native bypass** &mdash; Testing v4.8 surfaced that Discord's renderer CSP (`connect-src` allowlist) blocks the final `fetch()` to `*.discordsays.com` from the userscript. Steps 1-2 of the bypass (OAuth2 authorize + proxy-ticket mint) work; step 3 (POST to the activity backend) does not. The userscript now detects the CSP failure and prints a clear message pointing to the Vencord plugin instead of "Failed to fetch". The [Vencord plugin port](docs/VENCORD-PLUGIN.md) gained a native module (`native.ts`) that runs the discordsays POSTs in the Electron main process where CSP doesn't apply &mdash; **confirmed working in production against real ACHIEVEMENT_IN_ACTIVITY quests**.

### v4.8
- **ACHIEVEMENT_IN_ACTIVITY auto-bypass** &mdash; New OAuth2 → discordsays.com handshake. When Discord's heartbeat endpoint rejects (HTTP 403, which it does for most current Achievement quests), Orion now authorizes against the activity's own backend, mints a proxy ticket, and POSTs the target progress directly. No more 25-minute passive wait, no more "join the activity manually". The previous picker toggle to skip these is now mandatory behavior &mdash; if both paths fail (typically age-gated or delisted activities like *The Odyssey*), the quest is skipped cleanly instead of blocking a queue slot. **Note: the discordsays.com POSTs are blocked by Discord's renderer CSP &mdash; the userscript can only complete the OAuth handshake locally. See [v4.8.1](#v481) for the workaround.**
- **2x faster video polling** &mdash; Video heartbeats now run at 3.5-4.75s instead of 7-9.5s. Discord's server-side validation accepts the faster cadence. **This entry was wrong and is reverted in v4.9.9:** it claimed the change cut each video quest's wall-clock in half, and it did not. Progress advances by real elapsed time, so the quest takes the same number of seconds either way and the shorter interval only doubled the request count.
- **Two parallel video quests** &mdash; Video concurrency raised from 1 to 2. Two video quests complete simultaneously instead of serially.
- **Fix `TypeError: Cannot read properties of null` on gear-icon click** &mdash; The options gear stays mounted in the header after the picker closes, but its panel doesn't. Added a null guard so post-picker clicks no longer throw.

### v4.7
- **Collapse-on-double-click + drag boundaries** &mdash; Double-click the header to minimize the panel to a 50px stub; double-click again to expand. The dashboard can no longer be dragged outside the viewport on either axis. Picker options panel hidden behind a new gear icon (`⚙️`) for a cleaner first-paint. Thanks to @TirOFlanc in [#32](https://github.com/nyxxbit/discord-quest-completer/pull/32).
- **Skip manual activities** &mdash; New picker toggle. When ACHIEVEMENT_IN_ACTIVITY quests fall back to passive mode (waiting for you to actually play the activity), the script now optionally fail-fast skips them so the queue keeps moving instead of blocking a slot for 25 minutes. Default off. Resolves [#33](https://github.com/nyxxbit/discord-quest-completer/issues/33).
- **Random 1-30min delay between cycles** &mdash; New picker toggle. Injects a randomized idle gap between quest cycles for anti-detection during long AFK runs. Default off (preserves current behavior). Implements the request in [#30](https://github.com/nyxxbit/discord-quest-completer/issues/30).
- **Dashboard persists when rewards are unclaimed** &mdash; The widget no longer auto-shuts down the moment the last quest completes if any task still has a CLAIM button waiting. Click STOP manually after claiming. Resolves [#31](https://github.com/nyxxbit/discord-quest-completer/issues/31).

### v4.6.3
- **Fix CSP violation in credit text** &mdash; The header's `by syntt_` was an `<a>` with inline `onmouseover` / `onmouseout` handlers. Discord enforces strict CSP and rejected the inline handlers with a console error; the link itself also redirected to `/@me` (Discord's URL scheme does not open user profiles via `discord.com/users/<id>`). Replaced with a plain `<span class="dev-credit">` and moved styling into the stylesheet. Resolves [#29](https://github.com/nyxxbit/discord-quest-completer/issues/29).

### v4.6.2
- **Native UI overhaul** &mdash; Replaced hardcoded hex colors with Discord's native CSS variables. The widget now automatically adapts to Light, Dark, AMOLED, and custom themes.
- **Circular progress & decluttering** &mdash; Switched linear progress bars to circular indicators (hover to see exact percentages). Completed quests now hide unnecessary text to keep the interface clean.
- **Desktop environment guard** &mdash; The script now checks for `window.DiscordNative`. Game and Stream quests are automatically hidden and skipped if you run the script in a web browser.
- **Removed window position saving** &mdash; Dropped `localStorage` usage for tracking the widget's coordinates to fix console spam and `window.localStorage is undefined` errors on newer Discord builds where storage access is restricted.
- **Optimistic UI & under-the-hood fixes** &mdash; Added a local ticker for smooth visual progress updates.

### v4.6.1
- **Louder completion sound** &mdash; Bumped the gain on the quest-completion ping (0.12 &rarr; 0.45) and arpeggio (0.18 &rarr; 0.55). Headphone users were complaining the tone was inaudible.

### v4.6
- **Vencord integration** &mdash; `loadModules` now uses `window.Vencord.Webpack` directly when Vencord is installed. Restores full functionality on modern Discord Stable, where the native chunk push hook can no longer reach the live module cache. Resolves [#20](https://github.com/nyxxbit/discord-quest-completer/issues/20)
- **Sentry-proof native extraction** &mdash; The push callback fires once per registered runtime; Discord ships Sentry's stripped runtime alongside the real one. The capture now picks the require with the largest `.c`, ignoring Sentry's tiny instance. Resolves [#23](https://github.com/nyxxbit/discord-quest-completer/issues/23) and [#26](https://github.com/nyxxbit/discord-quest-completer/issues/26)
- **Sound on completion** &mdash; New picker toggle plays a soft tone after each quest finishes and a 3-note arpeggio when the whole queue is done. Useful with auto-claim off so you can come back before the captcha times out. Resolves [#24](https://github.com/nyxxbit/discord-quest-completer/issues/24)

### v4.5.5
- **Hotfix Canary regression from v4.5.4** &mdash; first attempt at the dual-capture path. Superseded by v4.6's Sentry-proof solution.

### v4.5.4 (broken on Canary &mdash; use v4.5.5+)
- **Resilient `loadModules`** &mdash; `__webpack_require__` is now captured via the chunk callback closure instead of relying on `push()`'s return value. Some Discord builds return `undefined` from `push`; the callback always fires with the require argument
- **CSS `:disabled` styling** &mdash; Claim button disabled/failed states are driven by `:disabled` and a `.failed` modifier class. No more inline-style assignments scattered across handler code
- **Filter handler dedup** &mdash; The reward-filter and type-filter click handlers were near-identical; now collapsed into a single `FILTER_KINDS` table-driven path
- **Icon resolution simplification** &mdash; 7-arm if/else chain in `Logger.render` replaced with a single ternary expression

### v4.5.3
- **Pending state** &mdash; Unenrolled quests now wait for manual acceptance in Discord instead of failing when auto-enroll is disabled.
- **Ghost-task fix** &mdash; Unenrolled and hidden quests no longer attempt execution or time out in the background.
- **Claim button lock** &mdash; Prevented API spam and visual state resets by locking the "Claim Reward" button during UI renders.
- **Picker refactor** &mdash; Moved UI logic inside `Logger` and switched to native HTML forms for resilient state collection.
- **Dynamic filters** &mdash; Added Quest Type filtering.

### v4.5.2
- **Fix NodeList error** &mdash; `$$` now returns a real Array so `.every()` works on visible quest cards. Resolves `TypeError: visible.every is not a function` when clicking (De)select All

### v4.5.1
- **Fix (De)select All** &mdash; The toggle button now correctly checks/unchecks visible quest checkboxes without hiding them. Reward filters remain independent. Button label syncs with actual checkbox state

### v4.5
- **Quest picker UI** &mdash; Script no longer starts immediately. A visual quest picker shows all available quests with checkboxes, color-coded by reward type (Orbs, Avatar Decorations, In-Game Items). Filter entire reward categories with one click, select/deselect individual quests, then hit START
- **Options panel** &mdash; Toggle auto-enroll and auto-claim directly from the picker UI before starting. No more editing CONFIG to control these behaviors
- **Reward type filters** &mdash; Pill buttons at the top let you enable/disable entire reward categories. Disabling "Orbs" hides and unchecks all Orb quests instantly

### v4.4
- **JIT enrollment** &mdash; Quests enroll one at a time right before execution instead of in bulk, eliminating mass-enrollment detection vectors
- **Natural video polling** &mdash; Replaced static 1s intervals with 7&ndash;9.5s polling using 6-decimal float timestamps that match native Chromium player behavior
- **Randomized delays** &mdash; All fixed-interval API calls now use randomized timing ranges to break predictable patterns
- **Correct Windows PIDs** &mdash; Fake game process IDs generated as multiples of 4 to comply with Windows NT kernel architecture
- **Sequential execution** &mdash; Both game and video tasks now run sequentially (concurrency&nbsp;=&nbsp;1) to avoid parallel request spikes
- **Proper cleanup** &mdash; Removes `#orion-styles` element on shutdown, debug logging for previously silent catch blocks

### v4.3
- **GO TO QUESTS button** &mdash; Achievement quests in `RUNNING` state now show an `ACTION REQUIRED` status with a navigation button that uses Discord's native router (`transitionTo('/quest-home')`) to jump straight to the quest page
- **Resilient router detection** &mdash; New `findRouter()` locates Discord's minified `transitionTo` by source signature (`"transitionTo -"`), no hardcoded paths
- **Standardized log tags** &mdash; Unified prefixes across the codebase (`[System]`, `[Network]`, `[Task]`, `[Cycle]`, `[Enroll]`, `[Claim]`) for consistent, readable output
- **Cleaner UI logs** &mdash; `debug` level messages now go to DevTools only and no longer spam the in-app dashboard
- **Achievement progress display** &mdash; Progress text now omits the `s` (seconds) suffix for `ACHIEVEMENT` quests since their target is a count, not a duration
- **Fixed progress text updates** &mdash; Restored missing `progress-text` class so live progress numbers update correctly on task cards

### v4.2
- **Native UI Claiming:** Added in-UI claiming via Claim Reward button.
- **Rigid Configuration:** Moved hardcoded system limits to a frozen `SYS` object and added `TRY_TO_CLAIM_REWARD` config.
- **Fault-Tolerant Concurrency:** Switched to `Promise.allSettled` to prevent queue crashes on a single task failure.
- **Strict Garbage Collection:** Added `RUNTIME.cleanups` to track and safely flush active event listeners on script stop.
- **RPC & Lock Failsafes:** Forces dummy PID `9999` to reliably clear "Playing" status, and releases `window.orionLock` on fatal errors.
- **Granular Rate Limiting:** Differentiates between global (queue-freezing) and endpoint-specific API limits.

### v4.1
- Resilient `loadModules()` &mdash; uses `constructor.displayName` instead of hardcoded `.A/.Z/.Ay/.ZP` paths
- Auto-claim rewards (optimistic POST + captcha fallback with CLAIM button)
- Adaptive video speed (6-22 API calls instead of 180 for 900s quests)
- `ACHIEVEMENT_IN_ACTIVITY` handler for milestone-based quests
- `WATCH_VIDEO_ON_MOBILE` progress tracking fix
- Task sorting by progress percentage
- Per-cycle try-catch for crash isolation
- Fixed scroll (After activating the script, it turned blue when hovered)

### v4.0
- Fixed Issue #5: enrollment 404 no longer crashes the script
- ErrorHandler module with retry/skip/fatal classification
- Traffic queue with exponential backoff for 5xx errors
- Skip-list for permanently failed quests
- Idempotent cleanup in GAME/STREAM handlers

---

## Disclaimer

This tool is for **educational and research purposes only**. Automating user actions violates Discord's [Terms of Service](https://discord.com/terms). The developer is not responsible for any account suspensions or bans. Use at your own risk.

---

<div align="center">

Built by [**syntt_**](https://discord.com/users/1419678867005767783)

If this helped you, drop a star &mdash; it keeps the project alive.

</div>
