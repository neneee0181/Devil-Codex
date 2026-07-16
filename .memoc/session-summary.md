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
- v0.3.6 browser routing: Bridge OFF + Devil MCP ON temporarily disables only stock `browser@openai-bundled`, preventing its iab-only skill from overriding `devil_browser`; original plugin state restores on Bridge ON, MCP OFF, or exit. Other plugins/MCPs remain. Status also verifies App Server loaded Devil tools.

## Verification
- `npm run build`, `npm run test:main`, and `git diff --check` pass.

## Resume
- Manual: Bridge OFF + MCP ON → request Devil/우측 browser, verify `devil_browser`; Bridge ON → stock Codex Browser skill/iab remains available.
