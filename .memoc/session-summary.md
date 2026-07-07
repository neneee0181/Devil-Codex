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
Last: 2026-07-07T15:18:00+09:00
Replace, do not append. Keep <800B.

## Status
- Cache/token usage fix completed. UI now separates fresh tokens, throughput, cache reuse/creation, cache miss diagnostics, and stale missing-final warnings. Model-change notices persist in thread history. Busy follow-up messages always show queued edit/steer/cancel UI before steering.

## Changed
- Runtime/contracts/history usage parsing, Claude cache-miss diagnostics, renderer usage/settings UI, Claude MCP config stability, prompt injection cleanup, queue steering path.

## Open Tasks
- Version bump/tag/push pending.

## Resume
- Passed: `PATH=/opt/homebrew/bin:$PATH npm run build`.
