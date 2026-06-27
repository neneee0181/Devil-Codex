---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T07:05:19
updated: 2026-06-27T07:05:19
status: active
tags:
  - memoc
  - memoc/worklog
---
# Hide git controls without git workspace

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-27T07:05:19

## Summary

- Hid environment Git rows when changes are unavailable or cwd is `new-chat`.
- Guarded branch list loading and branch switching behind Git availability.

## Changed Files

- `memoc/session-summary.md`
- `src/renderer/main.tsx`

## Verification

- `npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
