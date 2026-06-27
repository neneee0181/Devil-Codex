# devil-codex 구현 계획

세부 UI·UX·기능 격차는 [`docs/CODEX_PARITY.md`](docs/CODEX_PARITY.md)를 기준으로 추적한다.

## 목표

`devil-codex`는 macOS와 Windows에서 동작하는 고충실도 Codex 데스크톱 재현 앱이다.

- Codex GUI, 기능, 작업 흐름, 체감 성능을 기준 제품과 최대한 같게 만든다.
- OpenAI 외 모델 공급자를 선택할 수 있게 확장한다.
- 차이는 멀티 모델 지원, 공개되지 않은 구현·자산, 플랫폼·공급자 제약에서만 허용한다.

## 기준 제품 범위

첫 번째 패리티 범위는 공식 Codex 앱 문서의 다음 흐름이다.

1. 프로젝트 전환, 스레드 생성·검색·재개·보관
2. Local / Worktree / Cloud 모드 선택
3. 스트리밍 대화와 thread / turn / item 진행 상태
4. 승인, 샌드박스, 명령 실행, 통합 터미널
5. Git diff, 인라인 코멘트, stage / commit / push / PR
6. Skills, MCP, Plugins, `AGENTS.md`, Slash commands
7. Browser, Computer Use, Automations, Subagents
8. macOS / Windows 네이티브 권한과 파일 시스템 동작

## 권장 구조

### 1. Desktop shell — Electron

- React + TypeScript renderer로 Codex와 같은 레이아웃·상호작용을 구현한다.
- Electron main process가 창, 파일 선택, OS 권한, 키체인, 프로세스 생명주기를 담당한다.
- 선택 이유: 데스크톱 UI를 웹 기반으로 높은 충실도로 재현하고, Node 기반 Codex 프로세스와 로컬 도구를 안정적으로 연결하기 쉽다.

### 2. Codex compatibility core — `codex app-server`

- 앱은 open-source Codex app-server를 child process로 실행하고 JSONL JSON-RPC 2.0으로 연결한다.
- Codex의 thread / turn / item 이벤트를 앱 상태 모델의 기준으로 삼는다.
- UI는 app-server 프로토콜을 직접 알지 않고, 별도 bridge API만 사용한다.

### 3. Provider adapter boundary

- OpenAI Codex 경로는 upstream app-server를 우선 사용한다.
- Claude, DeepSeek, Copilot 등은 동일한 UI 이벤트 계약으로 변환하는 native adapter를 둔다.
- 공통 기능을 억지로 최소 공통분모로 축소하지 않는다. 공급자 전용 기능은 Codex UI 흐름을 깨지 않는 범위에서 드러낸다.

### 4. Native services

- 비밀 정보: OS keychain / credential store. 저장소, 설정 파일, 로그에 평문 저장 금지.
- Git / worktree / terminal: Electron main process의 명시적 service 경계 뒤에 둔다.
- Browser / Computer Use: 플랫폼별 구현을 interface 뒤에 분리한다.

## 구현 순서

### M0 — 기준 수집과 계약 고정

- 현재 Codex 앱의 화면, 단축키, 상태 전이, 오류 상태를 캡처한다.
- app-server 버전을 고정하고 생성 TypeScript / JSON Schema를 저장한다.
- UI 이벤트 contract test와 visual snapshot 기준을 만든다.

### M1 — 로컬 단일 스레드

- 프로젝트 선택, 새 스레드, composer, 스트리밍 메시지, tool/item timeline.
- Local mode, 승인 UI, terminal drawer, diff drawer.
- OpenAI Codex app-server 한 경로만 연결한다.

### M2 — Codex 프로젝트 워크플로

- thread 목록/검색/보관, worktree, Git review, stage/commit/push/PR.
- Skills, MCP, `AGENTS.md`, Slash commands, 설정 화면.

**구현 완료 (2026-06-22)**

- 실제 `thread/search`, archive/unarchive, rename/fork와 로컬 pin
- Git branch 생성·전환, file/hunk stage·unstage·revert, commit/push, Draft PR, inline review
- 영구 Git worktree 목록·생성·전환
- 실제 `skills/list` 기반 composer invocation, MCP server/tool 목록·직접 실행
- `/feedback`, `/goal`, `/init`, `/mcp`, `/plan`, `/review`, `/status`
- 남은 Browser·Computer Use·Automations·Cloud는 M4, 멀티 provider는 M3 범위

### M3 — 멀티 모델

- provider registry, OS credential flow, 모델 선택 UI.
- API-key OpenAI / Anthropic / DeepSeek부터 검증한다.
- 각 provider가 Codex UI contract를 충족하는지 event replay test로 검증한다.

### M4 — 고급 패리티

- Browser, Computer Use, Automations, Subagents, Cloud / remote connections.
- macOS 및 Windows 권한, 샌드박스, 패키징, 자동 업데이트.

## 검증 기준

- UI: 기준 Codex 시나리오별 visual snapshot 비교.
- 동작: app-server protocol fixture / replay test.
- 성능: composer 입력, 스레드 전환, 첫 스트리밍 토큰, 대형 item timeline 성능 측정.
- 플랫폼: macOS와 Windows 각각에서 파일 접근, terminal, Git, 권한, 키체인 흐름 검증.
- 보안: API 키·OAuth 토큰·개인 대화가 로그, 스냅샷, Git에 남지 않는지 검사.

## M1에서 채택한 기본값

- macOS 우선 구현, Windows 호환 구조와 패키징 target 동시 유지
- OpenAI API key 우선. 구독 OAuth는 M3 이후
- Codex 레이아웃·동작은 재현하되, 공개되지 않은 자산은 독자 구현

## 현재 차단 조건

- upstream `openai/codex` 원격 조회는 현재 환경 DNS 문제로 확인하지 못했다. 설치 또는 네트워크가 가능한 환경에서 특정 upstream revision을 고정해야 한다.
- upstream revision 고정 전까지 app-server protocol은 설치된 `codex-cli 0.142.0-alpha.6` schema를 기준으로 한다.

## M1 완료 범위

- Electron + React/TypeScript shell 생성
- sandboxed preload IPC와 `codex app-server` JSONL JSON-RPC bridge 생성
- Codex runtime 연결, thread 생성, turn 전송, agent message streaming 표시
- workspace별 thread 목록 조회와 기존 thread 재개
- workspace Git status를 Diff panel에 표시
- 실제 OpenAI `gpt-5.4` turn으로 end-to-end smoke test

## 다음 행동

M3 provider adapter contract와 OS keychain credential flow를 설계한다. 그 전에 M2의 Git hunk/worktree/MCP/PR를 Electron에서 한 차례 수동 회귀 검증한다.
