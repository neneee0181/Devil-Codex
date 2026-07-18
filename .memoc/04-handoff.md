---
memoc: true
type: state
scope: project-memory
created: 2026-06-21T11:02:34
updated: 2026-07-18T22:11:11+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Agent Handoff

Last synced: 2026-07-18

## What Changed

### Latest: Antigravity `custom_tool_call` thought-signature repair

- Session `019f7526-c472-7522-91cc-9a9398c2e8be` failed immediately after the first `apply_patch` result because synthetic Responses id `ctc_74c2...` was sent as Gemini's opaque thought signature. This is a v0.3.23/v0.4.0 proxy regression, not a network, context-limit, build, or auth failure.
- Source fix removes the invalid `item.id -> thoughtSignature` mapping, rejects `ctc_`/`tsc_` in both signature validators, and independently tests parser, Google-wire filtering, and replay replacement. Main tests: 29/29; full build and diff check pass.
- **Manual test pending:** rebuild/reinstall or run the updated app, start a new Antigravity Gemini thread, execute a custom tool such as `apply_patch`, let its result return to the model, and confirm the next model step continues without `Corrupted thought signature`. Do not use the old failed session for acceptance; its true signature was cleared and its stored history cannot reconstruct it.

### Latest: Claude-mode delegate_subagent parity (2026-07-05)

- Codex-mode delegate flow verified OK; Claude-mode gaps fixed (prefixed MCP tool name match, subagent tab runtime derivation, claude child transcript/session persistence, JSONL import subagent rebuild). Details in `02-current-project-state.md`.
- **Manual test pending**: Claude Code 모드 부모 채팅에서 `delegate_subagent`(예: deepseek) 실행 → 타임라인 subagent 카드 + 우측 탭 자동 오픈 + picker 잠금 + 앱 재시작 후 재열기 확인. claude-code 자식 위임 시 탭에 대화내역 표시/이어보내기 확인.

### Latest: v0.1.27 — ask_user MCP + proxy auth + UI polish (continue on Windows)

- **ask_user MCP** (Claude Code AskUserQuestion 패턴): codex·외부모델 공용. 모델이 애매할 때 객관식 질문 → 모달 → 유저 답 → 모델로 반환.
  - `scripts/devil-ask-mcp.cjs` (stdio MCP, `ask_user` 툴), `src/main/ask-control-server.cts` (`~/.codex/devil-ask.sock`/named pipe, 0600, pending 관리), `AskUserModal.tsx`.
  - **항상 등록**(devilMcpEnabled 토글 무관): `registerDevilAskMcp` 별도 관리 블록, `setupDevilAskMcp()` 시작 시 실행. 패키징(package.json extraResources mac+win).
  - 질문 품질: 툴 DESC에 베스트프랙티스 주입(쓸때/안쓸때, 1~4질문·2~4옵션, header≤12, 배타옵션, 추천 맨앞+"(추천)", multiSelect 독립선택만, '기타' 금지=UI가 자유입력 제공) + 자가점검 3문항 + 정보이득 최대 1개 + few-shot 예시 1개. 서버 검증 2~4옵션/header컷.
- **proxy 보안 하드닝** (`proxy-server.cts`): `127.0.0.1:49873`에 경로 비밀토큰 `/<secret>/v1` + `Origin`/`Sec-Fetch-Site` 헤더 거부. 토큰 영속 `~/.codex/devil-proxy-secret`(0600) → URL 안정, codex 회귀 없음. base_url은 `registerDevilProvider(port, secret)`가 씀.
- **모달/UX**: 외부클릭 닫힘 누락 보강(project-create/rename/approval backdrop), 뷰포트 클램핑(max-height), DockTabStrip 메뉴 flip, 설정 연결 인라인패널 간격, provider 연결상태 점, 프로젝트 아이콘 lucide NotebookText(열림/닫힘 구분 제거).
- 커밋: `7a5eb2ac`(기능+보안+UI), `649450ac`(v0.1.27 + 질문 가이드), `15ac74c5`(자가점검+few-shot). 태그 `v0.1.27` 푸시 → 릴리스 워크플로.
- **NEXT (Windows에서 이어서)**: 화면(UI) 다듬기만 남음. ask_user 모달 실제 동작 검증("ask_user 툴로 질문해봐" 또는 애매한 작업), 프록시 토큰 차단 확인(`curl 127.0.0.1:49873/v1/models` → 404). 그 후 마무리.

