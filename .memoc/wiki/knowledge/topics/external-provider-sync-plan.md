---
memoc: true
type: wiki
scope: project-memory
created: 2026-06-23T16:40:22
updated: 2026-06-24T00:00:00
status: active
confidence: high
tags:
  - memoc
  - memoc/wiki
  - memoc/knowledge-wiki
  - memoc/topic
  - plan
  - sync
  - proxy
  - reconcile
---
# External-Provider Sync Plan — thread-level provider reconcile

> 이 문서는 다음 에이전트가 그대로 이어받아 구현할 작업 명세다.
> 푸시 금지. `test.txt`, 임시 대화 continuation txt, `.env.local`, provider token/credential은 절대 커밋하지 않는다.

## 0. 최종 목표

Devil Codex에서 같은 thread 안에서 여러 모델을 섞어 쓴다.

```text
Codex 모델
→ Devil proxy를 타지 않는다
→ 기존 Codex app-server/openai provider 경로 그대로 사용
→ 순정 Codex와 동기화 유지

외부 모델(Copilot / Claude Code)
→ app-server thread는 modelProvider: "devil"로 실행
→ Devil local Responses proxy를 통해 외부 provider로 변환
→ 응답 완료 후 thread 저장 provider를 openai로 reconcile
→ 순정 Codex에서는 같은 thread history로 보임
```

순정 Codex는 외부 모델명을 몰라도 된다. 순정 Codex에서는 같은 대화 내역을 열고 Codex 모델로 이어서 진행하면 된다. Devil Codex만 실제 turn별 provider/model 메타를 별도로 보존하고 표시한다.

## 1. 이번 결정의 핵심

기존 금지였던 `~/.codex/state_5.sqlite` / rollout `session_meta.model_provider` 변경을 **제한적으로 허용**한다.

허용 범위는 다음뿐이다.

```text
app-server가 실제로 생성/처리한 기존 thread의 provider 표시를
외부 turn 이후 devil → openai로 reconcile하는 작업
```

금지되는 것은 계속 금지다.

```text
없는 thread를 새로 만들어 SQLite/rollout에 삽입
turn content를 직접 조작해서 가짜 대화 생성
Codex credential/token 읽기 또는 저장
/Applications/Codex.app 수정
사용자 파일 삭제/초기화
```

## 2. 왜 이 방식이 필요한가

2026-06-24 확인 결과:

- Codex app-server `thread/list`에는 `modelProviders?: string[]` 필터가 있다.
- 실제 probe 결과:
  - `modelProviders: []` → `openai` + `devil` thread 모두 반환
  - `modelProviders: ["openai"]` → openai thread만 반환
  - `modelProviders: ["devil"]` → devil thread만 반환
- 순정 Codex UI가 현재 provider/openai 기준으로 list를 요청하면 `modelProvider: "devil"` 외부 thread가 안 보일 수 있다.
- `turn/start`에는 `modelProvider`가 없다. 한 turn만 provider를 바꾸는 공식 API는 없다.
- `thread/inject_items`는 model-visible history용이고 UI-visible turn/list에는 반영되지 않았다.

따라서 Codex 모델 직통을 유지하면서 외부 모델 thread를 순정 Codex에 보이게 하려면, 외부 turn 완료 후 저장 provider를 `openai`로 reconcile하는 방식이 현재 가장 현실적이다.

## 3. 목표 동작

### 3.1 Codex 모델

```text
renderer submit(provider="codex")
→ thread/start 또는 turn/start에 modelProvider를 넣지 않음
→ Codex app-server 기본 openai provider 사용
→ Devil proxy traffic 0건
→ thread는 openai로 저장
```

### 3.2 외부 모델 새 thread

```text
renderer submit(provider="copilot" | "claude-code")
→ thread/start(modelProvider: "devil", model: "<provider>:<model>")
→ reconcile journal pending 기록
→ turn/start(model: "<provider>:<model>")
→ app-server가 Devil proxy /v1/responses 호출
→ 외부 provider 응답 완료
→ app-server rollout/DB 기록 완료
→ provider reconcile: devil → openai
→ Devil-local metadata에는 실제 provider/model 기록
```

### 3.3 기존 openai thread에서 외부 모델 이어가기

