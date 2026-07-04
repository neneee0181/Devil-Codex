---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-04T15:51:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T15:51:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.1.32 prep: Claude Code auto-compact UI follow-up preserves SDK `autoCompactThreshold`/`autoCompactEnabled`; Claude SDK parsing, history reload, model picker, `/status`, and environment usage use the threshold as the current-context limit while still showing the raw max window separately.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check` pass.
