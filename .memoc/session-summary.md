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
Last: 2026-07-16. Replace; keep <800B.

## Status
- v0.3.2 project sidebar fix: after opening another project's thread, only `threads` whose actual cwd matches the new workspace merge into that project. Prevents Devil-Codex rows appearing under memoc. The Windows Bridge launcher fix remains included.

## Verification
- `npm run build` and `git diff --check` pass; run `npm run test:main` before release.

## Resume
- Manual installed-app test: Bridge ON hides MCP and locks chat; OFF restores both; verify stock picker after restart.
