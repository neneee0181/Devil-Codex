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
Last: 2026-07-02T17:34:00+09:00
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

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, and `git diff --check` pass under `devil-codex@0.1.7`.
