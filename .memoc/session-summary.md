---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-05T21:30:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-05T21:30:00+09:00
Replace, do not append. Keep <800B.

## Status
- Claude-mode "token heavy vs stock CLI" diagnosed: API usage at parity; display counted cache reads at full weight.

## Changed
- Cache read/creation split through claude-runtime → contracts → pricing → usage UI ("실사용 토큰" headline). Commit `6690e01`.

## Open Tasks
- Optional trims: per-turn Ask-user/English directive dedup; SessionStart hook refire on per-turn resume.
- v0.1.40 manual checks from previous session still pending.

## Resume
- Passed: tsc noEmit (both), build.
