---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T08:30:10
updated: 2026-07-04T08:30:10
status: active
tags:
  - memoc
  - memoc/worklog
---
# gate ask-user mcp and inject decision guidance

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T08:30:10

## Summary

- Added `ask_user_mcp_enabled` Codex setting, defaulting on.
- Settings UI now exposes "AI 질문 모달 MCP"; Codex and Claude MCP registration follows the toggle.
- Enabled turns inject guidance to use `devil_ask.ask_user` only for real ambiguous branch/trade-off decisions.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `src/main/codex-settings.cts`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/renderer/SettingsView.tsx`
- `src/shared/contracts.ts`

## Verification

- `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ./node_modules/.bin/tsc -p tsconfig.json --noEmit`
- `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ./node_modules/.bin/tsc -p tsconfig.electron.json`
- `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ./node_modules/.bin/vite build`; `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
