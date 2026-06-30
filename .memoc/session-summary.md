---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-06-30T15:53:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-30T15:53:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.0.18 fixes a remaining IPC race: `showMainWindow()` can no longer create a window before IPC handlers are ready, and tray creation now happens after handler registration. This prevents `No handler registered for 'runtime:status'` after install/relaunch.

## Verify
- `npm run build` passes.
- Built `dist-electron/main.cjs` has `runtime:status` before startup `createWindow()`, and local `npm start` spawned renderer plus `vendor/codex/codex.exe app-server --stdio`.
