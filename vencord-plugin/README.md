# OrionQuests — Vencord Userplugin

A [Vencord](https://vencord.dev) userplugin port of [Orion](../README.md), the auto-quest-completer for Discord.

> **Userplugin only.** This will not be accepted upstream into Vencord — Vencord does not accept plugins that automate Discord features. You install it manually as a third-party userplugin.

> **Desktop client only.** Same hard limit as the userscript version — Discord's internal Flux stores only exist in the desktop client (Stable, PTB, Canary). Vencord on web/mobile won't work for this plugin.

---

## Status

**Phase 1 — Scaffold.** The plugin loads, registers settings in Vencord's UI, resolves Discord's internal Flux stores via `findStore`, and logs incomplete quests on `start()`. **Quest execution is not yet ported.**

For actual quest completion right now, use the [userscript version](../README.md). This Vencord port is being built incrementally — see the roadmap below.

---

## Install

You need a working Vencord development setup. Follow [Vencord's installing guide](https://docs.vencord.dev/installing/) first if you haven't already.

```bash
# From inside your local Vencord clone
cd src/userplugins

# Clone the OrionQuest repo to a temporary folder, move only the
# plugin subdirectory into place, then clean up
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

Open Discord's DevTools (`Ctrl+Shift+I`) → Console tab. After enabling the plugin you should see something like:

```
[Vencord] [OrionQuests] Starting OrionQuests (Phase 1 scaffold)
[Vencord] [OrionQuests] Discord stores loaded: { QuestStore: true, RunStore: true, ... }
[Vencord] [OrionQuests] Found 3 incomplete quests
[Vencord] [OrionQuests]   • Watch Steam Game Festival — task types: WATCH_VIDEO
[Vencord] [OrionQuests]   • Play Helldivers 2 — task types: PLAY_ON_DESKTOP
[Vencord] [OrionQuests]   • ...
[Vencord] [OrionQuests] Phase 1 scaffold complete. Quest execution is not yet implemented...
```

If you see `QuestStore not found via findStore`, Discord likely renamed the store internally — open an issue with the Discord build version and I'll adjust the lookup.

---

## Settings

Exposed in Vencord's plugin settings UI. Mirrors the `CONFIG` object in the userscript version.

| Setting | Default | Equivalent in `../index.js` |
|---|---|---|
| Try to claim reward | `false` | `CONFIG.TRY_TO_CLAIM_REWARD` |
| Hide activity | `false` | `CONFIG.HIDE_ACTIVITY` |
| Game concurrency | `1` | `CONFIG.GAME_CONCURRENCY` |
| Video concurrency | `2` | `CONFIG.VIDEO_CONCURRENCY` |
| Verbose logging | `false` | (debug logs) |

---

## Roadmap

- [x] **Phase 1** — Plugin scaffold, settings UI, store discovery, quest listing
- [ ] **Phase 2** — Quest enrollment + skip-list + traffic queue with backoff
- [ ] **Phase 3** — `VIDEO` task handler (port from `Tasks.VIDEO` in `../index.js`)
- [ ] **Phase 4** — `GAME` / `STREAM` / `ACTIVITY` / `ACHIEVEMENT` handlers
- [ ] **Phase 5** — React dashboard (replaces the DOM-injected panel from the userscript)
- [ ] **Phase 6** — Auto-claim with captcha fallback
- [ ] **Phase 7** — Native commands (`/orion start`, `/orion stop`, `/orion status`)

---

## Why a separate plugin instead of just running the userscript inside Vencord?

You *can* paste the userscript into Discord's DevTools console even if you're running Vencord. It still works. The plugin port exists because:

1. **Lifecycle integration** — Vencord starts/stops the plugin automatically with Discord, no manual paste each time
2. **Settings UI** — Vencord generates a native settings panel from `definePluginSettings`, no editing source before running
3. **Persistent across reloads** — settings live in Vencord's `DataStore`, not `localStorage`
4. **Cleaner module discovery** — uses Vencord's `findStore` instead of the manual `webpackChunkdiscord_app` walk
5. **Smaller maintenance surface** — when Discord updates and breaks store discovery, Vencord's helpers usually adapt before the userscript does

---

## License

MIT — see [`LICENSE`](../LICENSE) at the repo root.

This plugin is loaded into Vencord, which is **GPL-3.0-or-later**. The compiled `Vencord + OrionQuests` bundle that you actually run is therefore subject to GPL terms; the source code in this directory remains MIT-licensed and may be reused under MIT terms in any context outside Vencord (e.g., porting to other client mods).
