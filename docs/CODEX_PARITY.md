# Codex 패리티 체크리스트

## 기준

- 기준 화면: 사용자가 2026-06-21 제공한 실제 Codex macOS screenshot
- 기준 기능: 같은 날 받은 공식 Codex App commands, features, settings 문서
- 목표: UI 모양뿐 아니라 navigation, state transition, shortcut, runtime behavior까지 최대한 동일하게 재현

상태 표기:

- ✅ 구현·실행 검증
- 🟡 일부 구현
- ⬜ 미구현
- 🚫 현재 공개 API 또는 플랫폼 제약 확인 필요

## 1. App shell과 navigation

| 항목 | 실제 Codex 기준 | 현재 상태 |
|---|---|---|
| macOS traffic lights와 native titlebar | 좌상단 traffic lights, sidebar 안 back/forward | 🟡 hiddenInset·Codex형 SVG controls 구현, 패키징 검증 남음 |
| Sidebar | `새 채팅`, `검색`, `플러그인`, `자동화`, 프로젝트/thread 목록, 하단 설정 | ✅ 구조·navigation 검증 |
| 프로젝트 그룹 | 폴더별 그룹, thread title, 상대 시간, 접기/펼치기, 더 보기 | ✅ `thread/list`(cwd 무필터)로 모든 Codex 프로젝트를 cwd별 그룹으로 표시·접기/펼치기·thread 열기. 모든 프로젝트 hover ··· 메뉴(Finder·새 채팅)와 삭제하기(폴더 유지, devil-codex 사이드바에서만 숨김, localStorage 영구) 검증 |
| Thread header | title, `...`, editor open dropdown, environment toggle, panel controls | 🟡 dropdown·panel toggle 검증, 일부 panel backend 남음 |
| Back/forward | thread/navigation history | 🟡 SVG control UI, history 동작 남음 |
| Command menu | `Cmd+Shift+P` 또는 `Cmd+K` | ⬜ |
| Sidebar toggle | `Cmd+B` | 🟡 버튼 닫기/복원 검증, 단축키 남음 |

## 2. Thread와 composer

| 항목 | 실제 Codex 기준 | 현재 상태 |
|---|---|---|
| 새 채팅 | sidebar action, `Cmd+N` | 🟡 button/API/shortcut 구현, shortcut live test 남음 |
| Thread 목록 | 실제 app-server thread list | ✅ |
| Thread 재개 | 선택한 기존 thread resume | ✅ `thread/resume` + `thread/read(includeTurns)`로 과거 user/agent와 turn activity 복원 |
| Thread 검색 | 제목·대화 내용·Git branch 검색, `Cmd+G` | ✅ 실제 `thread/search` full-text 검색과 `Cmd+G` 연결 |
| 현재 thread 검색 | `Cmd+F` | ⬜ |
| 보관·복원 | archived thread settings 포함 | ✅ `thread/archive`·`thread/unarchive`, 프로젝트/전체 보관함 연결 |
| 메시지 streaming | agent message delta | ✅ |
| Reasoning/tool/file timeline | Codex item UI 형태 | 🟡 과거·실시간 commentary/reasoning/command/file/MCP/compaction turn UI 구현. 실제 장시간 turn 수동 검증 남음 |
| Composer | 하단 floating composer, attach, mode, model, permission, goal, voice | 🟡 Codex형 추론/모델/속도 picker·승인 정책·목표·파일 경로 첨부 구현. Enter 전송/Shift+Enter 줄바꿈, caret 기준 `$`/`/` picker와 선택 skill 칩 검증. reasoning/speed backend·voice·실제 file content 남음 |
| Slash commands | `/feedback`, `/goal`, `/init`, `/mcp`, `/plan`, `/review`, `/status` | ✅ 7개 command action 연결 |
| Skills invocation | `$` picker | ✅ 실제 `skills/list` 목록·inline chip·`UserInput.skill` turn 실행 |
| Dictation | `Ctrl+M` | ⬜ |

## 3. Environment와 Git

| 항목 | 실제 Codex 기준 | 현재 상태 |
|---|---|---|
| Floating environment card | 오른쪽 상단 floating card | ✅ screenshot 구조와 toggle 검증 |
| 변경 사항 요약 | additions/deletions 및 file diff | ✅ 실제 Git file 목록·additions/deletions·선택 상태 검증 |
| Local/Worktree/Cloud | composer와 환경 card에서 전환 | 🟡 Local + 영구 Git worktree 구현, Cloud는 M4 |
| Branch | 현재 branch 표시·선택 | ✅ local/remote 목록, 생성·전환 |
| Commit/push | environment card에서 실행 | ✅ 선택 file stage/commit(`--only`)/push 사용자 검증 |
| Line-level diff | file 선택, line diff, inline comment | 🟡 unified line diff·line number·inline Codex 의견 전송 구현, split diff와 수동 검증 남음 |
| Stage/revert | file/hunk 단위 | 🟡 file stage/unstage와 hunk stage/revert 구현, Electron 회귀 검증 남음 |
| Pull request | GitHub CLI/연동 | 🟡 feature branch Draft PR 생성(`gh pr create --fill`) 연결, 수동 검증 남음 |
| Integrated terminal | `Cmd+J`, thread/workspace scoped terminal | ✅ workspace shell PTY, `%` 프롬프트 옆 인라인 passthrough 입력(`<pre>`+투명 textarea, xterm 합성 버그 회피), 에코/스크롤백, 한글 IME·방향키·`Ctrl+C`·`clear`·resize, bottom/right 탭 + portal 런처(`+`) 검증 |

## 4. Settings

