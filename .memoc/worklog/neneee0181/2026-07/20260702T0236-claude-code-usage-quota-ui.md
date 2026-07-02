---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-02T02:36:40
updated: 2026-07-02T02:36:40
status: active
tags:
  - memoc
  - memoc/worklog
---
# claude-code-usage-quota-ui

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-02T02:36:39

## Summary

- Claude Code usage now parses Anthropic OAuth usage recursively and normalizes CLI-style quota windows.
- Settings Usage opens Provider limits first and displays used %, not remaining %.
- Account menu usage now prefers the currently selected provider, so Claude Code mode shows Claude Code usage first.

## Changed Files

- `memoc/00-agent-index.md`
- `.memoc/00-project-brief.md`
- `.memoc/01-agent-workflow.md`
- `.memoc/02-current-project-state.md`
- `.memoc/03-decisions.md`
- `.memoc/04-handoff.md`
- `.memoc/05-done-checklist.md`
- `.memoc/06-project-rules.md`
- `.memoc/actors/README.md`
- `.memoc/actors/neneee0181.md`
- `.memoc/boot.md`
- `.memoc/memoc-usage.md`

## Verification

- `npm run build`
- `git diff --check -- src\main\provider-usage.cts src\renderer\SettingsView.tsx src\renderer\main.tsx`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
