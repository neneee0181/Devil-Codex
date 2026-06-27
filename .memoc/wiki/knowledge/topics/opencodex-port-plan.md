---
memoc: true
type: wiki
scope: project-memory
created: 2026-06-24T00:00:00
updated: 2026-06-24T00:00:00
status: active
tags:
  - memoc
  - memoc/topic
  - devil-codex
  - opencodex
  - provider
  - proxy
  - sync
  - memoc/wiki
  - memoc/knowledge-wiki
confidence: medium
---
# OpenCodex Port Plan for Devil Codex

## Goal

Port the useful provider adapter/tool translation ideas from `lidge-jun/opencodex` into Devil Codex while preserving Devil's product rule:

```text
Codex models:
  Devil Codex → Codex app-server directly
  No Devil proxy
  Stock Codex sync remains native

External models:
  Devil Codex → app-server modelProvider:"devil" → Devil proxy → external provider
  Then reconcile thread provider/model back to openai for stock Codex visibility
```

This is different from opencodex. opencodex globally proxies Codex. Devil Codex must not do that for Codex models.

## Current Devil State

### Already implemented / ported

| Area | Current Devil state | Source/idea |
|---|---|---|
| Codex-direct routing | `provider=codex` stays on app-server direct path | Devil-specific product rule |
| External proxy routing | all non-Codex providers route through `modelProvider:"devil"` and local proxy | Devil sync plan |
| Stock Codex sync | external turns reconcile DB/rollout provider/model back to `openai` | rcodex-style reconcile plan |
| Pending journal | reconcile has pending/retry/startup recovery | Devil-specific safety layer |
| Actual provider metadata | Devil stores real provider/model separately | Devil-specific metadata |
| Function tools | basic function tool schemas are converted to provider tool formats | opencodex adapter idea |
| Namespaced tools | namespace + tool name flatten to `namespace__tool` and map back | opencodex adapter idea |
| Custom/freeform tools | freeform tools are relayed back as `custom_tool_call` | opencodex bridge idea |
| `tool_search` | `tool_search_call` and `tool_search_output` are preserved | opencodex parser idea |
| Deferred tools | tools returned from `tool_search_output` are merged into next provider request | opencodex parser idea |
| Orphan tool results | OpenAI-compatible/API-key and Copilot insert synthetic assistant tool call before bare tool result | opencodex chat adapter idea |
| Request options | max tokens, temperature, top_p, stop, tool_choice, reasoning, penalties are parsed and forwarded | opencodex options idea |
| Anthropic thinking handling | drops incompatible sampling controls when extended thinking is enabled | opencodex Anthropic adapter idea |
| Image input preservation | OpenAI-compatible/Copilot use `image_url`; Gemini uses `inline_data`; Anthropic already handles image blocks | opencodex image adapter idea |
| Provider error display | upstream HTTP/stream/empty output errors are turned into visible chat errors | Devil + opencodex-style debugging |
| Usage view | Codex/Claude usage view exists; Copilot quota unavailable | rcodex/opencodex-informed |
| Capability UI | model picker and Provider 연결 tab show per-model tools/image/web/diagnostics badges | opencodex registry idea, small Devil map |
| Provider diagnostics | diagnostics attach to the same completed turn when possible and include route/reconcile/capability/sidecar status | Devil-specific debugging |
| Sidecar settings | Settings → 구성 exposes default-off web-search/vision sidecar toggles and request limits | opencodex sidecar idea, gated for later |
| Web-search sidecar tool loop | when enabled, external-provider turns expose a synthetic `web_search` tool, intercept the call, run native Codex/ChatGPT web_search, inject a tool result, and re-ask the model | opencodex sidecar loop idea adapted to Devil |
| Attachment/image parsing | `input_image` remains structured through the proxy; OpenAI-compatible/Copilot use `image_url`, Gemini uses `inline_data`, Anthropic accepts base64/URL image sources; text `input_file.file_data` can be decoded into text context when present | opencodex image adapter idea adapted to Devil |

