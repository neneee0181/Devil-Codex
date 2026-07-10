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
Last: 2026-07-10. Replace; keep <800B.

## Status
- Stock bridge works; native uses transparent passthrough; first five `spawn_agent` candidates are selected external models.
- v0.2.11 adds Settings -> 구성 -> 순정 Codex Bridge toggle to restore stock Codex mode.

## Changed
- Catalog injection, desktop-to-headless handoff, Windows autostart, stock web/vision sidecars.
- Toggle off removes managed bridge config, scheduled task, and stale headless bridge process.

## Resume
- Full build/diff check pass for v0.2.11. Commit/tag/push if not done.
