---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-02T23:52:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-03T01:05:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Current version is `0.1.16`; local fixes are being released.
- `CAVEMAN MODE ACTIVE` remains visible to mirror stock Claude CLI; moved hook-only JSONLs were restored and no code quarantines/rewrites Claude JSONLs.
- Composer clear uses `replaceChildren()` per draft key; uncached thread opens now show loading UI instead of hidden initializing content.
- Perf hotfix: visible chat timeline events and terminal command-history output are batched with `requestAnimationFrame`. Streaming agent text now renders as lightweight pre-wrap text until the turn completes, then switches back to Markdown; per-turn change metadata is precomputed to reduce rerender work.
- Review hotfix: when right/bottom `review` tab is visible, workspace changes and selected diff auto-refresh quietly every ~0.9s while busy or ~1.8s idle.
- Terminal history hotfix: command output cleanup now preserves CR/CRLF as newlines and applies backspace/delete edits, so Windows `cmd dir` output no longer collapses lines or shows `c\b \bcls` artifacts.
- Claude CLI resume hotfix: Devil-created Claude Code JSONLs are normalized from `entrypoint:"sdk-cli"` to `entrypoint:"cli"` both when the session id appears and again at turn end, improving live CLI resume/list compatibility.
- Notification hotfix: app notifications now support `force`; ask/approval/turn-complete notifications bypass focused-window suppression, and Windows sets AppUserModelID.
- Composer placeholder hotfix: placeholder is an overlay, not layout content, so first typed line no longer starts under/after it.
- Timeline merge hotfix: user items now dedupe by visible text/attachment fingerprint before an agent answer, preventing optimistic+synced duplicate user bubbles with the work tab between them.
- Chat scrollbar hotfix: `.thread-view` now reserves scrollbar gutter and uses a visible track/thumb so chat scroll position is not hidden on dark backgrounds.
- Prior `v0.1.14` already fixed keyed terminal reuse and broad Claude project cwd import.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, and `git diff --check` pass.
