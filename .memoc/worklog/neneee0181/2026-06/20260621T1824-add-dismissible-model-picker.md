---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-21T18:24:27
updated: 2026-06-21T18:24:27
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add dismissible model picker

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-21T18:24:27

## Summary

- Added shared outside-click/Escape dismissal hooks for shell and composer popovers.
- Replaced native model select with a Codex-like reasoning/model/speed nested picker.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `docs/CODEX_PARITY.md`
- `src/renderer/components/Composer.tsx`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/renderer/components/ModelPicker.tsx`
- `src/renderer/hooks/useOutsideDismiss.ts`

## Verification

- `npm run build` and `git diff --check` passed.
- Electron verified model/submenu content and outside-click dismissal for model, approval, and account menus.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
