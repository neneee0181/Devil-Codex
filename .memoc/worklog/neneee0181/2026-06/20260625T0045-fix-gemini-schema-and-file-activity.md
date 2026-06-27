---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-25T00:45:00
tags:
  - memoc
  - worklog
  - devil-codex
  - provider
  - timeline
  - memoc/worklog
updated: 2026-06-24T17:24:41
status: active
---
# Fix Gemini schema rejection and external file activity visibility

## Summary

- Added Gemini-specific tool schema normalization to strip `additionalProperties` and related unsupported JSON Schema keywords before sending `functionDeclarations`.
- Added per-turn workspace snapshots around app-server turns.
- If app-server reports command execution but no native `fileChange` item, Devil compares the before/after Git diff and emits a synthetic `fileChange` timeline item.
- Made file-change activity expandable and compact so it matches the Codex-style `파일 N개 수정` / `편집함 path +N -M` view.

## Verification

- `npm run build` passed.
- Smoke-tested `normalizeGeminiSchema` to ensure `additionalProperties` is removed.

## Manual follow-up

- Test Gemini simple turn and an external-provider file creation turn in Electron.
