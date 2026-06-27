---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-25T01:05:00
tags:
  - memoc
  - worklog
  - devil-codex
  - timeline
  - ui
  - memoc/worklog
updated: 2026-06-24T17:31:16
status: active
---
# Unify Codex/external activity UI

## Summary

- Updated the shared turn activity renderer so Codex and external-provider turns present activity in the same Codex-like structure.
- Grouped `rg` command activity into `코드 검색 N개` with visible searched queries.
- Grouped file/skill read commands into `파일 N개 읽음` with `Read ...` / skill-read lines.
- Kept generic shell commands expandable with a concise `... 실행 완료` label and shell output panel.
- Existing file edit, web-search, and provider diagnostic cards continue to render in the same activity stream.

## Verification

- `npm run build` passed.

## Manual follow-up

- Test one Codex turn and one external-provider turn that perform read/search/edit/build actions and compare the activity layout.
