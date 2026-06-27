---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-21T16:49:03
updated: 2026-06-21T16:49:03
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add Git diff review panel

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-21T16:49:03

## Summary

- Added sandboxed Electron IPC for per-file Git unified diffs, including untracked and staged-file fallback.
- Connected the environment change summary and review panel to real file selection, counts, and rendered line diffs.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`
- `README.md`
- `docs/CODEX_PARITY.md`
- `src/main/contracts.cts`
- `src/main/git-status.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`

## Verification

- `npm run build` passed.
- Electron manual check: opening `변경 사항` and selecting two modified text files rendered their actual unified diffs.

## Follow-up

- Add split/inline comments and stage/revert after the terminal PTY decision.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
