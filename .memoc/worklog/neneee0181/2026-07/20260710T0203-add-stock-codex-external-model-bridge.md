---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-10T02:03:46
updated: 2026-07-10T02:03:46
status: active
tags:
  - memoc
  - memoc/worklog
---
# Add stock Codex external-model bridge

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-07-10T02:03:46

## Summary

- Added a managed stock-Codex catalog with connected external `provider:model` entries.
- Added headless proxy handoff after Devil desktop exits; desktop mode removes the stock bridge so Codex models keep the native direct route.
- Prioritized the selected external Provider's first five models for stock Codex `spawn_agent`, so standard subagents can use the same external proxy route.
- Added opt-in persisted stock-bridge web-search/vision sidecar controls; both default off. A forced external Copilot web-search request completed with three sidecar searches/tool calls, and a real local PNG vision request completed with one sidecar call and no failure.

## Changed Files

- `README.md`
- `src/main/codex-config.cts`
- `src/main/main.cts`
- `src/main/proxy/proxy-server.cts`
- `src/main/proxy/web-search-sidecar.cts`
- `src/main/codex-stock-catalog.cts`
- `src/main/codex-settings.cts`
- `src/renderer/SettingsView.tsx`

## Verification

- `npm run build` and `git diff --check` pass.
- Temp CODEX_HOME smoke confirms catalog injection plus bridge activation/removal while preserving a native model and the Devil provider table.
- Real headless bridge created 440 external catalog rows; Codex app-server `model/list` returned 194 routed rows (its 200-item response cap) plus native `gpt-5.5`.
- Real SSE: `copilot@181058817:gpt-4o` completed through the external adapter; native `gpt-5.5` completed through transparent ChatGPT/Codex passthrough.
- Raw Codex `model/list` native and routed entries have identical fields and no per-model provider field. Exact per-model transport bypass inside one stock dropdown is unavailable without changing upstream Codex; this matches OpenCodex's transparent-proxy design.
- Confirmed again against a shallow `openai/codex` source checkout: `modelProvider` is a thread request/config selection, while model catalog records carry no provider mapping for the stock client picker.
- Current generated catalog has five NVIDIA external entries at priorities `0..4`, followed by native `gpt-5.5` at priority `20`; this is the stock subagent candidate ordering.

## Follow-up

_None for the stock-bridge feature set. Specialized OpenCodex Provider/OAuth adapters remain a separate implementation scope._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
