---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-22T05:05:27
updated: 2026-06-22T05:05:27
status: active
tags:
  - memoc
  - memoc/worklog
---
# Import Codex projects, threads, and conversation history

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-22T05:05:27

## Summary

- Discovered the real app-server protocol via `codex app-server generate-ts` (methods incl `thread/read{includeTurns}`, `thread/list{cwd?}` returning `Thread{cwd,turns[].items[]}`).
- Conversation history: bridge `readThread` calls `thread/read` includeTurns, flattens turns→items (userMessage/agentMessage/plan → kind+text); `resumeThread` now populates the timeline with full past dialog instead of a placeholder.
- Codex projects: bridge `listProjects` calls `thread/list` with NO cwd filter → all threads; renderer groups by cwd into sidebar project groups (active = rich ThreadList, others = collapsible groups; clicking a thread resumes + switches workspace + loads its history).

## Changed Files

- `ocs/CODEX_PARITY.md`
- `src/main/app-server.cts`
- `src/main/contracts.cts`
- `src/main/main.cts`
- `src/main/preload.cts`
- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- `src/shared/contracts.ts`

## Verification

- CDP (port 9222): resumed "프로젝트 파악하기" → 458 timeline items with real 나/Codex text. Expanded SPOTLIT project → opened "설치 여부와 시점 확인" → history loaded + title/workspace switched.
- `npm run build` passes. Sidebar shows devil-codex (active) + SPOTLIT/memoc/obsidian_p/codex-discord-bot/... groups.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
