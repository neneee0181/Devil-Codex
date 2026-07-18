---
memoc: true
type: state
scope: project-memory
created: 2026-06-21T11:02:34
updated: 2026-07-18T19:35:00+09:00
status: active
tags:
  - memoc
  - memoc/state
---
# Decisions

Durable project decisions live here. Keep entries short, dated, and useful to future agents.

## Decision Log

### 2026-07-18 — Settings save includes runtime transition and rollback

- A settings change is successful only after both durable persistence and its MCP/Bridge/remote runtime effects succeed. Serialize transitions; on failure restore the prior persisted snapshot and reverse the runtime transition before reporting an exact error.
- Keyless local providers are not considered connected solely from cached model IDs. The internal UI requires a successful model refresh in the current renderer session; Bridge/proxy exposure requires a previously successful account model discovery and a non-empty list.

### 2026-07-06 — Remote control: Tailscale 기반, tailnet 기본 + Funnel opt-in, 모바일 핵심 UI만

- 폰/타 기기 브라우저에서 Devil 원격 조작 기능을 만들기로 결정 (아직 미구현, 명세만 확정).
- 접속 방식: 기본은 Tailscale tailnet 전용(폰에도 무료 Tailscale 앱), 설정에서 Tailscale Funnel 공개 URL opt-in. Funnel 시 토큰 인증 + 기기 승인 + rate limit 필수.
- 모바일 UI 범위: 스레드 목록·대화·턴 전송·승인 응답·사용량만. 터미널/브라우저뷰/git 패널은 데스크톱 전용.
- 네이티브 모바일 앱 없음(PWA). 구현 명세: [wiki/project/remote-control.md](wiki/project/remote-control.md).

### 2026-06-24 — Use thread-level provider reconcile for stock-Codex external sync

- User approved a narrow rcodex-style compatibility layer: after an external-provider turn is processed by the Codex app-server through `modelProvider: "devil"`, Devil may reconcile that existing thread's stored provider back to `openai` by patching `~/.codex/state_5.sqlite` `threads.model_provider` and the rollout first-line `session_meta.payload.model_provider`.
- Scope is intentionally narrow. It may only change provider metadata for app-server-created threads; it must not create fake threads, inject fake turn content, read credentials, modify `/Applications/Codex.app`, or touch user files such as `test.txt`.
- Rationale: app-server protocol and probes showed `thread/list` filters by `modelProviders`; `modelProviders:["openai"]` hides `devil` threads, `modelProviders:["devil"]` shows them, and `modelProviders:[]` shows both. `turn/start` has no `modelProvider`, while `thread/resume` does. `thread/inject_items` did not create UI-visible turns.
- Required safety layer: journal-first pending reconcile, schema guard, backup-before-write, retry/backoff for SQLite locks, startup recovery, and Devil-local provider/model provenance metadata. Reconcile failure must never hide or delete the Devil-local conversation.
- Product behavior: Codex provider turns stay vanilla and never traverse the Devil proxy. External provider turns use Devil proxy, then reconcile to `openai` so stock Codex can show the same thread; stock Codex will not know which external model produced a turn and will continue with Codex/OpenAI if the user replies there.

### 2026-06-24 — Enforce provider tool limits at proxy boundary

- Copilot returned `400 invalid_request_body` for the app-server's 191 tools; its documented response set the concrete maximum at 128.
- `tool-sanitize.cts` is now the shared boundary for Copilot and Anthropic: it removes unsupported schema metadata, normalizes tool names, and limits requests to 128 while preserving core-tool matches first.
- This applies only after an external thread is explicitly routed to `modelProvider: "devil"`; default Codex models still omit that field and never traverse the proxy.

### 2026-06-24 — Remove direct stock-Codex store injection

- `codex-mirror.cts` and all calls to it were removed. Devil no longer writes rollout/session/SQLite state for synchronization.
- Stock Codex was fully restarted after a Copilot proxy thread, but UI inspection is blocked by local automation safety policy; visibility is unverified. Do not infer success or revive private-store mutation.

### 2026-06-23 — External models via app-server proxy provider (the sync solution)

