---
memoc: true
type: wiki
scope: project-memory
created: 2026-06-25T00:00:00
updated: 2026-06-25T00:00:00
status: active
confidence: high
tags:
  - memoc
  - memoc/wiki
  - memoc/knowledge-wiki
  - memoc/topic
  - milestone
  - plan
  - m4
---
# Milestone Status & M4 Plan

기준 문서: `PLANS.md`. 이 문서는 M0~M4 진행도 스냅샷 + M4 작업 계획 + opencodex 대비 격차.

## 1. 마일스톤 진행도 (2026-06-25 기준)

| | 범위 | 상태 |
|---|---|---|
| M0 기준수집/계약고정 | Codex 화면 캡처, app-server `codex-cli 0.142.0` 고정, TS/JSON schema 저장 | ✅ 완료 |
| M1 로컬 단일 스레드 | 프로젝트·새 스레드·composer·스트리밍·tool timeline, Local mode, 승인 UI, terminal/diff drawer, OpenAI 1경로 | ✅ 완료 (gpt-5.4 E2E) |
| M2 Codex 워크플로 | thread 목록/검색/보관, worktree, Git review, stage/commit/push/PR, Skills, MCP, AGENTS.md, slash | ✅ 완료 (2026-06-22) |
| M3 멀티 모델 | provider registry, OAuth, 모델 UI, 외부 어댑터, **순정 Codex 동기화** | ✅ 완료·검증 |
| M4 고급 패리티 | 패키징/배포·자동업뎃·서브에이전트·곁가지 대화·Automations·Browser·Cloud | ✅ 사실상 마무리 (A/B 완료, C=프롬프트런처로 충분, D=불가/스킵, E 선택) |

## 2. M3 완료 내역 (검증됨)

- provider 분리: login(Codex/Claude/Copilot) + API-key(OpenAI/Anthropic/Google/DeepSeek).
- in-app OAuth: Copilot device flow, Claude PKCE, safeStorage 암호화.
- 모델 선택 UI + 동적 모델 목록 + capability 뱃지.
- 외부 어댑터: Copilot/Anthropic/Gemini/OpenAI-compat, 툴 schema sanitize, Copilot 128 제한.
- 순정 Codex 동기화: `codex-provider-reconcile.cts` — 외부 turn 후 thread provider `devil→openai` reconcile (journal/guard/backup/retry). Codex 모델은 프록시 0홉 직통 유지.
- Copilot E2E 통과(순정 Codex 켠 채): DB/rollout `openai`, devil-local `copilot` 보존, pending 비움.
- 재시작 후 답변 복원, 제목/정렬, 실패 진단, 첨부/sidecar 확장까지 포함.
- 잔여 곁가지(문서첨부 PDF 품질, provider 대시보드 polish)는 M3 합격 기준 아님 → M4와 병행 정리.

## 3. M4 진행 상세 (무엇을 했고 뭐가 남았나)

### M4-A 패키징 & 배포 — ✅ 사실상 완료
구현됨:
- 앱 아이콘: `assets/icon.svg` + `scripts/build-icons.cjs`(sharp→icns/ico/png), 런타임 윈도우 + 빌드 설정 적용.
- electron-builder: `productName "Devil Codex"`, mac dmg+zip(arm64), win nsis(x64), `release/` 출력, github publish provider, `dist`/`dist:mac`/`dist:win` 스크립트.
- **codex 바이너리 동봉**: `vendor/codex/codex(.exe)` → `resources/codex`로, `app-server.cts`의 `codexBin()`(DEVIL_CODEX_BIN→번들→PATH). 동봉본도 사용자 `~/.codex` 공유.
- packaged cwd 버그(app.asar) 수정 → home. Vite `base:"./"`(blank-window) 수정.
- **자동업데이트**(`auto-update.cts`): 우상단 "업데이트 vX.Y.Z" 버튼. 감지=GitHub releases API(무료, 인증서 X). 클릭→ win: electron-updater 인플레이스, mac: 릴리스 페이지 열기(미서명 mac은 인플레이스 불가). `releaseType:release`로 비-draft 게시.
- 코드서명 스캐폴딩: `build/entitlements.mac.plist`, hardenedRuntime, 워크플로 secret 기반 서명+notarize(없으면 미서명).
- **GitHub Actions** `.github/workflows/release.yml`: mac/win 각 러너 빌드(node-pty 크로스컴파일 불가), codex OS별 다운로드. v* 태그 시 Windows job이 GitHub Release와 `latest.yml` update feed를 publish한다. macOS는 현재 unsigned/signed 여부와 무관하게 artifact-only로 둔다. 이유: `v0.1.1`에서 mac DMG/ZIP 동시 publish가 같은 GitHub Release 생성을 경합해 workflow가 실패했다.
남은(외부 자산 의존):
- `v0.1.2` 태그 릴리스로 win artifact/자동업데이트 테스트를 시작한다. `v0.1.1`은 Windows 자산은 있었지만 mac publish race 때문에 workflow가 실패했으므로 기준 태그로 쓰지 않는다. 남은 것: 실제 Windows 실행 확인(사용자), Apple Developer 인증서+mac release upload 재설계로 mac 자동업뎃(선택).

