---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-06-29T12:29:16+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-29T12:29:16+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Account menu usage now expands inline under `남은 사용량`, showing quota windows like `5시간 / % / reset`. Environment popover shows current-thread token usage with total/context max and per-model rows from provider request logs plus context estimate.

## Verify
- `npm run build` passes.
- Manual: open account menu, expand `남은 사용량`; open environment popover in a thread and confirm the token block appears when usage/context data exists.
