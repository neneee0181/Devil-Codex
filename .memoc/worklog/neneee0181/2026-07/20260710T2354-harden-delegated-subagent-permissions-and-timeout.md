---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-10T23:54:51
updated: 2026-07-10T23:54:51
status: done
tags:
  - memoc
  - memoc/worklog
---
# Harden delegated subagent permissions and timeout

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-10T23:54:51

## Summary

- Delegated Codex and Claude children now use the persisted Codex permission ceiling instead of unconditional full access.
- Added explicit timeout/terminal failures and an optional per-delegation reasoning effort.

## Changed Files

- `scripts/devil-subagent-mcp.cjs`
- `src/main/main.cts`
- `src/main/subagent-control-server.cts`

## Verification

- `npm run build`
- MCP `tools/list` smoke confirms the reasoningEffort schema is advertised.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
