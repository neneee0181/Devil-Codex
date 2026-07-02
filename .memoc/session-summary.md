---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-02T14:43:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-02T16:12:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Release prep for `v0.1.5`: DeepSeek provider-diagnostic fix audited/corrected; root `tsconfig.json` errors fixed; duplicate provider failure text deduped; user prompt rows preserved across completion/sync; side-chat/subagent UX fixed; provider usage force refresh added for open/manual/turn-completed/request-completed.
- User approved version bump/upload. `package.json`/lock bumped to `0.1.5`; commit/tag/push in progress. Untracked `test.md`, `test.txt`, `test2.md` intentionally excluded.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, and `git diff --check` pass under `devil-codex@0.1.5`.
