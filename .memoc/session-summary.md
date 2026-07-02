---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-02T12:30:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-02T12:30:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.1.1 release prep and stock restart continuation fixes are on origin/main.
- Claude Code runtime hardened: probe now detects the SDK's bundled platform `claude` binary (no external CLI needed), tool_result events from user messages resolve tool rows (was dead path), tool calls show in-progress via `item/started`, thinking streams as reasoning, text blocks separated, result usage attached to `turn/completed`.
- Session id is auto-generated and saved early via `onSessionId`, so a failed first turn can resume; user stop resolves quietly (no spurious 요청 실패 row).

## Verify
- `npm run build` passes; live haiku E2E: simple turn + bash tool turn both stream correct events.
