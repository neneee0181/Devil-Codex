---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-04T09:42:23
updated: 2026-07-04T09:42:23
status: active
tags:
  - memoc
  - memoc/worklog
---
# investigate codex-mode token drain and cap mirrored rollout outputs

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-04T09:42:23

## Summary

- Investigated Codex-mode token drain using rollout `token_count` and payload sizes; confirmed prompt caching is active, but large command outputs inflated per-turn context to ~180k-224k tokens.
- Capped Devil mirrored rollout command stdout/diff payloads and added auto-compaction preflight for Codex proxy-backed external model turns.
- Fixed Claude Code AskUserQuestion handling: native Claude SDK `onUserDialog` now returns dialog output shape, while canUseTool keeps permission result shape; Ask directive is not injected into Claude Code external direct-provider turns that cannot call tools.
- Root cause is not "no cache"; cached input still counts against usage windows, and huge cached context is repeatedly charged.

## Changed Files

- `src/main/main.cts`
- `.memoc/worklog/neneee0181/2026-07/20260704T0942-investigate-codex-mode-token-drain-and-cap-mirrored-rollout-outputs.md`

## Verification

- `npx tsc -p tsconfig.json --noEmit`
- `npx tsc -p tsconfig.electron.json`
- `npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
