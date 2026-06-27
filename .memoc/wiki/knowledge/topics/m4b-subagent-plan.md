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
  - m4
  - subagent
---
# M4-B Subagent Plan (작업 지시서)

> 다음 에이전트가 그대로 이어받아 구현. 단계마다 빌드/검증/커밋. 푸시는 사용자 지시 시만.
> 배경: [[m4-implementation-plan]], [[milestone-status]]. M4-A는 사실상 완료.

## 0. M4-B 정체 (중요 — picker 아님)

서브에이전트 = AI가 turn 도중 "부하 AI"를 띄워 작업 위임하는 것.
**Codex app-server 네이티브 기능.** 우리가 만드는 게 아니라 **화면에 표시**하는 것.

스키마 확인 결과 (`codex app-server generate-ts`):
- 클라이언트가 호출 가능한 메서드(`thread/*`, `turn/*`)에 spawnAgent **없음**.
- 서브에이전트는 **모델이 turn 중 collab 툴 호출**로 띄움: `CollabAgentTool = spawnAgent | sendInput | resumeAgent | wait | closeAgent`.
- app-server가 thread item으로 통지:
  - `{ type: "subAgentActivity", id, kind: SubAgentActivityKind, agentThreadId, agentPath }`
  - `SubAgentActivityKind = "started" | "interacted" | "interrupted"`
  - `{ type: "collabAgentToolCall", status: "inProgress"|"completed"|"failed", agentsStates }`
  - `SubAgentSource = "review" | "compact" | { thread_spawn: { parent_thread_id, depth, agent_path, agent_nickname, agent_role } } | "memory_consolidation" | { other }`
  - `ThreadSourceKind` 에 `subAgent`/`subAgentReview`/`subAgentCompact`/`subAgentThreadSpawn`/`subAgentOther`.
- **opencodex엔 서브에이전트 기능 없음** (그냥 프록시). 베낄 것 없음.

현재 `src/main/thread-history.cts` 매핑 kind: activity/agent/command/compaction/fileChange/mcp/message/reasoning/user/webSearch. **subagent 없음** → 서브에이전트 활동이 안 보이거나 일반 활동으로 떨어짐.

## 1. 목표

```text
지금:  모델이 부하 AI 띄움 → Devil 화면엔 표시 없음
목표:  모델이 부하 AI 띄움 → 타임라인에 중첩 "서브에이전트" 카드 표시 (Codex 패리티, 데빌 톤)
```

Codex-direct + 외부(proxy) 모델 둘 다 같은 app-server 파이프라인 → 표시 기능은 양쪽 자동 커버.

## 2. 구현 단계

### 2.1 contracts (`src/shared/contracts.ts` + `src/main/contracts.cts`)
`ThreadHistoryItem`에 subagent kind 추가:
```ts
| { kind: "subagent"; id: string; state: "started" | "interacted" | "interrupted";
    agentThreadId: string; agentPath: string;
    source?: "review" | "compact" | "thread_spawn" | "memory_consolidation" | "other";
    nickname?: string; role?: string; depth?: number }
```

### 2.2 매핑 (`src/main/thread-history.cts`)
- app-server `subAgentActivity` item → `subagent` kind 매핑 (state/agentThreadId/agentPath).
- 가능하면 `collabAgentToolCall` + `ThreadSourceKind` 로 source/nickname/role/depth 보강.
- v2 ThreadItem 형태 기준. 실제 런타임 이벤트로 필드명 재확인(generate-ts 출력 vs 실제 event 차이 주의).

### 2.3 렌더 (`src/renderer/threadTimeline.ts` + `components/TurnActivity.tsx`)
- 중첩 서브에이전트 카드: 아이콘(예: 분기/로봇) + "서브에이전트: <role|nickname>" + 상태(실행 중/완료/중단).
- 데빌 톤(빨강 액센트), 기존 activity 카드 스타일 재사용.
- 펼치면 그 서브에이전트 thread(`agentThreadId`) 내용 표시 — `thread:read`로 로드(이미 IPC 있음).
- review/compact source는 "리뷰"/"컨텍스트 정리"로 라벨.

