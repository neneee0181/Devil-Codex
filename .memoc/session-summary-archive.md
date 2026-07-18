# Session Summary Archive

Older oversized startup summaries moved by `memoc trim-summary`.

## [2026-06-21T11:06:11] archived summary (894B)

---
memoc: true
type: state
scope: project-memory
created: 2026-06-21T11:02:34
updated: 2026-06-21T20:04:22
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-21T20:04:22
Replace this file instead of appending to it. Keep total size <800B and each section ≤3 bullets.
Completed history belongs in actor worklogs; incomplete/risky resume detail belongs in `04-handoff.md`.
Agent-owned — updated by you, not by `memoc update`.

## Status
- Memoc-only project scaffold; no product code yet.
- Goal: Codex-familiar macOS/Windows app with multiple model providers.

## Changed
- Recorded philosophy, architecture constraints, provider sequence, and upstream strategy.

## Open Tasks
- Wait for user tooling installation, inspect it, then propose architecture and milestones.

## Resume
- Run `memoc summary`; inspect user-installed files before editing anything.

## [2026-06-21T11:23:18] archived summary (923B)

---
memoc: true
type: state
scope: project-memory
created: 2026-06-21T11:23:11
updated: 2026-06-21T11:23:11
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-21T20:06:11
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- Memory scaffold only; no product code yet.
- Goal: highest-practical-fidelity Codex macOS/Windows reproduction with selectable model providers.

## Changed
- Recorded product parity requirement: match Codex GUI, features, workflows, and performance as closely as practical; multi-provider support is the extension.

## Open Tasks
- Wait for user tooling installation; inspect before editing.
- Plan GUI parity, native providers, and upstream Codex sync.

## Resume
- Run `memoc summary`; read `00`, `03`, `04`, and `06` as needed. Use current Codex as the implementation reference; departures require a concrete constraint.

## [2026-06-21T16:09:56] archived summary (958B)

---
memoc: true
type: state
scope: project-memory
created: 2026-06-21T11:32:41
updated: 2026-06-21T11:32:41
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-22T01:05:00. Replace-only, <800B; history in worklog.

## Status
- Electron/React shell + Codex app-server bridge. Goal: Codex-parity, multi-provider. UI parity pass done.

## Changed (UI, renderer + main.cts)
- Neutral palette #181818/#262626. titleBarStyle:hidden + trafficLightPosition{19,19}; 52px aligned top strip; collapsed-nav in topbar.
- Flex stage-row(content-col+utility-panel)+terminal; panels always-rendered, flex-basis transition(.24s)=push; `resizing` state kills transition mid-drag. ThreadMenu rebuilt. Responsive 1120/900/720. NO @property (broke grid).

## Open Tasks
- Thread search/archive; real terminal/utility backends; line-diff/approval; pin upstream Codex rev.

## Resume
- Read `PLANS.md`; M1 thread/Git parity. Never read `.env.local`.

## [2026-06-22T04:38:14] archived summary (1279B)

---
memoc: true
type: state
scope: project-memory
created: 2026-06-21T16:10:05
updated: 2026-06-22T08:42:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-22T11:38:00. Replace-only; history: worklog; risks: 04-handoff.md.

## Status
- Electron/React shell + Codex app-server bridge. Goal: Codex-parity, multi-provider. UI parity pass done.

## Changed
- Right/bottom docks now preserve independent review/terminal/browser/files/side-chat tabs. Each `+` opens a compact launcher; Electron verified bottom browser tab and right browser tab.
- Terminal uses a native command input plus PTY-backed scrollback. This avoids Electron canvas/IME failures; `Ctrl+C`, `clear`, auto-scroll, Korean input, and divider resize are supported. Electron verified `echo 한글`.
- Composer `$`/`/` picker renders via a viewport portal above terminal/docks. Selected skills become inline editor tokens, Enter sends, Shift+Enter adds a line.
- Project hover/menu/new-chat context. First message lazily creates real persisted app-server thread; pending row survives list lag.

## Open Tasks
- Git split/inline/stage; browser/files/side-chat; worktree backend; approval item event mapping.

## Resume
- Read PLANS.md; M1 thread/Git parity. Never read `.env.local`.

## [2026-06-22T12:27:26] archived summary (977B)

---
memoc: true
type: state
scope: project-memory
created: 2026-06-22T04:38:14
updated: 2026-06-22T04:45:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-22T06:05:00. Replace-only, <800B. History: worklog; risks: 04-handoff.md.

## Status
- Electron/React shell + Codex app-server bridge. Goal: Codex-parity, multi-provider. M1 + UI parity + terminal + Codex data import working. Next: M2 Git workflow.

## Changed
- Codex data import: resume restores dialog (`thread/read`); all projects grouped by cwd (`thread/list`); per-project menu + 삭제하기 localStorage hide.
- Env card ↔ right panel exclusive; content reserves right inset under env card; composer width = chat column. Terminal `<pre>` passthrough. Worklog 0346/0505/0601.

## Open Tasks
- Git split/inline/stage, browser/files/side-chat backends, worktree, approval item mapping.

## Resume
- Read PLANS.md / docs/CODEX_PARITY.md; M2 Git+workflow. Never read `.env.local`.

## [2026-06-23T06:51:13] archived summary (984B)

---
memoc: true
type: state
scope: project-memory
created: 2026-06-22T12:27:26
updated: 2026-06-23T00:00:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-23. Replace-only, <800B. History: worklog; risks: 04-handoff.md.

## Status
- M1 done. M2 implemented: Codex UI, terminal, activity timeline, approvals, file browser/review, turn controls + git stage/hunk/commit/push/branches/draft-PR/inline-comments/per-turn-undo, worktree, skills+MCP, archive restore, rename/fork/pin. Build passes; git/worktree/MCP need manual regression.

