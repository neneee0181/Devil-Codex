---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-06T14:40:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-07T15:52:00+09:00
Replace, do not append. Keep <800B.

## Status
- Environment usage parity follow-up: Codex native threads now use timeline `tokenUsage` as a fallback when no provider request log exists, so the environment modal shows request count and model token stats instead of only context/loading.

## Changed
- `src/renderer/main.tsx` thread usage aggregation.

## Open Tasks
- Version bump/tag/push pending for usage modal hotfix.

## Resume
- Passed: `PATH=/opt/homebrew/bin:$PATH npm run build`.
