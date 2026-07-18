---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-18T13:12:39
updated: 2026-07-18T13:12:39
status: active
tags:
  - memoc
  - memoc/worklog
---
# fix Antigravity custom tool thought signature

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-18T13:12:39

## Summary

- Diagnosed session `019f7526-c472-7522-91cc-9a9398c2e8be`: synthetic Responses id `ctc_...` was accepted as a Gemini thought signature after the first custom tool result.
- Removed item-id/signature conflation, hardened signature validation, and added an exact custom-tool replay regression test.

## Changed Files

- `.memoc/02-current-project-state.md`
- `.memoc/04-handoff.md`
- `.memoc/session-summary.md`
- `src/main/proxy/antigravity-replay.cts`
- `src/main/proxy/api-key.cts`
- `src/main/proxy/parser.cts`
- `src/main/proxy/proxy-compat.test.cts`

## Verification

- `npm run test:main` — 29/29 passed.
- `npm run build` — passed; existing bundle-size warnings only.
- `git diff --check` — passed.

## Follow-up

- Rebuild/reinstall and verify a new Antigravity Gemini thread continues after an `apply_patch` result; the old failed session cannot reconstruct its cleared signature.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
