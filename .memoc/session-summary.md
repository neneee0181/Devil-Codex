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
Last: 2026-07-07T18:25:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.2.1 ready: composer pasted text now uses native editor insertion first so Ctrl/Cmd+Z undo behaves normally.

## Changed
- `src/renderer/components/composerEditor.ts`: `insertPlainTextAtSelection()` tries `document.execCommand("insertText")` before Range fallback.
- `package.json`, `package-lock.json`: version `0.2.1`.

## Open Tasks
- Commit/tag/push `v0.2.1`.

## Resume
- Passed: `npm run build`, `git diff --check`.
