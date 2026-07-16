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
- v0.3.1 Bridge restart fix: Windows stock-Codex launcher uses only the `OpenAI.Codex_*` AppsFolder identity. It never falls back to `Codex`/`cmd`, which could start Devil's bundled CLI and show a trust prompt. Design: `docs/STOCK_CODEX_BRIDGE_LIVE_TOGGLE.md`.

## Verification
- `npm run build` and `git diff --check` pass; run `npm run test:main` before release.

## Resume
- Manual installed-app test: Bridge ON hides MCP and locks chat; OFF restores both; verify stock picker after restart.
