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
  - m4
  - plan
---
# M4 Implementation Plan — 고급 패리티 (작업 지시서)

> 다음 에이전트가 그대로 이어받아 구현하는 명세. 순서 A→B→C→D→E.
> 단계마다 빌드/검증/커밋. **푸시는 사용자가 명시할 때만.**
> `test*.txt`, `.env.local`, provider token/credential 절대 커밋 금지.
> 배경: [[milestone-status]], [[opencodex-parity-comparison]]. M0~M3 완료·검증됨.

## 0. 공통 규칙 (모든 M4 작업)

```text
- Codex 모델은 프록시 0홉 직통 유지 (M3 불변 제약). 절대 깨지 말 것.
- ~/.codex 직접 쓰기는 승인된 reconcile 레이어(codex-provider-reconcile.cts)만.
- 새 기능은 Codex 데스크톱 패리티 기준으로 구현 (PLANS.md 원칙).
- 플랫폼 종속 코드는 interface 뒤에 분리 (mac 우선, Windows 호환 구조 유지).
- 단계마다 `npm run build` 통과 + 수동 1회 검증 후 커밋.
- 커밋 단위는 작게. 완료/검증된 단위만.
```

검증 한계 메모: computer-use는 `com.openai.codex`(순정 Codex) 창을 읽지 못한다. 순정 Codex UI 확인이 필요한 항목은 사용자 육안 확인으로 남기고 handoff에 기록.

---

## M4-A 패키징 & 배포 (최우선)

목적: `npm run dev` 개발 실행 → 실제 배포 가능한 설치형 앱. 이게 돼야 제품.

### A1. 빌드 도구 도입
- `electron-builder` 추가 (또는 `electron-forge`. builder 권장 — 자동업데이트 연계 쉬움).
- `package.json`에 `build` 설정 블록: appId `com.devilcodex.app`, productName, mac/win target.
- target: mac `dmg` + `zip`(updater용), win `nsis`.
- `npm run dist` 스크립트 추가 (현재 `build`는 tsc+vite만, 패키징 별도).
- 검증: `npm run dist` → `release/`에 `.dmg` 생성.

### A2. app-server 바이너리 전략 (중요 결정)
현재 devil-codex는 설치된 `codex` CLI의 app-server에 의존. 배포하려면 셋 중 택1:
```text
옵션1: codex 바이너리 동봉 (extraResources) — 가장 확실, 용량 큼, 라이선스 Apache-2.0 OK
옵션2: 첫 실행 시 codex 자동 다운로드/설치
옵션3: codex 미설치 시 안내 + 설치 가이드 (의존 유지)
```
- 권장: **옵션1**. `extraResources`로 플랫폼별 codex 바이너리 포함, 실행 시 번들 경로 우선 → 없으면 PATH fallback.
- `app-server.cts`의 codex 실행 경로 해석을 번들 우선으로 수정.
- 주의: 순정 Codex 동기화는 사용자의 `~/.codex`를 공유하므로, 동봉 codex도 같은 `~/.codex`를 보게 둔다.
- 검증: PATH에 codex 없는 상태에서 패키징 앱 실행 → 정상 기동.

### A3. 코드 서명 / notarization
- mac: Developer ID 인증서로 서명 + Apple notarization (`notarytool`). 인증서 없으면 미서명 빌드로 두고 handoff에 "서명 미적용" 명시.
- win: 가능하면 서명, 없으면 미서명.
- credential은 CI secret/환경변수로만. 절대 커밋 금지.

### A4. 자동 업데이트
- `electron-updater` + GitHub Releases provider.
- main에 update check/download/quit-and-install 흐름 + 간단 UI 알림.
- 검증: 버전 올린 더미 릴리스로 업데이트 감지 확인.

### A5. 산출물
- macOS `.dmg` + Windows `.exe` 설치 파일.
- README에 설치/실행 가이드.
- 커밋: `chore(dist): electron-builder packaging`, `feat(dist): bundle codex app-server`, `feat(dist): auto-update`.

완료 기준: 클린 머신에서 설치 → 실행 → Codex 로그인 → 1턴 성공. 외부 모델 1턴 성공.

---

## M4-B Subagents (Codex 패리티 핵심)

목적: Codex의 subagent picker 재현. 작업을 다른 모델/에이전트에 위임.

### B1. app-server subagent 프로토콜 확인
- `codex app-server generate-ts`로 subagent 관련 메서드/이벤트 스키마 확인 (`/private/tmp/...schema`).
- subagent 생성/위임/결과 이벤트가 thread/turn/item 흐름에 어떻게 들어오는지 파악.
- opencodex `featured models` 참고: subagent picker에 routed/native 모델 노출하는 방식.

### B2. featured 모델 선택
- Codex native 모델 + 외부 reconcile 모델(Copilot/Claude)을 subagent 후보로 노출.
- 외부 모델 subagent도 프록시 경로 + reconcile 적용 (M3 흐름 재사용).

### B3. UI
- Codex subagent picker UI 재현 (composer 또는 전용 패널).
- subagent turn이 timeline에 분기로 표시.

검증: subagent 위임 turn 생성 → 결과가 timeline 표시 + 동기화. 외부 모델 subagent도 동작.
커밋: `feat(subagents): codex subagent picker + delegation`.

---

## M4-C Automations

목적: Codex Automations(스케줄/반복 작업) 재현.

