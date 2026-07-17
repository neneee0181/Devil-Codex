# 순정 Codex Bridge 즉시 전환 설계·구현 문서

## 목표

Devil Codex의 **순정 Codex Bridge** 토글을 변경했을 때 Devil Codex를 종료하지 않고 즉시 적용한다.

- Bridge가 켜지면 순정 Codex 모델 선택기에 Devil Codex에서 고른 외부 모델이 나타난다.
- Bridge가 꺼지면 다음 순정 Codex 실행부터 외부 모델이 나타나지 않는다.
- 순정 Codex가 현재 실행 중이면 설정 반영 직후 종료하고 다시 실행한다. 실행 중이 아니면 시작하지 않는다.
- Devil Codex의 GPT/Codex 모델은 Bridge가 켜진 동안 로컬 프록시를 지나지만, 요청 본문·인증 헤더를 변경하지 않고 ChatGPT Codex upstream으로 그대로 전달한다.
- Bridge가 켜진 동안 Devil Codex는 순정 Codex 전용 모드가 된다. Devil 채팅 실행과 Devil 전용 MCP를 모두 잠그며, Bridge를 끄면 저장된 MCP 설정을 즉시 복구한다.

## 범위와 비범위

| 항목 | 이번 구현 | 비고 |
| --- | --- | --- |
| Bridge 토글 즉시 적용 | 포함 | Devil Codex 재시작 불필요 |
| 선택 모델 변경 즉시 반영 | 포함 | 순정 Codex가 실행 중이면 재시작 |
| GPT/Codex 투명 전달 | 포함 | provider adapter를 통과하지 않음 |
| 외부 모델 provider adapter | 유지 | `provider(:account):model`만 변환 |
| 순정 Codex의 진행 중 작업 보존 | 불가 | 사용자 요구대로 강제 종료 가능 |
| 외부 모델을 순정 Codex에 영구 설치 | 제외 | 관리 블록과 생성 catalog만 사용 |

## 핵심 설계

### 요청 경로

```text
순정 Codex 또는 Devil Codex
        │
        ▼
127.0.0.1:49873/<secret>/v1/responses
        │
        ├─ GPT/Codex model
        │     └─ 원본 body + 원본 OpenAI 인증 header 그대로
        │        https://chatgpt.com/backend-api/codex/responses
        │
        └─ 외부 model (provider(:account):model)
              └─ Devil provider adapter → 해당 provider API
```

GPT/Codex 요청에는 모델 이름, tool, input, reasoning 설정을 재작성하지 않는다. 이 경로는 로컬 네트워크 홉만 하나 추가하므로 토큰을 별도로 소비하지 않는다. 단, 프록시가 재시도하거나 adapter가 새 요청을 생성할 경우에는 그 요청만큼 제공자 사용량이 발생할 수 있다. GPT 투명 경로에서는 재시도를 추가하지 않는다.

### 설정 소유권

`~/.codex/config.toml`의 Devil 관리 블록만 수정한다.

```toml
# devil-codex:stock-bridge:start
model_provider = "devil"
model_catalog_json = "/.../devil-stock-catalog.json"
# devil-codex:stock-bridge:end
```

- 토글 켜기: catalog를 먼저 생성하고 위 블록을 원자적으로 기록한다.
- 토글 끄기: 위 관리 블록만 제거한다. 사용자가 작성한 다른 Codex 설정·로그인·대화 이력은 건드리지 않는다.
- catalog에는 선택된 외부 모델만 추가한다. GPT/Codex 기본 모델은 upstream 순정 catalog가 계속 제공한다.

## 상태 전이

