# Architecture

This document describes how Orion is structured internally. It is intended for contributors and the curious, not as a user guide. Last reviewed against `index.js` **v4.9.4**.

## High-level overview

Orion's core is a single-file IIFE (`index.js`) that runs inside the Discord desktop client's DevTools console. It discovers Discord's internal webpack stores at runtime, introspects the currently-available quests, and coordinates a handler per task type through a small task runner. There are no external dependencies and no build step.

It holds no persisted state. The only global it sets is the in-memory `window.orionLock` re-entry guard; the entire lifecycle (paste → completion → cleanup) lives in the IIFE closure. (The Vencord plugin port persists its settings via Vencord's DataStore, but the userscript itself persists nothing.)

One subsystem needs more than the renderer: the `ACHIEVEMENT_IN_ACTIVITY` bypass has to POST to `*.discordsays.com`, which Discord's renderer CSP blocks. Completing those quests on Discord Desktop therefore requires either the **localhost relay** (`tools/orion-relay/`) or the **Vencord plugin's native module** — the renderer alone cannot escape the CSP.

## File layout

```
OrionQuest/
├── index.js                       # single-file distributable — the actual userscript
├── eslint.config.mjs              # ESLint flat config scoped to index.js
├── README.md                      # end-user facing docs
├── CONTRIBUTING.md
├── docs/
│   └── ARCHITECTURE.md            # this file
├── vencord-plugin/                # Vencord/Equicord userplugin port (functional, in sync)
│   ├── index.tsx                  # plugin entry, /orion slash command, lifecycle
│   ├── orion.ts                   # store loading, main cycle loop, dashboard registry
│   ├── tasks.ts                   # per-type handlers incl. the OAuth bypass
│   ├── native.ts                  # main-process IPC: CSP-exempt discordsays POSTs
│   ├── traffic.ts                 # FIFO request queue with backoff
│   ├── patcher.ts                 # RunningGameStore monkey-patch + RPC dispatch
│   ├── settings.ts                # Vencord settings schema
│   ├── types.ts  ├── util.ts
├── tools/
│   ├── orion-relay/               # localhost HTTP relay (no client mod needed for the bypass)
│   │   ├── orion-relay.ps1  ├── start-relay.cmd  └── README.md
│   └── orion-vencord-bundle/      # non-tech installer (INSTALL.cmd + README.txt + prebuilt dist)
└── .github/
    └── workflows/                 # CI: lint + syntax check
```

## Module map (inside `index.js`)

The file is a layered IIFE; each "module" is a `const` object or function in the outer closure.

| Module          | Responsibility                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `CONFIG`        | User-tunable constants (name, version, colors, log limit, hide-activity)                         |
| `SYS`           | Frozen internal limits (max task time, retries, failure threshold, `IS_DESKTOP`)                |
| `RUNTIME`       | Mutable runtime state (running flag, cleanups, `autoEnroll`/`autoClaim`/`playSound`/`randomDelay`)|
| `Sound`         | Web Audio completion cue; reuses one `AudioContext`                                              |
| `Consent`       | Pre-authorization OAuth consent popup for the bypass (per-app, per-run, default decline)         |
| `esc()` / `notExpired()` | HTML-escape helper for server-controlled strings; NaN-safe quest-expiry check          |
| `ICONS`         | Inline SVG sprites used by the dashboard                                                         |
| `CONST`         | Frozen event names (`CONST.EVT`) and one blacklisted quest id (`CONST.ID`)                       |
| `ErrorHandler`  | Classifies HTTP errors into retryable / client / skippable                                       |
| `Traffic`       | Request queue with exponential backoff, rate-limit awareness, retry ceiling                      |
| `Mods`          | Reference to the Discord webpack stores discovered at boot                                       |
| `Patcher`       | Injects fake running-game records into `RunningGameStore`                                        |
| `Logger`        | Quest picker UI, dashboard renderer, log ring-buffer                                             |
| `Tasks`         | Per-task-type handlers + `_bypassPost` transport picker + `bypassAchievement`                    |
| `loadModules()` | Dual-path module extraction (Vencord API + native fallback)                                      |
| `main()`        | Entry point — discovers stores, renders picker, runs the task pipeline                           |

## Runtime sequence

```
paste into console → IIFE + orionLock guard → loadModules() (Mods = {...})
  → Logger.showQuestPicker() (checkboxes + filters, user clicks START)
  → main() task loop: JIT enroll → run handler per type → cleanup
```

## Webpack store discovery

Discord ships its stores in minified webpack bundles whose exported paths (`e.Z`, `e.A`, `e.ZP`, …) change every build, so hardcoded paths rot within days. Since v4.6, `loadModules()` uses a dual path:

1. **Vencord integration** — if `window.Vencord.Webpack` is present, request stores/props via Vencord's injected API. Bypasses recent Discord Stable runtime limitations entirely.
2. **Native fallback** — for vanilla Canary/PTB, push a fake chunk to `webpackChunkdiscord_app` to capture the module registry, guard against Sentry's secondary runtime by picking the `__webpack_require__` with the largest cache, then match stores by `constructor.displayName` (e.g. `"QuestStore"`), not by minified key.

Vanilla Discord **Stable** no longer exposes the live cache post-boot, so Stable users need Vencord (issue #20).

## Task types

| Type                      | Mechanism                                                                                 | Automatable        |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------ |
| `PLAY_ON_DESKTOP`         | Inject a fake running game into `RunningGameStore`; Discord's heartbeat reports progress   | Yes                |
| `STREAM_ON_DESKTOP`       | Spoof `StreamStore.getStreamerActiveStreamMetadata`                                        | Yes                |
| `WATCH_VIDEO` / `_ON_MOBILE` | Poll the video-progress endpoint with natural float timestamps at `rnd(3500,4750)`ms   | Yes                |
| `ACTIVITY`                | Heartbeats against a voice-channel stream key                                              | Yes                |
| `ACHIEVEMENT_IN_ACTIVITY` | Heartbeat spoof first; on rejection, the OAuth → discordsays progress forgery (below)      | Yes, with consent  |

`ACHIEVEMENT_IN_ACTIVITY` is validated by the activity backend (`discordsays.com`), not the client, so there is no client heartbeat to forge — Discord rejects those with 403. The bypass instead authorizes against that backend and reports progress to it directly. Quests for age-gated or delisted activities still can't be done: `/proxy-tickets` returns HTTP 403 code `50165` and the activity won't launch even manually, so they're skipped.

## ACHIEVEMENT bypass (OAuth → discordsays)

Runs only after the heartbeat path is rejected, and only with the user's consent (see below). Steps, in `Tasks.bypassAchievement` (`index.js`) / `tasks.ts`:

1. `POST /oauth2/authorize` for the quest's app (`authorize:true`, scope `identify applications.commands applications.entitlements`) → extract `code` from the returned `location` URL.
2. `POST /applications/{appId}/proxy-tickets` → a proxy ticket.
3. Build the `{appId}.discordsays.com` referrer carrying that ticket.
4. `POST {appId}.discordsays.com/.proxy/acf/authorize {code}` → a Discord Says token.
5. `POST {appId}.discordsays.com/.proxy/acf/quest/progress {progress: target}`.

Trust model: Discord delegates progress validation to the activity backend, so a forged progress POST from an authorized session is accepted. Steps 4-5 are the ones blocked by the renderer CSP and routed through a transport (below).

**Grant lifecycle.** Before step 1, Orion snapshots the app's existing OAuth grants (`GET /oauth2/tokens`). The snapshot is a **precondition**: if it fails, the bypass aborts before authorizing, so it never creates a grant it can't later identify. A `finally` block revokes only grants for that app that were absent from the snapshot, whether the flow succeeded or threw, so a failed bypass never leaves the app authorized and an authorization that existed before the run is never touched (a manual authorization made in parallel *during* the run is the one edge it can't distinguish).

**Consent.** The OAuth authorization is gated on explicit user consent. In the userscript, `Consent.ask()` shows a popup (app name, scopes, revoke note) before step 1 and defaults to decline. In the Vencord plugin, the `achievementBypass` setting (off by default) is the consent gate, which also covers the non-interactive `/orion start` and Auto-Start paths.

## Transport picker (`_bypassPost`)

Steps 4-5 hit `*.discordsays.com`, which the renderer CSP forbids. `Tasks._bypassPost` tries transports in priority order, first hit wins:

1. **Localhost relay** on `127.0.0.1:43210` (CSP allows `connect-src http://127.0.0.1:*`). No client mod.
2. **Vencord native module** via `VencordNative.pluginHelpers.OrionQuests` (main-process fetch).
3. **DiscordNative HTTP probes** — best-effort, in case a future build exposes a generic HTTP method.
4. **Direct fetch** — works on web Discord (no CSP), blocked on Desktop.

The Vencord port skips the picker and calls its native module directly. Every transport uses `redirect: "error"` so a 3xx from discordsays can't bounce the auth token / proxy-ticket referrer to another host.

## Localhost relay (`tools/orion-relay/`)

A ~170-line PowerShell HTTP listener that exists purely to escape the renderer CSP: the userscript can reach `127.0.0.1` but not `discordsays.com`, and the relay (outside the browser sandbox) can reach `discordsays.com`. Endpoints: `GET /health` (relay detection) and `POST /proxy` (forward to discordsays). Hardening: scheme pinned `https`, host pinned to `^[0-9]+\.discordsays\.com$`, path pinned to the two `.proxy/acf/*` endpoints, no redirect following, CORS reflected only to Discord origins, a strict request-header allowlist, an inbound `Host` check, and a body-size cap. Residual: while running, any local process can still drive forged progress through it — but only to those two endpoints, and a caller without a valid OAuth code/DS token gets rejected by discordsays anyway.

## Vencord native module (`native.ts`)

A main-process IPC bridge that performs the CSP-exempt discordsays POSTs for the plugin (and, when installed, for the userscript via `pluginHelpers`). This is a trust boundary: it runs privileged and CSP-free, so it validates every renderer-supplied value that shapes the request — `appId` and `questId` must be numeric and the `Referer` must be `https` pointing exactly at `{appId}.discordsays.com` — and uses `redirect: "error"`.

## Traffic layer

`Traffic.enqueue(path, body)` is the single egress point for every quest-related HTTP call: FIFO with jittered gaps, exponential backoff on `429` (Retry-After aware), retries on `5xx` up to `SYS.MAX_RETRIES`, and `4xx` propagated to callers. On shutdown, queued and deferred requests are rejected so awaiters never hang.

## Cleanup lifecycle

Every long-running subscription (Dispatcher events, safety timers, patched store methods) registers a `finish` callback in `RUNTIME.cleanups`. On **STOP** (or unload): `RUNTIME.running = false`; every cleanup runs (unsubscribe, restore patched methods, clear timers); the dashboard DOM is removed; `window.orionLock` is released. Cleanups are idempotent, so a double-stop is safe.

## Anti-detection posture

All already in code, not proposals:

- **JIT enrollment** (v4.4): quests enrolled one at a time right before execution.
- **Randomized intervals**: every polling/heartbeat loop uses `rnd(min,max)` ranges.
- **Realistic PIDs** for injected games (multiples of 4).
- **Natural video timestamps**: 6-decimal float seconds; cadence `rnd(3500,4750)`ms (2x faster than Discord's native 7-9.5s player loop).
- **Concurrency**: games at 1, videos at 2 (both exposed as Vencord settings).
- **Optional `randomDelay`** (off by default): a `rnd(60_000,1_800_000)`ms idle gap between cycles. The Vencord port currently uses a fixed `rnd(2500,4500)`ms inter-cycle wait instead.

## Security posture

- **DOM**: all server-controlled strings (quest/reward names, log text) are HTML-escaped via `esc()` before they touch `innerHTML`; the consent popup sets the app name via `textContent`. No inline event handlers anywhere (Discord's CSP rejects them).
- **OAuth**: explicit consent before authorizing; snapshot-precondition + `finally` revoke; never logs tokens, auth codes, or grant ids.
- **SSRF**: numeric-`appId` validation and `redirect: "error"` on every discordsays request; the native module additionally validates `questId` and `Referer`; the relay pins scheme/host/path.
- **Relay**: Discord-only CORS, header allowlist, Host check, body cap (see above).

## Compatibility

- **Discord Desktop** (Stable, PTB, Canary). Stable needs Vencord for store discovery (issue #20).
- **Browsers / script-injection mobile browsers**: web-compatible quests only; `GAME`/`STREAM` are filtered out via `SYS.IS_DESKTOP`.
- **ACHIEVEMENT bypass on Desktop**: needs the relay or the Vencord plugin (CSP can't be escaped from the renderer alone). On web Discord the direct fetch works.

## Vencord plugin (`vencord-plugin/`)

A functional port, in sync with the userscript. It replaces manual webpack walking with `findStore`/`findByProps`, uses Vencord's settings instead of `CONFIG`, performs the CSP-exempt POSTs in `native.ts`, and exposes `/orion start|stop|status`. See `vencord-plugin/README.md`.

## Contributing

See `CONTRIBUTING.md` in the repo root.
