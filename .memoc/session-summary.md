---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-06-27T22:05:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-28T01:00:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Windows UI polish ongoing after mac UI completion; build currently passes.
- Topbar/menu, model picker, activity rows, diagnostics, open-with, empty new-chat disabling, sidebar running indicators, and thread-scoped app-server pool are implemented.

## Changed
- Latest fix: native thread rename now targets stock Codex state, not only Devil UI. App-server thread summaries read `title` before `name`, and rename falls back to updating `~/.codex/state_5.sqlite` `threads.title` by id. External-provider threads still update Devil transcript meta too.
- Thread rename does not rename the real workspace folder; stock Codex stores display names in thread metadata.
- Latest UI/event fix: app-server original events are now sent to the renderer before Devil synthetic diagnostics/file-change events, and synthetic items without an explicit `turnId` are ignored by the timeline so Provider diagnostics cannot create a stray second "동안 작업" card.
- Security/flow audit fixes: thread app-server pool is capped at 8 idle-safe instances with create-failure cleanup; embedded browser blocks non-http(s)/non-about:blank schemes; browser/computer/ask MCP control pipes require per-run secret headers; provider/proxy errors are redacted before logs/diagnostics.

## Verify
- `npm run build` passes.
- Manual: test DeepSeek two-turn chat, MCP browser/computer tools after restart, and confirm blocked direct pipe calls without secret return 403.
