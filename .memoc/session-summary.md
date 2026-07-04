---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-04T09:24:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T09:24:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Pulled 0.1.25, deps, rebuilt stale `dist-electron`; quota smoke: 5h 74% left, 7d 0%.
- Mac perf: cheaper composer, draft debounce, idle prefetch, scroll throttle, no-op polling skip, memoized timeline/Markdown/activity.
- Claude import 259.5MB/~1.8s -> cached + JSONL stat skip (~2ms). Bottom dock keys scope runtime+draft cwd.
- Bumped app to 0.1.26 for tag release.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check`, providerUsageReport smoke pass.
