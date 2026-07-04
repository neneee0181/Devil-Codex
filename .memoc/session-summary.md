---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-04T14:26:23+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T14:26:23+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.1.30 prep: Claude Code context parity fix enables native auto compact, reads `Query.getContextUsage()` for actual current context, and labels fallback result usage as last-request/cache-included instead of current context.
- Context metadata persists to Claude transcript rows and survives timeline parsing/reload; UI status/model/slash labels distinguish current, estimated, and last-request context.
- Latest verification: `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check` pass.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check` pass.
