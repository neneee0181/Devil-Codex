---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-24T09:33:11
updated: 2026-06-24T09:33:11
status: active
tags:
  - memoc
  - memoc/worklog
---
# add provider usage settings view

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-24T09:33:11

## Summary

- Added provider usage IPC/reporting for logged-in Codex, Claude Code, and Copilot.
- Implemented Settings → Usage & Billing cards: Codex/Claude use rcodex-style quota APIs; Copilot shows unavailable because no reliable quota API was found.
- Account-menu "남은 사용량" already routes to this tab, so it now lands on real provider usage UI.

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

- `npm run build` passed.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
