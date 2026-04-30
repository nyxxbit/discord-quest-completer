<div align="center">

# Orion

**Auto-complete every Discord Quest in seconds** &mdash; v4.5.4

[![Version](https://img.shields.io/badge/v4.5.4-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://github.com/nyxxbit/discord-quest-completer)
[![Stars](https://img.shields.io/github/stars/nyxxbit/discord-quest-completer?style=for-the-badge&color=faa61a)](https://github.com/nyxxbit/discord-quest-completer/stargazers)
[![License](https://img.shields.io/badge/MIT-green?style=for-the-badge)](LICENSE)

Completes all Discord Quests automatically &mdash; game, video, stream, activity, and achievement quests. Paste one script into DevTools, get every reward. No installs, no tokens, no dependencies.

**Works on every Discord update** &mdash; no hardcoded paths, uses `constructor.displayName` for resilient module detection.

[Get Started](#quick-start) &bull; [How It Works](#how-it-works) &bull; [Configuration](#configuration)

</div>

---

> [!WARNING]
> **Discord Stable build 536904+ is partially incompatible** (late April 2026). A new Stable build changed the webpack runtime so `webpackChunkdiscord_app.push` no longer exposes the live module cache through any post-boot path. v4.5.4 fixes the original `Cannot read properties of undefined (reading 'c')` error but cannot reach the live store cache &mdash; a full fix requires boot-time injection (see [#20](https://github.com/nyxxbit/discord-quest-completer/issues/20)).
>
> **Workaround:** use [Discord Canary](https://canary.discord.com/download) for now. Community PRs to land boot-time injection are welcome.

---

## Why Orion?

- **Completes ALL quest types** &mdash; Video, Game, Stream, Activity, and the new Achievement quests
- **Auto-claiming** &mdash; Claim rewards directly from the dashboard. Tries to claim automatically (if enabled), or provides a smart interactive button if captcha is needed
- **Resilient module loader** &mdash; finds Discord stores by class name, not minified paths. Survives Discord updates
- **Smart rate limiting** &mdash; exponential backoff on 429/5xx, skip-list for dead quests, randomized polling intervals. Distinguishes between global and endpoint limits, non-blocking retries
- **Fault-tolerant execution** &mdash; One failed quest won't break the queue (`Promise.allSettled`)
- **Zero setup** &mdash; single paste into the console. No Node.js, no npm, no extensions

---

## Quick start

> [!IMPORTANT]
> **Discord Desktop client only.** Orion hooks into Discord's internal webpack stores, which are only exposed in the desktop app (Stable, PTB, or Canary). It will **not** work in browser Discord, mobile Discord, or any web-based client &mdash; even with DevTools or script-injection extensions like Kiwi Browser. `GAME` and `STREAM` quests in particular are impossible outside the desktop client.

**1.** Open Discord ([Canary](https://canary.discord.com/download) recommended &mdash; console enabled by default)

**2.** Press `Ctrl + Shift + I` &rarr; Console tab

**3.** Paste [`index.js`](index.js) and hit Enter

> `Shift + .` toggles the dashboard. Click **STOP** to kill it instantly.

<details>
<summary>Enable console on stable Discord</summary>

Close Discord, edit `%appdata%/discord/settings.json`:

```json
{ "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING": true }
```

Restart Discord.
</details>

---

## How it works

Orion extracts Discord's internal webpack stores (`QuestStore`, `RunStore`, `Dispatcher`, etc.) and uses them to spoof game processes, send fake video progress, and dispatch heartbeat signals &mdash; all through Discord's own authenticated API client.

```
QuestStore → filter incomplete → JIT enroll → dispatch tasks → poll progress → auto-claim → done
```

| Quest type | What Orion does |
|------------|----------------|
| **Video** | Sends fake `video-progress` timestamps with natural 7-9.5s polling intervals and precise float payloads |
| **Game** | Injects a spoofed process into `RunStore` with real metadata from Discord's app registry |
| **Stream** | Patches `StreamStore.getStreamerActiveStreamMetadata` with synthetic stream data |
| **Activity** | Heartbeats against a voice channel to simulate participation |
| **Achievement** | Monitors `ACHIEVEMENT_IN_ACTIVITY` events &mdash; requires joining the Activity manually |

---

## Dashboard

Draggable overlay with persistent position. Live-sorts tasks so you always see what matters:

| Priority | State | Visual |
|----------|-------|--------|
| 1st | **Running** (highest progress first) | Blue accent, animated progress bar |
| 2nd | **Queued** | Orange accent, dimmed |
| 3rd | **Completed** | Green checkmark + Interactive CLAIM button if manual action needed |

Desktop notifications fire on each quest completion.

---

## Auto & In-UI Claiming

You can configure Orion's claiming behavior via the `TRY_TO_CLAIM_REWARD` setting.

- **Automated Claiming:** If enabled, tries to claim instantly upon completion.
- **In-UI Button:** If auto-claim fails due to captcha, or is disabled, a **CLAIM REWARD** button appears directly on the task card.

---

## Configuration

Most settings are now configurable through the **quest picker UI** that appears before the script starts:

- **Reward filters** &mdash; Toggle quests by reward type (Orbs, Avatar Decorations, In-Game Items)
- **Quest checkboxes** &mdash; Select/deselect individual quests
- **Auto-enroll** &mdash; Automatically accept quests before running them (default: ON)
- **Auto-claim** &mdash; Attempt to claim rewards on completion (default: OFF to avoid captcha)

Advanced settings can still be tweaked in the `CONFIG` object before pasting:

```js
const CONFIG = {
    HIDE_ACTIVITY: false,        // suppress "Playing..." from friends list
    MAX_LOG_ITEMS: 60,           // UI log limit
};
```

---

## Error handling

| Scenario | Behavior |
|----------|----------|
| **429 / 5xx** | Exponential backoff, re-queued up to `MAX_RETRIES`, distinguishes global vs endpoint limits |
| **404 on enroll** | Quest added to skip-list, script continues |
| **Repeated failures** | Task abandoned after `MAX_TASK_FAILURES` consecutive errors |
| **25 min timeout** | Task force-stopped, cycle advances |
| **Missing modules** | Required modules validated on boot; optional ones log a warning |
| **Claim fails** | Falls back to CLAIM button in dashboard |
| **Fatal crash** | Unconditionally releases `window.orionLock` so the script can be re-run without refreshing |

---

## Architecture

Single-file IIFE. No build tools, no external deps.

```
index.js
├─ CONFIG / SYS / RUNTIME      tunables, frozen system limits, active cleanups
├─ ErrorHandler                classifies HTTP errors (retry / skip / fatal)
├─ Logger                      DOM dashboard + task state + log output
├─ Traffic                     FIFO request queue with exponential backoff
├─ Patcher                     RunStore / StreamStore monkey-patching
├─ Tasks                       VIDEO, GAME, STREAM, ACTIVITY, ACHIEVEMENT handlers
├─ loadModules()               resilient webpack extraction via constructor.displayName
└─ main()                      discover → JIT enroll → execute → claim → loop
```

### Module detection

Unlike other scripts that break on every Discord update, Orion finds stores by their **class name** (`QuestStore`, `RunningGameStore`, etc.) via `constructor.displayName`. The Dispatcher is found by structural signature (`_subscriptions` + `subscribe` + `dispatch`), and the API client by its unique `.del` method. No hardcoded minified paths.

For a full internal tour of the script, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Contributing

Contributions are welcome &mdash; bug reports, PRs, and docs. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for the checklist and code style. Use the issue templates when reporting bugs or requesting features.

---

## Changelog

### v4.5.4
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
