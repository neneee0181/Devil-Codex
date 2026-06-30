---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-06-30T14:18:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-30T14:18:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.0.16 hotfix prepared for the app stuck at `Codex app-server 시작 중`: bundle Codex was bumped to `rust-v0.142.4`, app-server spawn now uses explicit stdio + remote-control disabled env, and initialize has a 30s timeout with child cleanup.

## Verify
- `npm run build` passes.
- `dist-electron/app-server.cjs` direct connect uses `vendor/codex` 0.142.4 and reaches `connected` in ~252ms.
