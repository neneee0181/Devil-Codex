---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-10T03:15:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-16. Replace; keep <800B.

## Status
- v0.3.5 MCP readiness: Settings > 구성 > 도구 now verifies browser/computer control server plus both MCP config entries, showing ready/disabled/bridge/error with refresh. Toggle still restarts every per-thread app server; no full app restart required. Current install: Bridge OFF, enabled, both registrations and named pipes present.

## Verification
- `npm run build`, `npm run test:main`, and `git diff --check` pass.

## Resume
- Manual installed-app test: Tools status must show 사용 가능, then request an in-app-browser action in a new message; model should call `devil_browser`, not launch Chrome.
