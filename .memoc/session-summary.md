---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-02T23:12:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-02T23:12:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Current version remains `0.1.13`; no bump/commit/push after latest hotfix.
- Local hotfix: terminal keyed-session reuse now wraps `node-pty` methods explicitly so `existing.resize is not a function` cannot occur after thread switches.
- Claude Code sync hotfix: imports every `~/.claude/projects/**/*.jsonl` CLI session even when it has no user/assistant text, using hook/attachment text as title fallback and deriving missing cwd from the Claude project folder key; missing timestamps no longer become "now".
- Future Devil-created Claude sessions set `CLAUDE_CODE_ENTRYPOINT=cli` in SDK env so they are more likely to appear in stock Claude CLI pickers.

## Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run build`, and `git diff --check` pass.
