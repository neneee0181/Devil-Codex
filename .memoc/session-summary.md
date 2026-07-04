---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-04T16:40:13+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T16:40:13+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.1.35 prep: fixed refresh-then-stop Codex interrupt by recovering running turnId from timeline/cache and blocking missing-turnId app-server calls; fixed steering/native duplicate user rows by removing attachment count from history-cache user merge key after footer stripping.

## Verify
- `PATH="/opt/homebrew/bin:$PATH" ./node_modules/.bin/tsc -p tsconfig.json --noEmit`, `PATH="/opt/homebrew/bin:$PATH" ./node_modules/.bin/vite build`, `git diff --check` pass.
