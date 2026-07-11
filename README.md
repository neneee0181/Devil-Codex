<div align="center">

# 😈 Devil Codex

**Codex의 데스크톱 경험을 그대로 — 거기에 모든 모델과 진짜 컴퓨터 제어를 얹다.**

Codex app-server를 중심으로 순정 Codex 모델, 외부 모델 provider, Bridge, 원격 제어와 Devil 자체 MCP 도구를 한 곳에 연결한 macOS / Windows 데스크톱 앱.

[![release](https://img.shields.io/github/v/release/neneee0181/Devil-Codex?color=6c4cf1)](https://github.com/neneee0181/Devil-Codex/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-444)](https://github.com/neneee0181/Devil-Codex)
[![electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![react](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![typescript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

## ✨ 한눈에 보기

Devil Codex는 공식 **Codex app-server**의 thread·turn·도구 경험을 기반으로, 아래 기능을 더합니다.

- 🧩 **순정 + 외부 모델** — Codex 로그인 모델은 가능한 한 순정 경로를 유지하고, Claude Code·Copilot·API·로컬 모델은 Devil provider 프록시로 같은 프로젝트 경험에 연결합니다.
- 🖥️ **진짜 제어** — 인앱 브라우저와 OS 전체 데스크톱을 조작하는 Devil MCP 도구를 제공합니다.
- 🌉 **순정 Codex Bridge** — 순정 Codex 앱/CLI에는 사용자가 고른 외부 모델만 노출합니다.
- 🌐 **원격·언어 UX** — Tailscale 기반 원격 접속, 영어 응답 강제와 응답 번역, 시스템 알림을 지원합니다.

> Codex 호환을 지향하는 비공식 프로젝트이며 OpenAI와 직접적인 제휴 관계가 없습니다.

---

## 🚀 주요 기능

### 멀티 모델 공급자

하나의 UI에서 provider와 모델을 전환합니다. Codex 로그인 모델은 app-server 직통 경로를 유지하고, 외부 모델은 Devil의 로컬 provider 프록시를 거칩니다.

| 구분 | 현재 경로 |
| --- | --- |
| Codex | app-server 직접 실행, native 모델 카탈로그 보강 |
| 로그인 provider | Claude Code · GitHub Copilot · Antigravity |
| API / 호스티드 provider | OpenAI-compatible · Anthropic · Google · DeepSeek · xAI · OpenRouter · NVIDIA NIM 등 |
| 로컬 provider | Ollama · vLLM · LM Studio |

- 🔐 API 키와 OAuth 자격 증명은 Electron `safeStorage`/OS 보안 저장소를 사용합니다.
- 🧠 외부 모델에는 웹 검색과 이미지 설명 sidecar를 선택적으로 적용할 수 있습니다.
- 🧵 외부 provider 대화도 Devil transcript와 Codex thread 연속성을 유지하도록 관리합니다.
- ☀️ GPT-5.6 Sol · Terra · Luna는 native Codex 카탈로그에 보강되어, 사용 권한이 있는 계정에서 순정 경로로 요청됩니다.

### 순정 Codex 모델 선택기 연동

Devil Codex를 종료한 뒤에도 순정 Codex 앱/CLI에서 외부 모델을 사용할 수 있습니다.

- `설정 → 구성 → Bridge`에서 기능을 켜거나 끌 수 있습니다.
- 순정 GPT 모델은 항상 먼저 표시됩니다.
- `순정 Codex에 표시할 모델`에서 추가한 외부 모델만, 지정한 순서대로 그 뒤에 표시됩니다.
- 선택 개수에는 제한이 없고, 위·아래 버튼으로 표시 순서를 바꿀 수 있습니다.
- Bridge를 끄면 순정 Codex에는 외부 모델이 보이지 않습니다. 선택 목록은 보존되어 다시 켤 때 복원됩니다.
- 웹 검색·이미지 설명 sidecar도 순정 Codex의 선택 외부 모델에 선택적으로 적용할 수 있습니다.

> 순정 Codex 선택기는 하나의 OpenAI transport를 사용합니다. 그래서 외부 모델은 로컬 Bridge가 변환하고, native Codex 모델은 본문·인증·응답을 변환하지 않은 채 원래 Codex 백엔드로 전달합니다.

### Devil 자체 도구 (MCP)

모델이 호출하는 Devil 전용 도구이며, 설정에서 켠 기능만 등록됩니다.

- 🌍 **브라우저 제어** — 인앱 브라우저 탐색·클릭·입력
- 🖱️ **컴퓨터 제어** — OS 전체 화면의 마우스·키보드·스크린샷 제어
- ❓ **사용자에게 질문** — 구조화된 객관식 질문 모달
- 🧑‍💻 **하위 에이전트** — 외부 provider/model에 독립 작업 위임

하위 에이전트는 저장된 Codex 승인 정책과 샌드박스 범위를 넘지 않으며, timeout·중단·빈 결과를 명확한 실패 상태로 반환합니다.

### 워크플로 & UX

- 💬 **요청 큐 + 스티어링** — 작업 중에도 다음 요청을 대기열에 넣고, 필요하면 현재 작업을 중단해 우선 처리합니다.
- 🧵 **Thread** — 생성·재개·검색·보관, thread별 우측/하단 도구 탭 상태 보존.
- 🗂️ **개발 환경** — 멀티 프로젝트, Git worktree, 변경 파일·unified diff·file/hunk stage/unstage/revert·inline review.
- ⌨️ **도구** — 내장 터미널, Git branch·commit·push, 외부 에디터/터미널 열기.
- 🔔 **개인화** — 백그라운드 알림, 영어 응답 강제와 응답 번역.

### 🌐 원격 제어

- Tailscale Funnel 또는 Tailnet 직접 주소로 모바일/브라우저에서 접속
- 토큰과 승인된 기기 관리
- 허용한 thread만 원격에서 표시·읽기·전송하도록 제한

---

## ⚙️ 설정 구조

`설정 → 구성`은 목적별 탭으로 나뉩니다.

| 탭 | 내용 |
| --- | --- |
| 기본 | 앱 정보, 승인 정책, 샌드박스, 터미널, 브라우저, 언어 |
| 도구 | Devil MCP, 사용자 질문, 하위 에이전트, 브라우저/컴퓨터 제어 |
| 원격 | Tailscale, 접속 주소, 기기, 허용 thread |
| Bridge | 순정 Codex 외부 모델 선택과 sidecar |
| Sidecar | Devil 앱 내부 외부 모델의 웹 검색·이미지 설명 보조 기능 |

---

## 🧱 아키텍처 한 줄 요약

```text
React renderer  ──IPC──▶  Electron main  ──▶  Codex app-server (native Codex 모델)
                                   │
                                   ├─ Devil provider proxy ─▶ 외부 provider API / OAuth / 로컬 모델
                                   ├─ Devil MCP ────────────▶ browser / computer / ask / subagent
                                   ├─ Stock Codex Bridge ───▶ 순정 Codex 앱·CLI용 선택 모델 카탈로그
                                   └─ Remote server ────────▶ Tailscale 기반 원격 웹
```

---

## 📦 요구 사항

- **Node.js 22+**
- **Codex CLI** 또는 사용 가능한 Codex 계정
- macOS 또는 Windows

> Codex 로그인 모델은 Codex 인증을, 외부 모델은 각 provider의 API 키·OAuth·로컬 endpoint를 사용합니다.

---

## 🛠️ 설치 & 실행

```bash
# 1) 의존성 설치
npm install

# 2) 개발 모드 실행
npm run dev
```

### 빌드 / 패키징

```bash
npm run build        # renderer + mobile UI + Electron main
npm run dist:win     # Windows 인스톨러
npm run dist:mac     # macOS 앱
```

---

## 🔒 보안 메모

- API 키·OAuth 자격 증명·원격 토큰을 채팅·커밋·로그·스크린샷에 넣지 마세요.
- Bridge와 원격 제어는 실제 외부 요청 또는 원격 접속을 가능하게 하므로 필요한 경우에만 켜세요.

---

## ⬇️ 다운로드

[**Releases**](https://github.com/neneee0181/Devil-Codex/releases)에서 최신 설치 파일을 받을 수 있습니다. 태그(`v*`)를 푸시하면 GitHub Actions가 릴리스 워크플로를 실행합니다.

> 설치 파일은 코드 서명 상태에 따라 Windows SmartScreen 또는 macOS Gatekeeper 경고를 표시할 수 있습니다.

## 📄 라이선스

[MIT](LICENSE) © 2026 neneee0181

<div align="center">
<sub>Codex 호환을 지향하는 비공식 프로젝트입니다. OpenAI와 직접적인 제휴 관계가 없습니다.</sub>
</div>
