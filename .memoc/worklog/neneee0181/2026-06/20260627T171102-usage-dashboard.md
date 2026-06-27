---
memoc: true
type: worklog
actor: neneee0181
created: 2026-06-27T17:11:02
tags:
  - devil-codex
  - settings
  - usage
  - memoc
  - memoc/worklog
scope: project-memory
updated: 2026-06-27T09:11:29
status: active
---
# Usage Dashboard

## Summary
- Added usage tabs under Settings → 사용량 및 청구.
- Kept Provider quota view and added Devil usage view for local proxy activity.
- Devil usage groups request logs by provider/model and shows total tokens, input/output tokens, request counts, average duration, failures, and estimated USD cost.
- Proxy request logs now persist upstream token usage when `done.usage` is available.

## Notes
- Existing request-log entries from before this change can show request counts without token totals.
- Pricing is an estimate based on public provider pricing and should not be treated as exact billing.

## Verification
- `npm run build`
- `git diff --check`
