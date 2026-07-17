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
- Bridge selection had a renderer race: rapid model clicks could overwrite earlier choices, leaving only the final saved models. The picker now commits each action from a latest-selection ref.
- Stock Bridge again uses `openai_base_url` to preserve stock thread identity; generated external catalog rows explicitly set `supports_websockets: false` so the HTTP/SSE proxy is used without a WebSocket preflight.
- Windows stock-Codex relaunch now uses stable `OpenAI.Codex_*` AppID, not display name `Codex` (installed app reports `ChatGPT`).

## Verification
- `npm run build`, `npm run test:main`, `git diff --check` pass. Config activation/removal and catalog WebSocket-flag smoke checks pass.

## Resume
- Manual installed-app check: enable Bridge, select 3+ models rapidly, confirm every row survives restart, then send a one-line Antigravity turn and inspect Provider request log plus provider-turn sync status.
