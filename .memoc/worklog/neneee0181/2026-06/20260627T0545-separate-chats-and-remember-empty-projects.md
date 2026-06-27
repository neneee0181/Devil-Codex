---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T05:45:11
updated: 2026-06-27T05:45:11
status: active
tags:
  - memoc
  - memoc/worklog
---
# Separate chats and remember empty projects

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-27T05:45:11

## Summary

- Moved general chats out of the Projects list into a separate `채팅` section with spacing.
- Remembered chosen/created project cwd values locally so empty projects show in the sidebar immediately.
- Re-adding a hidden project now removes it from the hidden-project list.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`

## Verification

- `npm run build` passed.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
