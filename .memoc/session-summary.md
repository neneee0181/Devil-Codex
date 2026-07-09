---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-08T18:57:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-09T13:55:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.2.7 ready: provider routing/parity + steering insertion fix.

## Changed
- Fixed `019f4509...`: external first turns now send `modelProvider` + `model_provider` and wait/retry before proxy routing.
- Copilot uses `/chat/completions`; Antigravity aliases resolve to wire ids; added `zai` GLM provider.
- Steering queued turns insert after the interrupted turn.

## Open Tasks
- Manual E2E: Copilot `gpt-5.5`, Antigravity alias, Z.AI `glm-5.2`, steering.

## Resume
- `npm run build` passes under v0.2.7. Commit/tag/push pending.
