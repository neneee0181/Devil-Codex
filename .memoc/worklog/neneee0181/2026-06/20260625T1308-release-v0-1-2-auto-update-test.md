---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-25T13:08:47
updated: 2026-06-25T13:08:47
status: active
tags:
  - memoc
  - memoc/worklog
---
# release v0.1.2 auto-update test

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-25T13:08:47

## Summary

- Bumped release target to `0.1.2` after `v0.1.1` uploaded Windows assets but failed the workflow due to macOS release publish race.
- Changed release workflow so macOS builds artifact-only and Windows remains the GitHub Release/update-feed publisher for Windows auto-update testing.
- Updated milestone/session memory with the `v0.1.1` partial-success and `v0.1.2` fixed-release status.

## Changed Files

- `github/workflows/release.yml`
- `.memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`
- `.memoc/wiki/knowledge/lint.md`
- `.memoc/wiki/knowledge/topics/milestone-status.md`
- `package-lock.json`
- `package.json`

## Verification

- `npm run build` passed.
- `.memoc/bin/memoc lint-wiki` passed with 0 issues / 4 warnings.
- `git diff --check` passed.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
