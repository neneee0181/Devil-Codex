---
memoc: true
type: wiki
scope: project-memory
created: 2026-07-06T00:00:00
updated: 2026-07-06T00:00:00
status: active
confidence: high
tags:
  - memoc
  - memoc/wiki
  - memoc/project-wiki
  - remote-control
  - memoc/project-doc
---
# 원격 제어(Remote Control) 구현 계획

폰/다른 기기의 브라우저에서 Devil Codex를 원격 조작하는 기능의 **전체 구현 명세**.
아직 미구현. 이 문서만 보고 다른 에이전트가 처음부터 구현할 수 있도록 작성됨.

## 0. 확정된 결정 (사용자 승인 완료, 2026-07-06)

| 항목 | 결정 |
|---|---|
| 접속 방식 | **둘 다** — 기본은 Tailscale tailnet 전용, 설정에서 Tailscale Funnel(공개 URL) opt-in |
| 모바일 UI 범위 | **핵심만** — 스레드 목록 · 대화 보기 · 메시지 전송 · 승인 응답 · 사용량. 터미널/브라우저뷰/git 패널/워크트리는 데스크톱 전용 유지 |
| 네이티브 앱 | 안 만듦. 폰은 브라우저(PWA)로 접속. iOS 개발자 계정 불필요 |
| 런타임 커버 | claude-code 모드 + codex 모드 **둘 다 자동 지원** (아래 1장 근거) |

## 1. 왜 이 구조가 두 런타임을 자동 커버하는가

Devil renderer는 main 프로세스와 **오직 `window.devilCodex` (preload IPC)로만** 통신한다.

- 요청: `ipcMain.handle(channel, fn)` ~100개 (전체 목록 3.2절)
- 이벤트(main→renderer): `sendToRenderer(channel, payload)` 6채널 + preload 전용 4채널 (3.3절)
- claude-code든 codex든 renderer 입장에선 같은 채널(`thread:*`, `turn:send`, `approval:respond`, `app-server:event`)을 쓴다. 런타임 분기는 main 내부(`requestedRuntime()`)에서 일어남.

→ IPC 표면을 WebSocket으로 브릿지하면 원격 클라이언트도 로컬 renderer와 동일 능력을 갖는다. 런타임별 추가 작업 0.

## 2. 아키텍처

```
[폰 브라우저 (모바일 웹 UI)]
   │  HTTPS (정적 파일) + WSS (IPC 브릿지)
   ▼
[Tailscale 터널]  ← tailnet(사설) 또는 Funnel(공개)
   ▼
[Electron main: remote-server.cts]
   ├─ HTTP: 모바일 웹 빌드 서빙 (dist-mobile/)
   ├─ WS:   JSON 프로토콜 ↔ 기존 IPC 핸들러 호출
   ├─ 인증: 토큰 + 기기 승인 + rate limit
   └─ 이벤트 팬아웃: sendToRenderer 가로채서 WS 클라이언트에도 방송
```

## 3. 구현 단계 (순서대로)

### 3.1 단계 1 — IPC 핸들러 레지스트리 리팩터 (`src/main/main.cts`)

현재 `main.cts`의 `registerIpcHandlers()` 안에 `ipcMain.handle("채널", fn)`이 인라인으로 ~100개 등록됨.
WS에서도 같은 핸들러를 호출하려면 **핸들러 Map을 먼저 만들고, ipcMain과 WS 양쪽에 등록**하는 구조로 바꾼다.

```ts
// main.cts 상단
const ipcHandlers = new Map<string, (input: unknown) => Promise<unknown> | unknown>();

function handle(channel: string, fn: (input: unknown) => Promise<unknown> | unknown): void {
  ipcHandlers.set(channel, fn);
  ipcMain.handle(channel, (_event, input) => fn(input));
}
```

- 기존 `ipcMain.handle("thread:list", async (_event, input) => ...)` 전부를 `handle("thread:list", async (input) => ...)`로 기계적 치환. `_event` 파라미터를 쓰는 핸들러는 없는지 확인 필요(현재 전부 `_event` 무시 패턴).
- `remote-server.cts`는 `ipcHandlers` Map을 주입받아 호출.
- **원격 차단 채널**(화이트리스트 방식 권장): 원격에서 허용할 채널만 명시. 핵심-만 범위이므로 초기 허용 목록:
  - `thread:list`, `thread:read`, `thread:create`, `thread:resume`, `thread:projects`, `thread:search`
  - `turn:send`, `turn:interrupt`
  - `approval:respond`, `ask:respond`
  - `runtime:status`, `runtime:connect`
  - `providers:usage`, `providers:load`, `settings:load`
  - `codex:models`, `claude:slash-commands`(메뉴 표시용)
  - 나머지(`workspace:*`, `terminal:*`, `browser:*`, `clipboard:*`, `update:*`, `providers:save-key` 등)는 **원격 거부** — 파일시스템/키 노출 방지.

