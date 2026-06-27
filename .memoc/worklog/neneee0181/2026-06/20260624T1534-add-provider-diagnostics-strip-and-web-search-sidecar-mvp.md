---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-24T15:34:47
updated: 2026-06-24T15:34:47
status: active
tags:
  - memoc
  - memoc/worklog
---
# add provider diagnostics strip and web-search sidecar mvp

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-24T15:34:47

## Summary

- Added collapsed Provider 진단 strip so route/provider/sidecar status is visible without opening 작업 내용.
- Added external-provider web-search sidecar MVP: default-off setting triggers one native Codex/ChatGPT pre-search for search-like prompts and injects result into provider context.
- Diagnostics now reports actual sidecar request count/failure reason; Codex direct route still ignores sidecars.

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