### Latest: v0.1.3 Windows polish/release prep

- Windows-installed UI issue reproduced from user screenshot: frameless Electron
  window had no visible close/minimize/maximize controls, and project rows showed
  raw Windows paths like `C:\Users\kevin\...`.
- Implemented Electron app-info/window-control IPC:
  - `window.devilCodex.appInfo()` returns packaged app version + platform.
  - `window.devilCodex.windowControl({ action })` handles close/minimize and
    maximize/restore.
- Renderer now shows mac-like traffic-light buttons only on non-darwin builds.
  macOS still uses native traffic lights.
- Settings → 구성 → 현재 버전 now displays the real Electron/package version
  instead of the stale hardcoded `0.1.0`.
- Project labels now use a cross-platform `basenamePath()` helper, so Windows
  project rows should match mac-style folder names instead of full paths.
- Version bumped to `0.1.3`; `npm run build` passes locally. Next step is
  commit/tag/push `v0.1.3` and wait for the Windows release/update assets.

### Latest: M4-C stock-style prompt launcher

- User clarified the desired M4-C behavior: Automations created from Devil must use/sync with the same **stock Codex/ChatGPT Automations** path. A Devil-only local scheduler/storage is not acceptable.
- The short-lived local Automations MVP was removed:
  - deleted `src/main/automation-store.cts`
  - removed `automations:list/create/update/delete/run` IPC/API contract and scheduler wiring
  - removed stale generated `dist-electron/automation-store.cjs*`
- Automations UI now mirrors stock Codex's current first-run screen behavior:
  - no local automation persistence or execution
  - "채팅으로 만들기" starts a new Codex-direct project chat and sends a general automation setup prompt
  - "일일 브리핑", "주간 검토", "프로젝트 모니터링" chips start new Codex-direct chats with matching setup prompts
  - current external model selection is ignored for these automation setup chats
  - `submit()` supports a scoped `forceNewThread` option so these prompts do not append to the currently open thread
- Keep the release update manual-check fix in `src/main/auto-update.cts`; it is unrelated and still useful.
- Investigation so far:
  - `~/.codex/state_5.sqlite` has `agent_jobs`/`agent_job_items`, but binary strings and schema indicate CSV/agent-job tooling (`spawn_agents_on_csv`, `report_agent_job_result`), not user-facing Automations.
  - `~/Library/Application Support/com.openai.chat/automation-repository-user-*` directories exist but are empty on this machine.
  - Codex app-server v0.142.0 rejects `tasks/list`, `tasks/get`, `tasks/result`, `tasks/cancel`, `app/automations`, `automation/list`, `automations/list`, and `codex/tasks/list` as unknown variants. Exposed app-server methods are thread/skills/hooks/marketplace/plugin/MCP-ish, not Automations.
  - Binary strings include `api/codex/tasks` and `app/automations`, which likely belong to ChatGPT/Codex backend/cloud task routes outside the local app-server protocol.
- Current safe state: no Devil-local automation execution exists. M4-C has a prompt-launcher UI only; real scheduled automation creation remains pending until the stock automation protocol/storage is found and guarded.
- Verified after prompt-launcher change: `npm run build` passes. Run `git diff --check` before committing.
- Release test status: `v0.1.1` created a GitHub Release and uploaded Windows update assets (`.exe`, `.blockmap`, `latest.yml`), but the workflow ended red because macOS electron-builder tried to publish DMG/ZIP outputs to the same release concurrently (`already_exists` on `tag_name`). `v0.1.2` bumps the app version and changes `.github/workflows/release.yml` so macOS builds artifact-only while Windows remains the release/update-feed publisher. Windows in-place update still needs user verification after CI completes.

### Latest: M4 packaging done, starting M4-B subagents

