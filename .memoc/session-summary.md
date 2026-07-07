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
Last: 2026-07-07T16:20:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.1.69 ready: macOS Tailscale remote/Funnel CLI detection now works when Electron lacks shell PATH.

## Changed
- `src/main/tailscale.cts`: tries Tailscale.app bundle CLI and common absolute paths on macOS/Linux, not only PATH `tailscale`.
- `package.json`, `package-lock.json`: version `0.1.69`.

## Open Tasks
- Commit/tag/push `v0.1.69`.

## Resume
- Passed: `npm run build`; restricted-PATH smoke resolved `/Applications/Tailscale.app/Contents/MacOS/tailscale` and status installed/online.
