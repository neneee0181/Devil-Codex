---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T03:01:15
updated: 2026-07-04T03:01:15
status: active
tags:
  - memoc
  - memoc/worklog
---
# Claude Code dynamic slash commands

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T03:01:15

## Summary

- Confirmed Claude Code `/` suggestions were coming from Devil/Codex static command filtering, not Claude Code.
- Added SDK-backed `supportedCommands()` IPC and renderer state so Claude mode shows real cwd/model command list.
- Changed Claude command selection to insert literal `/command ` text instead of inline skill tokens.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `src/main/claude-runtime.cts`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/components/Composer.tsx`
- `src/renderer/components/ComposerSuggestions.tsx`
- `src/renderer/main.tsx`
- `src/shared/contracts.ts`

## Verification

- Local SDK smoke check returned 87 Claude commands for this repo.
- `PATH="/opt/homebrew/bin:$PATH" npx tsc -p tsconfig.json --noEmit`
- `PATH="/opt/homebrew/bin:$PATH" npm run build`; `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
