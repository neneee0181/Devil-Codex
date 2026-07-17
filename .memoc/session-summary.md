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
- v0.3.8: Fixed per-browser WebContents registration race. Each browser now keeps an independent pending URL and only selected tabs activate the MCP browser target; initial loading state and ChatGPT navigation no longer leak across tabs.

## Verification
- `npm run build` and `git diff --check` pass.

## Resume
- Manual Electron check: add multiple browser/terminal tabs in both docks; Ctrl/Cmd-click a link and verify a new browser tab opens with original page intact.
