---
memoc: true
type: worklog
scope: project-memory
created: 2026-07-21T18:00:00+09:00
updated: 2026-07-21T18:00:00+09:00
status: active
tags:
  - memoc
  - memoc/worklog
---
# Antigravity thought_signature extraction gap fix

actor: neneee0181
branch: main
status: done

## Summary

- User reported Antigravity Bridge sessions (`019f7d6d...`) hit "Function call is missing a thought_signature" mid-session, causing repeated "다시 연결 중 /5" reconnect failures deep in long tool-loop conversations.
- Audited the prior v0.4.5 commit ("harden GLM/Claude/Antigravity routing"): confirmed it only added the new Kimi provider and Kimi-specific routing rules in `provider-policy.cts`. It did NOT modify `antigravity.cts` or `antigravity-replay.cts` at all -- the actual thought_signature bug was never touched despite the commit message implying Antigravity hardening.
- Cloned `lidge-jun/opencodex` and diffed their `google-antigravity-replay.ts` against our `antigravity-replay.cts` / `api-key.cts`. Found the real gap: our Gemini SSE parser (`streamGoogle` in `src/main/proxy/api-key.cts`) only read `thoughtSignature`/`thought_signature` directly on the part or functionCall object, but never checked the nested `extra_content.google.thought_signature` fallback that opencodex's `extractSignature()` checks. When Gemini returns the signature only in that nested shape, we silently dropped it, cached the tool call with no signature, and a later replay sent the request without one -- causing the upstream rejection.
- Fix: added `extractThoughtSignature()` helper in `api-key.cts` mirroring opencodex's fallback order (top-level thoughtSignature -> thought_signature -> fn.thoughtSignature -> fn.thought_signature -> extra_content.google.thought_signature), used it in `streamGoogle`'s function-call parsing.
- Added a regression test proving a nested-only signature is now captured.
- Version bump 0.4.5 -> 0.4.6.

## Verification

- `npm run build:main` clean, `npm run typecheck:renderer` clean.
- `npm run test:main` 55/55 (new test: "Google streams recover thought signatures nested under extra_content.google").

## Follow-up

- Install v0.4.6 and verify a long real Antigravity tool-loop session no longer hits the missing-thought_signature error. This was a code-level fix from static/unit-test evidence plus opencodex-diff comparison; it was not reproduced live against the real upstream Antigravity API since the failure is intermittent and shape-dependent on Gemini's response.