### C1. 프로토콜/저장 확인
- Codex automations가 app-server 메서드인지, config/파일 기반인지 확인.
- 없으면 devil-local 스케줄러(electron main `setInterval`/cron 유사) + 트리거 시 thread/turn 실행.

### C2. UI
- automation 목록/생성/편집/삭제. 사이드바 "자동화" 버튼(이미 존재)에 연결.
- 트리거: 시간 기반 우선. 결과는 새 thread 또는 기존 thread turn.

검증: automation 1개 등록 → 트리거 → 결과 thread 생성.
커밋: `feat(automations): scheduled task runner + UI`.

---

## M4-D Browser / Computer Use (무거움 — 후반)

목적: Codex의 브라우저 워크플로 + Computer Use 재현. 플랫폼 종속 큼.

### D1. 인터페이스 분리
- `BrowserService` / `ComputerUseService` interface 정의 (PLANS.md 구조 원칙).
- mac 구현 우선. Windows는 stub + 인터페이스만.

### D2. Browser
- Codex browser 흐름 확인 (headless? 내장 webview? app-server 연동?).
- 내장 Electron `BrowserView`/`webContents` 활용 가능성 검토.

### D3. Computer Use
- 스크린샷/클릭/타이핑 권한 (mac 접근성/화면기록 권한 요청 흐름).
- 안전: 위험 동작은 승인 게이트(기존 approval UI 재사용).

검증: 간단한 브라우저 탐색 1회 + computer-use 클릭 1회.
커밋: `feat(browser): ...`, `feat(computer-use): ...` (분리).

---

## M4-E Cloud / Remote (범위 확정 후)

목적: Codex cloud mode / remote connection.

### E1. 범위 조사
- Codex cloud 흐름이 무엇을 의미하는지 먼저 확인 (remote app-server? cloud thread sync?).
- 조사 결과로 구현 범위 결정 → 별도 계획 문서로 분리 가능.

검증/커밋: 범위 확정 후 정의.

---

## 작업 순서 체크리스트

- [x] 앱 아이콘: `assets/icon.svg` + `scripts/build-icons.cjs`(sharp→icns/ico/png), 런타임 윈도우 + 빌드 설정 적용
- [x] M4-A1 electron-builder 도입 + dist 스크립트 (`dist`/`dist:mac`/`dist:win`, productName "Devil Codex", dmg+zip/nsis, release/, github publish). 미서명 mac arm64 dmg 빌드 검증됨.
- [x] M4-A2 codex 경로 해석 `codexBin()` (DEVIL_CODEX_BIN→번들→PATH).
- [x] M4-A2b mac arm64 codex 동봉 검증 완료 (codex-cli 0.142.0, 독립 실행 OK). 플랫폼별 extraResources (mac=codex, win=codex.exe).
- [x] Windows 빌드 경로 확정: node-pty 크로스컴파일 불가 → `.github/workflows/release.yml`로 OS별 러너(mac/win) 빌드. codex 바이너리는 CI에서 OS별 다운로드(mac aarch64 .zst, win x64 .exe). codex-x86_64-pc-windows-msvc.exe 확보 확인.
- [ ] M4-A2c Windows nsis 실제 빌드 검증 (GH Actions 또는 Windows 머신에서) — 워크플로 트리거 필요
- [x] M4-A3 서명/notarization 스캐폴딩: `build/entitlements.mac.plist`, package.json hardenedRuntime/entitlements, 워크플로 secret 기반 서명+notarize(없으면 미서명). 가이드 [[code-signing-setup]]. ⚠️ 실제 인증서(Apple Developer $99/년 + win 코드서명)는 사용자가 GitHub secret 등록해야 완성.
- [x] M4-A4 업데이트 버튼 모델(인증서 불필요, mac+win 둘 다): 감지는 GitHub releases API 버전 비교(무료). 새 버전 있으면 우상단 topbar에 "업데이트 vX.Y.Z" 버튼. 클릭 → win: electron-updater 인플레이스 설치(미서명 OK), mac: 릴리스 페이지 열어 수동 재설치(미서명 mac은 macOS가 인플레이스 차단). `auto-update.cts`(initAutoUpdate/checkForUpdatesNow/installUpdate), preload/contracts `checkForUpdates`/`installUpdate`/`onUpdateState`, renderer 버튼 + 스타일.
  - 릴리스 방법: package.json version 올림 → `git tag vX.Y.Z` → `git push --tags` → CI 빌드+Release publish → 설치된 앱이 버튼 표시
- [ ] M4-A 완료: 클린 머신 설치→실행→Codex/외부 1턴 (mac ✅ / win 대기)

참고: mac CI는 arm64만 (x64 dmg는 x64 codex 바이너리 추가 필요 — 후순위).
vendor/codex 바이너리(238MB/308MB)는 gitignore, CI/릴리스에서 다운로드.
- [ ] M4-B subagents picker + 위임 + 동기화
- [ ] M4-C automations 스케줄러 + UI
- [ ] M4-D browser / computer-use (인터페이스 분리, mac 우선)
- [ ] M4-E cloud/remote 범위 조사 → 별도 계획

## 시작 전 선행 정리 (M3 잔여)

- [ ] Claude Code `401` 재로그인 후 외부 E2E 1회 (handoff 기록)
- [ ] 순정 Codex 사이드바 외부 thread 육안 확인 (사용자)

## Related

- [Milestone status](milestone-status.md)
- [opencodex comparison](opencodex-parity-comparison.md)
- [PLANS.md](../../../../PLANS.md)
- [Handoff](../../../04-handoff.md)
- [Topics](README.md)
