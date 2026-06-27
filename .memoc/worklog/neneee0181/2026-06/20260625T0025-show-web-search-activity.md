---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-25T00:25:00
tags:
  - memoc
  - worklog
  - devil-codex
  - provider
  - sidecar
  - memoc/worklog
updated: 2026-06-24T16:55:57
status: active
---
# Show web-search sidecar activity in timeline

## Summary

- Added per-turn sidecar web-search event recording with query, status, sources, and failure reason.
- Emitted those events as `webSearch` timeline items so the activity summary can show `웹 검색 N개`.
- Added renderer UI for expandable `웹 검색: ...` rows separate from `Provider 진단`.
- Updated the opencodex port plan to reflect that web-search is now a bounded synthetic-tool loop, not the old pre-search MVP.

## Verification

- `npm run build` passed after the code changes.
- Manual verification still needed in Electron with Settings → 구성 → 웹 검색 sidecar ON and an external provider search prompt.
