---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-06T14:40:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-07T17:05:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.1.71 ready: remote web is allowed-thread-only; empty allowed list now shows guidance instead of projects/new-thread UI.

## Changed
- `src/main/main.cts`: remote lists always filtered by `remoteAllowedThreadIds`; remote `thread:create` always denied; `remote:scope` always restricted.
- `src/mobile/main.tsx`: default remote scope starts restricted to avoid project/create UI flash.
- contract comments updated; version `0.1.71`.

## Open Tasks
- Commit/tag/push `v0.1.71`.

## Resume
- Passed: `npm run build`, `git diff --check`.