- Goal: external models (Claude Code / Copilot / API) must (1) run through the Codex app-server so they get the full Codex agent harness (tools, file edits, approvals) and (2) sync to the real Codex app, while (3) Codex-login models stay byte-for-byte identical to vanilla Codex (no proxy), and (4) the real Codex install stays vanilla.
- Why the previous approaches failed: direct provider calls bypass the app-server, so no tools and no sync. Writing rollout files + `state_5.sqlite` rows directly does NOT surface in Codex — proven 5 ways this session (new-thread inject, exact filename, field-matched row, live title-change, perfect clone cold-start all ignored; appended turns to an indexed thread's rollout are also ignored). The app-server registers ONLY turns it processes itself; its thread list/content come from an opaque internal index, not from re-reading our files.
- Therefore the only viable path (same one `rcodex` and `opencodex` use, and what `openai/codex` Config supports): a local OpenAI-Responses-compatible proxy registered as a Codex `model_provider`. Codex speaks only the OpenAI wire format to providers, so a translation layer is unavoidable; forking the Rust app-server would require the same translation in Rust plus toolchain/fork-maintenance/per-platform builds for zero benefit, so it is rejected.
- Key enabler confirmed in the installed Codex schema: `ThreadStartParams` has `model` AND `modelProvider` (and `ThreadSettings` too). So provider is selected PER THREAD — no need to change the root `model_provider` default. Codex-login threads omit `modelProvider` (stay vanilla, no proxy); external threads pass `modelProvider: "devil"`.
- Plan (port `opencodex` adapter logic into devil; do NOT depend on opencodex):
  1. `codex-config.cts`: inject `[model_providers.devil]` (name, `base_url = http://localhost:<port>/v1`, `wire_api = "responses"`, `requires_openai_auth`-style as needed) into `~/.codex/config.toml` as a NON-default provider (never set root `model_provider`). Back up config first; strip/rewrite our block idempotently; preserve all other keys.
  2. Internal proxy in the Electron main process: HTTP listener serving `GET /v1/models` and `POST /v1/responses` (Codex uses `wire_api=responses`), translating Codex Responses ⇄ Anthropic Messages / Copilot chat. Reuse the existing `provider-oauth.cts` tokens (Claude OAuth key, Copilot token). Reference: opencodex `src/adapters/anthropic.ts`, `src/server.ts`, rcodex `src/gateway/`.
  3. Routing: codex-login model turns → `thread/start`/`turn/start` with NO `modelProvider` (default, no proxy, identical to vanilla — same tokens/cost). Claude/Copilot turns → `modelProvider: "devil"`, `model: <claude/copilot id>` → app-server calls the local proxy → native processing → tools + real-Codex sync.
  4. Remove the dead `codex-mirror.cts` injection path once the proxy path works.
- Constraint: only one provider per turn (no mixing). Proxy never sees codex-default traffic.

### 2026-06-23 — External-provider chats are devil-codex-local (no real-Codex sync)

- Codex provider chats persist through the Codex app-server into `~/.codex` and sync bidirectionally with the real Codex app. Claude Code / Copilot / API-key chats do not.
- Attempted to make the real Codex app list external chats by writing Codex rollout files and inserting rows into `~/.codex/state_5.sqlite` (`threads`). Result: `thread/read` parses our rollout files fine, but `thread/list` ignores injected rows/files (count stayed fixed) — the app-server uses its own opaque index whose registration path we can't replicate.
- Decision: do not inject into Codex's private store. It doesn't work reliably, is brittle across Codex versions (`state_5` → future), and risks corrupting a live DB. External-provider chats stay in devil-codex's own store and render only inside devil-codex.
- Reverted that attempt; kept the devil-local transcript store (commit `d459a9d`). Revisit only if Codex exposes a supported import API.

### 2026-06-24 — Stock-Codex session-promotion experiment is not a decision reversal

- Commit `000aff4` temporarily reintroduces a compatibility experiment: it rewrites legacy Devil session metadata and `threads` rows to Codex Desktop/OpenAI shape, with backups under `~/.codex/devil-codex-backups`.
- The transformed fields and 13 promoted rows were verified, but stock Codex sidebar visibility has **not** been verified. This does not supersede the 2026-06-23 finding that direct private-store writes are not a stable import API.
- If a full stock-Codex quit/relaunch still hides Devil threads, remove/revert the promotion layer rather than escalating direct SQLite/rollout mutation. The supported long-term candidate remains an app-server `modelProvider: "devil"` Responses proxy.

### 2026-06-23 — Login vs API-key providers, in-app OAuth

- Split providers into login-based (Codex, Claude Code, GitHub Copilot) and API-key (OpenAI, Anthropic, Google, DeepSeek). Anthropic-by-API-key is its own provider, separate from Claude Code login.
- Login providers use self-contained in-app OAuth (rcodex `neneee0181/rcodex` as reference) instead of delegating to external CLIs, so they work without `gh`/`claude` installed and devil-codex owns the tokens. Codex is the exception: it keeps reusing the installed Codex's app-server session (free thread/history sync), so it is NOT converted to in-app OAuth.

### 2026-06-21 — Product philosophy

- `devil-codex` should reproduce the Codex desktop app's GUI, features, workflows, and performance characteristics as faithfully as practical while allowing users to choose among multiple models.

### 2026-06-21 — Independent desktop application

- Build an independent macOS and Windows desktop app rather than modifying the user's stock Codex installation.
- Recreate the GUI and workflows from observation as faithfully as practical; do not assume the proprietary official desktop frontend is available in `openai/codex`.

### 2026-06-21 — Reuse Codex core and track upstream

- Reuse the Apache-2.0 `openai/codex` core/app-server where practical.
- Keep custom changes narrow and periodically review and apply upstream Codex updates.

### 2026-06-21 — Provider architecture

- The desired final architecture does not require users to run or restore a separate proxy service.
- Implement model authentication and protocol adapters as native `devil-codex` components where feasible.
- Start with API-key providers; add Claude/Copilot subscription OAuth after the core workflow is stable.

### 2026-06-21 — Feature sequencing

- Preserve Codex concepts including Skills, MCP, tools, approvals, subagents, and project instructions.
- Browser workflows may ship before full cross-platform desktop Computer Use.

### 2026-06-21 — Parity is the implementation baseline

- Treat Codex, not an independently redesigned interpretation, as the reference product.
- Default to matching current Codex UI, behavior, capability coverage, and perceived performance whenever technically and legally practical.
- Departures need an explicit reason: multi-provider support, unavailable proprietary implementation/assets, or platform/provider constraints. Compatible reimplementations should preserve the observable Codex behavior.

### 2026-06-21 — Git completion policy

- Commit each completed, verified unit of work.
- Push only when the user explicitly asks to push.

### 2026-06-21 — Parity verification and handoff format

- Track Codex screen, navigation, settings, shortcuts, and feature parity in `docs/CODEX_PARITY.md`.
- Every completed work unit must include beginner-friendly run, use, feature, and test instructions.

### 2026-07-13 Unreal MCP lifecycle

- Keep a stable Devil relay at `127.0.0.1:3001` in front of Unreal native MCP at `127.0.0.1:3000`; support only loopback environment overrides for projects using different ports.
- Never replay `tools/call` after reconnect; return retry-required 503. Replay only idempotent tool discovery once.