### Verified so far

- `npm run build` passes after adapter/tool/request-option/image changes.
- Smoke checks passed:
  - `tool_search_output` namespace tool is merged into parsed tools.
  - Copilot orphan tool result is wrapped with synthetic namespaced assistant tool call.
  - DeepSeek/OpenAI-compatible body receives request options.
  - Gemini receives `systemInstruction` + `generationConfig`.
  - Anthropic receives stop/tool_choice/thinking and drops incompatible sampling under thinking.
  - OpenAI-compatible/Copilot preserve `input_image` as `image_url`.
  - Gemini converts image data URL to `inline_data`.
- Earlier real E2E:
  - Copilot `gpt-5-mini` external turn returned `OK`.
  - pending journal cleared.
  - SQLite/rollout provider reconciled back to `openai`.
  - stock Codex continuation after external turn was restored by model/provider reconcile.

### Not verified yet

- Full UI E2E after the newest adapter changes:
  - external model uses real file/tool call;
  - response appears correctly;
  - same thread appears in stock Codex;
  - stock Codex can continue with Codex model.
- Claude Code OAuth after relogin. Previous state showed Anthropic 401.
- `tool_search`/deferred tool real E2E in Devil UI.
- Vision/image real E2E with actual image attachment and external provider.
- PDF/binary attachment extraction beyond the first pass. Devil now has a local document extraction layer for text-like files, `.rtf`, `.docx`, and best-effort `.pdf`; richer PDF/binary parsing still needs future work.
- Attachment metadata persistence after app restart for sent user messages.
- Provider-specific model compatibility for models that appear in lists but do not respond.

## OpenCodex Features Worth Porting

### P0 — Finish verification before adding more scope

This is the highest priority because the current code already changed many provider paths.

Required tests:

```text
1. Codex model direct path
   Devil Codex + Codex model → no Devil proxy use → response OK

2. External text response
   Devil Codex + Copilot/API-key provider → response OK

3. External tool call
   External model creates/edits a file → file-change card appears

4. Reconcile
   After external turn → pending journal empty → DB/rollout provider=openai → DB model restored to Codex model

5. Stock Codex continuation
   Open same thread in stock Codex → continue with Codex model → no "external model not supported" error

6. Failure UX
   Unsupported/no-quota/no-login model → visible reason in chat, not silent "작업 실패"
```

Recommended next action:

```text
Run these before implementing web-search/vision/provider-registry.
```

Reason:

```text
If current adapter changes broke basic tool/reconcile behavior, adding sidecars will hide the root cause.
```

### P1 — Web-search sidecar for external models

Status in Devil:

```text
Implemented as of 2026-06-25.

Devil now:
1. activates only for external providers;
2. keeps Codex models on the direct app-server path;
3. injects a synthetic web_search function tool when the sidecar toggle is ON;
4. intercepts web_search tool calls before they reach Codex;
5. runs native Codex/ChatGPT web_search with forwarded auth headers;
6. injects the sidecar result as toolResult;
7. repeats the external-provider call until final answer or per-turn limit;
8. reports toolCalls/requests/loops/failures in Provider diagnostics.
```

Remaining verification:

```text
Run a real UI turn with web-search ON and a search-like prompt.
Confirm Provider diagnostics show toolCalls >= 1 and requests >= 1.
Then confirm stock Codex still sees/continues the reconciled thread.
```

OpenCodex files:

- `/private/tmp/opencodex-inspect/src/web-search/index.ts`
- `/private/tmp/opencodex-inspect/src/web-search/loop.ts`
- `/private/tmp/opencodex-inspect/src/web-search/executor.ts`
- `/private/tmp/opencodex-inspect/src/web-search/synthetic-tool.ts`
- `/private/tmp/opencodex-inspect/src/web-search/format-result.ts`
- `/private/tmp/opencodex-inspect/src/web-search/parse.ts`

