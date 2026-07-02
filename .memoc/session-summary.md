---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-03T10:30:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-03T10:30:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Releasing `0.1.17`: verified Codex's uncommitted fixes (steering order, dock/composer overlap, project name dialog+rename, Ctrl+R running restore, caveman hook filter, Claude session path fallback, scrollbar) all applied; build/typecheck pass.
- Residual risks fixed: running-turn restore only on renderer `reload` (cold start clears stale badges); `claudeSessionPath` caches resolved paths to avoid repeated full `.claude/projects` scans.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check` pass.
