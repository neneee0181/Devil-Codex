---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-10T04:52:36
updated: 2026-07-10T04:52:36
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add stock Codex bridge recovery toggle

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-10T04:52:36

## Summary

- Added a default-on stock Codex Bridge toggle in Settings.
- Toggle off restores stock Codex by removing managed config/autostart and stopping stale headless bridge processes.
- Bumped release target to v0.2.11.

## Changed Files

- `memoc/session-summary.md`
- `README.md`
- `package-lock.json`
- `package.json`
- `src/main/codex-settings.cts`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/stock-proxy-autostart.cts`
- `src/renderer/SettingsView.tsx`
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
