---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-05T12:00:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-05T13:45:00+09:00
Replace, do not append. Keep <800B.

## Status
- Preparing `v0.1.40`: local fixes verified, version bumped.

## Changed
- User-visible history strips Ask-user directive blocks and internal continuation summaries.
- Claude JSONL import skips "This session is being continued..." user summary rows.
- Renderer tracks the owner thread for visible `itemsRef`; navigation/sync no longer caches another thread's items under the active id.
- `mergeCachedActivities` no longer injects cached user/agent/system rows when native rollout already has conversation items.
- App-server thread title/preview compaction strips Ask-user directive text.
- Delegate subagents now create/send hidden Codex turns with `danger-full-access` and prepend a short no-`apply_patch` execution note, while still using caller-supplied provider/model dynamically.

## Open Tasks
- Manual after install: reopen `64616d2f...`/`019f2e2f...`; foreign user bubbles/internal directives should not appear. Run a delegate with a non-DeepSeek provider/model to confirm dynamic picker/path.

## Resume
- Passed: tsc noEmit, build, diff-check.
