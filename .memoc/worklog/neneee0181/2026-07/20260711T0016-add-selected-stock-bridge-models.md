---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-11T00:16:00
updated: 2026-07-11T00:16:00
status: done
tags:
  - memoc
  - memoc/worklog
---
# Add selected stock bridge models

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-11T00:16:00

## Summary

- Added an ordered Bridge model picker; only its selected external models enter the stock Codex catalog.
- Native GPT models remain first, and disabling Bridge removes all external models while retaining the selection.

## Changed Files

- `ackage-lock.json`
- `package.json`
- `src/main/codex-settings.cts`
- `src/main/codex-stock-catalog.cts`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/renderer/SettingsView.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`

## Verification

- `npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
