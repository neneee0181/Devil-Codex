---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-02T23:52:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-03T00:16:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Current version is `0.1.14`; latest fixes are local only, not bumped/committed/pushed.
- `CAVEMAN MODE ACTIVE` remains visible to mirror stock Claude CLI; moved hook-only JSONLs were restored and no code quarantines/rewrites Claude JSONLs.
- Composer clear uses `replaceChildren()` per draft key; uncached thread opens now show loading UI instead of hidden initializing content.
- Perf hotfix: visible chat timeline events and terminal command-history output are batched with `requestAnimationFrame`. Streaming agent text now renders as lightweight pre-wrap text until the turn completes, then switches back to Markdown; per-turn change metadata is precomputed to reduce rerender work.
- Prior `v0.1.14` already fixed keyed terminal reuse and broad Claude project cwd import.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, and `git diff --check` pass.
