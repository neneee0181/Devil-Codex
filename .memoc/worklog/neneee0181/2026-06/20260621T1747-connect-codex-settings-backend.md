---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-21T17:47:31
updated: 2026-06-21T17:47:31
status: active
tags:
  - memoc
  - memoc/worklog
---
# Connect Codex settings backend

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-21T17:47:31

## Summary

- Added isolated main-process `CodexSettingsStore` and renderer settings hook.
- Connected model, approval policy, and sandbox mode to `~/.codex/config.toml` while preserving unrelated content.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/06-project-rules.md`
- `.memoc/session-summary.md`
- `docs/CODEX_PARITY.md`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/SettingsView.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`
- `src/main/codex-settings.cts`
- `src/renderer/hooks/`

## Verification

- `npm run build`, `git diff --check`, and temp-file round-trip passed.
- Electron Settings → 구성 showed loaded values and `config.toml 저장됨` without mutating the real file during verification.

## Follow-up

- Split remaining Settings pages and connect personalization/instructions where app-server behavior is known.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
