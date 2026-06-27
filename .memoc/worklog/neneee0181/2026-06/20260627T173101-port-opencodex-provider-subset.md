---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T17:31:01+09:00
updated: 2026-06-27T17:31:01+09:00
status: complete
tags:
  - memoc
  - memoc/worklog
  - devil-codex
  - provider
  - opencodex
  - rcodex
---
# Port opencodex provider subset

## Summary

Ported the safe key/local provider subset from `lidge-jun/opencodex`, checking `neneee0181/rcodex` for endpoint/model hints. Devil keeps its own Codex-direct architecture: only external providers go through the Devil proxy.

## Changed

- Expanded `ProviderId`, provider catalog, capabilities, and shared API provider config for xAI, OpenRouter, Groq, Mistral, Cerebras, Together, Fireworks, Moonshot/Kimi, Hugging Face, NVIDIA NIM, Ollama, vLLM, and LM Studio.
- Model refresh and fallback runtime now use the shared config instead of hardcoded OpenAI/Anthropic/Google/DeepSeek URLs.
- Proxy routing accepts the new provider prefixes and exposes connected/keyless API providers from `/models`.
- OpenAI-compatible request forwarding suppresses `reasoning_effort` for providers/models where opencodex/rcodex compatibility is uncertain.
- Local providers are keyless in settings/picker, and vision sidecar routing now respects provider native-image capability.

## Verified

- `npm run build` passed.

## Follow-up

- Windows runtime verification for settings, picker, local provider endpoints, and external turns.
- Consider xAI/Kimi OAuth, Azure/custom providers, and broader rcodex free-tier catalog separately; they need more adapter/auth work than the current OpenAI-compatible path.
