---
memoc: true
type: state
scope: project-memory
status: active
updated: 2026-07-18T03:42:37
created: 2026-07-18T03:42:37
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-18.

## Status
- v0.3.18 fixed stale Bridge model selection synchronization.
- Stock session `019f733f-7b48-7982-a467-69e0f76bfb0d` exposed zstd parsing failure; proxy now bounds/decodes request bodies.
- OpenCodex parity pass added compact, retries/timeouts, reasoning/tool history, image limits, atomic catalogs, and WebSocket framing. Fixed WebSocket-lite `additional_tools` causing zero tools.
- `npm run build`, `npm run test:main`, and `git diff --check` pass.

## Resume
- Restart/install and verify external turns, compact, images, and WebSocket. Preserve `.DS_Store`.
