<div align="center">

<img src="https://cdn.discordapp.com/emojis/1120042457007792168.webp" width="80" />

# Orion

**Auto-complete every Discord Quest in seconds** &mdash; v4.1

[![Version](https://img.shields.io/badge/v4.1-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://github.com/nyxxbit/discord-quest-completer)
[![Stars](https://img.shields.io/github/stars/nyxxbit/discord-quest-completer?style=for-the-badge&color=faa61a)](https://github.com/nyxxbit/discord-quest-completer/stargazers)
[![License](https://img.shields.io/badge/MIT-green?style=for-the-badge)](LICENSE)

Completes all Discord Quests automatically &mdash; game, video, stream, activity, and achievement quests. Paste one script into DevTools, get every reward. No installs, no tokens, no dependencies.

**Works on every Discord update** &mdash; no hardcoded paths, uses `constructor.displayName` for resilient module detection.

[Get Started](#quick-start) &bull; [How It Works](#how-it-works) &bull; [Configuration](#configuration)

</div>

---

## Why Orion?

- **Completes ALL quest types** &mdash; Video, Game, Stream, Activity, and the new Achievement quests
- **Auto-claims rewards** &mdash; tries to claim without captcha; shows a CLAIM button when captcha is needed
- **Resilient module loader** &mdash; finds Discord stores by class name, not minified paths. Survives Discord updates
- **Smart rate limiting** &mdash; exponential backoff on 429/5xx, skip-list for dead quests, adaptive video speed
- **Zero setup** &mdash; single paste into the console. No Node.js, no npm, no extensions

---

## Quick start

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
QuestStore → filter incomplete → auto-enroll → dispatch tasks → poll progress → auto-claim → done
```

| Quest type | What Orion does |
|------------|----------------|
| **Video** | Sends fake `video-progress` timestamps with adaptive speed (6-22 API calls instead of 180) |
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
| 3rd | **Completed** | Green checkmark + CLAIM button if captcha needed |

Desktop notifications fire on each quest completion.

---

## Auto-claim

After completing a quest, Orion tries to claim the reward automatically:

- **No captcha needed?** &rarr; Claimed instantly, logged as `[Claim] reward claimed automatically!`
- **Captcha required?** &rarr; Shows a green **CLAIM REWARD** button on the task card that opens the quest page

---

## Configuration

Tweak before pasting. Timing values in milliseconds unless noted.

```js
const CONFIG = {
    VIDEO_SPEED: 5,              // baseline fake seconds per tick (auto-scales for longer videos)
    HIDE_ACTIVITY: false,        // suppress "Playing..." from friends list
    GAME_CONCURRENCY: 1,         // parallel game tasks (1 = safest)
    REQUEST_DELAY: 1500,         // gap between API calls
    MAX_TASK_TIME: 25 * 60_000,  // hard timeout per task
    MAX_TASK_FAILURES: 5,        // consecutive errors before abandoning a task
    MAX_RETRIES: 3,              // retries for transient (5xx) errors
};
```

---

## Error handling

| Scenario | Behavior |
|----------|----------|
| **429 / 5xx** | Exponential backoff, re-queued up to `MAX_RETRIES` |
| **404 on enroll** | Quest added to skip-list, script continues |
| **Repeated failures** | Task abandoned after `MAX_TASK_FAILURES` consecutive errors |
| **25 min timeout** | Task force-stopped, cycle advances |
| **Missing modules** | Required modules validated on boot; optional ones log a warning |
| **Claim fails** | Falls back to CLAIM button in dashboard |

---

## Architecture

Single-file IIFE. No build tools, no external deps.

```
index.js
├─ CONFIG / CONST / RUNTIME    tunables, frozen constants, mutable state
├─ ErrorHandler                classifies HTTP errors (retry / skip / fatal)
├─ Logger                      DOM dashboard + task state + log output
├─ Traffic                     FIFO request queue with exponential backoff
├─ Patcher                     RunStore / StreamStore monkey-patching
├─ Tasks                       VIDEO, GAME, STREAM, ACTIVITY, ACHIEVEMENT handlers
├─ loadModules()               resilient webpack extraction via constructor.displayName
└─ main()                      enroll → discover → execute → claim → loop
```

### Module detection

Unlike other scripts that break on every Discord update, Orion finds stores by their **class name** (`QuestStore`, `RunningGameStore`, etc.) via `constructor.displayName`. The Dispatcher is found by structural signature (`_subscriptions` + `subscribe` + `dispatch`), and the API client by its unique `.del` method. No hardcoded minified paths.

---

## Changelog

### v4.1
- Resilient `loadModules()` &mdash; uses `constructor.displayName` instead of hardcoded `.A/.Z/.Ay/.ZP` paths
- Auto-claim rewards (optimistic POST + captcha fallback with CLAIM button)
- Adaptive video speed (6-22 API calls instead of 180 for 900s quests)
- `ACHIEVEMENT_IN_ACTIVITY` handler for milestone-based quests
- `WATCH_VIDEO_ON_MOBILE` progress tracking fix
- Task sorting by progress percentage
- Per-cycle try-catch for crash isolation

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
