---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-24T07:55:05
updated: 2026-06-24T07:55:05
status: active
tags:
  - memoc
  - memoc/worklog
---
# diagnose Gemini empty external turn

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-24T07:55:05

## Summary

- Diagnosed Copilot-hosted Gemini `gemini-3.1-pro-preview` empty turn: rollout had user message and token counts, but no assistant item.
- Confirmed Devil provider metadata marked the turn as `failed`, not `synced`.
- Patched the proxy bridge to fail empty upstream completions explicitly, and made failed activity cards visible in the renderer.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/session-summary.md`
- `.memoc/worklog/neneee0181/2026-06/20260624T0755-diagnose-gemini-empty-external-turn.md`
- `src/main/proxy/bridge.cts`
- `src/renderer/components/TurnActivity.tsx`
- `src/renderer/styles.css`

## Verification

- `npm run build` passed.
- Read rollout and Devil provider transcript for thread `019ef88c-fe4f-72f0-b90f-491719c5d6c6`.

## Follow-up

- Retest Copilot Gemini in Devil. If it still fails, the UI should now show a failed activity instead of silently ending.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