주의: `turn/start`에는 `modelProvider`가 없으므로, 외부 모델 turn 전에 `thread/resume` 또는 equivalent app-server 호출로 해당 thread runtime 설정을 `modelProvider: "devil"`로 맞춰야 한다.

목표 흐름:

```text
existing thread provider=openai
→ 사용자가 Devil에서 외부 모델 선택
→ reconcile journal pending 기록
→ server.resumeThread({ id, model: "<provider>:<model>", modelProvider: "devil" })
→ server.sendTurn({ model: "<provider>:<model>" })
→ turn 완료
→ DB/rollout provider를 openai로 reconcile
```

구현 시 `CodexAppServer.resumeThread`는 현재 `modelProvider`를 받지 않으므로 확장 필요.

## 4. 안전 원칙

### 4.1 Journal-first

외부 turn 시작 전 반드시 pending journal을 먼저 저장한다.

예상 파일 위치:

```text
Electron userData/providers/pending-reconcile.json
```

예상 shape:

```json
{
  "version": 1,
  "items": {
    "thread-id": {
      "threadId": "thread-id",
      "targetProvider": "openai",
      "actualProvider": "copilot",
      "actualModel": "gpt-5-mini",
      "status": "pending",
      "attempts": 0,
      "startedAt": 1710000000000,
      "lastError": null
    }
  }
}
```

성공 시 item 삭제 또는 `done` 처리. 실패 시 pending 유지.

### 4.2 Schema guard

SQLite/rollout patch 전에 다음을 모두 확인한다.

```text
~/.codex/state_5.sqlite 존재
threads 테이블 존재
threads.id 존재
threads.model_provider 존재
threads.rollout_path 존재
thread row 존재
row.rollout_path 존재
rollout 파일 존재
rollout 첫 줄 JSON parse 성공
첫 줄 type === "session_meta"
payload.id === threadId
payload.model_provider 존재
```

하나라도 실패하면 patch하지 않는다.

```text
pending 유지
lastError 기록
사용자에게 "Codex 저장소 형식 변경 가능성" 상태 표시
백업 외에는 쓰지 않음
```

### 4.3 Backup-before-write

처음 write 전에 백업한다.

권장 위치:

```text
~/.codex/devil-codex-backups/reconcile-YYYY-MM-DDTHH-mm-ss/
  state_5.sqlite
  rollout-<thread-id>.jsonl
  manifest.json
```

manifest 예:

```json
{
  "version": 1,
  "threadId": "thread-id",
  "fromProvider": "devil",
  "toProvider": "openai",
  "dbPath": "/Users/.../.codex/state_5.sqlite",
  "rolloutPath": "/Users/.../.codex/sessions/.../rollout-....jsonl",
  "createdAt": 1710000000000
}
```

### 4.4 Retry/backoff

DB lock 또는 transient write 실패는 짧게 재시도한다.

```text
250ms
500ms
1000ms
2000ms
```

그래도 실패하면 pending 유지. 다음 앱 시작/다음 external turn 완료/수동 sync 액션에서 다시 시도.

### 4.5 No data-loss rule

reconcile 실패는 대화 실패가 아니다.

```text
Devil UI에는 ProviderTranscriptStore/local history로 계속 보여야 함
순정 Codex sync 상태만 "대기/실패"로 표시
```

## 5. 구현 파일 계획

### 5.1 신규: `src/main/codex-provider-reconcile.cts`

역할:

- pending journal load/save
- `markPendingExternalTurn(input)`
- `completeExternalTurn(threadId)`
- `reconcileThreadToOpenai(threadId)`
- `reconcilePending()`
- schema guard
- backup
- SQLite `threads.model_provider` patch
- rollout first-line `session_meta.payload.model_provider` patch
- retry/backoff

필수 제약:

- credentials/tokens 읽지 않음
- row content/turn content 수정하지 않음
- `model_provider` 필드만 patch
- schema guard 실패 시 write 금지

SQLite 구현 선택:

- 기존 dependency가 있으면 사용
- 없으면 Node/Electron 환경에서 사용 가능한 sqlite dependency 확인 후 최소 추가
- shell `sqlite3` CLI 의존은 피한다. 앱 runtime에서 동작해야 한다.