### M4-B 서브에이전트 + 곁가지 대화 — ✅ 완료
상세: [[m4b-subagent-plan]]. 요약:
- **서브에이전트(하위 에이전트)** 표시: 모델이 spawn(collab `spawnAgent`)한 자식 thread를 타임라인 카드(라이브+재로드) + 환경 "하위 에이전트" 섹션 + 우측 `subagent:<id>` 탭(Bot+닉네임). 코덱스/외부 모델 둘 다. 닉네임은 rollout `session_meta.agent_nickname`.
- **곁가지 대화(side conversation)**: 사용자가 만드는 임시 사이드 채팅. 우측 `sidechat:<id>` 탭(💬 "사이드 채팅"), 환경 "곁가지 대화" 섹션. **subagent와 완전 분리.** 우측바 "사이드 채팅"=즉시 새 대화 생성. 닫으면 삭제(`thread:delete`). **메인 thread별 분리**(sideChatsByThread). 모델 피커(provider별), 첨부(이미지/파일), 라이브 응답(폴백 폴링).
- 이벤트 격리(`subagentIdsRef`)로 서브/곁가지 turn이 메인 타임라인 침범 안 함. 사이드바에서 숨김(sideThreadSet).
- 한계: codex-메인이 자율로 외부-모델 서브에이전트 spawn은 app-server 의존(불가). 순정 Codex는 devil 곁가지를 자기 곁가지로 인식 못 함.

### M4-C Automations — 🟡 prompt-launcher MVP
정정:
- 사용자가 원하는 자동화는 **Devil-local scheduler**가 아니다.
- Devil Codex 자동화 화면에서 만들더라도 저장/실행/동기화는 순정 Codex/ChatGPT Automations와 같은 경로를 타야 한다.
- 따라서 짧게 구현했던 `AutomationStore`/로컬 scheduler/`automations:*` IPC/UI MVP는 제거했다.
- 현재는 순정 Codex 첫 화면처럼 버튼을 누르면 자동화 설정용 프롬프트가 새 채팅으로 전송되는 방식이 맞는 1차 목표다.

현재 확인:
- `src/main/automation-store.cts` 삭제, main/preload/contracts/renderer의 로컬 자동화 API 제거.
- Automations 화면은 `채팅으로 만들기`, `일일 브리핑`, `주간 검토`, `프로젝트 모니터링` 버튼을 제공한다. 각 버튼은 새 **Codex-direct** 프로젝트 채팅을 만들고, 자동화 설정을 위한 준비 프롬프트를 전송한다. 현재 composer가 외부 모델이어도 자동화 설정 채팅은 Codex provider로 보낸다.
- 이 단계는 로컬 schedule 생성이 아니라 순정 Codex와 같은 "대화로 자동화 만들기" 진입점이다.
- `npm run build` 통과.
- Codex app-server v0.142.0은 `tasks/list`, `tasks/get`, `tasks/result`, `tasks/cancel`, `app/automations`, `automation/list`, `automations/list`, `codex/tasks/list`를 모두 unknown variant로 거절한다.
- `~/.codex/state_5.sqlite`의 `agent_jobs`는 `spawn_agents_on_csv`/`report_agent_job_result` 계열로 보여, 사용자-facing Automations와 다른 기능일 가능성이 높다.
- `~/Library/Application Support/com.openai.chat/automation-repository-user-*` 디렉터리는 존재하지만 현재 비어 있다.
- 바이너리 문자열에는 `api/codex/tasks`, `app/automations`가 보인다. 현재 가설: 순정 Automations는 local app-server가 아니라 ChatGPT/Codex backend/cloud task route에 묶여 있다.

