---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-22T06:01:21
updated: 2026-06-22T06:01:21
status: active
tags:
  - memoc
  - memoc/worklog
---
# UI fixes: project menu/hide, env card exclusivity, composer alignment

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-22T06:01:21

## Summary

- Every Codex project group (not only the active workspace) now has a hover `...` menu (Finder + new-chat) and 삭제하기 that hides the project from devil-codex's sidebar via `localStorage devil-codex:hidden-projects` (folder untouched); active project's 제거하기 routes through the same `hideProject`. Collapsed active project no longer renders its thread-list, so spacing matches other rows.
- Environment card and the right utility panel are mutually exclusive (opening one closes the other), matching Codex; while the env card shows, the thread view + composer reserve right padding (`max(clamp, 348px)`) so messages/input don't render under the card.
- Composer horizontal padding aligned to the thread view so the input box matches the chat message column exactly (CDP: timeline and composer share left/right 353/1092).

## Changed Files

- `src/renderer/main.tsx` (hideProject, hiddenProjects state, project groups menu, env/utility exclusivity, env-open class, newThreadInProject)
- `src/renderer/components/ThreadList.tsx` (collapsed = no thread-list)
- `src/renderer/styles.css` (.other-projects, env-open thread-view/composer padding, composer padding)
- `docs/CODEX_PARITY.md`

## Verification

- CDP (port 9222): hid `memoc` → removed from list + persisted, survives reload (then cleared). Utility open → env card closes. Timeline/composer bounds identical. `npm run build` passes.
- Commits eb7335f, 1d1480c, 61b61ba (+ earlier 402d78c, f82f5a9). Push pending (user's GitHub account).

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
