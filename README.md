# Devil Codex

Codex app-server 기반의 데스크톱 개발 환경에 멀티 provider, 순정 Codex Bridge, 원격 제어와 Devil 전용 MCP 도구를 더한 Electron 앱입니다.

Devil Codex의 기본 원칙은 간단합니다.

- Codex 로그인 모델은 가능한 한 **순정 Codex 경로**를 유지합니다.
- 외부 모델은 Devil의 로컬 provider 프록시를 통해 동일한 thread·도구·프로젝트 경험에 연결합니다.
- 순정 Codex 앱/CLI를 위한 별도 Bridge는 사용자가 고른 외부 모델만 노출합니다.

> 비공식 프로젝트이며 OpenAI와 제휴 관계가 없습니다.

## 현재 제공 기능

### Codex와 외부 모델

- Codex app-server를 이용한 thread 생성·재개·검색·보관·turn streaming
- Codex 로그인 모델의 직접 실행 경로
- GPT-5.6 Sol, Terra, Luna의 native 모델 카탈로그 보강
- Claude Code, GitHub Copilot, OpenAI-compatible API provider, 로컬 Ollama/vLLM/LM Studio 등 외부 모델 연결
- 외부 provider 대화의 Devil 로컬 transcript와 Codex thread 연속성 관리
- provider별 모델·계정 선택, 사용량/요청 진단, 도구·이미지·검색 capability 표시

### 순정 Codex Bridge

Devil Codex를 종료한 뒤에도 순정 Codex 앱/CLI의 모델 선택기에서 외부 모델을 사용할 수 있습니다.

- `설정 → 구성 → Bridge`에서 Bridge를 켜거나 끌 수 있습니다.
- 순정 GPT 모델은 항상 먼저 표시됩니다.
- `순정 Codex에 표시할 모델`에서 추가한 외부 모델만, 지정한 순서대로 그 뒤에 표시됩니다.
- Bridge를 끄면 순정 Codex의 외부 모델 노출과 백그라운드 Bridge를 제거합니다. 선택 목록은 보존됩니다.
- 외부 모델용 웹 검색·이미지 설명 sidecar는 선택적으로 켤 수 있습니다.

### 개발 워크플로

- 멀티 프로젝트와 Git worktree
- 변경 파일·unified diff·file/hunk stage/unstage/revert·inline review 의견
- 내장 터미널, 외부 에디터/터미널 열기, Git branch·commit·push 작업
- 요청 대기열, turn interrupt/steer, thread별 우측/하단 도구 탭 상태 보존
- 영어 응답 강제와 응답 번역, 시스템 알림

### Devil MCP 도구

설정에서 켠 기능만 Codex 도구 목록에 등록됩니다.

- 인앱 브라우저 제어
- OS 컴퓨터 제어(마우스·키보드·스크린샷)
- 구조화된 사용자 질문 모달
- 외부 provider/모델에 독립 작업을 맡기는 하위 에이전트

하위 에이전트는 Devil Codex의 저장된 Codex 승인 정책과 샌드박스 범위를 넘지 않으며, timeout·중단·빈 결과를 명확히 실패 상태로 반환합니다.

### 원격 제어

- Tailscale Funnel 또는 Tailnet 직접 주소를 통한 모바일/브라우저 접속
- 토큰과 승인된 기기 관리
- 허용한 thread만 원격으로 표시·읽기·전송하도록 제한

## 설정 구조

`설정 → 구성`은 다음 탭으로 나뉩니다.

| 탭 | 내용 |
| --- | --- |
| 기본 | 앱 정보, 승인 정책, 샌드박스, 터미널, 브라우저, 언어 |
| 도구 | Devil MCP, 사용자 질문, 하위 에이전트, 브라우저/컴퓨터 제어 |
| 원격 | Tailscale, 접속 주소, 기기, 허용 thread |
| Bridge | 순정 Codex 외부 모델 선택과 sidecar |
| Sidecar | Devil 앱 내부 외부 모델의 웹 검색·이미지 설명 보조 기능 |

## 아키텍처

```text
React renderer
    │ IPC
Electron main
    ├── Codex app-server ──────────────── native Codex 모델
    ├── Devil provider proxy ─────────── 외부 provider API / OAuth / 로컬 모델
    ├── Devil MCP ────────────────────── browser · computer · ask · subagent
    ├── Stock Codex Bridge ───────────── 순정 Codex 앱/CLI용 선택 모델 카탈로그
    └── Remote server ────────────────── Tailscale 기반 원격 웹
```

## 개발 시작

### 요구 사항

- Node.js 22+
- Codex CLI 로그인 또는 사용 가능한 Codex 계정
- macOS 또는 Windows

외부 provider는 해당 API 키, OAuth 로그인 또는 로컬 endpoint가 별도로 필요할 수 있습니다.

```bash
npm install
npm run dev
```

## 검증과 패키징

```bash
# renderer + mobile UI + Electron main TypeScript 빌드
npm run build

# 패키지 생성
npm run dist:mac
npm run dist:win
```

태그를 푸시하면 GitHub Actions가 릴리스 워크플로를 실행합니다.

## 보안 메모

- API 키와 OAuth 자격 증명은 Electron `safeStorage`/OS 보안 저장소를 사용합니다.
- 비밀값을 채팅, 커밋, 로그, 스크린샷에 넣지 마세요.
- Bridge와 원격 제어는 실제 외부 요청 또는 원격 접속을 가능하게 하므로 필요한 경우에만 켜세요.

## 라이선스

[MIT](LICENSE) © 2026 neneee0181