### 3.2 참고 — 전체 IPC 채널 인벤토리 (2026-07-06 기준)

`app:*`(6) `approval:respond` `ask:respond` `browser:*`(19) `chat:new-chat-cwd` `claude:mcp-list/skills/slash-commands` `clipboard:*`(2) `codex:models/plugin-skills` `feedback:upload` `file:preview-image` `mcp:call/list` `providers:*`(12) `runtime:connect/status` `settings:load/save` `skills:list` `subagent:info` `terminal:*`(5) `thread:*`(13) `translate:text` `turn:interrupt/send` `update:check/install` `workspace:*`(18)

### 3.3 이벤트 채널 (main → renderer, 원격에도 방송할 것)

| 채널 | 원격 방송 | 비고 |
|---|---|---|
| `app-server:event` | ✅ | 턴 스트리밍/승인 요청 전부 이 채널. 핵심 |
| `app-server:status` | ✅ | 런타임 상태 |
| `provider:usage-changed` | ✅ | 사용량 갱신 |
| `provider:auth` | ✅ | 로그인 상태 표시용 |
| `ask:request` | ✅ | devil_ask 질문 모달 → 폰에서도 응답 가능해야 |
| `app:command`, `terminal:data`, `browser:state`, `browser:activate`, `update:state` | ❌ | 데스크톱 전용 |

구현: `sendToRenderer()` (main.cts:618)에 후킹.

```ts
function sendToRenderer(channel: string, payload: unknown): void {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, payload);
  remoteServer?.broadcast(channel, payload); // 추가. 내부에서 허용 채널 필터
}
```

주의: `ask-control-server.cts`의 `ask:request`는 sendToRenderer 경유인지 별도 경로인지 구현 시 확인 후 동일 후킹.

### 3.4 단계 2 — `src/main/remote-server.cts` (신규)

Node `http` + `ws` 패키지(신규 devDep 아님, dependencies에 `ws` 추가; Electron main에서 사용).

**HTTP 라우트**
- `GET /` 및 정적 파일 → `dist-mobile/` 서빙 (mime 몇 개만 수동 매핑: html/js/css/svg/png/woff2)
- `GET /healthz` → `{ ok: true, version }`
- 그 외 404. 디렉토리 트래버설 방지: `path.normalize` 후 루트 밖이면 403.

**WS 프로토콜** (`/ws` 경로, 텍스트 JSON)
```jsonc
// 클라 → 서버
{ "type": "auth",   "token": "<hex64>", "deviceId": "<uuid>", "deviceName": "iPhone Safari" }
{ "type": "call",   "id": 17, "channel": "thread:list", "input": { ... } }
// 서버 → 클라
{ "type": "auth-ok" } | { "type": "auth-pending" } | { "type": "auth-denied", "reason": "..." }
{ "type": "result", "id": 17, "ok": true,  "value": ... }
{ "type": "result", "id": 17, "ok": false, "error": "메시지" }
{ "type": "event",  "channel": "app-server:event", "payload": ... }
```
- `auth` 전의 `call`은 즉시 소켓 종료.
- `call` 처리: 허용 채널 검사 → `ipcHandlers.get(channel)(input)` → try/catch로 result 응답.
- 에러 객체는 `String(error)`만 전달 (스택/경로 노출 금지).

**클래스 골격**
```ts
export class RemoteServer {
  constructor(private options: {
    handlers: Map<string, (input: unknown) => Promise<unknown> | unknown>;
    allowedChannels: Set<string>;
    allowedEvents: Set<string>;
    auth: RemoteAuthStore;          // 단계 3
    onDeviceApprovalNeeded: (device: { deviceId: string; deviceName: string }) => Promise<boolean>;
    staticDir: string;              // dist-mobile 경로
  }) {}
  async start(input: { host: string; port: number }): Promise<{ port: number }> {}
  broadcast(channel: string, payload: unknown): void {}   // allowedEvents 필터 포함
  listClients(): Array<{ deviceId: string; deviceName: string; connectedAt: number }> {}
  disconnect(deviceId: string): void {}
  async stop(): Promise<void> {}
}
```

**바인딩 호스트**
- tailnet 모드: Tailscale 인터페이스 IP(100.64.0.0/10 대역)에만 bind. 탐지: `os.networkInterfaces()`에서 100.64/10 주소 검색. 없으면 시작 거부 + "Tailscale 설치/로그인 필요" 에러.
- Funnel 모드: `127.0.0.1` bind (Funnel이 localhost로 프록시하므로 외부 직접 노출 없음).

