---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T06:07:32
updated: 2026-06-27T06:07:32
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add thread context and sidebar menus

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-27T06:07:32

## Summary

- Added thread right-click menu for marker pin/unpin and Devil-only hide/delete.
- Added project header menu with archive visible chats, sort modes, and sidebar layout modes.

## Changed Files

- `memoc/session-summary.md`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`

## Verification

- `npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
