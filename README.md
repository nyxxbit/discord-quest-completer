<div align="center">

# Orion

**Auto-complete every Discord Quest in seconds** &mdash; v4.9.3

[![Version](https://img.shields.io/badge/v4.9.3-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://github.com/nyxxbit/discord-quest-completer)
[![Stars](https://img.shields.io/github/stars/nyxxbit/discord-quest-completer?style=for-the-badge&color=faa61a)](https://github.com/nyxxbit/discord-quest-completer/stargazers)
[![License](https://img.shields.io/badge/MIT-green?style=for-the-badge)](LICENSE)

Completes all Discord Quests automatically &mdash; game, video, stream, activity, and achievement quests. Paste one script into DevTools, get every reward. No installs, no tokens, no dependencies.

**Works on every Discord update** &mdash; no hardcoded paths, uses `constructor.displayName` for resilient module detection.

[Get Started](#quick-start) &bull; [How It Works](#how-it-works) &bull; [Configuration](#configuration)

</div>

---

> [!CAUTION]
> **Discord is actively cracking down on quest automation (April 2026+).** Some users have received system messages flagging their accounts after running automation tools (any tool, not just this one). The risk is real now, and enforcement can hit the entire Discord account, not only quest rewards. Use at your own discretion. Honest trade-off: faster Orbs vs a non-zero chance of an account strike.
>
> **The `ACHIEVEMENT_IN_ACTIVITY` bypass does more than spoof progress.** To complete those quests it runs a real OAuth2 authorization against the quest's application (scopes `identify applications.commands applications.entitlements`), mints a proxy ticket, posts forged progress to the activity backend at `discordsays.com`, then revokes the authorization it created. Full flow: `authorize -> proxy ticket -> discordsays authorize -> discordsays progress -> revoke`. It is forging quest progress on a logged-in account, which is exactly what Discord is enforcing against. If you don't want that on your main account, don't run it there.

---

> [!WARNING]
> **Vanilla Discord Stable is partially incompatible.** A recent Stable build changed the webpack runtime so `webpackChunkdiscord_app.push` no longer exposes the live module cache post-boot.
>
> **Workarounds (any of these works on Stable):**
> 1. **Paste the userscript with [Vencord](https://vencord.dev/) installed** &mdash; Orion v4.6+ auto-detects Vencord and uses its boot-time-injected Webpack API to restore full functionality.
> 2. **Install the [OrionQuests Vencord userplugin](vencord-plugin/)** &mdash; no console pasting, runs at Discord boot, exposes `/orion start|stop|status` slash commands. Best long-term option for Stable users.
> 3. Or use **[Discord Canary](https://canary.discord.com/download)** (vanilla, no mods), where the native userscript extraction still works.

---

## Why Orion?

- **Covers all 5 quest types** &mdash; PLAY, STREAM, VIDEO, ACTIVITY, and ACHIEVEMENT_IN_ACTIVITY. Most other tools only handle PLAY (game-time) quests.
- **Userscript and Vencord plugin in one repo** &mdash; pick whichever fits your setup. Both share the same engine, both kept in sync.
- **Auto-claiming** &mdash; Claim rewards directly from the dashboard. Tries to claim automatically (if enabled), or provides a smart interactive button if captcha is needed.
- **Resilient module loader** &mdash; finds Discord stores by class name, not minified paths. Dual extraction path (Vencord API + native fallback) survives Discord webpack changes.
- **Smart rate limiting** &mdash; exponential backoff on 429/5xx, skip-list for dead quests, randomized polling intervals. Distinguishes between global and endpoint limits, non-blocking retries.
- **Fault-tolerant execution** &mdash; One failed quest won't break the queue (`Promise.allSettled`).
- **Zero setup** &mdash; single paste into the console. No Node.js, no npm, no extensions.

---

## Quick start

> [!IMPORTANT]
> **Partial Browser/Mobile Support.** Orion runs in Discord web version or on mobile browsers Discord (via script-injection extensions like Kiwi Browser) for web-compatible quests (e.g., Video, Activity). However, `GAME` and `STREAM` quests are automatically filtered out as they are **impossible** outside the Discord Desktop client.

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
| **Achievement** | Tries heartbeat spoof first; if Discord rejects, forges the Discord Says OAuth handshake to mark progress directly. The discordsays POSTs auto-route through the best available transport: [Orion Relay](tools/orion-relay/) (zero client mods needed), [Vencord plugin](vencord-plugin/) if installed, or direct `fetch` on web Discord. Skips cleanly on age-gated/delisted activities |

---

## Dashboard

Draggable overlay styled to match native Discord design. Live-sorts tasks so you always see what matters:

| Priority | State | Visual |
|----------|-------|--------|
| 1st | **Running** (highest progress first) | Blue accent, circular progress bar |
| 2nd | **Queued** | Orange accent, dimmed |
| 3rd | **Completed** / **Action Required** | Green checkmark + Interactive CLAIM or ACTION REQUIRED buttons |

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
├─ loadModules()               dual-path extraction (Vencord API + native fallback)
└─ main()                      discover → JIT enroll → execute → claim → loop
```

### Module detection

Unlike other scripts that break on every Discord update, Orion finds stores by their **class name** (`QuestStore`, `RunningGameStore`, etc.) via `constructor.displayName`. The Dispatcher is found by structural signature (`_subscriptions` + `subscribe` + `dispatch`), and the API client by its unique `.del` method. No hardcoded minified paths.

For a full internal tour of the script, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Alternatives

Orion isn't the only tool in this space. If our approach doesn't fit your setup, these projects might:

- **[markterence/discord-quest-completer](https://github.com/markterence/discord-quest-completer)** &mdash; Native Windows app (Tauri/Rust + Vue). Creates dummy game executables that satisfy Discord's process detection without injecting into the client at all. **Most resilient long-term** because it doesn't depend on Discord internals. Trade-off: **PLAY quests only** (no VIDEO/STREAM/ACTIVITY/ACHIEVEMENT support), Windows-only, requires WebView2.
- **[nicola02nb/completeDiscordQuest](https://github.com/nicola02nb/completeDiscordQuest)** &mdash; Vencord plugin (also a BetterDiscord port available). Smaller and simpler than ours, port of [aamiaa's original snippet](https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb) that started this whole space. Mature (online since Sep 2025).
- **[nvckai/Discord-Web-Auto-Quest-Extension](https://github.com/nvckai/Discord-Web-Auto-Quest-Extension)** &mdash; Chrome extension. One-click install but VIDEO-focused.

Why Orion if these exist:

- We're the **only** tool covering all 5 quest types with one codebase.
- Userscript + Vencord plugin **share the same engine** in this repo, so behavior matches across install paths.
- Active development (multiple releases per month, community PRs merged on the same day they land).

Honest disclosure: we depend on Discord's webpack/internals. Every Discord update has a chance of breaking us. markterence's process-injection approach is structurally less brittle for users who only need PLAY quests.

---

## Contributing

Contributions are welcome &mdash; bug reports, PRs, and docs. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for the checklist and code style. Use the issue templates when reporting bugs or requesting features.

---

## Changelog

### v4.9.3
- **Security hardening of the ACHIEVEMENT bypass** &mdash; From a detailed security report ([#38](https://github.com/nyxxbit/discord-quest-completer/issues/38)). The OAuth grant cleanup now runs in a `finally` block, so a failed bypass never leaves the quest's app authorized on your account, and it only revokes the grant Orion created (diffed against a pre-flow snapshot of your existing grants) so it can never delete an authorization you made yourself. The localhost relay no longer follows redirects and rejects any host or path outside the two `discordsays.com` endpoints it needs. The userscript and the Vencord native module both validate the application id is numeric before building any URL (closes the SSRF angle). The README now spells out the full OAuth lifecycle and the account-level ban risk. The non-tech installer bundle is English-only now (`INSTALL.cmd`).

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
- **Honest CSP error message + Vencord native bypass** &mdash; Testing v4.8 surfaced that Discord's renderer CSP (`connect-src` allowlist) blocks the final `fetch()` to `*.discordsays.com` from the userscript. Steps 1-2 of the bypass (OAuth2 authorize + proxy-ticket mint) work; step 3 (POST to the activity backend) does not. The userscript now detects the CSP failure and prints a clear message pointing to the Vencord plugin instead of "Failed to fetch". The [Vencord plugin port](vencord-plugin/) gained a native module (`native.ts`) that runs the discordsays POSTs in the Electron main process where CSP doesn't apply &mdash; **confirmed working in production against real ACHIEVEMENT_IN_ACTIVITY quests**.

### v4.8
- **ACHIEVEMENT_IN_ACTIVITY auto-bypass** &mdash; New OAuth2 → discordsays.com handshake. When Discord's heartbeat endpoint rejects (HTTP 403, which it does for most current Achievement quests), Orion now authorizes against the activity's own backend, mints a proxy ticket, and POSTs the target progress directly. No more 25-minute passive wait, no more "join the activity manually". The previous picker toggle to skip these is now mandatory behavior &mdash; if both paths fail (typically age-gated or delisted activities like *The Odyssey*), the quest is skipped cleanly instead of blocking a queue slot. **Note: the discordsays.com POSTs are blocked by Discord's renderer CSP &mdash; the userscript can only complete the OAuth handshake locally. See [v4.8.1](#v481) for the workaround.**
- **2x faster video polling** &mdash; Video heartbeats now run at 3.5-4.75s instead of 7-9.5s. Cuts each video quest's wall-clock in half. Discord's server-side validation accepts the faster cadence.
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
