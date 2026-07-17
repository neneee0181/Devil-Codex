---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-17T13:43:00
updated: 2026-07-17T13:43:00
status: active
tags:
  - memoc
  - memoc/worklog
---
# Fix stock Bridge Codex relaunch and proxy health validation

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-17T13:43:00

## Summary

- Replaced Bridge `openai_base_url` override with managed `model_provider = "devil"` and HTTP/SSE-only transport.
- Fixed Windows stock-Codex restart discovery to use `OpenAI.Codex_*` AppID.

## Changed Files

- `src/main/codex-config.cts`
- `src/main/main.cts`
- `docs/STOCK_CODEX_BRIDGE_LIVE_TOGGLE.md`

## Verification

- `npm run build`; `npm run test:main`; `git diff --check`.
- Temporary Bridge config creation/removal smoke passed; installed-app Antigravity request remains manual.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
