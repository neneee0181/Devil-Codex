---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T16:18:00
updated: 2026-06-27T16:18:00
status: active
tags:
  - memoc
  - memoc/worklog
---
# Read-only plugins and skills tabs

## Summary
- Reworked `IntegrationsView` into top-level `플러그인` and `스킬` tabs.
- Plugin tab now lists connected stock-Codex MCP/plugin servers as read-only status, with no add/manage/run actions.
- Skill tab lists enabled Codex skills from `skills/list`, with search and refresh.
- Passed `npm run build` and `git diff --check`.
