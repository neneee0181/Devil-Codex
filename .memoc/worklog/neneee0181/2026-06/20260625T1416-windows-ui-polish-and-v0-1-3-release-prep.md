---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-25T14:16:48
updated: 2026-06-25T14:16:48
status: active
tags:
  - memoc
  - memoc/worklog
---
# Windows UI polish and v0.1.3 release prep

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-25T14:16:48

## Summary

- Added real app version display in Settings through Electron app-info IPC.
- Added non-macOS traffic-light window controls and Windows-safe project basename rendering.
- Bumped app/package version to `0.1.3` for the next Windows update test release.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`
- `package-lock.json`
- `package.json`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/SettingsView.tsx`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`

## Verification

- `git diff --check` passed.
- `npm run build` passed at `devil-codex@0.1.3`.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
