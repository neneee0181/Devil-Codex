---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-02T14:20:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-02T14:35:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.1.2 release prep: `package.json`/lock bumped to 0.1.2 for tag-triggered GitHub release action.
- v0.1.1 release prep and stock restart continuation fixes are on origin/main.
- Claude Code runtime hardened: probe now detects the SDK's bundled platform `claude` binary (no external CLI needed), tool_result events from user messages resolve tool rows (was dead path), tool calls show in-progress via `item/started`, thinking streams as reasoning, text blocks separated, result usage attached to `turn/completed`.
- Session id is auto-generated and saved early via `onSessionId`, so a failed first turn can resume; user stop resolves quietly (no spurious 요청 실패 row).
- Claude Code mode gap pass: image attachments now reach the SDK as content blocks, maxTurns cap removed, Claude turns log into the shared provider request log with usage, and the composer context gauge works in Claude mode.
- UI flow alignment: ModelPicker hides Codex-only 추론/속도 in Claude mode; Claude slash menu adds memory/init/review/pet; context-window fallback knows sonnet/opus/haiku/fable.
- Stock-Codex contamination root-caused: (1) legacy cleanup deleted stock's own `service_tier` on every settings load; (2) non-atomic config.toml writes let concurrent readers re-serialize a truncated parse, dropping model/effort/theme/trust. Fixed: no service_tier stripping, temp+rename atomic writes, skip-unchanged; live config restored from backup.
- Claude approval bridge: SDK `canUseTool` → existing renderer approval dialog; acceptEdits/default modes; accept/decline verified live.

## Verify
- `npm run build` passes under `devil-codex@0.1.2`.
