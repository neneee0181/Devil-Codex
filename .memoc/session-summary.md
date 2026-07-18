---
memoc: true
type: state
scope: project-memory
status: active
---
# Session Summary
Last: 2026-07-18.

## Status
- Bridge model selection could diverge because separate renderer settings hooks held stale snapshots. Added authoritative `settings:changed` IPC synchronization to every `useCodexSettings()` instance; released as v0.3.18.
- Full `npm run build`, `npm run test:main`, and `git diff --check` pass.

## Resume
- Install/restart Devil Codex, select exactly one Bridge model, then verify config/catalog and stock picker contain only that external model. Preserve `.DS_Store`.
