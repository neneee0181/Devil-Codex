---
memoc: true
type: state
scope: project-memory
created: 2026-06-21T11:02:34
updated: 2026-06-21T20:04:22
status: active
tags:
  - memoc
  - memoc/state
---
# Project Rules

Durable user and project preferences live here. Update when the user gives a rule that should persist across sessions.

## Operating Rules

- Keep `AGENTS.md` and `CLAUDE.md` as short entry files; durable context belongs under `.memoc/`.
- Do not track generated output folders such as `out/`, `.next/`, `dist/`, `build/` unless the user explicitly asks.
- Update `.memoc/04-handoff.md` after substantial work so the next agent can resume quickly.
- Use `.memoc/05-done-checklist.md` before saying substantial work is complete.

## Agent Behavior Preferences

- Be factual and operational in memory docs.
- Keep memory notes concise; do not paste temporary command output unless it changes future work.
- Preserve user changes and avoid reverting unrelated work.
- State unverified parts honestly in the final answer and handoff.
- Commit each completed, verified unit of work. Push only after an explicit user request.
- After every implementation unit, explain in simple Korean: how to run it, how to use it, what changed, exact automated/manual tests, success criteria, and where to inspect failures.
- Manual test instructions must name each button in click order, the expected visible result after every click, the failure symptom, and the next place to inspect.
- Treat the current official Codex desktop app and user-provided captures as the authoritative UI/UX reference; maintain a detailed parity checklist instead of judging similarity by general appearance.
- Keep `src/renderer/main.tsx` as app composition/state only. Put independent UI domains in focused files under `src/renderer/components/`; do not add new large feature UI to `main.tsx`.
- For every coding task, apply the `memoc-code` guardrails and keep `caveman` communication mode active.
- Split code by domain and responsibility before files become large; prefer focused components/services over accumulating implementation in one file.

## Project-Specific Rules

- Protect the product philosophy: deliver the closest practical reproduction of Codex while allowing diverse model providers.
- Treat visual, behavioral, feature, and performance parity with Codex as the default implementation target. Do not deliberately redesign, simplify, or substitute a different UX without an explicit reason.
- Recreate Codex UI and workflows as closely as practical. Use independent implementation and assets only when exact source/assets are unavailable or cannot be used; preserve observable parity in those cases.
- Inspect the current official Codex app when a UI flow needs reference; preserve captures as project references without copying private credentials or user data.
- Keep upstream Codex integration isolated so updates can be reviewed and applied with minimal merge conflict.
- Prefer in-process/native provider adapters over a user-managed localhost proxy in the final product.
- Implement and verify API-key providers before subscription OAuth providers.
- Design for macOS and Windows from the beginning; platform-specific automation must remain behind clear interfaces.
- Never log, commit, screenshot, or save API keys, OAuth tokens, account identifiers, or private conversation content.