### 3.5 단계 3 — 인증 (`src/main/remote-auth.cts` 신규)

보안 요구사항 (Funnel = 공개 인터넷 노출이므로 아래는 필수, 협상 불가):

1. **토큰**: `crypto.randomBytes(32).toString("hex")`. `app.getPath("userData")/remote-auth.json`에 저장 (Electron `safeStorage.encryptString` 사용 가능하면 암호화 저장, 불가 플랫폼은 평문 파일 + 파일 권한). "토큰 재발급" 버튼 → 즉시 전 기기 무효화.
2. **QR 내용**: `https://<host>:<port>/#t=<token>` — token은 **URL fragment**로 넣는다. fragment는 HTTP 요청에 포함되지 않아 서버/프록시 로그에 남지 않음. 모바일 웹이 로드 후 fragment에서 읽어 `location.hash` 지우고 sessionStorage 보관.
3. **기기 승인**: 처음 보는 `deviceId`가 올바른 토큰으로 auth 시도 → `auth-pending` 응답 → PC에서 `dialog.showMessageBox` "iPhone Safari 기기의 원격 접속을 허용할까요?" → 허용 시 `remote-auth.json`의 `devices[]`에 `{ deviceId, deviceName, approvedAt }` 저장, `auth-ok`. 거부 시 `auth-denied` + 소켓 종료.
4. **Rate limit**: IP별 auth 실패 5회/10분 → 해당 IP 1시간 차단 (in-memory Map이면 충분).
5. **원격 세션은 승인 권한 있음**: `approval:respond`가 원격에서 오면 로컬과 동일 처리. 단, bypass 권한 상승(`providers:save-key`, `settings:save` 등)은 허용 채널에서 제외했으므로 원격으로 못 함.

### 3.6 단계 4 — Tailscale 연동 (`src/main/tailscale.cts` 신규)

전부 Tailscale CLI 호출(`execFile`)로 구현. SDK 의존성 없음.

- 탐지: `tailscale status --json` — 성공+`Self.Online:true`면 사용 가능. 실패면 설치 안내 URL(`https://tailscale.com/download`) 반환.
- 주소: status JSON의 `Self.DNSName`(MagicDNS, 예 `devil-pc.tailXXXX.ts.net.`) 및 `Self.TailscaleIPs[0]`.
- TLS 인증서: `tailscale cert --cert-file <p> --key-file <p> <dnsname>` → HTTPS 서버에 사용. PWA/클립보드 API에 secure context 필요하므로 가능하면 항상 사용. cert 실패(HTTPS 미활성 tailnet)면 HTTP로 폴백하고 UI에 경고 표시.
- Funnel: 켜기 `tailscale funnel --bg <port>`, 끄기 `tailscale funnel --https=443 off`. 사전 조건(테일넷 정책에서 Funnel 허용)이 필요하므로 명령 실패 시 stderr를 그대로 설정 UI에 노출.
- Windows 경로: `tailscale`이 PATH에 없으면 `C:\Program Files\Tailscale\tailscale.exe` 폴백.

### 3.7 단계 5 — 모바일 웹 UI (`src/mobile/` 신규 + `vite.mobile.config.ts`)

기존 renderer(main.tsx 4700줄)는 데스크톱 전제라 그대로 못 씀. **경량 신규 엔트리**를 만들고 파싱 로직만 재사용.

- 재사용: `src/renderer/threadTimeline.ts`(이벤트→타임라인 변환), `src/shared/contracts.ts`, `src/renderer/providerPricing.ts`, `approvalRequests.ts`
- 신규: `src/mobile/main.tsx`, `src/mobile/ws-bridge.ts`, `src/mobile/index.html`, PWA manifest + 아이콘
- `ws-bridge.ts`: `window.devilCodex` 인터페이스 중 허용 채널 부분집합만 구현. 골격:

```ts
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
let nextId = 1;
// call(channel, input): ws.send({type:"call", id, channel, input}) → pending에 Promise 등록
// onmessage: result → pending resolve/reject, event → listeners 팬아웃
// 재연결: exponential backoff(1s→30s), 재연결 시 auth 재수행 + 활성 스레드 thread:read로 재동기화
```

- 화면 4개: ① 프로젝트/스레드 목록 ② 대화(타임라인 스트리밍 + 하단 입력) ③ 승인 모달(전면 시트) ④ 사용량 요약. 라우팅은 해시 기반(추가 라이브러리 없이).
- 빌드: `vite.mobile.config.ts` → `dist-mobile/` 출력. `package.json` scripts에 `"build:mobile": "vite build -c vite.mobile.config.ts"` 추가, `build` 체인에 포함. electron-builder `files`에 `dist-mobile/**` 추가.