What opencodex does:

```text
Codex hosted web_search tool is not directly usable by external providers.
OpenCodex:
1. detects hosted {type:"web_search"} in Responses request
2. removes it from normal provider tools
3. exposes synthetic function tool named web_search to external model
4. when model calls it, sidecar calls native ChatGPT/Codex backend with real web_search
5. injects the search result as tool_result
6. asks external model again
7. bounded by max searches and timeout
```

Why useful for Devil:

```text
External models would get near-Codex web-search behavior while Codex models stay native.
```

Devil-specific design:

```text
Only activate for external providers.
Use existing app-server/Codex auth path as the native sidecar.
Do not expose this as stock Codex state mutation.
Search result should be normal assistant/tool timeline in Devil, but final stored rollout still reconciles to openai.
```

Risk:

- extra tokens through native Codex/ChatGPT sidecar;
- latency;
- must avoid infinite search loop;
- current Codex app-server forwarded headers may not be enough outside opencodex's full proxy model.

Recommendation:

```text
Keep disabled by default.
Next improvement is Provider dashboard/live request log so failed sidecar HTTP/auth errors are easier to inspect.
```

### P1 — Vision sidecar for text-only external models

OpenCodex files:

- `/private/tmp/opencodex-inspect/src/vision/index.ts`
- `/private/tmp/opencodex-inspect/src/vision/describe.ts`
- `/private/tmp/opencodex-inspect/src/adapters/image.ts`

What opencodex does:

```text
If routed model is text-only and request has images:
1. use native ChatGPT/Codex vision model sidecar
2. describe the image
3. replace image part with compact text description
4. send to text-only external model
```

Current Devil state:

```text
Image payload preservation exists now.
But text-only model detection and pre-description sidecar do not exist.
```

Why useful:

```text
If DeepSeek or some Copilot-hosted model cannot see images, user still gets a usable response.
```

Risk:

- token/latency cost;
- privacy: image is sent through native ChatGPT/Codex sidecar;
- must cap image size and description length.

Recommendation:

```text
Add after web-search or alongside it only if user explicitly wants image parity.
Make it visible in UI: "이미지는 Codex vision sidecar로 설명 후 전달됨".
```

### P1 — Provider capability metadata

OpenCodex files:

- `/private/tmp/opencodex-inspect/src/providers/registry.ts`
- `/private/tmp/opencodex-inspect/src/codex-catalog.ts`
- `/private/tmp/opencodex-inspect/src/reasoning-effort.ts`
- `/private/tmp/opencodex-inspect/src/generated/jawcode-model-metadata.ts`
- `/private/tmp/opencodex-inspect/src/model-cache.ts`

What opencodex does:

```text
Per provider/model it tracks:
- adapter type
- context window
- image support
- reasoning efforts
- models that reject temperature/top_p/penalty
- tool_choice quirks
- reasoning content preservation
- media-generation model filtering
```

Current Devil state:

```text
Provider set is small:
codex, claude-code, copilot, openai, anthropic, google, deepseek.

Model discovery exists through GET /models or static fallback.
A small capability metadata MVP now exists and is visible in the model picker
and Provider 연결 tab:
  tools
  images
  webSearch
  diagnostics
  notes
```

Why useful:

```text
This directly addresses "models show up but don't work" and provider-specific 400s.
```

Recommended Devil approach:

Do not port the full 40+ registry immediately.

Create a small internal capability map:

```ts
{
  provider: "deepseek",
  models: {
    "deepseek-chat": {
      inputModalities: ["text"],
      reasoning: false,
      supportsTools: maybe,
      unsupportedOptions: ["reasoning_effort"]
    }
  }
}
```

Use it in:

```text
1. model picker labels/badges — implemented
2. Provider 연결 tab capability rows — implemented
3. request body filtering — partially implemented by adapter option handling
4. visible warning when user selects likely unsupported model — not implemented
5. optional "known broken" denylist — not implemented
```

