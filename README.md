<div align="center">

# 😈 Devil Codex

**Codex의 데스크톱 경험을 그대로 — 거기에 모든 모델과 진짜 컴퓨터 제어를 얹다.**

OpenAI Codex의 GUI·워크플로를 재현하고, 수십 개의 모델 공급자와 브라우저·데스크톱 제어를 더한 macOS / Windows 데스크톱 앱.

[![version](https://img.shields.io/badge/version-0.0.1-6c4cf1)](https://github.com/neneee0181/Devil-Codex)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-444)](https://github.com/neneee0181/Devil-Codex)
[![electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![react](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![typescript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

## ✨ 한눈에 보기

Devil Codex는 공식 **Codex app-server**에 직접 붙어 Codex의 thread·turn·도구·롤아웃을 그대로 쓰면서, 그 위에 세 가지를 더합니다.

- 🧩 **어떤 모델이든** — Codex 로그인 모델은 순정 경로 그대로, 외부 모델은 로컬 프록시 + reconcile로 같은 app-server 도구 위에서 구동.
- 🖥️ **진짜 제어** — 인앱 브라우저와 OS 전체 데스크톱(마우스·키보드·스크린샷)을 모델이 직접 조작하는 Devil 자체 MCP 도구.
- 🌐 **언어 자유** — 한글로 묻고 영어로 답하게 강제(토큰 절약), 각 답변은 무료 번역기로 한 번에 한글로.

---

## 🚀 주요 기능

### 멀티 모델 공급자
하나의 UI에서 모델을 전환합니다. Codex 로그인 모델은 순정 app-server 직통, 그 외에는 로컬 프록시를 통해 Codex의 도구·동기화 위에서 동작합니다.

| 구분 | 공급자 |
|---|---|
| 로그인 세션 | **Codex**, **Claude Code**, **GitHub Copilot** |
| 호스티드 API | OpenAI · Anthropic(Claude) · Google Gemini · DeepSeek · xAI Grok · Mistral · Groq · Cerebras · OpenRouter · Together · Fireworks · Moonshot(Kimi) · Hugging Face · NVIDIA NIM |
| 로컬 | **Ollama** · **vLLM** · **LM Studio** |

- 🔐 API 키는 OS Keychain(Electron `safeStorage`)에 암호화 저장 — 평문 노출 없음.
- 🧠 **Sidecar**: 비전 없는 모델엔 이미지 설명, 웹 검색이 없는 모델엔 검색 tool-loop를 Codex가 대신 제공.

### Devil 자체 도구 (MCP)
모델이 호출하는 Devil 전용 도구. 설정에서 켤 때만 등록됩니다.

- 🌍 **브라우저 제어** — 앱에 내장된 webview를 모델이 직접 탐색/클릭/입력.
- 🖱️ **컴퓨터 제어(Computer Use)** — `nut.js` 기반으로 **OS 전체 화면**을 제어. 멀티 모니터 스티칭 스크린샷, 한글 창 제목 인식, 비전/비-비전 모델 모두 대응(좌표 또는 창 목록).
- ❓ **사용자에게 질문** — 모델이 진행 중 구조화된 객관식 질문으로 사용자에게 확인(Claude Code의 AskUserQuestion 스타일).

### 워크플로 & UX
- 💬 **요청 큐 + 스티어링** — 작업 중에도 다음 요청을 입력하면 대기열에 쌓이고, 끝나는 즉시 이어서 전송. 대기 메시지는 **편집·취소·스티어링(현재 작업 중단하고 우선 처리)** 가능.
- 🌐 **영어 응답 + 번역** — 설정으로 모델을 영어 전용 응답으로 고정(토큰 절약). 각 AI 답변 우측 토글로 무료 번역(코드 블록은 원문 보존).
- 🧵 **Thread** — 생성·검색·보관·재개, Git 변경 파일 unified diff, turn 단위 롤백.
- 🗂️ **멀티 프로젝트**, 외부 에디터로 열기(VS Code · Visual Studio · IntelliJ · Rider · GitHub Desktop · 터미널 등), 내장 터미널, 서브에이전트/사이드 채팅.

---

## 📦 요구 사항

- **Node.js 22+**
- **Codex CLI** — `codex --version`이 동작해야 합니다.
- macOS 또는 Windows

> Codex 로그인 모델은 Codex CLI 인증을, 외부 모델은 각 공급자 API 키 또는 로컬 엔드포인트를 사용합니다.

---

## 🛠️ 설치 & 실행

```bash
# 1) 의존성 설치
npm install

# 2) 개발 모드 실행 (Electron 창이 열리고 Codex app-server에 자동 연결)
npm run dev
```

### 빌드 / 패키징

```bash
npm run build        # 렌더러(Vite) + 메인(tsc) 빌드
npm run dist:win     # Windows 인스톨러
npm run dist:mac     # macOS 앱
```

---

## ⚙️ 공급자 설정

1. 좌측 하단 **설정 → 연결**에서 사용할 공급자의 API 키를 입력합니다(로컬 모델은 키 불필요).
2. Composer 하단 **모델 선택기**에서 공급자와 모델을 고릅니다.
3. **설정 → 구성**에서 승인 정책·샌드박스, **Devil MCP 도구**(브라우저/컴퓨터 제어), **영어 응답 + 번역**, 외부 모델 Sidecar를 켭니다.

> 🔒 API 키를 채팅·커밋·스크린샷·로그에 넣지 마세요. 키는 OS Keychain에만 저장됩니다.

---

## 🧱 아키텍처 한 줄 요약

```
React 렌더러  ──IPC──▶  Electron 메인  ──▶  Codex app-server (순정 thread·turn·tools)
                              │
                              ├─ 로컬 프록시 + reconcile ─▶ 외부 모델 공급자
                              └─ Devil MCP (브라우저 / 컴퓨터 제어 / 사용자 질문)
```

---

## 📄 라이선스

이 저장소의 라이선스 정책은 추후 명시됩니다. © 2026 neneee0181.

<div align="center">
<sub>Codex 호환을 지향하는 비공식 프로젝트입니다. OpenAI와 직접적인 제휴 관계가 없습니다.</sub>
</div>
