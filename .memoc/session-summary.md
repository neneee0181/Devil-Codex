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
Last: 2026-07-16. Replace; keep <800B.

## Status
- v0.2.22 Bridge entry UX: ON disables new-chat entry points (sidebar, project rows, Windows menu, shortcuts, command palette) while preserving existing tabs/settings. Server chat/MCP block remains. Design: `docs/STOCK_CODEX_BRIDGE_LIVE_TOGGLE.md`.

## Verification
- `npm run build` and `git diff --check` pass; run `npm run test:main` before release.

## Resume
- Manual installed-app test: Bridge ON hides MCP and locks chat; OFF restores both; verify stock picker after restart.