Recommendation:

```text
Port this before adding lots of providers.
It is smaller and solves the user's current pain: listed models that fail silently or don't support tools.
```

### P1 — Better request log/debug panel

OpenCodex feature:

```text
Dashboard shows provider status, OAuth status, model selection, and live request log.
```

Current Devil state:

```text
Provider errors are visible in chat, but there is no structured request log UI.
```

Why useful:

```text
When a provider fails, user can see:
- provider/model
- HTTP status
- error type
- sanitized error body
- whether tool call happened
- whether reconcile succeeded
```

Devil-specific recommended design:

```text
Settings → Providers → Diagnostics
Per turn:
  provider
  model
  route: codex-direct | devil-proxy
  request options
  tools count
  image count
  upstream status
  final status
  reconcile status
```

Important:

```text
Never log API keys, OAuth tokens, cookies, or raw large request bodies.
```

Recommendation:

```text
Implement after P0, before sidecars if debugging remains painful.
```

### P2 — More providers from opencodex registry

OpenCodex supports many:

```text
xAI, Kimi, OpenRouter, Groq, Azure, Ollama, vLLM, LM Studio,
Together, Fireworks, Cerebras, Mistral, HuggingFace, NVIDIA NIM, etc.
```

Current Devil state:

```text
Devil already supports the safe key/local subset:
OpenAI, Anthropic API key, Google, DeepSeek, xAI API key,
OpenRouter, Groq, Mistral, Cerebras, Together, Fireworks,
Moonshot/Kimi API, Hugging Face, NVIDIA NIM, Ollama, vLLM, LM Studio,
plus Codex direct, Claude Code OAuth, and GitHub Copilot device login.

Adding the rest requires changing contracts, settings UI, proxy routing,
model refresh, key/env names, provider metadata, and in some cases adapter
behavior.
```

Recommendation:

```text
Do not port all providers yet.
First introduce "OpenAI-compatible custom provider" if expansion is needed.
```

Why:

```text
One custom OpenAI-compatible provider covers OpenRouter/Groq/Ollama/LM Studio/vLLM/etc. without exploding ProviderId.
```

Proposed flow:

```text
Settings → Providers → Add custom provider
Fields:
  id/name
  base URL
  API key or no key
  default model
  models endpoint optional
  adapter = openai-chat
```

This is more Devil-friendly than hardcoding 40 providers.

### Missing OpenCodex providers in Devil

Snapshot source:

```text
lidge-jun/opencodex `src/providers/registry.ts`, checked 2026-06-27.
OpenCodex registry entries: 41.
Devil intentionally aliases/partially covers:
  openai -> Codex direct / OpenAI API key
  anthropic -> Claude Code OAuth / Anthropic API key
  kimi -> Moonshot/Kimi API key, but not Kimi OAuth
```

Not currently exposed as first-class Devil providers:

