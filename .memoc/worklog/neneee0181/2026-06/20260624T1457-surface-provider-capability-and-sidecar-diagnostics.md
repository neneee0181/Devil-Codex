---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-24T14:57:33
updated: 2026-06-24T14:57:33
status: active
tags:
  - memoc
  - memoc/worklog
---
# surface provider capability and sidecar diagnostics

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-24T14:57:33

## Summary

- Added Provider 연결 capability rows so model capability metadata is visible outside the model picker.
- Added default-off sidecar settings and per-turn diagnostics that show sidecar enabled/disabled plus request-count budget.
- Changed diagnostics emission to attach to the completed turn when possible, reducing UI sync/refresh hiding.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`
- `.memoc/wiki/index.md`
- `.memoc/wiki/knowledge/lint.md`
- `.memoc/wiki/knowledge/topics/README.md`
- `src/main/codex-provider-reconcile.cts`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/main/provider-model-catalog.cts`
- `src/main/provider-oauth.cts`

## Verification

- `npm run build`
- `.memoc/bin/memoc lint-wiki`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