공식 Codex Settings 기준:

| 설정 영역 | 상태 |
|---|---|
| General | 🟡 Codex형 mode/권한/일반 UI와 로컬 저장, config.toml 핵심 정책 연결 |
| Profile | 🟡 Codex형 profile/activity UI, 실제 계정 데이터 남음 |
| Keyboard shortcuts | 🟡 Codex형 목록 UI와 일부 native menu shortcut |
| Notifications | ⬜ |
| Agent configuration | 🟡 `approval_policy`, `sandbox_mode`, `model` 읽기·보존형 저장 backend |
| Appearance | 🟡 theme/accent/sidebar/contrast UI와 로컬 저장 |
| Codex pets | ⬜ |
| Git | 🟡 category UI |
| Integrations & MCP | ✅ 실제 server/tool/resource/auth 상태와 tool call UI |
| Browser | 🟡 category UI |
| Computer Use | 🟡 category UI |
| Personalization | 🟡 personality/instructions/memory UI와 로컬 저장 |
| Context-aware suggestions | ⬜ |
| Memories | ⬜ |
| Archived threads | ✅ 전체/프로젝트 archive 목록·복원 |

## 5. Codex 기능

| 항목 | 상태 |
|---|---|
| Local thread | ✅ |
| Worktree thread | ✅ Git worktree 목록·생성·workspace 전환 |
| Cloud thread | ⬜ |
| Approvals/sandbox UI | ⬜ |
| Skills | ✅ |
| MCP | ✅ server status/tool call |
| Plugins | 🟡 Skills·MCP 통합 화면, marketplace install은 후속 |
| Automations/thread automations | ⬜ |
| Browser/in-app browser | ⬜ |
| Computer Use | ⬜ |
| Web search | app-server event mapping 필요 |
| Image generation | app-server event mapping 필요 |
| Artifacts/previews | ⬜ |
| Subagents | ⬜ |
| Goal mode | ⬜ |
| Review mode | ⬜ |
| Floating pop-out window | ⬜ |
| IDE/editor open | 🟡 VS Code/Finder/Terminal/IntelliJ 메뉴와 OS IPC 구현, 실제 앱 실행 검증 남음 |
| Deep links | ⬜ |

## 6. Multi-provider 확장

| 항목 | 상태 |
|---|---|
| OpenAI/Codex app-server | ✅ 실제 `gpt-5.4` turn 검증 |
| Provider adapter contract | ⬜ |
| Anthropic API key | ⬜ |
| DeepSeek API key | ⬜ |
| GitHub Copilot | ⬜ |
| OS keychain credential storage | ⬜ |
| Provider별 model/tool capability mapping | ⬜ |

## 현재 가장 큰 UI 차이

1. App shell/sidebar/header/environment/composer의 큰 구조는 실제 screenshot에 맞췄다.
2. 주요 shell/menu/settings 아이콘을 Lucide SVG로 통일했으나 일부 브랜드 아이콘은 호환 가능한 자체 glyph다.
3. 여러 project group, thread overflow, back/forward history는 아직 없다.
4. Settings 핵심 model/approval/sandbox는 `config.toml`과 연결됐고 Integrations/보관함도 실제 backend를 사용한다. 계정·결제·Pets는 후속이다.
5. 검색은 실제 app-server full-text search를 사용한다. 현재 thread 내부 `Cmd+F`는 후속이다.
6. composer는 caret 기준 `$`/`/` skill·command picker, approval 3단계, 전체 권한 경고, goal/attach를 지원한다. voice backend는 아직 없다.
7. 개발 실행에서는 macOS menu bar 앱 이름이 Electron으로 보인다. 패키징된 앱에서 `productName` 검증이 필요하다.
8. 오른쪽과 하단 도크는 독립적인 탭 스트립으로 검토/터미널/브라우저/파일/사이드 채팅을 보존한다. 각각 `+` launcher에서 탭을 추가하고 탭 닫기/전환이 가능하며 동시 표시와 flex 기반 상호 크기 조절을 Electron에서 검증했다.
9. 터미널은 실제 workspace shell PTY 세션, native 명령 입력, 출력 scrollback, `Ctrl+C`, `clear`, 높이 조절을 지원한다. Electron xterm canvas/IME 불안정을 피하기 위해 command-block UI로 렌더링한다. native PTY 불가 환경에서는 pipe shell로 fallback하며 CR을 LF로 변환한다. 브라우저/파일/사이드 채팅 backend는 아직 없다.
10. 오른쪽 또는 하단 검토는 실제 Git 목록·unified line diff·inline comment·file/hunk stage/revert를 지원한다. split diff는 후속이다.
11. 프로젝트 row hover actions, Codex형 프로젝트 메뉴, 프로젝트 기준 새 채팅 화면과 context footer를 구현했다. 첫 메시지가 실제 thread를 시작하고 목록 반영 전 pending row를 유지한다.

## 구현 우선순위

1. App shell visual structure 일치
2. Sidebar navigation과 thread/project UX
3. Search와 Settings
4. Environment/Git card와 line diff
5. Composer mode/model/approval/slash/skills
6. Terminal, approvals, tool/file/reasoning items
7. Plugins, MCP, automations, Browser, Computer Use
8. Multi-provider adapters와 Windows parity

## 검증 방식

- 같은 창 크기로 devil-codex와 실제 Codex screenshot 비교
- 각 sidebar action의 클릭 결과와 back/forward 상태 비교
- 공식 shortcut 목록을 자동·수동 test case로 유지
- app-server event fixture로 thread/turn/item UI replay
- macOS 이후 Windows에서 같은 시나리오 재검증
