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
Last: 2026-07-11. Replace; keep <800B.

## Status
- v0.2.14 keeps native GPT models first in stock Codex and shows only user-selected Bridge models after them.
- Desktop startup now registers a catalog-only native model file; native requests remain direct.
- Delegated subagents now honor the persisted Codex permission ceiling, report terminal timeout/failure honestly, and accept an optional reasoning effort.

## Verification
- `npm run build`, `git diff --check`, and the subagent MCP tools-list smoke pass.

## Resume
- Commit/tag/push v0.2.14 when requested.