다음 필요:
1. Automations prompt-launcher를 Electron에서 수동 검증한다.
2. 순정 Codex/ChatGPT 앱에서 실제 자동화 1개를 만든 뒤 저장소/네트워크 변화 관찰.
3. API/저장소 형식이 확인되면 schema guard + backup + read-only probe → write adapter 순서로 구현.
4. 확인 전에는 Devil-local 자동화 저장/실행을 되살리지 않는다.

### M4-D Browser / Computer Use — 🟢 자체 구현 완료 (브라우저 + computer-use)
순정 브라우저/computer-use는 Codex 데스크톱 전용 인프라(cua_node/iab/SkyComputerUse)라 devil에 못 붙음 → **devil 자체 구현으로 우회.** 상세: [[m4d-browser-plan]].
- **브라우저(in-app)**: webview + AI 제어엔진 + 빨간 커서 + `devil_browser` MCP. codex+외부 둘 다. Windows 검증 완료.
- **computer-use(화면 전체 제어) — devil-native 자체 구현 ✅ (2026-06-27, v0.1.16)**:
  - 순정 경로 막힘 확인: Win Codex에 computer-use.exe 번들 **있음**(`...\@oai\sky\bin\windows\codex-computer-use.exe`), CLI 0.137→**0.142.2** 올려 `sandboxCwd must use file URI` 에러는 풀렸으나, 화면제어 **호스트 파이프(`\\.\pipe\codex-computer-use-<uuid>`)는 순정 Codex 데스크톱 GUI 앱(308MB)만 띄움**. CLI app-server(devil)는 못 띄움 → 순정 `codex exec`조차 `os error 2`. = mac(서명/TCC)과 다른 벽이지만 devil 단독 불가 동일.
  - → **devil 자체 엔진 신규 구축**: `src/main/desktop-control.cts`(nut.js `@nut-tree-fork/nut-js` 입력 + Electron desktopCapturer 캡처, **멀티모니터 sharp 합성**, 좌표 origin 정규화, **Win32 GetWindowTextW UTF-16 창 열거**=한글 제목), `desktop-control-server.cts`(named pipe `\\.\pipe\devil-codex-computer`), `scripts/devil-computer-mcp.cjs`(stdio MCP: computer_screenshot/click/move/type/key/scroll/list_windows), `[mcp_servers.devil_computer]` 등록.
  - screenshot = 이미지+텍스트 캡션 동시 반환 → vision/non-vision 동적 대응(모델 분기 없이). codex(vision)+deepseek(non-vision) 실증.
  - Windows는 서명/권한 벽 없음(일반 앱 제어 가능, UIPI로 관리자 창만 예외). mac은 추후(TCC+서명).
  - 타임라인 UI(v0.1.17): 툴 이미지 인라인 + 작업 내레이션 시간순 인라인 + 최종응답 밖 + 완료 시 자동 접힘.

### M4-E Cloud / remote — ❌ 불가 (조사 완료, 2026-06-26)
- Codex 스키마에 cloud/remote/task 메서드 **없음**(GitDiffToRemote만=git diff). Cloud=ChatGPT/OpenAI 백엔드 서버 기능. **자체 서버 없이는 불가. 스킵 확정.**

## 결정 (2026-06-26, 사용자 확정)
- **M4-A**: 완료 마감. mac = 수동 설치(미서명), Windows 자동업뎃 작동 확인됨. Apple 인증서 안 함.
- **M4-C Automations**: 프롬프트 런처로 충분. 추가 안 함.
- **M4-D 브라우저**: devil 자체 구현 완료 → **테스트만**. computer-use는 mac 한계 / Windows 번들 확인 후.
- **M4-E Cloud**: 서버 필요 → 불가, 스킵.
- → **M1~M4 사실상 종료.** 남은 실질 작업 = M4-D 브라우저 테스트 통과 + (선택) Windows computer-use 번들 확인.

