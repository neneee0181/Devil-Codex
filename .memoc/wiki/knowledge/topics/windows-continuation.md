---
memoc: true
type: wiki
scope: project-memory
created: 2026-06-26T00:00:00
updated: 2026-06-26T00:00:00
status: active
confidence: high
tags:
  - memoc
  - memoc/wiki
  - memoc/knowledge-wiki
  - memoc/topic
  - windows
  - browser
  - release
---
# Windows 이어가기 (Devil Codex)

Windows 컴퓨터에서 이어서 작업할 때 이 문서부터 읽어라. mac에서 여기까지 했고, 무엇이 되고 무엇을 확인/할지 정리.

## ⮕ Update 2026-06-27 (Windows에서 진행한 것)
- **브라우저**: Windows named pipe end-to-end 검증 완료 (정상 작동).
- **Computer Use = devil-native 자체 구현 완료 (v0.1.16)**. 순정 경로는 호스트 파이프를 순정 데스크톱 GUI 앱만 띄워서 devil 단독 불가(순정 `codex exec`조차 `os error 2`) → nut.js 기반 자체 엔진으로 우회. 상세는 [[milestone-status]] M4-D 절. 파일: `src/main/desktop-control.cts`, `desktop-control-server.cts`(pipe `\\.\pipe\devil-codex-computer`), `scripts/devil-computer-mcp.cjs`, `codex-config.cts`(`[mcp_servers.devil_computer]`). 멀티모니터(sharp 합성)+UTF-16 한글 창 제목+좌표 origin 정규화 포함.
- **타임라인 UI(v0.1.17)**: 툴 스샷/이미지 인라인 + 작업 내레이션 시간순 인라인 + 최종응답만 밖 + 완료 시 자동 접힘.
- 빌드 시 codex CLI 0.142.2 필요(dev는 `DEVIL_CODEX_BIN`로 강제했음; 시스템 PATH에 0.137 남아있으면 sandboxCwd 에러).
- **남은 작업**: UI 화면 다듬기(일반 + Windows 고유 레이아웃 정돈). v0.1.17 푸시 확인.

## 0. 빠른 시작
- 빌드/실행: `npm ci` → `npm run dev`. 빌드 검증: `npm run build`.
- 현재 버전: `package.json` 0.1.15 기준. 릴리스는 **사용자 지시 시에만** (`npm version <x> --no-git-tag-version` → commit → `git tag vX` → `git push origin main && git push origin vX` → GitHub Actions가 mac/win 빌드 + 단일 릴리스 publish).
- 자동업데이트: 앱 우상단 "업데이트" 버튼. Windows는 nsis `oneClick:true` + `quitAndInstall(true,true)`로 **무인 설치+재실행**(확인됨). mac은 zip 받아 quarantine 떼고 교체(확인됨).

## 1. 지금까지 완료 (M1~M4 거의 끝)
- M1~M3 ✅. M4-A 패키징/자동업뎃 ✅. M4-B 서브에이전트+곁가지대화 ✅. M4-C Automations=프롬프트런처 ✅. M4-E Cloud=불가(서버필요).
- **M4-D 브라우저 ✅ 작동** (아래 상세). 상세 구현은 [[m4d-browser-plan]].

## 2. M4-D 내장 브라우저 — 작동함 (Windows에서 검증 필요)
구조: 우측탭 `<webview>`(DOM, 모달 위에 안 가림) + main이 guest WebContents 캡처 + 제어 브리지(유닉스소켓/Windows named pipe `\\.\pipe\devil-codex-browser`) + stdio MCP `scripts/devil-browser-mcp.cjs` + `~/.codex`에 `[mcp_servers.devil_browser]` 등록.
- AI 제어 툴: `browser_navigate/read/screenshot/click/type/key/scroll`. 모델(codex/외부)이 호출 → MCP → 소켓 → 우리 브라우저. **AI 커서**(빨강 40px, 클릭 ripple) 표시.
- 핵심 해결됨: ① MCP elicitation 자동 accept(안 그럼 툴 hang) ② 한글/React 입력=value 직접 설정 ③ Enter=실제 키이벤트+form submit ④ 스크린샷 CSS 1:1 리사이즈(레티나 2x 클릭 어긋남 수정) ⑤ browser_read가 조작요소 selector 목록 반환.
- 파일: `src/main/browser-view.cts`(BrowserViewManager: navigate/aiClick/aiType/aiKey/aiScroll/aiReadText/screenshot/captureRect/waitForLoad + CURSOR_SCRIPT + INTERACTIVE_SCRIPT), `src/main/browser-control-server.cts`(소켓 서버, EADDRINUSE/stale 소켓 정리), `scripts/devil-browser-mcp.cjs`(stdio MCP), `src/main/codex-config.cts`(registerDevilBrowserMcp: command=electron, ELECTRON_RUN_AS_NODE=1, DEVIL_BROWSER_SOCK), `src/renderer/components/ToolContent.tsx`(BrowserPanel UI), `src/main/main.cts`(browserControl.start + browser:activate).

