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
Last: 2026-07-16. Replace; keep <800B.

## Status
- v0.2.20 Bridge live toggle: desktop reclaims the proxy from the headless handoff, writes/removes bridge config immediately, and restarts only an already-running stock GUI Codex. GPT/Codex requests are raw transparent pass-through; external IDs use adapters. Design: `docs/STOCK_CODEX_BRIDGE_LIVE_TOGGLE.md`.

## Verification
- `npm run test:main`, `npm run build`, and `git diff --check` pass.

## Resume
- Manual installed-app test: toggle ON/OFF/model selection with stock Codex open, then repeat closed.
