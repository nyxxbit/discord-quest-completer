<div align="center">


# Orion

**Discord Quest Completer** &mdash; v4.0 Enterprise

[![Version](https://img.shields.io/badge/v4.0-Enterprise-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://github.com/nyxxbit/discord-quest-completer)
[![License](https://img.shields.io/badge/MIT-green?style=for-the-badge)](LICENSE)
[![Status](https://img.shields.io/badge/stable-3BA55C?style=for-the-badge)](https://github.com/nyxxbit/discord-quest-completer)

Auto-completes Discord Quests & Orbs by simulating game activity, video watching, streaming, and voice participation. Paste into DevTools, walk away.

</div>

---

## How it works

Orion hooks into Discord's internal webpack modules to spoof game processes, fake video progress, and send heartbeat signals &mdash; all through Discord's own API client, so requests carry the user's existing session. No tokens, no external dependencies, no build step.

```
QuestStore → filter incomplete → auto-enroll → dispatch tasks → poll progress → done
```

| Task type | What Orion does |
|-----------|----------------|
| **Video** | Sends fake `video-progress` timestamps until Discord confirms completion |
| **Game** | Injects a spoofed process into `RunStore` with real metadata from Discord's app registry |
| **Stream** | Patches `StreamStore.getStreamerActiveStreamMetadata` with synthetic stream data |
| **Activity** | Heartbeats against a voice channel to simulate participation |
| **Achievement** | Listens for `ACHIEVEMENT_IN_ACTIVITY` events &mdash; requires joining the Activity manually |

---

## Quick start

**1.** Open Discord (Canary recommended &mdash; console enabled by default)

**2.** Press `Ctrl + Shift + I` &rarr; Console tab

**3.** Paste the contents of [`index.js`](index.js) and hit Enter

> **Tip:** `Shift + .` toggles the dashboard visibility.

### Enabling console on stable Discord

If you're not on Canary, close Discord and edit `%appdata%/discord/settings.json`:

```json
{
  "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING": true
}
```

Restart Discord after saving.

---

## Dashboard

The injected UI is draggable, remembers its position across sessions, and live-sorts tasks by state:

| Priority | State | Visual |
|----------|-------|--------|
| 1st | **Running** (highest progress first) | Blue accent, animated progress bar |
| 2nd | **Queued** | Orange accent, dimmed |
| 3rd | **Completed** | Green accent, checkmark icon |

Desktop notifications fire on each quest completion.

---

## Configuration

Tweak these before pasting. All timing values are in milliseconds unless noted.

```js
const CONFIG = {
    VIDEO_SPEED: 5,              // fake seconds added per tick
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
| **404 on enroll** | Quest added to skip-list, script continues with remaining quests |
| **Repeated failures** | Task abandoned after `MAX_TASK_FAILURES` consecutive errors |
| **25 min timeout** | Task force-stopped, cycle advances |
| **Missing modules** | Required modules validated on boot &mdash; optional ones log a warning |

---

## Architecture

Single-file IIFE, no build tools, no external deps. Designed to be pasted into a console.

```
index.js
├─ CONFIG / CONST          tunables and frozen constants
├─ ErrorHandler             classifies HTTP errors (retry / skip / fatal)
├─ Logger                   DOM dashboard + task state + log output
├─ Traffic                  FIFO request queue with backoff
├─ Patcher                  RunStore / StreamStore monkey-patching
├─ Tasks                    VIDEO, GAME, STREAM, ACTIVITY, ACHIEVEMENT handlers
├─ loadModules()            webpack chunk extraction
└─ main()                   enroll → discover → execute → loop
```

---

## Disclaimer

This tool is for **educational and research purposes only**. Automating user actions violates Discord's [Terms of Service](https://discord.com/terms). The developer is not responsible for any account suspensions or bans. Use at your own risk.

---

<div align="center">

Built by [**syntt_**](https://discord.com/users/1419678867005767783)

</div>
