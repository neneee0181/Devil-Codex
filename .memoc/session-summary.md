---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-04T09:46:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T09:46:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Preparing v0.1.27 release: includes v0.1.26 perf/quota/bottom-dock fixes plus Claude live text ordering/final-text fix.
- Claude text blocks get unique ids; only result/end_turn final text is saved/emitted final agent; tool_use prefaces stay ordered work notes.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check` pass.
