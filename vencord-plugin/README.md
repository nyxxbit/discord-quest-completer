# OrionQuests — Vencord Userplugin

A [Vencord](https://vencord.dev) userplugin port of [Orion](../README.md), the auto-quest-completer for Discord.

> **Userplugin only.** Will not be accepted upstream into Vencord — Vencord does not accept plugins that automate Discord features. Install manually as a third-party userplugin.

> **Desktop client only.** Same hard limit as the userscript — Discord's internal Flux stores only exist in the desktop client (Stable, PTB, Canary). Vencord on web/mobile won't work for this plugin.

---

## Status

**Functional, in sync with userscript v4.9.1.** Quest enrollment, all five task handlers (`VIDEO` / `GAME` / `STREAM` / `ACTIVITY` / `ACHIEVEMENT`), traffic queue with backoff, RunStore patching, and auto-claim are ported. A `/orion` slash command provides start / stop / status from any Discord channel.

**ACHIEVEMENT auto-bypass — confirmed working.** The userscript can run the OAuth2 authorize flow but Discord's renderer CSP blocks the final POST to `*.discordsays.com`. This plugin includes a native module (`native.ts`) that runs those POSTs in the Electron main process, where CSP doesn't apply &mdash; verified against a live `ACHIEVEMENT_IN_ACTIVITY` quest after the user passed age verification. Quests that are still age-gated (HTTP 403 code 50165 from `/proxy-tickets`) still skip; everything else now completes without launching the activity manually.

**Bonus: also unlocks the standalone userscript.** v4.8.2 of `../index.js` detects this plugin's native module via `VencordNative.pluginHelpers.OrionQuests` and routes its discordsays POSTs through here. So pasting the userscript into the console works for `ACHIEVEMENT_IN_ACTIVITY` quests too, as long as this plugin is installed and enabled.

The remaining gap from the userscript is the floating dashboard panel — progress is currently surfaced via Discord's native console + `/orion status` rather than a custom DOM overlay. That fits the Vencord usage model better, but if you want the panel back, see the open enhancement tracker.

---

## Install

You need a working Vencord development setup. Follow [Vencord's installing guide](https://docs.vencord.dev/installing/) first if you haven't already.

```bash
# From inside your local Vencord clone
cd src/userplugins

# Pull just this plugin's directory
git clone --depth 1 https://github.com/nyxxbit/discord-quest-completer.git _orion-temp
mv _orion-temp/vencord-plugin orionQuests
rm -rf _orion-temp

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

If you see `QuestStore not found`, Discord likely renamed the store internally — open an issue with the Discord build version and I'll adjust the lookup.

---

## Slash command

`/orion <action>` — one of:

| Action | Effect |
| --- | --- |
| `start` | Start the engine. Loads stores, runs the quest cycle. |
| `stop` | Stop the engine. Restores patched stores, clears running tasks. |
| `status` | Show what's running and progress per task. |

The reply is bot-only (no one else in the channel sees it).

---

## Settings

Exposed in Vencord's plugin settings UI. Persisted via Vencord's `DataStore`.

| Setting | Default | Equivalent in `../index.js` |
| --- | --- | --- |
| Auto Start | `false` | (none — userscript starts on paste) |
| Try to claim reward | `false` | `RUNTIME.autoClaim` (picker toggle) |
| Hide activity | `false` | `CONFIG.HIDE_ACTIVITY` |
| Game concurrency | `1` | inferred from `runConcurrent(queues.game, 1)` |
| Video concurrency | `2` | inferred from `runConcurrent(queues.video, 2)` |
| Verbose logging | `false` | (debug logs) |

---

## Architecture

```
vencord-plugin/
├── index.tsx     # plugin entry, /orion slash command, lifecycle
├── settings.ts   # Vencord settings schema
├── orion.ts      # store loading, main cycle loop, dashboard registry
├── traffic.ts    # FIFO request queue with exponential backoff
├── tasks.ts      # per-type handlers (VIDEO / GAME / STREAM / ACTIVITY / ACHIEVEMENT)
├── native.ts     # main-process IPC handlers — CSP-exempt discordsays POSTs
├── patcher.ts    # RunningGameStore monkey-patch + RPC dispatch
├── types.ts      # shared TypeScript interfaces
└── util.ts       # sleep / rnd / sanitize helpers
```

Each module is the TypeScript equivalent of the same-named section in `../index.js`. Discord-specific webpack discovery is replaced by Vencord's `findStore` / `findByProps` + `Common.FluxDispatcher` / `Common.RestAPI`.

---

## Why a separate plugin instead of just running the userscript inside Vencord?

You *can* paste the userscript into Discord's DevTools console even if you're running Vencord. It still works (and v4.6 of the userscript even auto-detects Vencord). The plugin port exists because:

1. **Lifecycle integration** — Vencord starts/stops the plugin automatically with Discord, no manual paste each time.
2. **Settings UI** — Vencord generates a native settings panel from `definePluginSettings`, no editing source before running.
3. **Persistent across reloads** — settings live in Vencord's `DataStore`, not `localStorage`.
4. **Cleaner module discovery** — `findStore` is more resilient across Discord builds than the userscript's manual `webpackChunkdiscord_app` walk.
5. **Slash commands** — `/orion start|stop|status` from any channel, no need to open DevTools.

---

## Known limitations

Same as the userscript:

- **ACHIEVEMENT_IN_ACTIVITY** quests now auto-complete via the discordsays OAuth bypass when heartbeat spoofing is rejected (v4.8+). The discordsays POSTs are made through the native module to bypass renderer CSP. Falls back to skip only for age-gated or delisted activities (HTTP 403 code 50165 from `/proxy-tickets`) — those can't be launched even manually. **If you haven't age-verified for the activity in Discord's settings, the proxy-ticket endpoint will return 50165 even on auto-bypass; verify your age first.**
- **Browsers / mobile** never supported.
- **PLAY_ON_DESKTOP** progress is real wall-clock elapsed time on Discord's server. Cannot be accelerated.

---

## License

MIT — see [`LICENSE`](../LICENSE) at the repo root.

This plugin is loaded into Vencord, which is **GPL-3.0-or-later**. The compiled `Vencord + OrionQuests` bundle that you actually run is therefore subject to GPL terms; the source code in this directory remains MIT-licensed and may be reused under MIT terms in any context outside Vencord (e.g., porting to other client mods).
