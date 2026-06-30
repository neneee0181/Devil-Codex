---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-06-30T15:40:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-30T15:40:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.0.17 fixes the remaining startup hang: `startCodexProxy()`/MCP registration no longer blocks `createWindow()`, IPC handlers are registered before the window loads, and renderer runtime connect failures now surface as errors instead of leaving `Codex app-server 시작 중` stuck.

## Verify
- `npm run build` passes.
- Local `npm start` spawned renderer plus `vendor/codex/codex.exe app-server --stdio`; startup no longer blocked before the window path.
