---
memoc: true
type: worklog
actor: neneee0181
created: 2026-06-27T17:20:27
tags:
  - devil-codex
  - model-picker
  - reasoning
  - memoc
  - memoc/worklog
scope: project-memory
updated: 2026-06-27T09:11:29
status: active
---
# Model Picker Reasoning And Speed

## Summary
- Confirmed previous model picker reasoning/speed controls were UI-only.
- Lifted reasoning effort and response speed state from `ModelPicker` into `main.tsx` so selections persist and flow into submit/retry.
- `turn/start` now includes `reasoning: { effort }` and service tier hints.
- External proxy parses those hints; adapters already use reasoning effort, and OpenAI-compatible OpenAI requests receive `service_tier`.
- Speed submenu is now a small side popover with standard/fast choices.

## Verification
- `npm run build`
- `git diff --check`
