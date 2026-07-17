---
title: Fix stock Bridge model selection and transport
date: 2026-07-17
actor: neneee0181
---

- Confirmed installed Devil Codex is v0.3.12 and the prior stock session reached Bridge WebSocket/HTTP fallback but never an external provider.
- Fixed rapid Bridge model selection overwrites using a latest-selection ref in the renderer.
- Restored stock `openai_base_url` identity path and set `supports_websockets: false` on generated external catalog rows.
- Verified full build, main test, diff check, config activation/removal smoke, and catalog flag smoke. Installed-app external turn remains manual E2E.