- M3 complete+verified. M4-A (packaging/distribution) effectively complete:
  Devil icon (`assets/icon.svg` → `scripts/build-icons.cjs`), electron-builder
  dmg(mac arm64)/nsis(win x64), bundled codex app-server per-platform
  (`vendor/codex`, resolved by `codexBin()` in app-server.cts), packaged cwd
  fix (home dir), Vite `base:"./"` fix (blank-window), GitHub Actions
  `.github/workflows/release.yml` (builds both OS on their own runners since
  node-pty can't cross-compile), update button (cert-free: win in-place via
  electron-updater, mac opens release page), code-signing scaffolding
  (`build/entitlements.mac.plist`, secret-gated). Releases published as
  non-draft (`releaseType:release`) so the in-app update check sees them.
- CI gotchas fixed: implicit publish needs GH_TOKEN; unset empty CSC_LINK or
  unsigned mac build fails with "not a file".
- Release flow: bump version → `git tag vX.Y.Z` → push tag → CI builds +
  publishes GitHub Release → installed apps show the update button.
- M4-B core DONE+verified in-app: subagent activity cards (live + reload) for
  Codex-model AND external-model turns. New-thread first-turn crash fixed with
  a typed ThreadNotPersistedError (readThreadRow/readSessionMeta/missing-DB
  throw it; prepareExternalTurn returns boolean; restoreModelFor benign) — all
  external providers handled identically, no error-string matching.
- NEXT (M4-B parity polish): match stock Codex's two surfaces —
  (1) environment popover "하위 에이전트" section listing spawned subagents
  (nickname, e.g. Laplace/Curie), (2) right-tab subagent chat reusing the
  side-chat panel to open each subagent's thread. Spec in
  `.memoc/wiki/knowledge/topics/m4b-subagent-plan.md` §4.

### external-provider sync direction

- New accepted sync plan: implement a narrow rcodex-style thread provider reconcile layer. Codex-model turns remain vanilla/no proxy. External turns run via app-server `modelProvider: "devil"` and Devil proxy, then the existing thread's provider metadata is reconciled back to `openai` in `state_5.sqlite` + rollout `session_meta` so stock Codex can list it.
- This is allowed only with journal-first pending tracking, schema guard, backup-before-write, retry/backoff, startup recovery, and Devil-local actual provider/model metadata. It must not create fake threads or fake turn content.
- Detailed implementation plan lives in `.memoc/wiki/knowledge/topics/external-provider-sync-plan.md`.
- First implementation is present and builds: `codex-provider-reconcile.cts` journal/guard/backup/patch/retry, `resumeThread(modelProvider)`, external-turn pending/resume/reconcile wiring, and provider/model provenance in `ProviderTranscriptStore`.
- Direct Copilot E2E on 2026-06-24 passed while stock Codex was also running: Devil `copilot/gpt-5-mini` returned `OK`; `pending-reconcile.json` ended empty; SQLite row `019ef7f6-5112-7183-9ef8-ebb6d41dfce9` had `model_provider=openai`; rollout `session_meta.model_provider=openai`; Devil provider metadata recorded `provider=copilot`, `model=gpt-5-mini`, `syncStatus=synced`.
- During testing, the first Copilot send failed with `no rollout found` because a fresh proxy-backed thread may not have a rollout before its first turn. Fix: tolerate that specific pre-turn `resumeThread` failure, then let `turn/start` create the rollout; if `sendTurn` fails, discard the pending journal item and mark the provider turn failed.
- Existing stock-Codex-origin continuation initially failed because the app-server had already loaded the thread under `openai`; patching DB/rollout alone did not refresh that cache. Fix: after `prepareExternalTurn()` patches provider to `devil`, dispose the `CodexAppServer` instance, then resume the thread with `modelProvider:"devil"` before `turn/start`. Verified with `CONTINUE_WITH_COPILOT_TEST_3. OK only.` on thread `019ef81f-1335-7562-9833-ebc075728354`: UI got `OK`, pending journal empty, SQLite/rollout restored to `openai`, provider turn marked `synced`.
- Stock Codex then failed when replying because DB `threads.model` still said `copilot:gpt-5-mini` while provider had been restored to `openai`. Fix: pending journal now stores `restoreModel`; reconcile restores both provider and model. Existing bad row was manually backed up under `~/.codex/devil-codex-backups/manual-model-restore-*` and restored to `gpt-5.5`. Verified with `MODEL_RESTORE_AFTER_COPILOT_TEST. OK only.`: UI got `OK`, pending journal empty, DB ended `openai|gpt-5.5`.
- Devil external-provider title churn fixed: `main.cts` no longer passes `title` on every proxy turn. It computes a title only when the local external transcript has no user turn yet, preferring native Codex history's first user message, then fallback input text. Existing local bad titles were normalized in `~/Library/Application Support/devil-codex/providers/transcripts.json`.
- Devil sidebar time/order fixed: external provider summaries had millisecond `updatedAt` values while renderer `relativeTime()` expects seconds, causing many entries to show `1분` and sort oddly. `ProviderTranscriptStore` now normalizes to seconds and merged lists are sorted newest-first. Existing local timestamps were normalized in the provider transcript store.
- Devil-created provider threads now recover/reopen locally across restart; `ProviderTranscriptStore` recovery is serialized and startup tolerates app-server model-discovery delay (`b3177de`, `b497e8d`).
- `20a2fc2` removed `codex-mirror.cts`; no Devil code now writes private rollout/session/SQLite state.
- Copilot's real failure body showed a strict 128-tool maximum. `f162512` adds shared schema/name normalization and an external-provider 128-tool limit for Copilot + Anthropic.
- Verified in Electron: Copilot app-server turn returned `OK` through the proxy; default Codex `gpt-5.4` returned `OK` with no proxy log; both external/Codex test threads reappeared after Devil restart.
- Claude Code adapter currently receives Anthropic `401 Invalid authentication credentials`; re-login is needed before treating Claude E2E as passing.
- Stock Codex was quit/relaunched after the Copilot thread, but its sidebar cannot be inspected through current automation safety controls. Result remains unverified; do not claim sync.

