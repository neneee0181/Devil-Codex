---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-02T00:16:07+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-02T00:16:07+09:00
Replace, <800B. History: worklog.

## Status
- test1/test2 OK: live `gpt-5.5`, effort medium, tier default, dark.
- Restart bug cause: rollout `turn_context` kept `never`/danger/disabled, overriding repaired DB/state.
- Fix: terminal sync writes state DB + rollout JSONL; matcher parses JSON lines. Large rollout skip + warn keeps sends safe.
- Live repaired: recent Devil threads DB/state on-request/workspace; target rollout 5 contexts bad=0.
- Release prep: bumped app to `0.1.1` for Windows retest.

## Verify
- `npm run build` and `git diff --check` pass.
