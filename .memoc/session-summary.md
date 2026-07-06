---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-06T13:45:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-06T13:45:00+09:00
Replace, do not append. Keep <800B.

## Status
- Remote-control MVP implemented: tailnet default, Funnel opt-in, mobile PWA core UI.

## Changed
- Added `remote-server/auth/tailscale` main modules, WS IPC bridge allowlist, token+device approval+rate limit, QR/status Settings UI.
- Added `src/mobile` PWA and `build:mobile`; package includes `dist-mobile/**`; deps `ws`, `qrcode`.

## Open Tasks
- Manual device test: Tailscale phone QR -> approve -> list/read/send/approval. Funnel LTE test still needed.
- Feature-gap backlog: plan mode (both), manual /compact (claude), native codex /review.

## Resume
- Passed: `npm run build` (renderer + mobile + main). Build output `dist-mobile/` is generated, not source.
