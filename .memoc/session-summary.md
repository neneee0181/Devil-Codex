---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-10T03:15:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-17. Replace; keep <800B.

## Status
- 2026-07-18: Bridge picker showed only two because config/catalog actually contained two; provider cache had many models. Added main-process settings write lock to prevent concurrent picker saves from overwriting a larger selection with a shorter snapshot. Electron main build and 12-selection concurrency smoke pass.
- 2026-07-18: Added keyless OpenCode Free provider from OpenCodex pattern: Zen `/models` live discovery, `big-pickle`/`*-free` filter, desktop client header, proxy/catalog/pickers, and privacy warning. Main/renderer builds and provider config smoke pass; live endpoint returned free model ids.
- 2026-07-18: Bridge save failure reproduced and fixed: `/v1/models` unions live + connected cached account/provider models. Stock routed catalog IDs now use OpenCodex-compatible `provider[@account]/model` slugs, with legacy colon migration and proxy compatibility. Version 0.3.16; main/renderer builds, main test, catalog/migration smoke pass.
- 2026-07-18: Stock Codex `projectless-thread-ids` now drives standalone chat classification; imported projectless threads no longer create/show as Devil project folders. TypeScript no-emit and diff checks pass.
- 2026-07-18: File-change summary card now waits until the final agent message stream/turn completes before appearing. TypeScript no-emit and diff checks pass.
- 2026-07-18: Long pasted text is kept as a compact attachment card after live completion sync; echoed model-bound attachment context no longer replaces it with the full body. TypeScript no-emit and diff checks pass.
- 2026-07-18: Native `turn/steer` removes the old activity/agent items, suppresses old completion from recreating the work tab, and lets the new turn create a fresh activity below the steering user message; old completion cannot clear newer active UI state. TypeScript no-emit and diff checks pass.
- 2026-07-18: Bridge catalog and Settings picker now merge account-specific + provider-wide models, preventing partial lists during staggered refreshes. macOS stock app relaunch supports both Codex and ChatGPT registrations/process names.
- Bridge selection had a renderer race: rapid model clicks could overwrite earlier choices, leaving only the final saved models. The picker now commits each action from a latest-selection ref.
- OpenCodex comparison confirmed built-in OpenAI always probes WebSocket under `openai_base_url`; external catalog rows therefore remove WS flags, while Bridge answers `/v1/responses` upgrades with `426` to force Codex's supported same-session HTTP/SSE fallback.
- Windows stock-Codex relaunch now uses stable `OpenAI.Codex_*` AppID, not display name `Codex` (installed app reports `ChatGPT`).

## Verification
- Electron-hosted TypeScript `--noEmit` and `git diff --check` pass. Full npm build unavailable because system `node`/`npm` are absent.

## Resume
- Manual installed-app check: enable Bridge, select 3+ models rapidly, confirm every row survives restart, then send a one-line Antigravity turn and inspect Provider request log plus provider-turn sync status.
