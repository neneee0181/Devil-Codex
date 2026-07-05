---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-05T22:45:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-05T22:45:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.1.43 prep: terminal startup crash fixed for right/bottom tabs.

## Changed
- `terminal-manager.cts` now falls through auto shell candidates, catches fallback spawn errors, and uses a safe cwd when a new-thread project path is missing.
- Version bumped to `0.1.43`.

## Open Tasks
- Manual in-app check: multi-turn Claude chat, stop button, model switch mid-thread.
- User-side installed-app check: right/bottom terminal on a project new thread should not show a main-process JS error.

## Resume
- Passed: `npm run build:main`, `npm run build:renderer`, `git diff --check`. Direct Node smoke created sessions but ConPTY helper did not exit cleanly outside Electron.