### Windows에서 확인할 것 (우선)
1. **소켓 = Windows named pipe** (`\\.\pipe\devil-codex-browser`). mac은 `~/.codex/devil-browser.sock`. 코드는 platform 분기됨. Windows에서 dev 실행 → 터미널에 `[devil-codex browser] control server on \\.\pipe\...` 뜨는지.
2. codex/deepseek 모델로 `browser_navigate로 naver 열고 browser_read` → 탭 자동으로 뜨고 페이지 읽고 AI 커서 보이는지.
3. **Computer Use 번들 확인** (Windows 고유 — 핵심 미확인 작업):
   ```powershell
   Get-Content "$env:USERPROFILE\.codex\config.toml" | Select-String "computer|node_repl|BROWSER_USE|SkyComputer|plugins"
   Get-ChildItem -Recurse "$env:LOCALAPPDATA" -Filter "*ComputerUse*" -ErrorAction SilentlyContinue | Select FullName
   Get-ChildItem -Recurse "$env:LOCALAPPDATA" -Filter "*cua_node*" -ErrorAction SilentlyContinue | Select FullName
   ```
   - Windows Codex 설치본에 computer-use .exe 번들 있으면 → devil(codex 모델)이 상속해서 화면제어 가능할 수 있음(Windows는 mac TCC 권한 없음). 없으면 → Windows computer-use 불가, 브라우저로 대체.

## 3. 알려진 한계 / 주의
- **codex(gpt-5.5)는 "브라우저 스킬"이라 하면 자기 내장 browser/chrome 스킬을 먼저** 시도(devil엔 iab 백엔드 없어 실패) → 잠깐 헤맨 뒤 우리 devil_browser MCP로 폴백. `--disable in_app_browser` 시도했다가 더 악화돼 **되돌림**. 깔끔히 없애려면 node_repl MCP/browser plugin을 devil app-server에서만 제외해야 하는데 공유 `~/.codex`라 위험 → 보류. 회피: 프롬프트에 "browser_navigate 도구로"처럼 도구명 명시.
- **deepseek 등 외부 모델 = vision 없음** → 스크린샷이 텍스트로 감 → 좌표 클릭 부정확. browser_read의 selector 목록으로 보완. 정밀 작업은 codex 권장.
- 외부 모델 텍스트전용은 이미지 `[이미지 생략됨]`로 치환(`api-key.cts chatContent allowImages`).
- `~/.codex`의 `devil_browser` MCP 블록은 공유라 순정 Codex에도 보임. 순정은 자기 iab 우선이라 거의 안 씀. devil 꺼져있으면 순정에서 호출 시 소켓 없어 에러(무해).

## 4. UI 플랫폼 분기 (방금 작업)
- Windows 창버튼: 우상단 아이콘식(최소화 –/최대화 □/닫기 ✕, 닫기 hover 빨강) = `.win-controls` (`src/renderer/main.tsx` WindowControls, `styles.css`). mac은 네이티브 신호등(좌상단) 유지.
- `app-shell.is-windows .topbar { padding-right:150px }` = 창버튼이 상단 툴바 안 가리게 공간 확보.
- Windows 상단바는 순정 Codex 레이아웃에 맞춰 왼쪽 사이드바/뒤로/앞으로 + 파일/편집/보기/도움말 메뉴, 오른쪽 `다음으로 열기`/하단탭/우측탭/창제어로 분기됨. macOS는 기존 레이아웃 유지.
- `다음으로 열기`는 실제 설치/사용 가능한 앱만 동적으로 표시한다. Windows: VS Code, Visual Studio, Antigravity, GitHub Desktop, File Explorer, Terminal, Git Bash, IntelliJ IDEA, Rider. macOS: VS Code, Finder, Terminal, IntelliJ IDEA.
- 빈 새 채팅(`.../new-chat`, 아직 대화 없음)은 스레드 점 세 개 메뉴를 숨기고 `다음으로 열기`를 비활성화한다. 이 상태에서 pseudo folder를 열려고 하던 `explorer ...\new-chat` 오류를 피한다.

## 5. 릴리스 파이프라인 메모
- `.github/workflows/release.yml`: build job(mac/win, `-p never`, 모든 자산+latest*.yml artifact) + 단일 ubuntu `release` job(`gh release create`). publish race 해결됨.
- mac ad-hoc 서명(`build/after-sign.cjs`)으로 "손상됨" 회피. 첫 설치만 우클릭/설정 또는 `xattr -dr com.apple.quarantine`.
- artifactName=`DevilCodex-${version}-${arch}.${ext}` (공백 없음 — latest.yml 자산명 일치 필수).
- mac dmg+zip 둘 다 빌드(zip=in-app 업데이트용).

## Related
- [m4d-browser-plan](m4d-browser-plan.md)
- [milestone-status](milestone-status.md)
- [handoff](../../../04-handoff.md)