| OpenCodex id | Label | Auth | Adapter | Why not in Devil yet |
|---|---|---|---|---|
| `azure-openai` | Azure OpenAI | key | `azure-openai` | Needs Azure deployment/resource/version fields, not just OpenAI-compatible base URL. |
| `firepass` | Fire Pass (Fireworks Kimi) | key | `openai-chat` | Overlaps Fireworks; needs preset/branding decision. |
| `venice` | Venice | key | `openai-chat` | OpenAI-compatible; good candidate for custom provider/preset. |
| `zai` | Z.AI — GLM Coding Plan | key | `openai-chat` | Needs GLM reasoning/locked-parameter metadata. |
| `nanogpt` | NanoGPT | key | `openai-chat` | OpenAI-compatible; good candidate for custom provider/preset. |
| `synthetic` | Synthetic | key | `openai-chat` | OpenAI-compatible; needs model compatibility verification. |
| `qwen-portal` | Qwen Portal | key | `openai-chat` | OpenAI-compatible; needs Qwen portal auth/model verification. |
| `qianfan` | Qianfan (Baidu) | key | `openai-chat` | Region/provider-specific auth and model behavior need verification. |
| `alibaba` | Alibaba Coding Plan | key | `openai-chat` | Coding-plan endpoint; needs model/tool compatibility verification. |
| `parallel` | Parallel | key | `openai-chat` | OpenAI-compatible; needs model compatibility verification. |
| `zenmux` | ZenMux | key | `openai-chat` | OpenAI-compatible aggregator; good custom provider candidate. |
| `litellm` | LiteLLM (self-hosted) | key | `openai-chat` | Better handled by a custom OpenAI-compatible provider than a hardcoded entry. |
| `ollama-cloud` | Ollama Cloud | key | `openai-chat` | Separate from local Ollama; needs hosted auth and model verification. |
| `minimax` | MiniMax — Coding Plan | key | `openai-chat` | Needs provider-specific model/tool behavior verification. |
| `minimax-cn` | MiniMax — Coding Plan (CN) | key | `openai-chat` | Region-specific endpoint; needs separate preset and verification. |
| `kimi-code` | Kimi (coding) | key | `openai-chat` | Devil has Moonshot API key, but not this dedicated Kimi coding endpoint/preset. |
| `opencode-zen` | opencode zen | key | `openai-chat` | OpenAI-compatible coding endpoint; needs preset/verification. |
| `vercel-ai-gateway` | Vercel AI Gateway | key | `openai-chat` | Gateway provider; best served by custom provider support. |
| `xiaomi` | Xiaomi MiMo | key | `anthropic` | Uses Anthropic wire on a non-Anthropic endpoint; needs adapter metadata and testing. |
| `kilo` | Kilo | key | `openai-chat` | Gateway-style endpoint; custom provider candidate. |
| `cloudflare-ai-gateway` | Cloudflare AI Gateway | key | `anthropic` | Requires account/gateway URL templating and Anthropic adapter path. |
| `github-copilot` | GitHub Copilot | key | `openai-chat` | Devil already has Copilot device login; key-mode Copilot is not exposed. |
| `gitlab-duo` | GitLab Duo | key | `openai-chat` | Needs GitLab auth/proxy behavior verification. |

Also not fully matched:

| Area | OpenCodex | Devil |
|---|---|---|
| xAI OAuth | `xai` OAuth login | xAI API key only. |
| Kimi OAuth | `kimi` OAuth login | Moonshot/Kimi API key only. |
| Anthropic OAuth product mode | `anthropic` OAuth | Claude Code OAuth plus Anthropic API key; not the same user-facing preset. |
| OpenAI API key adapter | `openai-apikey` uses Responses passthrough | Devil OpenAI API key currently uses OpenAI-compatible chat path. |
| Generic provider API | `/api/provider-presets`, `/api/key-providers`, `/api/providers` | Not implemented; Devil uses a fixed internal catalog plus verified model refresh. |

Current decision:

```text
Do not adopt the full OpenCodex registry/API layer yet.
It is possible, but it touches ProviderId typing, proxy routing, settings UI,
model validation, and provider metadata at once.

If provider breadth becomes a priority, implement:
1. custom OpenAI-compatible provider first;
2. Azure OpenAI preset/adapter second;
3. provider presets for the missing OpenAI-compatible services third;
4. xAI/Kimi OAuth only after the key/custom layer is stable.
```

### P2 — OpenAI Responses API-key adapter

OpenCodex has:

- `openai-responses` passthrough adapter
- `openai-chat` adapter

Current Devil:

```text
OpenAI API-key uses Chat Completions style through api-key.cts.
```

Why useful:

```text
For OpenAI API-key models, Responses API may preserve Codex-like semantics better than Chat Completions.
```

Risk:

```text
Need to ensure tool call output, custom tools, reasoning, and image handling match current Codex expectations.
May be redundant because Codex-login models already use native app-server direct.
```

Recommendation:

