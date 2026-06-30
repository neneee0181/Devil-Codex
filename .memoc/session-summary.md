---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-06-30T18:05:33+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-30T18:05:33+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Update detection fix is committed on top of v0.0.19 without a version bump: renderer now calls `checkForUpdates()` after subscribing to update state, and packaged apps poll GitHub latest every 5 minutes instead of every 6 hours.

## Verify
- `npm run build` passes.
- GitHub latest release API returned `v0.0.19` with Windows assets, so the remaining issue was stale/missed polling state.
