---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-24T09:24:32
updated: 2026-06-24T09:24:32
status: active
tags:
  - memoc
  - memoc/worklog
---
# port provider credential model handling

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-24T09:24:32

## Summary

- Ported rcodex-style Copilot diagnostics: device/token/model calls now preserve upstream failure bodies and use consistent Copilot headers.
- Ported opencodex-style safer API-key model refresh: short cache + saved/static fallback for transient `/models` failures, while 401/403 credential errors still surface.
- Added env-key fallback for Anthropic, Google/Gemini, and DeepSeek API-key providers.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`
- `.memoc/wiki/index.md`
- `.memoc/wiki/knowledge/lint.md`
- `.memoc/wiki/knowledge/topics/README.md`
- `src/main/codex-provider-reconcile.cts`
- `src/main/main.cts`
- `src/main/provider-model-catalog.cts`
- `src/main/provider-oauth.cts`
- `src/main/provider-settings.cts`
- `src/main/provider-transcript.cts`

## Verification

- `npm run build` passed.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
