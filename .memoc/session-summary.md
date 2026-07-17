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
Last: 2026-07-17. Replace; keep <800B.

## Status
- v0.3.9: Devil MCP registrations now exist only while Devil desktop is running. Shutdown waits for browser/computer/ask/subagent MCP removal; Bridge owners also clean all Devil MCP entries before serving stock Codex.
- Composer: `@` lists installed Codex plugins by name; choosing one expands its bundled skills into the actual request. `$` remains single-skill selection.

## Verification
- `npm run build` and `git diff --check` pass.

## Resume
- Manual Electron check: quit Devil with Bridge OFF, then open stock Codex and confirm no `devil_*` MCP tool is offered. With Bridge ON, confirm the same while the background Bridge service is running.
