---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T08:18:54
updated: 2026-07-04T08:18:54
status: active
tags:
  - memoc
  - memoc/worklog
---
# side-chat auto subagent model fallback

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T08:18:54

## Summary

- Added default auto model selection for side-chat/subagent tabs.
- Ranking uses provider/account availability, tool capability, diagnostics, provider reliability, and prompt text.
- Send flow retries recommended fallback candidates before the current model; manual model choices disable auto until re-enabled.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `src/renderer/components/BottomDock.tsx`
- `src/renderer/components/ToolContent.tsx`
- `src/renderer/components/UtilityPanel.tsx`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`

## Verification

- `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ./node_modules/.bin/tsc -p tsconfig.json --noEmit`
- `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ./node_modules/.bin/vite build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
