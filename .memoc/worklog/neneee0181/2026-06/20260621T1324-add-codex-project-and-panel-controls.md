---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-21T13:24:58
updated: 2026-06-21T13:24:58
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add Codex project and panel controls

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-21T13:24:58

## Summary

- Added Codex-like project controls, open-with menu, account popup, and split utility panel.
- Connected external workspace opening through Electron IPC and Git review to live workspace data.
- Made project/open-with/account popovers mutually exclusive.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`
- `README.md`
- `docs/CODEX_PARITY.md`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`

## Verification

- `npm run build`
- `git diff --check`
- Electron manual test: project/open-with/account menus, utility panel, and Git review.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