```text
Low priority unless OpenAI API-key behavior is worse than expected.
```

### P2 — WebSocket transport

OpenCodex files:

- `/private/tmp/opencodex-inspect/src/ws-bridge.ts`

What it does:

```text
Supports Codex Responses WebSocket path and pumps SSE/JSON response events to WS frames.
```

Current Devil:

```text
Devil proxy currently focuses on SSE HTTP.
Codex app-server path already works for our known flow.
```

Recommendation:

```text
Do not port now unless current Codex app-server begins using WS for modelProvider:"devil".
```

Reason:

```text
High protocol complexity, low immediate benefit.
```

### P3 — Service/shim/injection/codex catalog

OpenCodex has:

```text
ocx service
codex shim
config injection
catalog injection
history provider remap
```

Current Devil product:

```text
Devil is the app.
It must not globally rewrite native Codex config for Codex models.
```

Recommendation:

```text
Do not port as-is.
Only borrow small ideas:
- robust restore/reconcile safety
- model metadata/capability mapping
- diagnostics
```

## Recommended Implementation Order

### Phase A — Stabilize current adapter port

Goal:

```text
Prove current path works before adding sidecars.
```

Tasks:

1. Real UI E2E for external tool call:
   ```text
   External model → create file → response OK → file card visible
   ```
2. Reconcile verification:
   ```text
   pending journal empty
   state_5.sqlite provider=openai
   rollout session_meta provider=openai
   DB model restored to Codex model
   ```
3. Stock Codex continuation:
   ```text
   same thread → Codex model reply OK
   ```
4. Failure test:
   ```text
   choose unsupported/no-quota model → visible provider failure reason
   ```

Success:

```text
At least Copilot + one API-key provider pass text + tool + reconcile.
```

### Phase B — Capability metadata MVP

Goal:

```text
Stop showing/using models in ways that are likely to fail.
```

Tasks:

1. Add `ProviderModelCapability` metadata type.
2. Add capability map for current providers only:
   - Copilot known working models vs questionable models
   - Claude Code Sonnet/Haiku auth/model notes
   - Anthropic API models
   - Google Gemini generateContent models
   - DeepSeek chat/reasoner quirks
3. Use metadata to filter/transform request options:
   - no temperature/top_p/penalty where known
   - no image support → route to vision sidecar later or warn
   - no tools → warn or disable tool-required tasks
4. Model picker badges:
   ```text
   tools
   vision
   reasoning
   maybe unsupported
   ```

### Phase C — Diagnostics UI

Goal:

```text
Make provider failures understandable without terminal spelunking.
```

Tasks:

1. Store sanitized provider request summaries.
2. Store upstream status/error class.
3. Store reconcile status per turn.
4. Add Settings → Providers → Diagnostics or per-turn "details" panel.

### Phase D — Web-search sidecar

Goal:

```text
External models get current web-search capability like Codex.
```

Current Devil state:

```text
Implemented:
1. Settings toggle is default off.
2. External-provider turns only; Codex direct route is ignored.
3. Devil exposes a synthetic web_search tool to external providers.
4. When the external model calls web_search, Devil runs native Codex/ChatGPT web_search through the sidecar.
5. The sidecar result is injected back as a tool result and the external model is asked again.
6. The loop is bounded by the configured request limit.
7. Diagnostics show toolCalls, request count, loop count, and failure reason.
8. Timeline now shows a separate `웹 검색: ...` activity row with query/source/failure detail.

Not full opencodex yet:
1. No dedicated Provider dashboard/live request log yet.
2. No vision sidecar yet.
3. Search details are visible per turn, but not yet in a global provider request log.
```

Remaining tasks:

1. Add Provider dashboard/live request log for sidecar/tool/provider calls.
2. Add vision sidecar for text-only external models.
3. Expand provider registry/catalog polish.
6. Add cost/latency indicator.

### Phase E — Vision sidecar

Goal:

```text
Text-only external models can handle image input.
```

