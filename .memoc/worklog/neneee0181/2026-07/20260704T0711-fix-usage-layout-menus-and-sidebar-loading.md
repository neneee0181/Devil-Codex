---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T07:11:49
updated: 2026-07-04T07:11:49
status: active
tags:
  - memoc
  - memoc/worklog
---
# Fix usage layout menus and sidebar loading

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T07:11:49

## Summary

- Fixed Provider usage row clipping and changed quota labels to `% 사용` in Settings/account inline UI.
- Made thread copy submenu flip left near the viewport edge.
- Added sidebar loading rows while runtime thread/project lists refresh.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `package-lock.json`
- `package.json`
- `src/renderer/SettingsView.tsx`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`

## Verification

- `PATH="/opt/homebrew/bin:$PATH" npx tsc -p tsconfig.json --noEmit`
- `PATH="/opt/homebrew/bin:$PATH" npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
