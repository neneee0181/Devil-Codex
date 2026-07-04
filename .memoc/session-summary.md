---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-04T08:44:44
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T09:42:23
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Codex-mode token drain investigated. Rollout logs show caching works, but huge command outputs made last request context ~180k-224k tokens, so cached input still burned rate-limit budget.

## Changed
- `src/main/main.cts`: capped mirrored rollout command stdout/diffs and added auto-compaction preflight for Codex proxy-backed external provider turns.
- Ask MCP: Claude native SDK dialog returns proper AskUserQuestion output; Claude Code external direct-provider turns no longer receive unusable ask_user directive.
- Earlier same session: Ask MCP toggle/guidance and Claude SDK AskUserQuestion modal bridge.

## Open Tasks
- Runtime/manual test after version bump: verify Codex external-provider long thread compacts before sending, large command outputs are truncated in mirrored rollout, and Claude native AskUserQuestion opens Devil modal.

## Resume
- If token drain persists, inspect whether stock app-server native command output itself needs UI/tool-output truncation beyond Devil mirrored rollout truncation.
