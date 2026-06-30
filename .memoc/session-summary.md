---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-06-30T18:42:15+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-30T18:42:15+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.0.20 release prep in progress: multi-bug UI/runtime fix plus speed-setting contamination fix are implemented; package/package-lock bumped to 0.0.20 for tag-based updater release.

## Verify
- `npm run build` passes on 0.0.20.
- Smoke checks passed for context snapshot attach, Windows icon extraResources, and `git diff --check` on touched files.
