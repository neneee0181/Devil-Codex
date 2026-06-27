---
memoc: true
type: wiki
scope: project-memory
created: 2026-06-25T00:00:00
updated: 2026-06-27T17:31:01
status: active
confidence: high
tags:
  - memoc
  - memoc/wiki
  - memoc/knowledge-wiki
  - memoc/topic
  - opencodex
  - parity
---
# opencodex 대비 devil-codex 패리티 비교

레퍼런스: `lidge-jun/opencodex` (MIT). devil-codex가 변환 로직을 포팅한 기준.
참고: [[milestone-status]].

## 0. 근본 구조 차이 (가장 중요)

| | opencodex | devil-codex |
|---|---|---|
| 형태 | standalone 프록시 CLI/서비스 | Electron 앱 **내장** 프록시 |
| Codex 연결 | `~/.codex` config 주입, **root provider 통째 교체** | per-thread `modelProvider:"devil"` + 사후 reconcile |
| Codex 모델 | 프록시 1홉 통과 (전 모델 프록시) | **프록시 0홉 직통 (순정 동일)** |
| 동기화 방식 | root provider 단일화로 자연 노출 | 외부 turn만 devil→openai reconcile |
| 종료 후 | `ocx stop`으로 config 원복 | 앱 종료 시 reconcile 완료분만 순정 유지 |

→ devil-codex가 "순정 Codex byte-for-byte 직통" 요구를 **더 잘 만족**. opencodex는 그 분리 모드 없음.

## 1. 파일 매핑

| opencodex | devil-codex | 상태 |
|---|---|---|
| `adapters/anthropic.ts` | `proxy/anthropic.cts` | ✅ |
| `adapters/openai-chat.ts` | `proxy/api-key.cts` (openai/deepseek) + `proxy/copilot.cts` | ✅ |
| `adapters/google.ts` | `proxy/api-key.cts` (gemini) | ✅ |
| `adapters/openai-responses.ts` | `proxy/proxy-server.cts` raw passthrough | ✅ |
| `adapters/azure.ts` | — | ❌ 없음 |
| `adapters/image.ts` | `proxy/vision-sidecar.cts` | ✅ (방식 다름) |
| `bridge.ts` | `proxy/bridge.cts` | ✅ (포팅) |
| `responses/parser.ts` | `proxy/parser.cts` | ✅ |
| `errors.ts` | `proxy/errors.cts` | ✅ |
| `web-search/*` (executor/loop/parse/synthetic-tool) | `proxy/web-search-sidecar.cts` (단일파일) | ✅ |
| `vision/describe.ts` | `proxy/vision-sidecar.cts` | ✅ |
| `oauth/anthropic.ts`,`pkce.ts`,`store.ts`,`callback-server.ts` | `provider-oauth.cts` | ✅ |
| `oauth/local-token-detect.ts` | `provider-oauth.cts` (macOS keychain import) | ✅ |
| `oauth/xai.ts`,`oauth/kimi.ts` | — | ❌ 없음 |
| `codex-catalog.ts` | `provider-model-catalog.cts` | ✅ |
| `codex-history-provider.ts` | `provider-transcript.cts` | ✅ |
| `codex-inject.ts` | **의도적 미사용** (금지) → `codex-provider-reconcile.cts` | ⚠️ 대체 |
| `providers/registry.ts` | `provider-settings.cts` + shared API provider config/catalog | 🟡 key/local subset expanded |
| `model-cache.ts` | `api-key.cts` 내 short cache | ✅ |
| `router.ts`/`server.ts`/`service.ts` | `proxy/proxy-server.cts` + `main.cts` | ✅ |
| (Codex 자체 GUI 없음, dashboard만) | **전체 Codex 데스크톱 UI 재현** | ➕ devil 우위 |

## 2. 기능 비교

| 기능 | opencodex | devil-codex |
|---|---|---|
| Anthropic Messages 변환 | ✅ | ✅ |
| OpenAI Chat 변환 (40+ compat) | ✅ 40+ | 🟡 core key/local subset: OpenAI, DeepSeek, xAI, OpenRouter, Groq, Mistral, Cerebras, Together, Fireworks, Moonshot, Hugging Face, NVIDIA, Ollama, vLLM, LM Studio |
| Google Gemini 변환 | ✅ | ✅ (schema sanitize 포함) |
| Azure 변환 | ✅ | ❌ |
| OpenAI Responses passthrough | ✅ | ✅ |
| 툴콜/reasoning/이미지 양방향 | ✅ | ✅ |
| 웹검색 sidecar (gpt-5.4-mini) | ✅ | ✅ tool-loop |
| vision sidecar | ✅ | ✅ |
| OAuth (Anthropic) | ✅ | ✅ |
| OAuth (xAI, Kimi) | ✅ | ❌ |
| OAuth (GitHub Copilot device) | ❌ | ✅ (devil 우위) |
| 모델 자동 discovery (/models) | ✅ | ✅ |
| live request log / 진단 | ✅ dashboard | ✅ Settings→연결 |
| 40+ provider 카탈로그 | ✅ | 🟡 safe opencodex key/local subset added; rcodex free-tier/special providers not all ported |
| background service (launchd 등) | ✅ | ❌ (앱 프로세스) |
| 클린 종료/config 원복 | ✅ | ✅ (reconcile + 미주입) |
| **순정 Codex 직통 분리 모드** | ❌ | ✅ |
| **Codex 데스크톱 GUI 전체** | ❌ | ✅ |

## 3. 결론

- **변환 핵심(어댑터/sidecar/oauth/parser/bridge): 동등 수준 도달.** opencodex의 어려운 부분 다 포팅됨.
- **devil-codex 우위:** 순정 Codex 직통 유지 + Codex 데스크톱 UI 전체 재현 + Copilot OAuth.
- **opencodex 우위(남은 격차):**
  1. provider 폭 — Devil now has the safe OpenAI-compatible key/local subset, but not the full 40+ registry/custom-provider layer.
  2. xAI/Kimi OAuth.
  3. Azure/custom provider adapter.
  4. background service (앱 꺼도 순정 Codex가 외부 thread 계속 쓰려면 필요).
- **판단:** "Codex 재현 + 멀티모델" 목표 기준 devil-codex가 이미 opencodex 능가. 격차는 전부 "provider 다양성/배포 편의"라 M4 또는 필요시 확장 항목. 핵심 패리티 부채 없음.

## Related

- [Milestone status](milestone-status.md)
- [Sync plan](external-provider-sync-plan.md)
- [Topics](README.md)
