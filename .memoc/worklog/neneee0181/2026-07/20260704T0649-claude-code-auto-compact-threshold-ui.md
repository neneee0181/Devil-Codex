---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T06:49:22
updated: 2026-07-04T06:49:22
status: active
tags:
  - memoc
  - memoc/worklog
---
# Claude Code auto-compact threshold UI

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T06:49:22

## Summary

- Preserved Claude SDK `autoCompactThreshold`/`isAutoCompactEnabled` in `ContextUsage` for live turns and reloaded history.
- Updated context UI surfaces to use the auto-compact threshold as the active limit while showing the raw max window separately.
- Confirmed the referenced Claude session's compaction was manual, not automatic.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `src/main/claude-runtime.cts`
- `src/main/contracts.cts`
- `src/main/thread-history.cts`
- `src/renderer/components/ComposerSuggestions.tsx`
- `src/renderer/components/ModelPicker.tsx`
- `src/renderer/main.tsx`
- `src/renderer/threadTimeline.ts`
- `src/shared/contracts.ts`

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