### 2.4 검증
- Codex 모델로 서브에이전트 띄우는 turn 유발 (리뷰 모드 또는 위임 프롬프트) → 중첩 카드 뜨는지.
- 카드 펼침 → 부하 thread 내용 보이는지.

커밋: `feat(subagents): render subagent activity in timeline`.

**완료 (2026-06-25):** 2.1~2.3 구현됨.
- contracts: `ThreadActivityEntry` kind `"subagent"` + `subagent{agentThreadId,...}`.
- 매핑 두 경로 모두: `thread-history.cts`(thread/read) + `threadTimeline.ts entryFromItem`(라이브 스트리밍) — `collabAgentToolCall`(spawn/send/resume/wait/close, receiverThreadIds) + `subAgentActivity`(started/interacted/interrupted, agentThreadId, agentPath→role).
- 렌더: `TurnActivity.tsx` `SubagentEntry` 카드(데빌 톤, 펼치면 `readThread(agentThreadId)`), 요약 "서브에이전트 N개".
- 빌드 통과. 실제 서브에이전트 발생 turn으로 화면 검증은 수동 필요(앱).

## 3. 외부 모델 서브에이전트 (2단계, 미검증 — 실험 필요)

사용자 요구: 순정 Codex 모델 서브에이전트는 유지 + **외부 모델(Claude/Copilot)도 서브에이전트로 쓰고 싶음.**

이론상 가능하나 미검증. 필요 조건:
1. 외부 모델이 `spawnAgent` collab 툴을 호출할 수 있어야 함.
   - 외부 모델도 프록시로 Codex 툴셋 받음 → Codex가 agent 툴을 요청에 넣으면 호출 가능.
   - ⚠️ `tool-sanitize.cts`의 128개 제한/정규화에서 agent 툴이 안 잘리는지 확인.
2. 띄워진 부하 thread가 `modelProvider="devil"` + 외부 모델을 물려받아야 외부 모델로 돔.
   - `SubAgentSource.thread_spawn`엔 provider 필드 없음 → **상속 여부 실제 실행으로 확인 필요.**
   - 안 되면: 새 subagent thread 생성 시 reconcile/proxy가 nested thread도 처리하게 보강.

실험 절차:
1. 2.x 표시 기능 완성 후.
2. 외부 모델(예 Copilot)로 "이 작업을 서브에이전트에 위임해" 류 turn.
3. 프록시 로그/타임라인에서 서브에이전트 spawn 발생하는지 + 부하가 어느 provider로 도는지 확인.
4. 부하가 codex(openai)로 떨어지면 → app-server가 subagent thread provider를 부모에서 안 물려받는 것. 이 경우 한계로 기록 + 가능하면 보강 방법 조사 (직접 주입 금지 원칙 유지).

결과를 `04-handoff.md` + `03-decisions.md`에 사실대로 기록.

**완료 (2026-06-25):** 외부 모델 서브에이전트 인앱 검증 성공.
- 새 스레드 첫 turn 크래시 = 타입 기반 `ThreadNotPersistedError`로 근본 해결
  (`readThreadRow`/`readSessionMeta`/DB-missing이 throw, `prepareExternalTurn`
  boolean 반환, `restoreModelFor` benign). 전 외부 provider 공통 처리, 문자열 매칭 없음.
- 외부 모델로 서브에이전트 생성→대기→종료 풀사이클 + 카드 표시 확인(Curie).

## 4. M4-B 패리티 폴리시 (다음 — 순정 Codex 화면 맞추기)

순정 Codex 화면 2곳에 서브에이전트가 노출됨. 동일하게 구현:

