---
title: Align stock Bridge WebSocket fallback with OpenCodex
date: 2026-07-18
actor: neneee0181
---

- Compared `lidge-jun/opencodex` Bridge injection and server transport code.
- Confirmed loopback history-safe route is `openai_base_url`, not a custom root model provider.
- Added explicit `426 Upgrade Required` for authenticated `/v1/responses` WebSocket upgrades; Codex falls back to HTTP/SSE.
- Removed WS capability flags from generated external catalog rows. Build, main test, diff check, catalog gate, and compiled fallback checks pass. Installed external-turn E2E remains.
