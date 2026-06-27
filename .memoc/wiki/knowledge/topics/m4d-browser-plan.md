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
  - m4
  - browser
  - computer-use
---
# M4-D 브라우저 / Computer Use 진행 상황 + 이어가기

Devil Codex에 순정 Codex의 "브라우저"(in-app browser, iab) + computer-use를 이식하는 작업.

## 1. 배경 / 핵심 결론

- 순정 Codex의 브라우저/computer-use는 **Codex 데스크톱 앱 전용 인프라**(`cua_node` node_repl MCP + iab/chrome 백엔드 + `SkyComputerUse*` 네이티브)에 묶여 있어 devil-codex(별도 Electron)에선 안 붙음. `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S` 해시 화이트리스트까지 있어 순정 pipe에 우리 클라이언트 못 붙임.
- 외부 모델(deepseek 등)이 프록시 통해 순정 브라우저 MCP를 호출해도 실행 루프는 Codex app-server 소유 → 결국 같은 백엔드라 실패.
- **해결 = devil 자체 브라우저(WebContentsView/webview) + 자체 제어 + 자체 MCP.** 순정 백엔드 우회. → 아래가 그 구현.

## 2. 완료된 것 (코드, main 커밋됨)

### 1단계 — 내장 브라우저 UI ✅
- `src/main/browser-view.cts` `BrowserViewManager`: guest WebContents 보유(렌더러 `<webview>`를 main이 `did-attach-webview`로 캡처). navigate/back/forward/reload/stop/state.
- 렌더러 `src/renderer/components/ToolContent.tsx` `BrowserPanel`: 우측탭 "브라우저"에 `<webview partition="persist:devil-browser">` + 주소창/네비. **DOM 요소라 모달/팝오버가 z-index로 위에 뜸**(네이티브 WebContentsView 폐기 — 항상 위로 떠서 모달 가렸음).
- resize 중 webview `pointer-events:none`(드래그 끊김 방지).

### 주소창 도구 3종 ✅ (순정 동일)
- 스크린샷(ScanLine): `capturePage` → composer에 이미지 주입(`onBrowserAsk`→`composerInject`→Composer `inject` prop).
- 요소 선택(MessageSquarePlus): **DevTools식** — renderer `<webview>.executeJavaScript(INSPECTOR_SCRIPT)`로 hover 하이라이트 + 클릭 선택 → `browser:capture-rect`로 요소 crop → composer. 버튼 재클릭/ESC 취소(`window.__devilCancelPick`).
- ⋮ 메뉴: 강제 새로고침/페이지에서 찾기(findInPage)/확대축소(zoom)/쿠키·캐시 지우기.

### 2단계 — AI 제어 엔진 + 커서 ✅
- `BrowserViewManager`: `aiClick({x,y|selector})`(selector면 scrollIntoView 후 중앙), `aiType`, `aiKey`, `aiScroll`, `aiReadText`(8000자). 실제 `wc.sendInputEvent`로 조작.
- **AI 커서**: `CURSOR_SCRIPT`를 페이지에 주입(빨간 포인터 SVG + 0.4s glide + 클릭 ripple, 페이지 로드마다 재주입). 순정처럼 AI 움직임 보임.
- IPC/preload: `browserAiClick/Type/Key/Scroll/Read` (devtools 콘솔로 수동 테스트 가능).

