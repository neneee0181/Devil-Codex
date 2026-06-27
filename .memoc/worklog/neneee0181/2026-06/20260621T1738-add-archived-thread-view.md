---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-21T17:38:56
updated: 2026-06-21T17:38:56
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add archived thread view

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-21T17:38:56

## Summary

- Added project-menu archived thread view backed by `thread/list({ archived: true })`.
- Kept restore unimplemented until app-server protocol method is verified.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `docs/CODEX_PARITY.md`
- `src/renderer/components/ThreadList.tsx`
- `src/renderer/main.tsx`
- `src/renderer/components/ArchivedThreadsView.tsx`

## Verification

- `npm run build` and `git diff --check` passed.
- Electron renderer loaded; hover-only project menu was not exposed in accessibility automation.

## Follow-up

- Verify restore method from app-server schema before adding restore action.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
