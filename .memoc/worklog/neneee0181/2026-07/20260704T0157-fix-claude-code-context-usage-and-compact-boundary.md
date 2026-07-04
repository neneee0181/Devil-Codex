---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T01:57:55
updated: 2026-07-04T11:27:14+09:00
status: active
tags:
  - memoc
  - memoc/worklog
---
# fix claude code context usage and compact boundary

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T01:57:55

## Summary

- Fixed Claude Code usage accounting: cache tokens are no longer mixed into displayed uncached input, while `contextUsage` still reflects the prompt input size used for context pressure.
- Added live/import handling for Claude Code `compact_boundary` system records so automatic/manual compaction appears as a compaction activity and survives restart.
- Adjusted usage totals/cost estimates to handle both old cache-in-input logs and new separated cache logs; Claude overflow status now says next request uses Claude Code auto-compaction.
- Fixed app back/forward navigation to preserve the active thread plus runtime and refresh nav button enabled state.
- Fixed intermittent duplicate Claude Code response display by skipping active-thread periodic native JSONL sync/merge for Claude Code live timelines and attaching the live `turnId` to completed transcript appends.
- Bumped app version to `0.1.28`.

## Changed Files

- `src/main/claude-runtime.cts`
- `src/main/provider-transcript.cts`
- `src/renderer/SettingsView.tsx`
- `src/renderer/main.tsx`
- `src/renderer/providerPricing.ts`
- `src/renderer/threadTimeline.ts`
- `package.json`
- `package-lock.json`

## Verification

- `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" npx tsc -p tsconfig.json --noEmit`
- `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
