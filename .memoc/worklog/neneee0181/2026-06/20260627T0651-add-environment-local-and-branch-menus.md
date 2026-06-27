---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T06:51:57
updated: 2026-06-27T06:51:57
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add environment local and branch menus

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-27T06:51:57

## Summary

- Added environment local-side menu with Codex web and usage actions.
- Added environment branch menu for checkout and branch creation.
- Added external URL IPC for the Codex web link.

## Changed Files

- `memoc/session-summary.md`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`

## Verification

- `npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
