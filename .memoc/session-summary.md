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
- Claude-mode token issue closed: accounting split (`6690e01`) + persistent per-thread Claude process (`291f7b8`).

## Changed
- Turns stream into one live SDK query per thread; hooks fire once, cache stays warm. Stop/mode-change/10min-idle dispose then resume.
- User kept per-turn directives + devil MCP tools (intentional).

## Open Tasks
- Manual in-app check: multi-turn Claude chat, stop button, model switch mid-thread.
- v0.1.40 manual checks from previous session still pending.

## Resume
- Passed: tsc noEmit (both), build, runtime smoke (2-turn reuse).
