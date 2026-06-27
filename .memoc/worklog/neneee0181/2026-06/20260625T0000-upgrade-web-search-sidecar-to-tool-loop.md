---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-25T00:00:00
updated: 2026-06-25T00:00:00
status: active
actor: neneee0181
tags:
  - memoc
  - memoc/worklog
  - devil-codex
  - opencodex
  - sidecar
  - provider
---
# Upgrade web-search sidecar to tool loop

## Summary

- Replaced the earlier web-search prepass behavior with an opencodex-style external-provider tool loop.
- Added synthetic `web_search` tool metadata for external models only.
- Intercepts `web_search` tool calls, runs native Codex/ChatGPT web_search through forwarded auth headers, injects a tool result, and re-runs the external model until it produces a final answer or hits the configured per-turn search limit.
- Provider diagnostics now report web-search sidecar mode, tool call count, real sidecar request count, loop count, and failures.
- Codex direct route remains unchanged and still ignores sidecars.

## Verification

- `npm run build` passed.
- Local smoke checks against compiled `dist-electron/proxy/web-search-sidecar.cjs` verified:
  - synthetic `web_search` calls are intercepted and removed from passthrough;
  - normal tool calls continue through passthrough.

## Follow-up

- Manual UI E2E: external model + web-search ON + current-info prompt.
- Verify stock-Codex sync after the web-search external turn.
- Remaining opencodex parity: vision sidecar, Provider dashboard/live request log, then richer provider registry/catalog metadata.
