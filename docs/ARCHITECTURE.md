# Architecture

This document describes how Orion is structured internally. It is intended for contributors and the curious — not a user guide.

## High-level overview

Orion is a single-file IIFE (`index.js`) that runs inside the Discord desktop client's DevTools console. It discovers Discord's internal webpack stores at runtime, introspects the currently-available quests, and coordinates handlers for each task type through a small task runner.

There are no external dependencies, no build step, and no state persisted outside `localStorage`. The entire lifecycle (from paste → completion → cleanup) is managed inside the IIFE's closure.

## File layout

```
OrionQuest/
├── index.js              # single-file distributable — the actual userscript
├── eslint.config.mjs     # ESLint flat config scoped to index.js
├── README.md             # end-user facing docs
├── docs/
│   └── ARCHITECTURE.md   # this file
├── vencord-plugin/       # early-stage Vencord/Equicord plugin port
└── .github/
    └── workflows/        # CI: lint + syntax check
```

## Module map (inside `index.js`)

The file is organized top-to-bottom as a layered IIFE. Each "module" is just a `const` object or function scoped to the outer closure.

| Module          | Responsibility                                                                 |
| --------------- | ------------------------------------------------------------------------------ |
| `CONFIG`        | User-tunable constants (colors, log limit, UI visibility toggles)              |
| `SYS`           | Frozen internal limits (max task time, retries, failure threshold)             |
| `RUNTIME`       | Mutable runtime state (running flag, cleanups, user selections, auto-enroll/claim preferences)|
| `ICONS`         | Inline SVG sprites used by the dashboard                                       |
| `CONST`         | Frozen event names and blacklisted quest IDs                                   |
| `Storage`       | Thin wrapper around `localStorage` (namespaced under `orion_*`)                |
| `ErrorHandler`  | Classifies HTTP errors into retryable / client / skippable                     |
| `Traffic`       | Request queue with exponential backoff, rate-limit awareness, retry ceiling    |
| `Mods`          | Reference to the Discord webpack stores discovered at boot                     |
| `Patcher`       | Injects fake running-game records into `RunningGameStore`                      |
| `Logger`        | Quest picker UI, dashboard renderer, and log ring-buffer                       |
| `Tasks`         | Per-task-type handlers (GAME / STREAM / VIDEO / ACTIVITY / ACHIEVEMENT)        |
| `main()`        | Entry point — discovers stores, renders dashboard, runs task pipeline          |

## Runtime sequence

```
paste into console
      │
      ▼
┌─────────────────────────┐
│  IIFE executes          │
│  window.orionLock guard │
└──────────┬──────────────┘
           │
           ▼
┌──────────────────────┐
│ loadModules()        │  discover stores via displayName
│ → Mods = {...}       │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────┐
│ Logger.showQuestPicker() │  visual UI — checkboxes + filters
│ user clicks START        │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────┐
│ main() task loop     │  JIT enroll → run handler → cleanup
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ task handler         │  per type: GAME / VIDEO / STREAM / ...
└──────────────────────┘
```

## Webpack store discovery

Discord ships its stores inside minified webpack bundles whose exported paths (`e.Z`, `e.A`, `e.Ay`, `e.ZP`, …) change with every build. Relying on hardcoded paths breaks within days.

Since v4.1, `loadModules()` takes a different approach:

1. Push a fake webpack chunk to obtain the module registry (`webpackChunkdiscord_app`).
2. Walk every module's exports.
3. Match stores by `constructor.displayName` (e.g. `"QuestStore"`, `"RunningGameStore"`, `"StreamStore"`), not by minified key.

`displayName` is a developer-ergonomic string that Discord generally keeps stable across builds, which gives us a cheap, robust hook point.

## Task types

Every Discord quest has one or more **tasks**, and each task has a **type** that determines how Orion satisfies it:

| Type                      | Mechanism                                                                                               | Automatable |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| `PLAY_ON_DESKTOP`         | Inject fake running-game into `RunningGameStore`; Discord's native heartbeat loop reports progress      | Yes         |
| `STREAM_ON_DESKTOP`       | Spoof `StreamStore.getStreamerActiveStreamMetadata` return value                                        | Yes         |
| `WATCH_VIDEO` / `WATCH_VIDEO_ON_MOBILE` | Polls the quest progress endpoint with natural float timestamps at 7–9.5s intervals        | Yes         |
| `ACTIVITY`                | Sends heartbeats against a voice-channel stream key                                                     | Yes         |
| `ACHIEVEMENT_IN_ACTIVITY` | Attempts heartbeat; falls back to passive mode + "GO TO QUESTS" button                                  | **No** — server-side validated |

ACHIEVEMENT quests are validated entirely by the activity server (`discordsays.com` for Embedded Activities) over the RPC PostMessage protocol. There is no client-side event that carries progress and no heartbeat payload we can forge — Discord rejects any such attempt with 403.

## Traffic layer

`Traffic.enqueue(path, body)` is the single egress point for every quest-related HTTP call. It provides:

- FIFO ordering with jittered gaps (anti burst).
- Exponential backoff on `429` (Retry-After header aware).
- Automatic retries for `5xx` (`SYS.MAX_RETRIES` ceiling).
- Propagation of `4xx` to callers so they can short-circuit.

This keeps the Task handlers free of any retry/backoff logic.

## Cleanup lifecycle

Every long-running subscription (Dispatcher events, safety timers, patched store methods) registers a `finish` callback with `RUNTIME.cleanups`. When the user clicks **STOP** on the dashboard (or the page unloads):

1. `RUNTIME.running = false` is set.
2. Every cleanup in `RUNTIME.cleanups` runs — unsubscribe listeners, restore patched methods, clear timers.
3. The dashboard DOM is removed.
4. `window.orionLock` is released so a fresh paste works.

A double-stop is safe — cleanups are idempotent.

## Anti-detection posture

Current notable choices (all already in code, not proposals):

- **JIT enrollment** (v4.4): quests are enrolled one-at-a-time right before execution, not in bulk up-front.
- **Randomized intervals**: every polling/heartbeat loop uses `rnd(min, max)` ranges — no fixed cadence.
- **Realistic PIDs** for injected games: multiples of 4, matching Windows NT kernel alignment.
- **Natural video timestamps**: 6-decimal float seconds that match Chromium's native `<video>` event timing.
- **Concurrency = 1**: sequential tasks avoid parallel request spikes.

## Compatibility

- **Discord Desktop only** (Stable, PTB, Canary). The script needs `window.webpackChunkdiscord_app`, which is only present in the Electron client.
- **Browsers** (Chrome, Kiwi, etc.) do not expose webpack chunks the same way → script exits with "Core modules not found".
- **Mobile clients** are out of scope and will remain so.

## Vencord plugin (`vencord-plugin/`)

A separate port that wraps the same logic as a Vencord/Equicord userplugin. It replaces manual webpack walking with `findByProps` / `findStore` helpers and uses Vencord's settings system instead of `CONFIG`. It is still early-stage — see `vencord-plugin/README.md` for status.

## Contributing

See `CONTRIBUTING.md` in the repo root.