## 3.5 부수 개선 (M3/M4 진행 중 처리)

- 이미지 첨부: 메인 composer 붙여넣기/드롭/첨부 + 갤러리 + 뷰어(확대/복사/저장). **순정 Codex 이미지 복원**: thread/read가 localImage temp경로(삭제됨)만 줘서 "이미지 없음" → rollout base64를 `getRolloutImageUrls`+`enrichThreadImages`로 치환. text-path phantom dedup.
- side-chat 첨부: `useAttachments` 훅 공유. 한글 IME 엔터(isComposing) 가드.
- 환경 팝오버: 우측탭 열린 채로 환경도 열림(우측탭 누르면 환경 닫힘은 유지).

## 4. opencodex 대비 격차 (참고)

상세는 [[opencodex-parity-comparison]] 참고. 요약:
- 핵심 변환(어댑터/sidecar/oauth)은 동등 수준 달성.
- devil-codex가 더 나음: 순정 Codex 직통 유지(프록시 0홉) + per-thread reconcile. opencodex는 root provider 통째 교체(전 모델 프록시).
- 격차: opencodex 40+ provider 카탈로그/azure/xai·kimi OAuth는 미구현(필요시 확장).

## 5. 남은 할 일 (다음 에이전트용)

1. **M4-A 마감(외부 자산)**: `v0.1.2` GitHub Actions 릴리스 완료 후 win nsis artifact 실제 Windows 실행/자동업데이트 확인; (선택) Apple Developer 인증서 GitHub secret 등록 + mac publish 경합 없는 업로드 단계 설계→mac 서명+자동업뎃.
2. **M4-C Automations**: 순정 Codex/ChatGPT에서 실제 automation을 하나 만든 뒤 저장/네트워크/API 변화를 확인.
3. **M4-D Browser/Computer Use**, **M4-E Cloud**.
4. Claude Code `401` 재로그인 후 외부 E2E 1회(미검증 시).
5. (선택) 문서첨부 PDF 추출 품질, provider 대시보드 polish.

## 주의/원칙 (불변)

- Codex 모델은 프록시 0홉 직통(순정 동일). `~/.codex` 직접 쓰기는 승인된 reconcile/이미지-읽기만.
- 단계마다 `npm run build` 통과 + 커밋. **푸시는 사용자 지시 시만**.
- main 프로세스(.cts) 변경은 `npm run dev` 재시작해야 반영.
- `test*.txt`, `.env.local`, 토큰/크레덴셜 커밋 금지.

## Related

- [Sync plan](external-provider-sync-plan.md)
- [PLANS.md](../../../../PLANS.md)
- [Handoff](../../../04-handoff.md)
- [Topics](README.md)

## M4-D 실사용 메모 (2026-06-25)
- codex 모델은 browser/computer-use **MCP 툴 호출 정상**(node_repl browser, computer_use MCP). M4-D = codex app-server+MCP 그대로 상속 → 자동 지원.
- 실패는 **환경**: ① macOS TCC 권한(손쉬운사용/화면기록/자동화) 미부여 → `errAETimeout`/aborted. devil-codex는 미서명이라 순정처럼 권한 다이얼로그가 안 뜸(서명=M4-A3 필요). ② Chrome 확장/in-app browser 백엔드 미연결("iab unavailable"/"extension unavailable"). 확장은 자동설치 불가(보안).
- 구현: 실패 감지 시 **권한/확장 안내 배너 + 딥링크**(`app:open-permission` IPC → x-apple.systempreferences pane / chrome web store). 미서명 한계로 권한 켜도 안 먹을 수 있음.
- 외부 모델(deepseek 등)은 browser/CU MCP 직접 호출 못 함 → shell `open`(앱 띄우기만) 또는 sidecar 우회(웹검색/vision, 한도 제약). 진짜 제어는 codex 모델로.
- Windows: TCC 권한 없음(computer-use는 win 바이너리 있어야 가능, 현 config는 mac 전용). 브라우저 확장 경로는 OS 무관.