### 5.2 수정: `src/main/app-server.cts`

필요 변경:

- `resumeThread(input)`에 optional `modelProvider?: string` 추가
- `thread/resume` params에 `modelProvider` 전달
- `listThreads`/`listProjects`에서 반환 thread의 `modelProvider`를 ThreadSummary에 보존할 수 있으면 보존

주의:

- Codex provider path에서는 modelProvider를 절대 전달하지 않는다.

### 5.3 수정: `src/main/main.cts`

외부 provider 흐름에 연결한다.

새 thread:

```text
thread:create provider external
→ createThread(modelProvider: "devil")
→ providerTranscripts.saveMeta(...)
```

외부 turn:

```text
turn:send provider external
→ reconciler.markPendingExternalTurn(...)
→ 필요 시 server.resumeThread({ id, model: prefixedModel, modelProvider: "devil" })
→ providerTranscripts.append(user)
→ server.sendTurn(prefixedModel)
→ app-server sendTurn resolve 또는 turn/completed 감지
→ providerTranscripts local history 보호
→ reconciler.completeExternalTurn(threadId)
```

startup:

```text
app.whenReady
→ startCodexProxy()
→ reconciler.reconcilePending().catch(...)
```

주의:

- `completeExternalTurn`은 실패해도 throw로 UI turn 성공을 깨지 말 것. pending 상태만 유지한다.
- Codex provider turn은 reconciler를 호출하지 않는다.

### 5.4 수정: `src/main/provider-transcript.cts`

현재 역할:

- Devil external thread local recovery/rendering

추가 역할:

- 실제 provider/model metadata 저장
- external turn별 provenance 저장

예상 shape 확장:

```ts
type StoredShape = {
  items: Record<string, ThreadHistoryItem[]>;
  meta: Record<string, ThreadSummary>;
  turns?: Record<string, Array<{
    itemId?: string;
    provider: string;
    model: string;
    startedAt: number;
    completedAt?: number;
    syncStatus?: "pending" | "synced" | "failed";
  }>>;
  recovered?: boolean;
};
```

Devil UI는 나중에 이 메타를 사용해:

```text
Assistant · Copilot gpt-5-mini
Assistant · Claude Code claude-sonnet-4
Assistant · Codex gpt-5.4
```

처럼 표시할 수 있다.

### 5.5 선택 수정: renderer sync status

1차 구현에서는 UI 배지 없이 console/log + local metadata만으로도 가능하다.

2차 구현에서 추가:

```text
동기화 대기 중
순정 Codex 동기화됨
동기화 실패 · 재시도 예정
```

## 6. 검증 계획

### 6.1 Automated verification

```bash
npm run build
```

성공 기준:

```text
TypeScript/Electron/Vite build 통과
```

추가 정적 확인:

```bash
rg -n "CodexMirror|promoteDevilSessions|codex-mirror" src
```

성공 기준:

```text
결과 0줄
```

### 6.2 Local app-server probe

외부 thread 생성/완료 후:

```text
thread/list modelProviders:["openai"]에 해당 thread가 보여야 함
thread/list modelProviders:["devil"]에는 해당 thread가 없어야 함
thread/list modelProviders:[]에는 해당 thread가 보여야 함
```

### 6.3 Manual verification — Codex 직통

Test: Codex 모델 프록시 우회

1. Devil Codex 실행
2. provider `Codex`, model `gpt-5.4` 또는 현재 기본 Codex 모델 선택
3. 입력:

```text
순정 Codex 프록시 우회 검증입니다. OK만 답해.
```

4. 기대:

```text
응답 OK
Devil proxy log에 native/external traffic 없음
thread DB provider=openai
순정 Codex sidebar에 thread 보임
```

### 6.4 Manual verification — 외부 모델 reconcile

Test: Copilot 외부 모델 동기화

1. Devil Codex에서 provider `Copilot`, model `gpt-5-mini` 선택
2. 입력:

```text
외부 Copilot reconcile 검증입니다. OK만 답해.
```

3. 기대:

