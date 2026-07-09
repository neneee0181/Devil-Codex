---
memoc: true
type: state
scope: project-memory
created: 2026-07-04T08:44:44
updated: 2026-07-08T18:57:00
status: active
tags:
  - memoc
  - memoc/state
---
# Session Summary
Last: 2026-07-09T15:20:00+09:00
Replace, do not append. Keep <800B.

## Status
- v0.2.8 ready: NVIDIA NIM 429/RPM investigation and client-side throttle.

## Changed
- `019f4559...`: NVIDIA `z-ai/glm-5.2` repeated 429; thread peak was 6 req/min, likely endpoint/account/model dynamic limit.
- Added Settings -> 구성 -> NVIDIA NIM RPM 제한: default 40, 0 disables.
- Proxy paces all NVIDIA upstream calls; diagnostics show `provider.nvidiaRateLimitRpm`.

## Open Tasks
- Manual E2E: set NVIDIA 10-40 RPM and check 429s.

## Resume
- `npm run build` and `git diff --check` pass. Commit/tag/push pending.
