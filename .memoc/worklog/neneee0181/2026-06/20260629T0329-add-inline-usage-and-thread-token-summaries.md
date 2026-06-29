---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-29T03:29:40
updated: 2026-06-29T03:29:40
status: active
tags:
  - memoc
  - memoc/worklog
---
# add inline usage and thread token summaries

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-29T03:29:40

## Summary

- Added inline quota-window expansion under the account menu `남은 사용량` row.
- Added current-thread token summary and per-model rows to the environment popover.
- Verified with `npm run build`.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`

## Verification

- `npm run build`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
