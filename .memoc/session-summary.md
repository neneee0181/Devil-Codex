---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-06T14:40:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-07T18:10:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.2.0 ready: remote settings now offers both public Funnel QR and direct Tailscale QR fallback; allowed-thread picker UI cleaned up.

## Changed
- `src/main/main.cts`: bind remote server on all interfaces, add tokenized `tailnetUrl`/QR, sanitize new token URL fields.
- `src/renderer/SettingsView.tsx`, `styles.css`: access cards, better QR/copy UX, styled allowed-thread cards.
- contracts updated; version `0.2.0`.

## Open Tasks
- Commit/tag/push `v0.2.0`.

## Resume
- Passed: `npm run build`, `git diff --check`; current public Funnel curl `/healthz` returned 200 before source change.
