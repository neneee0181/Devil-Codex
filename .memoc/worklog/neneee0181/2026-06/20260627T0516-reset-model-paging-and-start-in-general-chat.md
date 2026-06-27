---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T05:16:43
updated: 2026-06-27T05:16:43
status: active
tags:
  - memoc
  - memoc/worklog
---
# Reset model paging and start in general chat

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-27T05:16:43

## Summary

- Changed model picker paging to 10 models per reveal and reset reveal counts when the picker closes.
- Changed app startup/connect to land on the standalone general chat cwd, matching the top-left `새 채팅` behavior.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `src/renderer/components/ModelPicker.tsx`
- `src/renderer/main.tsx`

## Verification

- `npm run build` passed.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