| 현재 | 동작 | 결과 |
| --- | --- | --- |
| Bridge OFF → ON | 로컬 프록시 시작 → catalog 동기화 → 관리 블록 기록 → 순정 Codex가 실행 중이면 재시작 | 외부 모델 표시 |
| Bridge ON → OFF | 관리 블록 제거 → background proxy 중지 → 순정 Codex가 실행 중이면 재시작 | 외부 모델 미표시 |
| Bridge ON + 선택 모델 변경 | catalog 갱신 → 관리 블록 재기록 → 순정 Codex가 실행 중이면 재시작 | 변경된 목록 표시 |
| Bridge OFF → ON (Devil 기능) | Devil Browser·Computer Use·Ask·Subagent MCP 블록 제거 → Devil 채팅/큐/스티어링 차단 | 순정 Codex가 Devil 전용 MCP를 인식하지 않음 |
| Bridge ON → OFF (Devil 기능) | 저장된 MCP opt-in을 config에 다시 등록 → Devil 채팅 차단 해제 | Devil 기능 즉시 복구 |
| Devil Codex 시작 + Bridge ON | 기존 headless proxy 종료 → 데스크톱 프로세스가 프록시 소유 → 관리 블록 유지·동기화 | Devil 종료 불필요 |
| Devil Codex 종료 + Bridge ON | 관리 블록을 유지하고 headless proxy로 소유권 handoff | 순정 Codex 단독 실행도 Bridge 유지 |
| Devil Codex 시작 + Bridge OFF | 관리 블록 제거, headless proxy 정지 | 순정 Codex 기본 상태 |

## 브라우저 스킬 라우팅

Devil Codex의 내장 브라우저는 `devil_browser` MCP로 제어한다. 순정 Codex의 `browser:control-in-app-browser` 스킬은 순정 `iab` 런타임 전용이며 외부 브라우저 MCP를 사용하지 않으므로, 두 경로를 동시에 노출하면 Devil 앱에서 `iab` 연결 실패가 발생한다.

| 상태 | Browser 플러그인 | 브라우저 제어 경로 |
| --- | --- | --- |
| Bridge OFF + Devil Browser MCP ON | `browser@openai-bundled`만 일시 비활성화 | `devil_browser` → Devil 우측 내장 브라우저 |
| Bridge ON | 원래 활성 상태로 복구 | 순정 Codex `browser:control-in-app-browser` → `iab` |
| Devil Browser MCP OFF 또는 Devil 종료 | 원래 활성 상태로 복구 | 순정 Browser 플러그인 기본 동작 |

다른 순정 MCP와 플러그인은 변경하지 않는다. Devil은 플러그인을 비활성화하기 전의 Browser 플러그인 table을 별도 상태 파일에 보관하고, 종료·Bridge ON·MCP OFF 때 원래 table을 그대로 복구한다. Browser MCP 상태는 config/socket만 확인하지 않고 Codex App Server가 `browser_navigate` 및 `computer_screenshot` 도구를 실제 로드했는지까지 검사한다.

## 순정 Codex 재시작 정책

Bridge 설정은 순정 Codex가 시작할 때 읽는다. 따라서 설정 파일만 갱신해도 이미 열린 앱의 모델 picker는 즉시 바뀌지 않는다.

Bridge ON일 때 Devil Codex는 기존 스레드·설정·파일/터미널 탭을 계속 열 수 있지만, 새 대화 진입점은 비활성화한다. 대상은 사이드바 새 채팅, 프로젝트별 새 채팅, Windows 파일 메뉴, 단축키와 명령 팔레트의 새 채팅 항목이다.

1. OS별로 **데스크톱 순정 Codex 앱만** 실행 여부를 확인한다. CLI `codex` 프로세스는 종료 대상이 아니다.
2. 실행 중일 때만 해당 앱을 강제 종료한다. 진행 중인 순정 Codex 작업은 취소될 수 있다.
3. 종료가 확인되면 기존 OS launcher로 다시 실행한다.
4. 실행 중이 아니면 아무 앱도 새로 열지 않는다.