- Built Electron + React/Vite shell with a sandboxed preload bridge to `codex app-server`.
- Verified Electron → app-server → thread list/resume → real OpenAI `gpt-5.4` turn → streaming timeline → Git status panel.
- Rebuilt the shell from the supplied Codex screenshot: navigation sidebar, main thread, floating environment card, composer, search, settings, and native menu shortcuts.
- Added and verified project collapse/menu, external editor dropdown IPC, mutually exclusive popovers, account menu, utility split panel, and Git review summary.
- Fixed terminal overlay, dropdown stacking, hover-only project actions, focus styling, and terminal/utility coexistence.
- Added Motion micro-interactions, Lucide SVG icons, resizable left/right/bottom panels, Codex thread menu, and dedicated settings UI with local persistence.
- Added real Git review IPC: environment `변경 사항` opens file list, and selecting a text file renders its unified line diff with add/delete counts.
- Replaced terminal-only bottom panel with a shared bottom dock. Right and bottom docks expose the same five tools, can stay open together, and resize content interactively.
- Added real terminal keyboard input and pipe-shell fallback newline normalization; Electron UI command execution was verified by file side effect.
- Replaced hidden terminal input capture with xterm native input. Added caret-anchored `$`/`/` suggestions, approval modes/full-access warning, project hover/menu/contextual new-chat, and lazy first-message thread creation with pending-list preservation.
- Added Codex-like turn activity/history, approvals, context-compaction resume, stop control, Markdown/image rendering, file browser/code preview, and per-turn file undo that preserves conversation history.

## Next Steps