### 4.1 환경 모달 "하위 에이전트" 섹션
- 순정: 환경(SlidersHorizontal) 팝오버에 `변경 사항 / 로컬 / main / 커밋` 아래
  **"하위 에이전트"** 섹션 + spawn된 에이전트 행(아이콘 + 닉네임, 예 `Laplace`).
- 현재 turn(또는 thread)에서 spawn된 subagent 목록을 모음 → 환경 패널에 렌더.
- 데이터 출처: 타임라인 subagent activity의 `subagent.agentThreadId`/`role`/nickname,
  또는 app-server `collabAgentToolCall.receiverThreadIds` + 닉네임.
- 행 클릭 → 4.2 우측 서브에이전트 채팅 열기.

### 4.2 우측 탭 서브에이전트 채팅 (side-chat 재활용)
- 순정: 우측에 `Laplace` 탭으로 서브에이전트 대화창(그 에이전트 thread 메시지 + 입력창).
- 구현: 기존 `openUtility("side-chat")` 패널을 재사용. 서브에이전트용으로 띄울 때
  해당 `agentThreadId`를 로드(`thread:read`)해서 대화 표시.
- 탭 헤더에 닉네임 + 서브에이전트 아이콘. 가능하면 그 thread로 후속 입력도.
  (입력이 어려우면 우선 읽기전용 대화 표시부터.)

### 구현 위치 추정
- 환경 패널: `src/renderer/main.tsx` 환경 팝오버(`environmentOpen`) 렌더부.
- 서브에이전트 수집: 활성 thread items에서 `kind:"subagent"` 모으기.
- 우측 채팅: 기존 side-chat util 패널 + `agentThreadId` 파라미터.

검증: 서브에이전트 띄우는 turn → 환경 모달에 닉네임 뜸 → 클릭 → 우측에 그 대화 열림.

**완료 (2026-06-25):**
- 환경 팝오버 "하위 에이전트" 섹션 (EnvironmentCard, namedSubagents).
- 우측 **side-chat 탭 안에서** 서브에이전트 동작 (별도 컬럼 아님). `ToolContent`의
  `SideChat` 컴포넌트: thread 로드 + 대화 + **입력창**(sendTurn → reload).
- 닉네임: `subagent:info` IPC가 spawn된 thread rollout `session_meta.agent_nickname`
  읽어 env 리스트 + side-chat 헤더에 표시 (Laplace/Curie).
- side-chat thread 이벤트는 메인 타임라인에서 격리(`subagentChatRef` 가드).
- 입력은 sendTurn 후 re-read 방식(라이브 스트리밍 아님). 라이브 스트리밍 side-chat은 후속.

## 5. 후속 수정 (2026-06-25)

- **per-thread**: 화면 전환 시 `subagentChat` 클리어(`restoreNavigation`) — 공통 표시 버그 해결.
- **입력 동작**: codex 턴은 보내기 전 `resumeThread`(서브에이전트 thread가 app-server에 로드 안 돼 무효였음). 외부는 proxy 경로가 내부 resume.
- **새 사이드바 thread 생김 버그**: `sendTurn`에 `subagent` 플래그 추가 → external 경로에서 `providerTranscripts.saveMeta/append` 스킵. 순정 Codex처럼 서브에이전트는 숨은 자식 thread, 새 채팅 안 만듦.
- **서브에이전트 모델 = 외부 가능**: 이 codex 빌드는 `~/.codex/agents` 정의 파일 없이 ad-hoc spawn(닉네임 자동). 자율 spawn 모델은 spawn하는 에이전트가 `collabAgentToolCall.model`로 결정 → "codex 메인 + 자율 외부 서브에이전트"는 app-server 수정 없이 불가(순정 유지 원칙). 대신:
  - 메인이 외부면 서브에이전트도 외부 상속(자동, 검증됨).
  - **side-chat 전용 모델 피커**(provider별 optgroup)로 서브에이전트마다 독립 모델 선택(codex/외부) — `subagent:info`가 model도 반환, picked provider/model로 전송.
