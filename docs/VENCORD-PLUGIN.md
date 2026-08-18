# OrionQuests, a Vencord userplugin

A [Vencord](https://vencord.dev) userplugin port of [Orion](../README.md), the auto-quest-completer for Discord.

> **Userplugin only.** Will not be accepted upstream into Vencord, which does not accept plugins that automate Discord features. Install manually as a third-party userplugin.

> **Desktop client only.** Same hard limit as the userscript: Discord's internal Flux stores only exist in the desktop client (Stable, PTB, Canary). Vencord on web/mobile won't work for this plugin.

---

## Status

**Functional, in sync with userscript v4.10.6.** Quest enrollment, all five task handlers (`VIDEO` / `GAME` / `STREAM` / `ACTIVITY` / `ACHIEVEMENT`), traffic queue with backoff, RunStore patching, and auto-claim are ported. A `/orion` slash command provides start / stop / status from any Discord channel, plus Vencord-only pause / resume controls.

**ACHIEVEMENT auto-bypass, confirmed working.** The userscript can run the OAuth2 authorize flow but Discord's renderer CSP blocks the final POST to `*.discordsays.com`. This plugin includes a native module (`native.ts`) that runs those POSTs in the Electron main process, where CSP doesn't apply. Verified against a live `ACHIEVEMENT_IN_ACTIVITY` quest after the user passed age verification. Quests that are still age-gated (HTTP 403 code 50165 from `/proxy-tickets`) still skip; everything else now completes without launching the activity manually.

**Bonus: also unlocks the standalone userscript.** `../index.js` detects this plugin's native module via `VencordNative.pluginHelpers.OrionQuests` and routes its discordsays POSTs through here. So pasting the userscript into the console works for `ACHIEVEMENT_IN_ACTIVITY` quests too, as long as this plugin is installed and enabled.

The remaining gap from the userscript is the floating dashboard panel. Progress is surfaced through the console and `/orion status` instead of a DOM overlay, which fits the Vencord usage model better. If you want the panel, open an issue.

---

## Install

You need a working Vencord development setup. Follow [Vencord's installing guide](https://docs.vencord.dev/installing/) first if you haven't already.

### Option A: UserpluginInstaller (one click, auto-updates)

If you run [nin0's `UserpluginInstaller`](https://discord.com/channels/1015060230222131221/1302000818131828810/1302000818131828810), paste this repo's URL into its **Install Plugin** field:

```
https://github.com/nyxxbit/discord-quest-completer
```

It clones the repo into `src/userplugins/discord-quest-completer` and rebuilds. From then on the plugin shows up in the **UserPlugins** settings tab with an update button (`git fetch` + `git rebase origin/HEAD`), so new Orion releases land without touching a terminal.

The install dialog will warn that this plugin **uses native modules**. That is expected and unavoidable: `native.ts` is what runs the `discordsays.com` POSTs in the Electron main process, where Discord's renderer CSP does not apply. Read it before you accept, the file is about 200 lines.

The clone also brings the userscript (`index.js`), `docs/`, and `tools/` along, since the installer clones the whole repo. They are inert: Vencord only ever imports `index.tsx` and `native.ts` from a plugin folder.

### Option B: manual clone

```bash
# From inside your local Vencord clone
cd src/userplugins

# The repo root IS the plugin, so clone it directly
git clone --depth 1 https://github.com/nyxxbit/discord-quest-completer.git

# Rebuild Vencord with the new plugin included
cd ../..
pnpm build
```

If Vencord isn't already injected into Discord, run `pnpm inject` once afterward.

Restart Discord. Open **Vencord settings → Plugins**, search for `OrionQuests`, and toggle it on.

### Verifying the install

After enabling, type `/orion status` in any channel. Expected response:

```
Orion
Idle. Use /orion start to begin.
```

Then `/orion start` to kick off the cycle. The console (`Ctrl+Shift+I`) shows progress logs.

If you see `QuestStore not found`, Discord likely renamed the store internally. Open an issue with the Discord build version and I'll adjust the lookup.

---

## Slash command

`/orion <action>`, one of:

| Action | Effect |
| --- | --- |
| `start` | Start the engine. Loads stores, runs the quest cycle. |
| `stop` | Stop the engine. Restores patched stores, clears running tasks. |
| `status` | Show what's running and progress per task. |
| `pause` | Pause all queued/running quests, or only the optional `quest` target. The engine itself stays running. |
| `resume` | Resume all paused quests, or only the optional `quest` target. Resumed quests become eligible on a later cycle. |

For `pause` / `resume`, `quest` may be an exact quest id, an exact case-insensitive name, or a unique case-insensitive name fragment. Ambiguous fragments are rejected instead of guessed.

Examples:

```text
/orion action:pause
/orion action:pause quest:Genshin
/orion action:resume quest:Genshin
/orion action:resume
```

Pause state is scoped to the current Discord account and plugin session. It survives Orion `stop` → `start` for the same account, but clears on account switch or plugin/client reload. Resume never revives the cancelled task generation; the quest continues from progress Discord already recorded when a later cycle schedules it again.

The reply is bot-only (no one else in the channel sees it).

---

## Settings

Exposed in Vencord's plugin settings UI. Persisted via Vencord's `DataStore`.

| Setting | Default | Equivalent in `../index.js` |
| --- | --- | --- |
| Auto Start | `false` | (none, the userscript starts on paste) |
| Auto-enroll | `true` | `RUNTIME.autoEnroll` (picker toggle). Off leaves quests you have not accepted untouched and lists them as `PENDING` until you accept them in Discord. |
| Watch for enrollments | `false` | (none, the userscript is a paste-and-run session with nothing idle to watch). Uses Discord's `QUESTS_ENROLL_SUCCESS` Flux event while the engine is idle instead of inferring enrollments from generic QuestStore changes. Owned by `index.tsx` rather than the engine: armed by plugin load and `/orion start`, disarmed by `/orion stop` and by disabling the plugin, left armed when a queue drains on its own. |
| Try achievement bypass | `false` | `Consent.ask()` popup. **This is the account-risk setting.** Off means `ACHIEVEMENT_IN_ACTIVITY` quests are skipped rather than completed. Turning it on is your consent to OAuth-authorize each quest's app on your account. Read the caution in the [README](../README.md) first. |
| Try to claim reward | `false` | `RUNTIME.autoClaim` (picker toggle) |
| Hide activity | `false` | `CONFIG.HIDE_ACTIVITY`. Both turn Discord's own `status.showCurrentGame` off while quests run and restore it on stop. Needs `UserSettingsAPI`, which the plugin declares as a dependency. |
| Game concurrency | `1` | inferred from `runConcurrent(queues.game, 1)` |
| Video concurrency | `2` | inferred from `runConcurrent(queues.video, 2)` |
| Play sound | `false` | `RUNTIME.playSound` (picker toggle) |
| Verbose logging | `false` | (debug logs). Raises Orion's debug messages to info level so they appear without switching the console to Verbose. |

---

## Architecture

The plugin sources sit at the **repo root**, so a clone of this repo is directly loadable as `src/userplugins/discord-quest-completer`:

```
discord-quest-completer/
├── index.tsx     # plugin entry, /orion slash command, lifecycle
├── settings.ts   # Vencord settings schema
├── orion.ts      # store loading, main cycle loop, dashboard registry
├── taskControl.ts     # per-quest task generations, cancellation and scoped cleanup
├── questTarget.ts     # pause/resume quest target resolution
├── questConfig.ts     # taskConfigV2 / legacy task helpers
├── oauthLifecycle.ts  # account-safe compensating OAuth cleanup
├── traffic.ts    # FIFO request queue with exponential backoff
├── tasks.ts      # per-type handlers (VIDEO / GAME / STREAM / ACTIVITY / ACHIEVEMENT)
├── native.ts     # main-process IPC handlers, CSP-exempt discordsays POSTs
├── hooks.ts      # settings-to-engine bridge, imports nothing so it cannot close a cycle
├── patcher.ts    # RunningGameStore monkey-patch + RPC dispatch
├── types.ts      # shared TypeScript interfaces
├── util.ts       # sleep / rnd / sanitize helpers
└── index.js      # the standalone userscript, not part of the plugin build
```

Vencord's build only scans the top level of a plugin folder for `index.ts(x)` and `native.ts`, which is why these files cannot live in a subdirectory. See [ARCHITECTURE.md](ARCHITECTURE.md#why-the-plugin-sources-live-at-the-repo-root) for the resolution details.

Each module is the TypeScript equivalent of the same-named section in `../index.js`. Discord-specific webpack discovery is replaced by Vencord's `findStore` / `findByProps` + `Common.FluxDispatcher` / `Common.RestAPI`.

Per-quest pause adds a task generation below the existing engine generation. Cancelling one generation is one-way; a later Resume only makes the quest eligible for a new generation. Task-owned delays, queued Traffic work and cleanup are bound to that generation. A request already handed to Discord's `RestAPI` cannot be unsent, so its old generation stays reserved until the request settles and its stale continuation remains inactive.

---

## Why a separate plugin instead of just running the userscript inside Vencord?

You *can* paste the userscript into Discord's DevTools console even if you're running Vencord. It still works (and v4.6 of the userscript even auto-detects Vencord). The plugin port exists because:

1. **Lifecycle integration.** Vencord starts/stops the plugin automatically with Discord, no manual paste each time.
2. **Settings UI.** Vencord generates a native settings panel from `definePluginSettings`, no editing source before running.
3. **Persistent across reloads.** Settings live in Vencord's `DataStore`, not `localStorage`.
4. **Cleaner module discovery.** `findStore` is more resilient across Discord builds than the userscript's manual `webpackChunkdiscord_app` walk.
5. **Slash commands.** `/orion start|stop|status|pause|resume` from any channel, no need to open DevTools.

---

## Known limitations

Same as the userscript:

- **ACHIEVEMENT_IN_ACTIVITY** quests now auto-complete via the discordsays OAuth bypass when heartbeat spoofing is rejected (v4.8+). The discordsays POSTs are made through the native module to bypass renderer CSP. Falls back to skip only for age-gated or delisted activities (HTTP 403 code 50165 from `/proxy-tickets`), which can't be launched even manually. **If you haven't age-verified for the activity in Discord's settings, the proxy-ticket endpoint will return 50165 even on auto-bypass; verify your age first.**
- **Browsers / mobile** never supported.
- **PLAY_ON_DESKTOP** progress is real wall-clock elapsed time on Discord's server. Cannot be accelerated.

Plugin-specific pause/resume limitations:

- **Per-quest pause/resume is Vencord-plugin-only.** The standalone `index.js` run lifecycle is unchanged.
- A request already handed to Discord's `RestAPI` cannot be retracted. Pause prevents its stale continuation from starting later work and keeps the old task generation reserved until that call settles.

---

## License

MIT, see [`LICENSE`](../LICENSE) at the repo root.

This plugin is loaded into Vencord, which is **GPL-3.0-or-later**. The compiled `Vencord + OrionQuests` bundle that you actually run is therefore subject to GPL terms; the source code in this directory remains MIT-licensed and may be reused under MIT terms in any context outside Vencord (e.g., porting to other client mods).
