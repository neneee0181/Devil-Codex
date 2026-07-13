---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-13T07:57:11
updated: 2026-07-13T07:57:11
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add Unreal MCP reconnect relay

actor: lim
actor_source: git config user.name
branch: codex/unreal-mcp-reconnect-relay
status: done
created: 2026-07-13T07:57:11

## Summary

- Added a project-neutral, loopback-only Unreal MCP relay that reconnects after an Unreal Editor restart without restarting Codex.
- Added default and non-default port setup documentation, preserving safe retry behavior for mutating tools.

## Changed Files

- `src/main/unreal-mcp-relay.cts`
- `src/main/main.cts`
- `docs/unreal-mcp-relay.md`
- `.memoc/02-current-project-state.md`
- `.memoc/03-decisions.md`
- `.memoc/session-summary.md`

## Verification

- `node node_modules\\typescript\\bin\\tsc -p tsconfig.electron.json`
- Live Unreal Editor restart: an existing relay session completed `tools/list` after native MCP restarted.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/lim.md)
