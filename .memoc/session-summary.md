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
- README now documents only the current project architecture, supported features, Bridge selection behavior, and development commands.
- Default-mode question routing now directs genuinely blocking questions to Devil Ask MCP; native Plan mode uses only Codex's native question tool.

## Verification
- `npm run build` and `git diff --check` pass for the question-routing change.

## Resume
- Question-routing fix is uncommitted; restart the desktop app and manually verify fresh Default and Plan-mode turns before committing if requested.
