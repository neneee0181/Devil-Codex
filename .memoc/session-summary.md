---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-04T16:11:25+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T16:11:25+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.1.33 prep: fixed Provider usage UI clipping and changed quota labels to `% 사용`; thread copy submenu flips left when near screen edge; runtime/sidebar thread+project refresh now shows lightweight loading rows.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check` pass.
