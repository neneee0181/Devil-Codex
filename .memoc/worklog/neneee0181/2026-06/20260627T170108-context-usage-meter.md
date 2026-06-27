---
memoc: true
type: worklog
actor: neneee0181
created: 2026-06-27T17:01:08
tags:
  - devil-codex
  - renderer
  - context-usage
  - memoc
  - memoc/worklog
scope: project-memory
updated: 2026-06-27T09:11:29
status: active
---
# Context Usage Meter

## Summary
- Added a small circular context usage meter beside the composer model picker.
- Added hover tooltip with context window label, percentage full, and used/max token count.
- Thread history/timeline contracts now preserve context usage if app-server exposes it.
- Renderer estimates usage from visible thread content as a fallback because current app-server raw `thread/read` payload does not expose exact context/token fields.

## Verification
- `npm run build`
- `git diff --check`
