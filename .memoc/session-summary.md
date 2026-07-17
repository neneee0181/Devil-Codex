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
- v0.3.10: Sites navigation calls live `list_sites`, supports search/copy/Open in Devil browser, and starts build/deploy chats. `@` plugin suggestions now load without a workspace/runtime connection and group cached skills by plugin.

## Verification
- `npm run build` and `git diff --check` pass after Sites UI work.

## Resume
- Manual Electron check: open a Codex thread, choose `사이트`, and verify `list_sites` loads actual sites when the runtime exposes `sites`; Open should create a right-side browser tab.