```text
응답 OK
turn 처리 중 app-server/proxy는 modelProvider=devil 사용
turn 완료 후 DB/rollout provider=openai로 reconcile
Devil local metadata에는 provider=copilot, model=gpt-5-mini 저장
순정 Codex sidebar에 같은 thread 보임
순정 Codex에서 열면 대화내역이 남아 있음
순정 Codex에서 이어 쓰면 Codex 모델로 이어짐
```

### 6.5 Crash recovery simulation

Test: pending journal recovery

1. 외부 turn 시작 전 pending journal 생성 확인
2. reconcile 직전 앱 종료 또는 reconcile 실패를 강제
3. Devil Codex 재시작
4. 기대:

```text
pending journal을 읽고 자동 reconcile 재시도
성공 시 pending 제거
실패 시 pending 유지 + lastError 기록
대화내역은 Devil에서 계속 보임
```

### 6.6 Schema guard test

Test: 잘못된 rollout/DB shape에서 write 금지

1. 테스트용 temp CODEX_HOME 또는 fixture 사용
2. `threads.model_provider` 누락/rollout 첫 줄 불일치 fixture 구성
3. `reconcileThreadToOpenai` 호출
4. 기대:

```text
write 없음
backup 외 원본 불변
pending 유지
lastError에 schema guard failure 기록
```

## 7. known tradeoffs

### 7.1 의미상 provider는 openai로 보임

순정 Codex 저장소에서는 외부 provider turn도 openai thread로 보인다.

허용 이유:

```text
사용자는 순정 Codex에서 외부 모델명을 몰라도 된다고 승인함
순정 Codex에서는 대화내역 유지와 Codex 모델 이어쓰기가 목표
실제 provider/model provenance는 Devil-local metadata에 보존
```

### 7.2 내부 저장소 호환 레이어 유지보수 필요

Codex가 `state_5.sqlite` schema 또는 rollout format을 바꾸면 reconcile이 멈출 수 있다.

대응:

```text
schema guard
backup
pending retry
수동 복구
memoc/handoff 기록
```

### 7.3 순정 Codex와 동시 실행 중 lock 가능

대응:

```text
busy timeout
retry/backoff
pending queue
대화 자체는 Devil-local store로 보호
```

## 8. 구현 순서

1. `codex-provider-reconcile.cts` 추가
   - pure helpers + journal + schema guard + backup + patch
2. `app-server.cts`에 `resumeThread({ modelProvider })` 추가
3. `main.cts` external turn 흐름에 pending/complete reconcile 연결
4. `provider-transcript.cts`에 실제 provider/model 메타 저장 추가
5. build
6. temp fixture 단위 검증
7. 실제 Copilot 1턴 수동 검증
8. memoc `02`, `03`, `04`, `session-summary` 갱신
9. `memoc lint-wiki`
10. 커밋

## 9. 완료 기준

완료로 간주하려면 모두 만족해야 한다.

- Codex 모델은 Devil proxy를 타지 않는다.
- 외부 모델은 Devil proxy를 탄다.
- 외부 모델 응답 후 thread provider가 `openai`로 reconcile된다.
- Devil-local metadata에는 실제 외부 provider/model이 남는다.
- reconcile 실패 시 pending journal에 남고 앱 재시작 후 재시도된다.
- schema guard 실패 시 원본을 쓰지 않는다.
- `npm run build` 통과.
- 푸시하지 않는다.

## Evidence

- `codex app-server generate-ts --out /private/tmp/devil-codex-appserver-ts`
  - `ThreadListParams.modelProviders?: Array<string>`
  - `TurnStartParams`에는 `modelProvider` 없음
  - `ThreadResumeParams`에는 `modelProvider?: string`
- app-server probe:
  - `modelProviders: []` → openai 45 + devil 5 포함
  - `modelProviders: ["openai"]` → openai만
  - `modelProviders: ["devil"]` → devil만
- `thread/inject_items` probe:
  - `foundInOpenaiList=false`
  - `turnCount=0`
  - UI-visible sync 용도로 부적합
- rcodex reference:
  - `src/commands/migrate.ts`는 SQLite `threads.model_provider`와 rollout first-line `session_meta.payload.model_provider`를 함께 바꾼다.

## Related

- [Decisions](../../../03-decisions.md)
- [Handoff](../../../04-handoff.md)
- [Knowledge Wiki](../README.md)
- [Topics](README.md)
