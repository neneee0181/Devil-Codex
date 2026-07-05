---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-05T22:23:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-05T22:23:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.1.42 prep: Codex provider quota parser fixed for Settings/account usage.

## Changed
- `provider-usage.cts` now prefers official `rate_limit.primary_window`/`secondary_window` and avoids mixing monthly/additional quota candidates into 5h/7d rows.
- Version bumped to `0.1.42`.

## Open Tasks
- Manual in-app check: multi-turn Claude chat, stop button, model switch mid-thread.
- User-side installed-app check: Settings/account usage should no longer show 5시간 as 100% used when API reports low usage.

## Resume
- Passed: `npm run build:main`, `npm run build:renderer`, parser fixture, live Codex usage smoke.
