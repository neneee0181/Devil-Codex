---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-21T23:42:56
updated: 2026-06-21T23:42:56
status: active
tags:
  - memoc
  - memoc/worklog
---
# Fix project composer and terminal UX

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-21T23:42:56

## Summary

- Fixed native xterm input and bottom tool popup layout.
- Added caret suggestions, permission warning, project menu/context, and lazy persisted thread creation.

## Changed Files

- `src/main/app-server.cts`
- `src/main/contracts.cts`
- `src/renderer/components/Composer.tsx`
- `src/renderer/components/TerminalSession.tsx`
- `src/renderer/components/ThreadList.tsx`
- `src/renderer/components/terminalKeyboard.ts`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`
- `src/renderer/components/ApprovalPicker.tsx`
- `src/renderer/components/ComposerSuggestions.tsx`
- `src/renderer/components/PermissionWarningDialog.tsx`
- `src/renderer/components/composerCaret.ts`
- `docs/CODEX_PARITY.md`
- `.memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`

## Verification

- `npm run build`; `git diff --check`.
- Electron: terminal file side effect, bottom popup, `$`/`/`, approval warning, project hover/menu/new-chat, immediate thread row verified.
- Escalated app-server `thread/list` confirmed persisted `Reply with exactly: thread-created-ui-ok` thread.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
