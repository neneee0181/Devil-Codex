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
- Bridge external turns now select managed `model_provider = "devil"` with `supports_websockets = false`; prior `openai_base_url` kept WebSocket prewarm on and produced 404/500 before Antigravity.
- Windows stock-Codex relaunch now uses stable `OpenAI.Codex_*` AppID, not display name `Codex` (installed app reports `ChatGPT`).

## Verification
- `npm run build`, `npm run test:main`, `git diff --check` pass. AppID probe passes.

## Resume
- Manual installed-app check: enable Bridge, confirm selected models, send a one-line Antigravity turn, then inspect Provider request log for completed/failed route.
