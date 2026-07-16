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
- v0.3.4 subagent activity parity: child tabs now render their own user/agent/activity timeline with the same expandable command, MCP and per-file diff cards as main chat. Child history is keyed by child thread ID; it never shares main history. v0.3.3 detail improvements remain included.

## Verification
- `npm run build`, `npm run test:main`, and `git diff --check` pass.

## Resume
- Manual installed-app test: Bridge ON hides MCP and locks chat; OFF restores both; verify stock picker after restart.
