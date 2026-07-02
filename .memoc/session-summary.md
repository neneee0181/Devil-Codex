---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-02T14:43:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-02T18:17:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Release prep for `v0.1.5`: DeepSeek provider-diagnostic fix audited/corrected; root `tsconfig.json` errors fixed; duplicate provider failure text deduped; user prompt rows preserved across completion/sync; side-chat/subagent UX fixed; provider usage force refresh added for open/manual/turn-completed/request-completed.
- User approved version bump/upload. `package.json`/lock bumped to `0.1.5`; commit/tag/push in progress. Untracked `test.md`, `test.txt`, `test2.md` intentionally excluded.
- Post-`v0.1.5` local regression fix: removed resurrected side-chat launcher/list rendering; side chats and right-panel restore are now keyed by `runtime:threadId`; runtime switch closes right and bottom docks.
- Runtime switch follow-up: switching Codex/Claude stores the current runtime thread snapshot and restores it when returning, preserving running-thread live cache. Thread bottom pinning now uses max scrollTop plus frame/timeout stabilization so new threads land at the true bottom.
- Right-panel scroll follow-up: opening a right utility tab captures current thread scrollTop, temporarily suppresses auto-bottom during the panel width transition, and restores the same scroll position across delayed layout passes.
- Review file-list polish: status column now uses `max-content` and nowrap so `새 파일` renders horizontally instead of stacked vertically.
- Thread panel-state follow-up: right utility panel state now stores `tabs/active/open/expanded` per `runtime:threadId`; closed threads stay closed even if they have tabs. Runtime switching snapshots/restores each runtime's last active thread without overwriting that panel state.
- Release prep for `v0.1.6`: package version bumped to `0.1.6`; validation passes; commit/tag/push in progress. Untracked `test.md`, `test.txt`, `test2.md` intentionally excluded.
- Post-v0.1.6 local scroll polish: thread initial scroll now applies synchronously in `useLayoutEffect` before paint, then stabilizes on the next frame, so opening a thread starts at bottom instead of visibly scrolling down.
- Loading UX follow-up: uncached thread opens show a dedicated conversation loading state instead of looking empty; side-chat creation uses a small toast, and side-chat history loading now shows a skeleton panel instead of plain text.
- Release prep for `v0.1.7`: package version bumped to `0.1.7`; validation passes; commit/tag/push in progress. Untracked `test.md`, `test.txt`, `test2.md` intentionally excluded.
- Post-v0.1.7 local scroll fix: removed smooth scrolling from `.thread-view`; cached thread opens hide the view until initial scroll is applied in layout effect, while uncached opens keep a visible loading bar until history arrives.
- Steering follow-up: forced queued steering now prefixes the next turn with an explicit "continue the work, do not just answer" directive, marks the interrupted turn, skips its post-completion history sync/final-answer recovery, and keeps busy state on when the queued turn starts.
- Activity status follow-up: a failed sub-command no longer marks the whole turn card as "작업 실패" when the turn itself completed; merge now lets newer turn status replace stale failed state.
- Release prep for `v0.1.8`: package version bumped to `0.1.8`; validation passes; commit/tag/push in progress. Untracked `test.md`, `test.txt`, `test2.md` intentionally excluded.
- Bottom-dock follow-up: bottom tabs now store `tabs/active/open/height` per `runtime:threadId`, matching right-panel behavior across thread/runtime/settings navigation.
- Notification follow-up: Settings has an `알림` page; background OS notifications fire for final turn completion/failure, approval prompts, and ask-user questions when the app is hidden/unfocused.
- Release prep for `v0.1.9`: README updated, stray untracked `test.*` files removed, package version bumped to `0.1.9`; validation passes; commit/tag/push in progress.
- Post-v0.1.9 local hotfix: right-panel expanded mode no longer hides the bottom dock content while leaving its height as a black area.
- Browser profile follow-up: embedded browser defaults to `persist:devil-browser`; Settings -> 구성 has a toggle to switch between persisted and guest browser sessions.
- Release prep for `v0.1.10`: package version bumped to `0.1.10`; validation passes; commit/tag/push in progress.
- Browser loading UX follow-up: embedded browser shows a thin animated load bar over the page while Chromium reports navigation loading.
- Browser per-thread URL follow-up: browser tab URLs are saved/restored per `runtime:threadId` for both right and bottom docks.
- Release prep for `v0.1.11`: package version bumped to `0.1.11`; validation passes; commit/tag/push in progress.
- MCP slash follow-up: composer `/` suggestions now include connected MCP servers from `mcpServerStatus/list`; selecting one inserts an inline `/server` token and prefixes the turn with an instruction to use that MCP.
- Claude skills follow-up: main now scans `~/.claude/skills/*/SKILL.md`; Claude Code composer merges those dynamic skills with built-ins and prompts Claude to read selected skill files.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, and `git diff --check` pass under `devil-codex@0.1.11`.
