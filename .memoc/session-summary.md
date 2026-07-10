---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-10T03:15:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-10. Replace; keep <800B.

## Status
- v0.2.12 adds GPT-5.6 Sol/Terra/Luna to Devil Codex's native Codex picker.
- Desktop startup now registers a catalog-only native model file; native requests remain direct.

## Verification
- `npm run build`, `git diff --check`, and isolated bundled app-server smoke pass.
- Smoke returned all 3 GPT-5.6 IDs with `model_catalog_json` set and no `openai_base_url`.

## Resume
- Commit/tag/push v0.2.12.
