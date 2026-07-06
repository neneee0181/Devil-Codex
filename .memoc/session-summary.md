---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-06T13:15:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-06T13:15:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.1.45 prep: markdown file-link normalization fixed for session file links.

## Changed
- `MarkdownContent` normalizes `devil-file:` paths, strips `:line[:col]`, repairs old `. [memoc]`-style links, and keeps `.memoc/...` inside the link.
- `WorkspaceFilesPanel` normalizes target/open paths before find/read.
- Version bumped to `0.1.45`.

## Open Tasks
- Implement remote control per wiki spec (await user "go").
- Feature-gap backlog: plan mode (both), manual /compact (claude), native codex /review.
- Manual in-app check: multi-turn Claude chat, stop button, model switch mid-thread.
- User-side check: session `019f3598-6e76-77c2-b333-06a970373838` remote-control.md link opens.

## Resume
- Passed: `npm run build:main`, `npm run build:renderer`, `git diff --check`.
