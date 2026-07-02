---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-02T02:43:19
updated: 2026-07-02T02:43:19
status: active
tags:
  - memoc
  - memoc/worklog
---
# polish-runtime-icons-and-claude-fable-usage

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-02T02:43:19

## Summary

- Claude Code usage now adds a 0% Fable weekly row when Anthropic omits it.
- Runtime switch and account menu now use provided rounded Codex/Claude image icons and shorter labels.
- Claude mode account label now shows Claude instead of Codex.

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
- `git diff --check -- src\main\provider-usage.cts src\renderer\main.tsx src\renderer\styles.css`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
