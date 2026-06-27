---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-22T03:29:27
updated: 2026-06-22T03:29:27
status: active
tags:
  - memoc
  - memoc/worklog
---
# Fix terminal command console

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-22T03:29:27

## Summary

- Replaced Electron-invisible xterm/transcript path with native command input plus PTY scrollback.
- Moved `$` and `/` suggestions into a viewport portal and made selected skills inline composer tokens.
- Enlarged and pointer-captured bottom dock resize handle.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `docs/CODEX_PARITY.md`
- `src/renderer/components/BottomDock.tsx`
- `src/renderer/components/Composer.tsx`
- `src/renderer/components/ComposerSuggestions.tsx`
- `src/renderer/components/TerminalSession.tsx`
- `src/renderer/styles.css`
- `src/renderer/components/composerEditor.ts`
- `src/renderer/components/terminalText.ts`

## Verification

- `npm run build`
- `git diff --check`
- Electron: `echo 한글`, slash picker, inline Memoc token, launcher popup, divider drag.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
