---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-08T00:00:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-08T00:00:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.2.2: remote-web thread switch no longer shows previous thread; side chat inherits composer approval mode so it can read the repo.

## Changed
- `src/mobile/main.tsx`: clear history on thread switch + guard `?? currentThread` fallback.
- `src/renderer/main.tsx` + ToolContent/UtilityPanel/BottomDock: side chat inherits approval mode (createThread + sendTurn).
- `package.json`/lock: `0.2.2`.

## Open Tasks
- Commit/tag/push `v0.2.2`.

## Resume
- Passed: `npm run build` (exit 0), `git diff --check`. Pre-existing renderer tsc errors unrelated.
