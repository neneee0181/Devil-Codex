---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-10T03:15:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-13. Replace; keep <800B.

## Status
- v0.2.15 routes Default-mode blocking questions to Devil Ask MCP and reserves native questioning for Codex Plan mode.
- README, `README.en.md`, and `README.zh-CN.md` share the supplied main-chat hero and five feature screenshots; each has language navigation.

## Verification
- `git diff --check` passes; local links/assets, fenced blocks, and all six 2880 × 1800 PNG assets were verified across the three READMEs.

## Resume
- Localized README update is uncommitted; inspect GitHub rendering, then commit if requested.
- Relay follow-up `codex/unreal-mcp-relay-stream-safety`: upstream abort/error handling and a Node interruption test added; `npm run test:main` and `npm run build` pass.
- Bridge picker UX (2026-07-16): v0.2.19 replaces the flat Stock Bridge model add-list with a Composer-style Provider → account → model chooser, provider/model search, immediate Bridge add/remove toggles, and retained display-order controls. Full build passes; test, commit/tag/push pending.
