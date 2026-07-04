---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-04T12:24:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T12:24:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.1.29 prep: Codex `/` menu details/availability now use live model/MCP/skill/context/thread state. Built-ins stay local fallback because app-server has no slash/list API.
- Claude Code `/` menu uses SDK `supportedCommands()`.
- Codex `019f2a64...` duplicate rows fixed by attachment-footer normalization.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check` pass.
