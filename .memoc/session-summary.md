---
memoc: true
type: state
scope: project-memory
created: 2026-07-18T16:09:15
updated: 2026-07-21T18:00:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-21. Replace; keep <800B. History: worklog.

## Status
- v0.4.6: fixed Antigravity thought_signature loss when Gemini nests it under `extra_content.google.thought_signature` (opencodex parity gap). Root cause of intermittent mid-session "다시 연결 중" tool-loop failures.
- Main tests 55/55 (new regression test added), build + typecheck clean.

## Resume
- Install v0.4.6; verify long Antigravity tool-loop sessions no longer hit "missing thought_signature".

