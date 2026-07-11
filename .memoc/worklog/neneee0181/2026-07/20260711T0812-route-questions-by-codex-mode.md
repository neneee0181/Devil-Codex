---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-11T08:12:24
updated: 2026-07-11T08:12:24
status: done
tags:
  - memoc
  - memoc/worklog
---
# Route questions by Codex mode

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-11T08:12:24

## Summary

- Default mode turns now explicitly use Devil Ask MCP for genuinely blocking decisions, instead of attempting unavailable native `request_user_input`.
- Native Codex Plan mode keeps the native question tool and excludes Devil Ask MCP.

## Changed Files

- `src/main/main.cts`

## Verification

- `npm run build`
- `git diff --check`

## Follow-up

- Restart the desktop app and confirm a fresh Default-mode turn opens the Devil Ask modal; confirm Plan mode uses native Codex questioning instead.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