### 배포 / 자동업데이트 — ✅ 동작 확인 (2026-06-26, v0.1.10)
릴리스/자동업뎃이 v0.1.1~0.1.8 동안 여러 버그로 깨졌다가 정리됨:
- **mac ad-hoc 서명**(`build/after-sign.cjs`, `afterSign` 훅): 미서명 arm64 = "손상됨"(강제 휴지통) → ad-hoc 서명으로 완화. 단 최신 macOS는 우클릭→열기 막음 → 첫 설치만 `xattr -dr com.apple.quarantine` 또는 시스템설정 "확인 없이 열기" 1회.
- **mac in-app 업데이트**(`auto-update.cts` `installMacUpdate`): 인증서 없이도 됨. 업뎃 버튼 → 릴리스 `.zip`(arch 매칭) 다운 → 압축해제 → quarantine 제거 → detached 스크립트가 종료 대기→번들 교체→quarantine 재제거→재실행. **첫 설치만 수동, 이후 버튼 한 번.** mac에 `zip` 타깃 필수(package.json mac.target에 dmg+zip).
- **이름 공백 버그**: `productName "Devil Codex"`(공백)을 GitHub/electron-builder가 들쭉날쭉 변환(점 vs 대시) → win latest.yml ↔ 자산 불일치 404 → fallback. **수정 = `artifactName "DevilCodex-${version}-${arch}.${ext}"`(공백 없음).** latest.yml/latest-mac.yml ↔ 자산 일치.
- **release publish race**: 러너별 `-p always`가 같은 GitHub Release 동시 생성 → 422 + latest.yml 누락. **수정 = 빌드는 `-p never`, 별도 ubuntu `release` job이 양쪽 artifact 다운로드 후 `gh release create`로 릴리스 1개 생성**(latest*.yml 포함). `.github/workflows/release.yml`.
- 검증: 0.1.9 수동 설치 → 0.1.10 **업데이트 버튼 자동 성공**(mac). win도 latest.yml 일치로 자동.
- **릴리스 절차(사용자 지시 시만)**: `npm version <x> --no-git-tag-version` → 커밋 → `git tag vX` → `git push origin main && git push origin vX` → Actions가 mac/win 빌드 + 단일 릴리스. 사용자는 앱 업데이트 버튼. **자동 버전업 금지(사용자가 "올려" 할 때만).**

### 3단계 — devil_browser MCP ✅ (작동 확인 중)
- MCP 등록+호출 확인됨(채팅에 `browser_navigate 실행` 카드 뜸). 
- **자동 탭 열기**(v0.1.10): AI 브라우저 툴 호출 시 control server가 `browser:activate` → 렌더러가 우측탭 브라우저 자동 오픈(webview 마운트). navigate는 guest 없으면 URL 큐잉 후 attach 시 로드. → 모델이 `browser_navigate` 하면 탭 뜨고 페이지 보임.
- 외부 모델(deepseek) 이미지 깨짐 수정(v0.1.8): 텍스트전용 모델엔 image_url→`[이미지 생략됨]` 텍스트(`api-key.cts chatContent allowImages`). deepseek도 browser tool 사용 가능.
- 현재 사용자 테스트 중: deepseek/codex로 browser_navigate+read, AI 커서 보이나.

### (구) 3단계 — devil_browser MCP ✅
- `src/main/browser-control-server.cts` `BrowserControlServer`: 127.0.0.1:**49874** HTTP 브리지 → BrowserViewManager. routes: /navigate /click /type /key /scroll /read /screenshot /state.
- `scripts/devil-browser-mcp.cjs`: **stdio JSON-RPC MCP**(newline-delimited). tools: `browser_navigate/read/screenshot/click/type/key/scroll`. 호출 시 49874로 HTTP 포워딩.
- `src/main/codex-config.cts` `registerDevilBrowserMcp({execPath, script, port})`: `~/.codex/config.toml`에 관리 블록 `# >>> devil-codex browser mcp (managed) >>>` / `[mcp_servers.devil_browser]` (command=Electron execPath, `ELECTRON_RUN_AS_NODE=1`, args=[script], `DEVIL_BROWSER_PORT=49874`). `unregisterDevilBrowserMcp`도 있음.
- `main.cts` `startCodexProxy()`에서 `browserControl.start()` + `registerDevilBrowserMcp` 호출. 스크립트 경로: packaged=`process.resourcesPath/scripts/...`, dev=`__dirname/../scripts/...`.
- electron-builder `extraResources`(mac+win)에 `scripts/devil-browser-mcp.cjs` 동봉.

→ 흐름: 모델(codex/외부) `browser_*` 호출 → Codex app-server → MCP 스크립트 → HTTP → 우리 브라우저(커서 보이며). **codex+외부 둘 다 커버**(별도 4단계 불필요).

