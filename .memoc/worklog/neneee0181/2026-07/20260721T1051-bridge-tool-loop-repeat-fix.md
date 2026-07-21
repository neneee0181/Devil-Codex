---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-21T10:51:36+09:00
updated: 2026-07-21T10:51:36+09:00
status: active
tags:
  - memoc
  - memoc/worklog
---
# Bridge tool-loop repeat fix

actor: neneee0181
branch: main
status: done

## Summary

- Session `019f7ada-2eb0-7841-806d-53ca857ee5fa` made 12 successful first-attempt Bridge rounds; it was not a network retry loop.
- Native lite SSE completion omitted `output`, so Devil cached no current assistant/tool-call state and the next round replanned from stale context. Streamed output items are now restored before continuation storage.
- Corrected the stale `exec_command` example when only `shell_command` exists and compacted repeated equivalent future-plan work memos to their latest copy.
- Released with the completed Antigravity progress and final file-change rollup work as v0.4.4.

## Verification

- Full build passed; proxy compatibility tests passed 36/36; renderer tests passed 6/6; `git diff --check` passed.
- Full main suite passed 45/46; only the unchanged Windows diagnostic-log chmod assertion failed (`0o666` vs expected `0o600`).

## Follow-up

- Install v0.4.4 and verify fresh stock-Bridge and Antigravity turns.
