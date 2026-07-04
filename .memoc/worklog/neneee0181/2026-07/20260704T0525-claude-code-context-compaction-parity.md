---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T05:25:46
updated: 2026-07-04T05:25:46
status: active
tags:
  - memoc
  - memoc/worklog
---
# Claude Code context compaction parity

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T05:25:46

## Summary

- Enabled native Claude Code auto-compact behavior for SDK turns.
- Added real SDK context usage capture/persistence and separated cache-inclusive last-request usage from current context UI.
- Bumped package version to `0.1.30` for release.

## Changed Files

- `src/main/claude-runtime.cts`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/provider-transcript.cts`
- `src/main/thread-history.cts`
- `package.json`
- `package-lock.json`
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
