---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-24T10:59:42
updated: 2026-06-24T10:59:42
status: active
tags:
  - memoc
  - memoc/worklog
---
# port opencodex deferred tool handling

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-24T10:59:42

## Summary

- Ported opencodex-style deferred tool handling into Devil's Responses parser.
- `tool_search_output` specs are now merged into routed provider tool lists and a short exact-name hint is kept in history.
- Added opencodex-style chat adapter safety for orphan tool results in Copilot/API-key providers, preserving namespaced tool names.
- Gemini API-key requests now use `systemInstruction` instead of folding instructions into the first user message.
- Ported request options from Responses into provider bodies: max tokens, sampling, stop, tool choice, reasoning effort, and penalties where supported.
- Ported image content preservation for OpenAI-compatible/API-key, Copilot, and Gemini routed requests.
- This preserves the existing product rule: Codex models stay app-server direct; only external models use the Devil proxy/reconcile path.

## Changed Files

- `src/main/proxy/parser.cts`
- `src/main/proxy/copilot.cts`
- `src/main/proxy/api-key.cts`
- `src/main/proxy/anthropic.cts`
- `src/main/proxy/types.cts`
- `.memoc/session-summary.md`
- `.memoc/worklog/neneee0181/2026-06/20260624T1059-port-opencodex-deferred-tool-handling.md`

## Verification

- `npm run build` passed.
- Smoke check: built parser merges `tool_search_output` namespace tools into the next provider tool list.
- Smoke check: built Copilot adapter wraps orphan tool results with a synthetic namespaced assistant tool call.
- Smoke check: DeepSeek/OpenAI-compatible receives max tokens/sampling/stop/tool_choice/penalties; Gemini receives `systemInstruction` + `generationConfig`; Anthropic receives stop/tool_choice/thinking and drops incompatible sampling controls under thinking.
- Smoke check: OpenAI-compatible/Copilot payloads preserve `input_image` as `image_url`; Gemini converts a data URL image into `inline_data`.
- Manual deferred-tool E2E still needs a Devil restart and a real external-provider tool call.

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
