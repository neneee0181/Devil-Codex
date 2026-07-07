---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-06T14:40:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-07T15:36:00+09:00
Replace, do not append. Keep <800B.

## Status
- Cache/token usage fix completed. Follow-up steering correction: queued panel stays visible, and Codex direct Enter-icon steering now uses native `turn/steer` first; non-Codex/attachments/skills fall back to interrupt+queued send.

## Changed
- `src/renderer/main.tsx` steering queue path.

## Open Tasks
- Version bump/tag/push pending for steering hotfix.

## Resume
- Passed: `PATH=/opt/homebrew/bin:$PATH npm run build`.
