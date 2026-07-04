---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T03:24:19
updated: 2026-07-04T03:24:19
status: active
tags:
  - memoc
  - memoc/worklog
---
# Codex slash menu dynamic state sync

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T03:24:19

## Summary

- Codex `/` menu now reflects live model/MCP/skill/context/thread state while keeping built-ins as local fallback because app-server exposes no slash-list API.
- Release version bumped to `0.1.29`.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `package-lock.json`
- `package.json`
- `src/main/claude-runtime.cts`
- `src/main/contracts.cts`
- `src/main/history-cache.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/components/Composer.tsx`
- `src/renderer/components/ComposerSuggestions.tsx`
- `src/renderer/main.tsx`

## Verification

- `npx tsc -p tsconfig.json --noEmit`
- `npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
