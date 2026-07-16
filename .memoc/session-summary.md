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
- v0.3.3 activity detail: work cards now show each code search/file read, expandable original command, cwd and output, redacted MCP input/result, and per-file collapsible diffs. v0.3.2 project sidebar isolation and Windows Bridge launcher fix remain included.

## Verification
- `npm run build`, `npm run test:main`, and `git diff --check` pass.

## Resume
- Manual installed-app test: Bridge ON hides MCP and locks chat; OFF restores both; verify stock picker after restart.
