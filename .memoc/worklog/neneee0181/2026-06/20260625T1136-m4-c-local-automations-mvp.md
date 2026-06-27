---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-25T11:36:17
updated: 2026-06-25T11:36:17
status: active
tags:
  - memoc
  - memoc/worklog
---
# M4-C local automations MVP — reverted

actor: neneee0181
actor_source: git config user.name
branch: main
status: superseded
created: 2026-06-25T11:36:17

## Summary

- Implemented a short-lived M4-C local Automations MVP: persisted schedules, IPC, scheduler, and Automations UI.
- Reverted/superseded it after user clarification: Automations must use the stock Codex/ChatGPT automation path, not Devil-only local storage or scheduler.
- Fixed packaged manual update check so renderer receives refreshed update state.

## Changed Files

- `memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`
- `.memoc/wiki/knowledge/topics/milestone-status.md`
- `src/main/automation-store.cts` (removed after supersession)
- `src/main/auto-update.cts`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`

## Verification

- Initial `npm run build` and `git diff --check` passed for the local MVP.
- After supersession, local automation source/IPC/scheduler were removed and `npm run build` passed again.

## Follow-up

- Do not revive Devil-local automation storage/execution.
- M4-C next step is to identify the stock Codex/ChatGPT automation protocol/storage using a real stock automation sample.
- Release tag/upload still requires explicit user confirmation.

## Follow-up update: stock-style prompt launcher

- Implemented the stock-Codex-like first-run Automations entrypoint after the user showed the stock UI.
- `채팅으로 만들기` and the three template chips now create a new Codex-direct project chat and send a prepared setup prompt, ignoring any currently selected external provider.
- This intentionally does **not** store schedules or execute local background jobs; it only starts the automation setup conversation.
- `npm run build` passed after the change.

## Release update

- Bumped package version to `0.1.1` for the first GitHub tag/release auto-update test.
- Intended release tag: `v0.1.1`.
- CI should build mac/win installers and publish update metadata; Windows verification is user-side after the release finishes.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
