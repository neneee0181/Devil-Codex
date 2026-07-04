---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T00:02:36
updated: 2026-07-04T00:02:36
status: active
tags:
  - memoc
  - memoc/worklog
---
# Fix quota build sync, composer lag, bottom dock state

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T00:02:36

## Summary

- Pulled `origin/main`, installed newly locked Claude SDK deps, and rebuilt ignored `dist/` + `dist-electron/`; stale built Provider usage logic was the confirmed 5-hour `0%` display cause.
- Reduced Mac renderer lag by making composer input snapshots cheaper, debouncing draft localStorage writes, moving thread-history prefetch to idle time, and throttling scroll state/storage writes.
- Measured runtime-switch slowness: Claude import parsed 259.5MB on every summaries/read (~1.8s). Added transcript memory cache plus Claude JSONL mtime/size skip so unchanged checks use the ~2ms stat path.
- Follow-up perf pass: unchanged thread/project polling results now skip React state updates, and timeline/Markdown/activity components are memoized with stable timeline callbacks so unrelated App state changes do not reparse old messages.
- Fixed bottom dock leakage by scoping empty-thread state to runtime + new-chat/project-draft cwd and moving runtime-prefixed UI state keys.
- Bumped `package.json` and `package-lock.json` to `0.1.26` for the tag-triggered release workflow.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `package.json`
- `package-lock.json`
- `src/renderer/components/Composer.tsx`
- `src/renderer/components/composerEditor.ts`
- `src/renderer/components/MarkdownContent.tsx`
- `src/renderer/components/TimelineCard.tsx`
- `src/renderer/components/TurnActivity.tsx`
- `src/renderer/main.tsx`
- `src/main/provider-transcript.cts`
- `src/renderer/styles.css`

## Verification

- `npx tsc -p tsconfig.json --noEmit`
- `npm run build`
- `git diff --check`
- Built `providerUsageReport` smoke check against local Codex OAuth token; current API returned `5시간 used=26 remaining=74`, `7일 used=100 remaining=0`.
- Local timing probes: old Claude JSONL full read/parse path ~1795ms for 13 files/259.5MB; stat-only changed-file path ~2ms.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