Tasks:

1. Add model capability `inputModalities`.
2. If image + text-only model, use Codex vision sidecar.
3. Replace image with concise description.
4. Show UI marker that image was described by sidecar.

### Phase F — Provider expansion

Goal:

```text
Support more providers without exploding code.
```

Recommended first:

```text
Custom OpenAI-compatible provider
```

Then optionally:

```text
OpenRouter, Groq, Ollama/LM Studio/vLLM, xAI, Kimi
```

## Decisions Needed From User

### Decision 1 — Next priority

Recommended:

```text
Phase A → Phase B → Phase C
```

Alternative:

```text
Phase A → Web-search sidecar
```

Tradeoff:

| Choice | Good | Bad |
|---|---|---|
| Capability metadata first | fewer failing models, cleaner UX | less flashy |
| Web-search first | powerful external models | more moving parts, more tokens |

### Decision 2 — Sidecar cost policy

Question:

```text
Should web-search/vision sidecars run automatically, or only after user enables a setting?
```

Recommended:

```text
Default off at first, with a visible setting.
```

Reason:

```text
Sidecars spend extra Codex/ChatGPT tokens and add latency.
```

### Decision 3 — Provider expansion policy

Question:

```text
Do we add many hardcoded providers, or add one custom OpenAI-compatible provider first?
```

Recommended:

```text
Custom OpenAI-compatible provider first.
```

Reason:

```text
It covers many providers with less code and less UI clutter.
```

## Current Recommendation

Do not add web-search/vision/provider-registry immediately.

Recommended next concrete work:

```text
1. Run real E2E for current adapter port.
2. Add current-provider capability metadata MVP.
3. Add diagnostics view so failures are explainable.
4. Then decide between web-search sidecar and vision sidecar.
```

This keeps Devil Codex aligned with the target:

```text
Codex direct remains pure.
External providers become stronger through the Devil proxy.
Stock Codex sync remains the compatibility anchor.
```

## 2026-06-24 Implementation Update

### Capability metadata MVP

Devil now attaches lightweight capability metadata to every provider model at load/save time:

```text
tools: native | limited | none | unknown
images: native | sidecar | none | unknown
webSearch: native | sidecar | none | unknown
diagnostics: good | limited | experimental | unknown
notes: short provider/model caveats
```

Policy:

```text
Codex:
  direct app-server route
  native tools/images/webSearch

External providers:
  devil proxy + reconcile route
  webSearch sidecar candidate, not enabled
  provider/model notes visible in picker tooltip
```

### Diagnostics UI MVP

Every completed external-provider turn now emits a `providerDiagnostics` activity entry. Codex-direct turns also emit a diagnostic entry showing `route: app-server direct`.

The collapsed turn now also shows a compact `Provider 진단` strip, so the user does not need to expand `작업 내용` just to notice provider/route/sidecar state.

The diagnostic card includes:

```text
provider
model
route
tools/images/webSearch capability
diagnostics confidence
reconcile expectation
sidecar enabled status
provider notes
error, when available
```

Goal:

```text
User can tell whether failure is likely model support, auth/quota, tool compatibility, or reconcile state.
```

### Web-search / vision sidecar decision

Web-search sidecar has moved past the first MVP into a bounded synthetic-tool loop. Vision sidecar is still reviewed but intentionally not implemented yet.

Reason:

```text
Sidecar adds extra token cost, latency, native Codex/ChatGPT auth dependence, and loop control risk.
The current web-search loop is setting-gated, budget-limited, and visible in timeline/diagnostics.
```

Next sidecar implementation should be gated by:

```text
1. setting flag, default off
2. visible UI marker: "Codex sidecar used"
3. max search/image-description budget
4. diagnostics entry with sidecar request count and failure reason
5. no change to Codex-direct route
```

## Related

- [Knowledge Wiki](../README.md)
- [Topics](README.md)
- [External Provider Sync Plan](external-provider-sync-plan.md)
