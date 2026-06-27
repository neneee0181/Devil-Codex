---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T05:28:42
updated: 2026-06-27T05:28:42
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add project creation modal

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-27T05:28:42

## Summary

- Added a Codex-like project creation modal and sidebar Projects header add control.
- Added a local project-folder IPC that creates real folders under `~/Documents/Codex/Projects`, preserving cwd-based Codex/Devil sync.
- Reset model picker expanded-provider state when the picker closes.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/components/ModelPicker.tsx`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`

## Verification

- `npm run build` passed.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
