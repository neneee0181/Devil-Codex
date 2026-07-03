---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-03T10:30:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-03T20:47:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Releasing `0.1.22`: terminal shell profiles added; Codex 5h/7d generic quota percent is parsed as remaining; token_revoked/invalidated OAuth failures show re-login guidance and response.failed clears running UI state.
- Fixed Claude transcript ordering: JSONL import classifies assistant text before tool_use/tool_result as activity "작업 메모" instead of standalone final agent messages, preventing duplicated/out-of-order narration after steering or sync.
- Token-spend finding: Claude Code path calls `@anthropic-ai/claude-agent-sdk` directly; high usage is mostly resumed session context + selected prefixes + large tool/output history, not Codex proxy double-routing.
- Provider usage UI now matches Claude CLI direction: quota rows display `% 사용` from `usedPercent`; Claude parser accepts more percent/ratio field names, carries parent context into nested windows so Fable model buckets can be labeled, and no longer fabricates a 0% Fable row when missing.
- Final-answer duplication fix: timeline merge now keys agent messages by `turnId + trimmed text` instead of event ids, and dedupes existing agent duplicates before/after merge.
- Synced user messages are normalized before merge, stripping internal plugin/MCP/handoff/context prefixes so raw model prompts do not appear after the final answer.
- Composer placeholder fix: inline skill/MCP tokens count as non-empty content, so the placeholder disappears immediately when `/` inserts a token into an otherwise empty prompt.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `git diff --check` pass.
