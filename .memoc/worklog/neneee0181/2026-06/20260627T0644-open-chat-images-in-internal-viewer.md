---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-27T06:44:18
updated: 2026-06-27T06:44:18
status: active
tags:
  - memoc
  - memoc/worklog
---
# Open chat images in internal viewer

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-27T06:44:18

## Summary

- Reused the attachment image viewer for markdown and tool-result images.
- Prevented AI chat images from opening external windows on click.

## Changed Files

- `memoc/session-summary.md`
- `src/renderer/components/AttachmentCards.tsx`
- `src/renderer/components/MarkdownContent.tsx`
- `src/renderer/components/TurnActivity.tsx`
- `src/renderer/styles.css`

## Verification

- `npm run build`
- `git diff --check`

## Follow-up

_None._

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
