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
Last: 2026-07-07T16:40:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.1.70 ready: Tailscale non-JSON status output no longer surfaces as `Unexpected token...`; environment card sits higher and scrolls within a smaller max-height.

## Changed
- `src/main/tailscale.cts`: catches non-JSON `status --json` output and returns it as a Tailscale offline/error message.
- `src/renderer/styles.css`: environment card top/z-index/max-height adjusted.
- `package.json`, `package-lock.json`: version `0.1.70`.

## Open Tasks
- Commit/tag/push `v0.1.70`.

## Resume
- Passed: `npm run build`, `git diff --check`, restricted-PATH Tailscale status smoke.