- 한계: 자율 codex-main 외부 서브에이전트는 app-server 의존. 라이브 스트리밍 side-chat 후속.

## 6. 멀티탭 + 격리 리팩터 (2026-06-25)

순정 Codex 패리티 + 버그수정:
- **멀티 서브에이전트 탭**: 우측 패널 탭이 `string[]`(tool kinds + `subagent:<id>`).
  여러 서브에이전트 동시 탭 가능. `DockTabStrip`이 subagent 탭은 Bot+닉네임 렌더.
- **per-thread 탭 영속**: `panelByThread` ref에 메인 thread별 {tabs,active} 저장,
  `restoreNavigation`에서 복원 → 스레드 돌아오면 열려있던 서브에이전트 탭 그대로.
- **대화 상태 lift**: `subagentHistory`(main state)로 올림 → 탭 전환에도 유지,
  낙관적 입력 메시지 사라짐 해결(SideChat은 history/onHistory props).
- **이벤트 격리**: `subagentIdsRef`(영속 Set) — subagent thread 이벤트(threadId 없는
  delta는 activeTurn 기반)를 메인 타임라인에서 완전 차단. "서브에이전트 응답이
  메인 채팅에 새는" 버그 근본 해결(active 여부 무관).
- side-chat tool 탭(런처/스레드메뉴)은 빈 안내 placeholder, 실제 서브에이전트는 `subagent:<id>` 탭.

## 7. side-chat 런처 + 입력 버그 (2026-06-25)

- **side-chat 탭 = 런처**: 우측 탭 "사이드 채팅" 누르면 ① "새 사이드 채팅" 버튼 ② 이 thread의 서브에이전트 목록. 클릭하면 해당/새 탭 열림(순정 Codex 패리티).
- **새 사이드 채팅**: `newSideChat()` → 새 codex thread 생성(메인 사이드바엔 안 뜸, plain codex라 saveMeta 없음) → subagent 탭으로 오픈. 모델 피커로 외부 전환 가능. 여러 개 가능.
- **입력 즉시 안 보이던 버그**: send 후 `readThread`가 방금 끝난 turn보다 늦어서 낙관적 메시지를 stale로 덮어씀 → 사라졌다 재시작 시 보임. 수정: 낙관적 user 메시지 유지 + `readThread`를 메시지 수 늘 때까지 폴링(최대 20×600ms) 후 전체 대화 표시.

## 4. 주의/원칙

- M4-A 불변 제약 유지: Codex 모델 프록시 0홉 직통, `~/.codex` 직접 쓰기는 reconcile 레이어만.
- 표시 기능(2)은 안전(읽기/렌더). 외부 서브에이전트(3)는 실험 — 안 되면 한계로 남기고 직접 주입 회귀 금지.
- generate-ts 스키마는 참고용. 실제 app-server event 페이로드로 필드명 검증할 것.

## Related

- [M4 plan](m4-implementation-plan.md)
- [Milestone status](milestone-status.md)
- [Sync plan](external-provider-sync-plan.md)
- [Topics](README.md)

## 8. side-chat UX 폴리시 (2026-06-25)

- 한글 IME 조합 중 엔터 무시(isComposing) — 마지막 글자 남던 버그.
- 새 side-chat 자동 작명(Laplace/Curie… 풀, 중복 회피). 대화 시작 후에만 런처 리스트 노출(빈 건 숨김).
- side-chat 첨부: 이미지/파일 붙여넣기·드롭·파일선택·갤러리(제거)·전송, `useAttachments` 훅 추출(Composer 로직 공유). 메시지 버블에 attachment 카드 렌더.
- 순정 Codex `input_image`(base64) → thread-history attachments 매핑("이미지 없음" 해결). main-process라 `npm run dev` 재시작 필요.
