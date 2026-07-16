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
- GPT-5.6 picker recovery (2026-07-16): installed v0.2.17 still showed the static Codex fallback (5.5/5.4/5.4 Mini) despite live/catalog Sol/Terra/Luna. v0.2.18 adds the three IDs to that native fallback, while v0.2.17's cache merge/retry remains. They stay on direct Codex routing; build, test, commit/tag/push still pending.