## Changed
- Full M2 git workflow + worktree + skills/MCP connected (ef7009a..c096d3a). Worklog 20260622T1706. PLANS next = M3.

## Open Tasks
- Manual regression: hunk stage/revert, worktree, MCP tool call, draft PR, tracked/multi-file undo. Then M3 provider adapter + OS keychain.

## Resume
- 13 commits unpushed. Read PLANS.md / docs/CODEX_PARITY.md. Never read `.env.local`; commit only unless push requested.

## [2026-06-26T02:08:39] archived summary (1334B)

---
memoc: true
type: state
scope: project-memory
updated: 2026-06-26T00:00:00
status: active
created: 2026-06-24T00:20:37
tags:
  - memoc
  - memoc/state
---
# Session Summary

Last: 2026-06-26

## Focus

M1–M4 essentially done. Current = M4-D embedded browser (devil's own, bypassing
Codex's locked browser backend). Code complete, awaiting user test.

## Done

- M4-A packaging/auto-update (mac manual, Windows in-place verified, v0.1.4).
- M4-B subagents + 곁가지 대화. M4-C Automations = prompt launcher (enough).
- M4-D browser: own `<webview>` + address bar + screenshot/element-picker/⋮menu
  + AI control engine (click/type/scroll/read) + visible AI cursor +
  `devil_browser` MCP (127.0.0.1:49874 control server + stdio MCP script,
  registered in ~/.codex). Codex + external models. Bypasses Codex's
  unavailable iab/chrome backend.

## Next

1. **Test M4-D browser** (user): restart dev twice, ask codex model to
   browser_navigate/read/click → in-app browser drives + AI cursor visible.
2. **Windows**: check computer-use bundle (m4d-browser-plan.md §3 PowerShell) →
   inherit if present, else skip. mac computer-use = perm/unsigned limit.
3. M4-E Cloud = impossible (no server, no Codex cloud API). Skipped.

Full plan/handoff: `.memoc/wiki/knowledge/topics/m4d-browser-plan.md`,
`milestone-status.md`.

## [2026-06-27T11:24:44] archived summary (1768B)

---
memoc: true
type: state
scope: project-memory
created: 2026-06-26T02:08:39
updated: 2026-06-27T19:28:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-06-27

## Status
Mac UI mostly polished; next target Windows. Focus: provider/API expansion.

## Changed
- Ported safe opencodex/rcodex key+local provider subset into shared provider config.
- Added xAI, OpenRouter, Groq, Mistral, Cerebras, Together, Fireworks, Moonshot, HF, NVIDIA, Ollama, vLLM, LM Studio.
- Settings → 연결 now opens login/API-key controls inline inside the clicked provider card.
- Fixed Claude Code login status so opening the OAuth browser does not count as logged in before the callback stores a valid token.
- Picker/provider readiness now requires verified live model lists for API-key, local, Claude Code, and Copilot providers; stale/invalid key model caches are cleared on key changes and 401/403.
- Wiki now records OpenCodex registry providers still missing from Devil and keeps full registry adoption as a later/custom-provider decision.
- Copilot picker recovery: after GitHub token -> Copilot bearer succeeds, tolerate sparse/failed `/models` metadata but only fallback to verified `gpt-5-mini`; `gpt-5.4` is blocked on Copilot because this account/API path returns "model not supported".
- Copilot sparse `/models` metadata now allows listed models such as `gpt-5.2` when `supported_endpoints` is missing; only known blocked models are filtered.
- `npm run build` passes.

## Open Tasks
- Repo migration: update builder publish config + `auto-update.cts`.
- Windows verify provider settings/picker/local endpoints.
- Later: xAI/Kimi OAuth, Azure/custom, broader rcodex catalog.

## Resume
.memoc/wiki/knowledge/topics/opencodex-port-plan.md

## [2026-07-04T08:44:44] archived summary (993B)

---
memoc: true
type: state
scope: project-memory
created: 2026-06-27T22:05:00
updated: 2026-07-04T16:40:13+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-04T17:39:00+09:00
Replace, do not append. Keep <800B.
History: worklog. Resume risks: 04-handoff.md.

## Status
- v0.1.35 prep: side-chat/subagent tabs default to auto model selection with fallback candidates. Ask-user MCP is now setting-gated (`ask_user_mcp_enabled`, default true): settings UI exposes "AI 질문 모달 MCP"; Codex/Claude MCP registration follows it; enabled turns inject guidance to use `devil_ask.ask_user` only for real ambiguous branch/trade-off decisions.

## Verify
- `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ./node_modules/.bin/tsc -p tsconfig.json --noEmit`, `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ./node_modules/.bin/tsc -p tsconfig.electron.json`, `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ./node_modules/.bin/vite build`, `git diff --check` pass.

## [2026-07-18T16:05:36] archived summary (834B)

---
memoc: true
type: state
scope: project-memory
status: active
updated: 2026-07-19T00:59:37+09:00
created: 2026-07-18T03:42:37
tags: [memoc, memoc/state]
---
# Session Summary
Last: 2026-07-19.

## Status
- Gemini connector schemas preserve `properties.title/default/examples`; plugin version selection is deterministic across OSes.
- Remote mutation claims require confirming tool results; missing existing resources no longer justify localhost/new-site substitution.
- Antigravity tool-turn narration/raw patch text is suppressed; final text-only answers remain intact.
- Main tests 32/32, full build, and diff check pass.

## Resume
- Rebuild/reinstall and run a new Antigravity `@sites` E2E. Current Sites account still returns persisted-project 404 plus an empty list; exact Mac comparison needs its successful task ID/export.