### 테스트 방법 (미완)
- `npm run dev` 재시작(2번 — 1번째에 config 블록 생성, 2번째에 내장 app-server가 그 블록 읽어 툴 노출).
- codex 모델로: "browser_navigate로 naver.com 열고 browser_read 해줘" / "검색창 클릭하고 햇밀정원 입력".
- 확인: 툴 호출 카드 뜨나, 우측탭 브라우저 실제 조작되나, 빨간 AI 커서 보이나.
- 검증 포인트: `~/.codex/config.toml`에 `devil_browser` 블록 있나, 내장 app-server가 MCP 인식하나.

## 3. 남은 것 — Windows computer-use (화면 전체 제어)

### 현황
- 브라우저 제어(위 1~3단계)는 **OS 무관** → Windows도 됨.
- **computer-use(화면 직접 제어)**: mac은 `Codex Computer Use.app`+`SkyComputerUse*`(네이티브 .app, macOS 전용) + TCC 권한 필요(미서명이라 errAETimeout). Windows 가능 여부 = **Windows Codex 설치본에 computer-use 번들(.exe)이 있는지에 달림** — mac에선 확인 불가.

### Windows에서 이어서 할 일 (단계)
1. **번들 존재 확인** (PowerShell):
   ```powershell
   Get-Content "$env:USERPROFILE\.codex\config.toml" | Select-String "computer|node_repl|BROWSER_USE|SkyComputer|plugins"
   Get-ChildItem -Recurse "$env:LOCALAPPDATA" -Filter "*ComputerUse*" -ErrorAction SilentlyContinue | Select FullName
   Get-ChildItem -Recurse "$env:LOCALAPPDATA" -Filter "*cua_node*" -ErrorAction SilentlyContinue | Select FullName
   ```
   - Codex 설치 루트(보통 `%LOCALAPPDATA%\Programs\@openai\codex\` 또는 유사) 안 `plugins\openai-bundled\plugins\computer-use\`, `cua_node\` 찾기.
2. **번들 있으면**: mac 패턴 그대로 → `~/.codex/config.toml`의 `[mcp_servers.node_repl]` + `[plugins."computer-use@openai-bundled"]`가 Windows 경로/exe로 잡혀 있을 것. devil-codex는 **같은 ~/.codex + 같은 codex 바이너리**를 쓰므로 codex 모델이면 그 computer-use MCP를 자동 상속 → 추가 구현 거의 불필요. 확인: devil에서 codex 모델로 computer-use 프롬프트 → 동작 여부. mac과 달리 Windows는 TCC 권한 없음(접근성/화면기록 다이얼로그 없음) → 권한 문제 없이 될 가능성.
3. **번들 없으면(mac 전용)**: 순정 computer-use 불가. 대안 = devil 자체 화면제어 구현(robotjs/nut.js 같은 네이티브 입력 + 스크린 캡처를 MCP로). 큰 작업. 우선순위 낮음. 브라우저로 대부분 대체.
4. 결과(config 내용 + 파일 경로) 확보 후 판단 → 있으면 상속 검증, 없으면 자체 구현 여부 결정.

### computer-use 권한 안내 (이미 구현됨)
- 실패(errAETimeout/aborted/extension) 감지 시 배너 + 딥링크(`app:open-permission`: 손쉬운사용/화면기록/자동화 pane, chrome web store). mac 미서명은 권한 켜도 막힐 수 있음(서명 필요).

## 4. 결론 (확정)
- **M4-E Cloud**: ❌ 불가. Codex 스키마에 cloud/remote/task 메서드 없음(=ChatGPT 백엔드 기능). 자체 서버 없이는 불가. 스킵.
- **M4-D 브라우저**: ✅ 구현 완료(자체 webview+MCP), 테스트만 남음. codex+외부 모델 둘 다.
- **M4-D computer-use**: mac=권한/미서명 한계, **Windows=번들 확인 후 결정**(위 3절).

## Related
- [Milestone status](milestone-status.md)
- [Handoff](../../../04-handoff.md)
