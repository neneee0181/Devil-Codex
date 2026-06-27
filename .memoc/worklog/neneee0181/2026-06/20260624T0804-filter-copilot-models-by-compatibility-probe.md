---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-24T08:04:40
updated: 2026-06-24T08:04:40
status: active
tags:
  - memoc
  - memoc/worklog
---
# reject Copilot compatibility probe

actor: neneee0181
actor_source: git config user.name
branch: main
status: superseded
created: 2026-06-24T08:04:40

## Summary

- Investigated token-heavy Copilot model compatibility probing and rejected it.
- opencodex/rcodex use metadata/cache based model discovery, not per-model generation probes.
- Probe code was removed; follow-up should fix Gemini-like empty turns in adapter parsing/error handling.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `.memoc/worklog/neneee0181/2026-06/20260624T0804-filter-copilot-models-by-compatibility-probe.md`
- `src/main/provider-oauth.cts`
- `src/renderer/hooks/useProviders.ts`
- `src/renderer/main.tsx`

## Verification

- `npm run build` passed.
- `git diff --check` passed.

## Follow-up

- Inspect the actual Copilot/Gemini SSE shape before adding deny rules or parser changes.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