### 3.8 단계 6 — 설정 UI (`src/renderer/SettingsView.tsx` + main IPC 추가)

신규 IPC 채널 (로컬 renderer 전용, 원격 허용 목록에 넣지 말 것):
- `remote:status` → `{ enabled, mode: "tailnet"|"funnel", url, tailscale: { installed, online, dnsName }, devices: [...], clients: [...] }`
- `remote:enable` `{ mode }` / `remote:disable`
- `remote:regenerate-token`
- `remote:revoke-device` `{ deviceId }`

설정 화면 "원격 제어" 섹션:
- on/off 토글, 모드 선택(tailnet/Funnel), 상태 표시
- QR 코드 렌더 — deps에 `qrcode` 추가, main에서 `QRCode.toDataURL(url)` 생성해 renderer에 전달 (renderer 번들 비대 방지)
- 승인된 기기 목록 + 해지 버튼, 현재 접속 중 클라이언트 표시
- Funnel 켤 때 경고문: "공개 URL이 생성됩니다. QR/URL을 아는 사람은 접속을 시도할 수 있습니다."
- Tailscale 미설치 시: 다운로드 링크 + 재확인 버튼

### 3.9 단계 7 — 수명주기 연결

- `main.cts` `before-quit`: `remoteServer?.stop()` 추가 (claudeRuntime.disposeAllInstances() 옆)
- 앱 시작 시: 설정에 enabled 저장돼 있으면 자동 시작. 시작 실패(Tailscale 다운 등)는 앱 부팅을 막지 말고 상태만 표시
- 절전/네트워크 변경: WS 클라이언트 쪽 재연결 로직이 담당. 서버는 heartbeat ping 30초, 2회 무응답 소켓 정리

## 4. 파일 변경 요약

| 파일 | 작업 |
|---|---|
| `src/main/remote-server.cts` | 신규 — HTTP+WS 서버, 브릿지, 방송 |
| `src/main/remote-auth.cts` | 신규 — 토큰/기기/rate limit 저장소 |
| `src/main/tailscale.cts` | 신규 — CLI 래퍼 (status/cert/funnel) |
| `src/main/main.cts` | handle() 레지스트리 치환, sendToRenderer 후킹, remote:* IPC, before-quit |
| `src/main/preload.cts` + `contracts.cts` + `src/shared/contracts.ts` | remote:* API 타입 추가 |
| `src/mobile/*` | 신규 — 모바일 웹 앱 |
| `vite.mobile.config.ts` | 신규 |
| `src/renderer/SettingsView.tsx` | 원격 제어 섹션 |
| `package.json` | deps: `ws`, `qrcode`; scripts: `build:mobile`; electron-builder files |

## 5. 테스트 계획

1. 단위: RemoteServer에 가짜 handlers Map 주입 → call/result, 허용 외 채널 거부, auth 전 call 거부, rate limit
2. 로컬 통합: `127.0.0.1`로 띄우고 PC 브라우저에서 모바일 UI 접속 → 스레드 목록/턴 전송/스트리밍/승인 응답 (claude + codex 모드 각각)
3. 실기기: 폰 Tailscale 설치 → QR → 대화 왕복. Funnel 켜고 LTE(비-tailnet)에서 접속
4. 보안: 잘못된 토큰 5회 → 차단 확인. 미승인 deviceId → pending. `workspace:read-file`을 원격 call로 보내 거부되는지 확인
5. 회귀: 원격 off 상태에서 기존 데스크톱 기능 전부 정상 (핸들러 레지스트리 리팩터가 유일한 기존 코드 변경점)

## 6. 리스크 / 주의

- **핸들러 레지스트리 리팩터가 가장 넓은 변경** — ~100개 치환. 기계적이지만 `_event`를 실제 사용하는 핸들러가 있는지 반드시 grep (`ipcMain.handle` 콜백에서 `_event` 외 이름 사용 여부).
- `app-server:event`는 원격에 그대로 방송해도 안전 (파일 내용은 diff 요약 수준) — 단 승인 요청 payload에 명령 전문 포함, 이는 의도된 것.
- 모바일 동시 접속 + 데스크톱 조작 시 상태 경합: 양쪽 다 `app-server:event` 수신하므로 타임라인은 수렴. 낙관적 UI(스레드 제목 등)는 폰에선 생략해 단순화.
- Electron `safeStorage`는 Linux 일부 환경에서 불가 → 폴백 경로 필수.
- `ws` 패키지는 main 번들(tsconfig.electron.json) 대상 — CJS require 호환 확인.

## Related

- [Project Wiki](README.md)
- [Current Project State](../../02-current-project-state.md)
- [Decisions](../../03-decisions.md)
- [Handoff](../../04-handoff.md)