| OS | 탐지·종료 | 재실행 |
| --- | --- | --- |
| Windows | Microsoft Store 패키지 경로 `OpenAI.Codex_*`의 GUI 프로세스만 종료 | AppsFolder AUMID 또는 Codex 앱 launcher |
| macOS | `Codex.app`의 bundle/process 확인 후 quit, 시간 초과 시 해당 앱만 종료 | `open -a Codex` |
| Linux | 알려진 GUI executable/process만 확인하고 종료 | desktop launcher 또는 `xdg-open codex:` |

앱 식별에 실패한 플랫폼에서는 설정을 적용하되 자동 재시작을 생략하고 로그에 원인을 남긴다. 임의의 `codex` CLI를 종료하지 않는 것이 더 안전하다.

## 실패 및 원복

- 프록시 시작 실패: 관리 블록을 쓰지 않고 현재 상태를 유지한다.
- catalog 생성 실패: 기존 관리 블록을 바꾸지 않는다.
- 관리 블록 기록 실패: 프록시는 살아 있어도 순정 Codex를 재시작하지 않는다.
- 순정 Codex 종료/재실행 실패: Bridge 설정은 유지하고 오류를 기록한다. 사용자가 다음에 순정 Codex를 직접 실행하면 새 설정을 읽는다.
- 토글 OFF에서 proxy 종료 실패: 관리 블록은 우선 제거한다. 남은 loopback proxy는 외부에서 접근할 수 없으며 다음 Devil 시작 시 다시 정리한다.

## 보안·개인정보 원칙

- 프록시는 `127.0.0.1`만 listen하며 임의의 secret path를 요구한다.
- native GPT 경로에서는 요청 body·authorization·응답 내용을 로그/설정 파일에 저장하지 않는다.
- OpenAI 관련 header는 기존 요청의 값을 전달하며, Devil Codex가 별도 OpenAI API key를 만들거나 저장하지 않는다.
- 외부 provider의 credential 처리는 기존 keychain/provider 설정 경계를 그대로 사용한다.
- Bridge ON에서는 `devil_browser`, `devil_computer`, `devil_ask`, `devil_subagent` MCP 관리 블록을 모두 제거한다. 순정 Codex가 끊어진 로컬 socket 도구를 보거나 실행할 수 없게 한다.

## 구현 순서

1. 순정 Codex GUI 앱 감지·재시작 helper를 추가한다.
2. headless bridge proxy를 플랫폼 공통으로 정리할 수 있게 한다.
3. 데스크톱 시작 시 Bridge ON이면 headless proxy를 정리한 뒤 데스크톱 프록시가 즉시 config를 소유하게 바꾼다.
4. 설정 저장 시 토글/선택 모델 변경을 즉시 config에 반영하고, 실행 중인 순정 Codex만 재시작한다.
5. 종료 시에는 기존 headless handoff를 유지한다.
6. 자동 테스트와 build를 실행하고 Windows 수동 시나리오를 확인한다.

## 검증 시나리오

### 자동

```bash
npm run test:main
npm run build
```

성공 기준은 process helper의 플랫폼별 명령 선택 테스트와 TypeScript/Electron main build가 모두 통과하는 것이다.

### 수동

1. Devil Codex와 순정 Codex를 모두 실행하고 Devil Codex 설정에서 Bridge를 켠다.
2. 순정 Codex가 자동으로 재시작된 뒤 모델 picker를 연다.
3. 선택한 외부 provider → account → model이 나타나는지 확인한다.
4. GPT-5.6 모델로 대화를 보내고 Devil Codex request log에 adapter 요청이 아닌 native pass-through로 처리되는지 확인한다.
5. Bridge를 끄면 순정 Codex가 다시 시작되고 외부 모델이 사라지는지 확인한다.
6. 순정 Codex를 종료한 상태에서 토글을 켜고, 순정 Codex가 자동으로 새로 열리지 않는지 확인한다. 이후 사용자가 직접 실행하면 외부 모델이 보여야 한다.
