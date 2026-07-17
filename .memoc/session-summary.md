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
- Dock tabs now permit multiple independent browser and terminal instances. Browser WebContents are registered per tab, preserved while switching, and MCP stays bound to selected tab. Ctrl/Cmd-click and `window.open` create/focus a new tab in same dock. Files/review remain single-instance.

## Verification
- `npm run build` and `git diff --check` pass.

## Resume
- Manual Electron check: add multiple browser/terminal tabs in both docks; Ctrl/Cmd-click a link and verify a new browser tab opens with original page intact.