1. Toggle Settings → 구성 → 웹 검색 sidecar ON, use an external model, and ask a current-info/search prompt. Confirm the turn summary shows `웹 검색 1개` and the expanded activity contains a `웹 검색: ...` row with query/source detail. Also confirm Provider 진단 shows `sidecar.webSearch: enabled; mode tool-loop`, `toolCalls >= 1`, and `requests >= 1`.
2. With web-search sidecar still ON, ask a non-search prompt. Confirm diagnostics either show `toolCalls 0` or no sidecar request; the model should answer normally.
3. Run one Codex-direct turn with sidecar ON. Confirm diagnostics still say `route: app-server direct` and `sidecar: ignored on Codex direct route`.
4. After an external web-search turn, confirm stock Codex sees the same thread and can continue with a Codex model.
5. Remaining opencodex-parity work: vision sidecar, Provider dashboard/live request log, then broader provider registry/catalog polish.
6. Verify Gemini API-key simple/tool-enabled turns after the schema sanitizer fix. The previous failure text was `Unknown name "additionalProperties" ... function_declarations[].parameters`.
7. Verify an external model file edit prompt such as `test3.txt 생성하고, test3라고 작성해줘.` shows both the shell command row and a compact `파일 1개 수정` row inside 작업 내용.
8. Verify both Codex and external-provider turns use the same activity UI: code search rows group as `코드 검색 N개`, file/skill reads as `파일 N개 읽음`, file edits as `파일 N개 수정`, and normal shell commands open into a Shell output panel.
9. Verify attachment UI parity: paste/drop/select an image and confirm it appears above the composer, sends as an image, then appears above the user bubble; click it to open the viewer, copy it, and save it. Paste a long text block and confirm it becomes a `pasted-text-*.txt` card while the model still receives the content.
10. Verify attachment metadata survives restart/sync: send an external-provider turn with an image or long pasted text attachment, quit/restart Devil, reopen the thread, and confirm the user bubble still shows the attachment card. If stock Codex history was newer and Devil ran `thread:sync-history`, local attachment cards should still be preserved.
11. Verify Provider request log persistence: run one successful external turn and one failing external turn, restart Devil, open Settings → 연결, and confirm recent rows still show provider/model/tools/images/files/sidecar/errorType plus per-model compatibility state.
12. Priority shift: stop spending product time on Provider dashboard/model compatibility polish unless it blocks debugging. Next useful work is document attachment fidelity. Manually verify `.txt`, `.docx`, and text-based `.pdf` attachments with Codex direct and one external provider.

## Blockers

- Stock-Codex UI visibility still needs user visual confirmation because automation cannot inspect `com.openai.codex`; backend storage visibility is verified through stock Codex's DB/rollout files. The old fake-thread/private-store injection must not return. The approved path is only thread-level provider reconcile for app-server-created threads, guarded by journal, schema checks, backups, and retry/recovery.

## Do Not Touch Without Asking

- Do not overwrite or remove files installed by the user.
- Do not modify `/Applications/Codex.app`, provider credentials, login sessions, or system permissions without explicit approval.
- `~/.codex` writes are allowed only for the approved provider reconcile layer: patch existing app-server-created thread provider metadata after external turns, with backup/schema guard/journal. No fake thread/turn injection.
- Do not store API keys, OAuth tokens, or other credentials in memoc or tracked project files.
- Do not push changes unless the user explicitly asks. Commit completed, verified work before handoff.
- Never commit user-created test artifacts such as `test.txt`.

## Verified

- The project folder exists and memoc is installed locally.
- `openai/codex` publicly provides the CLI/core/app-server under Apache-2.0; the official desktop GUI source was not found in that repository during initial research.

## Not Verified

- Stock Codex sidebar visibility of the Copilot E2E thread by direct UI inspection; computer-use blocks `com.openai.codex`. Backend DB/rollout state is verified as `openai`.
- macOS packaging, Windows runtime validation, provider compatibility, OAuth policy compliance, and Computer Use implementation.
- Exact effort required for visual and behavioral parity with future Codex desktop releases.
- Tracked-file and multi-file undo safety paths compile but have not been manually verified yet.
- Upstream `openai/codex` revision and source tree: sandboxed remote lookup failed because `github.com` DNS resolution was unavailable; escalated lookup timed out.
- Document extraction first pass is implemented in `src/main/document-attachments.cts`: text-like files, `.rtf`, `.docx`, and best-effort `.pdf` are converted into hidden model context at `turn:send`. OpenCodex mostly did not need this because it relies more on native Codex attachment flow; Devil needs it because external providers must receive readable file context too. Scanned/complex PDFs and richer binary formats remain unverified/future work.

## Resume Notes

- Begin with `memoc summary`, then read `03-decisions.md` before touching the sync code. Latest proxy commits: `20a2fc2`, `f162512`.
- Preserve the central product test: Codex-login threads must stay vanilla; external model support must not corrupt or falsely promise stock-Codex synchronization.

## Suggested Reads

- `.memoc/00-project-brief.md`
- `.memoc/03-decisions.md`
- `.memoc/06-project-rules.md`
