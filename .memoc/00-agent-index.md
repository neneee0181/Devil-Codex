---
memoc: true
type: core
scope: project-memory
created: 2026-06-27T11:24:44
updated: 2026-06-27T11:24:44
status: active
tags:
  - memoc
  - memoc/core
---
# Agent Index

This is the fast entry map for agents. Start here, then open only the docs relevant to the task.

## Read Order

1. Entry file managed block.
2. `.memoc/session-summary.md`.
3. Search first, then open only task-relevant files.

## Project Snapshot

<!-- memoc:snapshot:start -->
- Last synced: 2026-06-27T11:24:44
- Detected stack: Node.js, React, Electron, TypeScript

### Config Files

- `.env.local`
- `package.json`
- `tsconfig.json`
- `vite.config.ts`

### Source Directories

- `.claude`
- `.github`
- `assets`
- `dist-electron`
- `docs`
- `release`
- `scripts`
- `src`
- `vendor`

### Package Scripts

- `dev`: `concurrently -k "npm:dev:renderer" "npm:dev:electron"`
- `dev:renderer`: `vite --host 127.0.0.1 --port 5173 --strictPort`
- `dev:electron`: `npm run build:main && wait-on tcp:5173 && cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 electron .`
- `build`: `npm run build:renderer && npm run build:main`
- `build:renderer`: `vite build`
- `build:main`: `tsc -p tsconfig.electron.json`
- `start`: `electron .`
- `icons`: `node scripts/build-icons.cjs`
- `prepackage`: `npm run icons && npm run build`
- `package`: `electron-builder`
- `dist`: `npm run prepackage && electron-builder`
- `dist:mac`: `npm run prepackage && electron-builder --mac`
- `dist:win`: `npm run prepackage && electron-builder --win`
- `postinstall`: `node scripts/fix-pty.cjs`
<!-- memoc:snapshot:end -->

## Core Docs

- [Boot](boot.md)
- [Project Brief](00-project-brief.md)
- [memoc Usage](memoc-usage.md)
- [Agent Workflow](01-agent-workflow.md)
- [Current Project State](02-current-project-state.md)
- [Decisions](03-decisions.md)
- [Handoff](04-handoff.md)
- [Done Checklist](05-done-checklist.md)
- [Project Rules](06-project-rules.md)
- [Session Summary](session-summary.md)
- [Activity](activity.md)
- [Actors](actors/README.md)
- [Worklog](worklog/README.md)
- [Wiki Index](wiki/index.md)
- [Project Wiki](wiki/project/README.md)
- [Knowledge Wiki](wiki/knowledge/README.md)
- [Raw Sources](raw/README.md)

## Wiki

- [Wiki Index](wiki/index.md) — hub for project and knowledge wikis.
- [Project Wiki](wiki/project/README.md) — implementation docs for this repo.
- [Knowledge Wiki](wiki/knowledge/README.md) — source-backed concepts and external knowledge.
- [Sources](wiki/knowledge/sources.md) — source provenance and ingest notes.
- [Glossary](wiki/knowledge/glossary.md) — terms and aliases.
- [Open Questions](wiki/knowledge/questions.md) — unresolved knowledge gaps.
- [Wiki Lint](wiki/knowledge/lint.md) — orphan, stale, and contradiction checks.
