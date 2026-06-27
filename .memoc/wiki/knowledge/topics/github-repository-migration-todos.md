---
memoc: true
type: wiki
status: active
created: 2026-06-27
updated: 2026-06-27
tags:
  - devil-codex
  - github
  - auto-update
  - release
  - skill
  - memoc
  - memoc/wiki
  - memoc/knowledge-wiki
  - memoc/topic
scope: project-memory
confidence: medium
---
# GitHub Repository Migration TODOs

## Context
Devil Codex currently publishes installers and checks updates through GitHub Releases.
If the GitHub repository changes, the application must stop reading releases from the old repository.

Current hard-coded repository references:

- `package.json`
  - `build.publish[0].owner`
  - `build.publish[0].repo`
- `src/main/auto-update.cts`
  - `const REPO = "neneee0181/Devil-Codex"`
  - GitHub latest release API URL
  - fallback release page URL

The GitHub Actions release workflow mostly uses `${GITHUB_REPOSITORY}`, so it should follow the repository where the workflow runs. However, release secrets must be recreated or migrated in the new repository.

## Required Code Changes When Repository Changes
1. Update `package.json` electron-builder publish target.
   - Change `owner` to the new GitHub owner/org.
   - Change `repo` to the new repository name.
2. Update `src/main/auto-update.cts`.
   - Change `REPO` to `<owner>/<repo>`.
   - Confirm `fetchLatestRelease()` reads the new repository.
   - Confirm fallback manual download URL opens the new repository release page.
3. Verify release workflow secrets in the new repository.
   - `MAC_CSC_LINK`
   - `MAC_CSC_KEY_PASSWORD`
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`
   - `WIN_CSC_LINK`
   - `WIN_CSC_KEY_PASSWORD`
4. Create a tagged release in the new repository and confirm update feeds/assets are attached.
   - `latest.yml`
   - `latest-mac.yml`
   - `.dmg`
   - `.zip`
   - `.exe`
   - `.blockmap`

## Auto-Update Verification
1. Build and install an older packaged version.
2. Publish a newer `v*` tag in the new repository.
3. Open the installed app.
4. Confirm update detection uses:
   - `https://api.github.com/repos/<owner>/<repo>/releases/latest`
5. Click install update.
6. Confirm:
   - Windows downloads through `electron-updater`.
   - macOS downloads the new repository `.zip` asset and swaps the app bundle.

## Future Skill: Report Devil-vs-Stock Codex Issues
Goal: create a skill that files an issue in the migrated Devil Codex GitHub repository when something works in stock Codex but fails in Devil Codex.

Recommended behavior:

1. Ask the user for confirmation before creating an issue.
2. Collect a structured bug report:
   - Devil Codex version
   - OS/platform
   - current model/provider
   - workspace path, if safe to disclose
   - exact user action
   - expected stock Codex behavior
   - actual Devil Codex behavior
   - relevant logs or screenshots, after redacting secrets
3. Create an issue in the migrated repository.
4. Apply labels such as:
   - `bug`
   - `codex-parity`
   - `needs-triage`
5. Never upload secrets, API keys, tokens, private file contents, or full transcripts without explicit user confirmation.

Possible implementation options:

- Use GitHub CLI when authenticated:
  - `gh issue create --repo <owner>/<repo>`
- Use a GitHub connector/plugin if available in the Codex environment.
- Use a repository issue template once the target repository is finalized.

## Open Decision
When the new GitHub repository is chosen, decide whether the repository target should remain hard-coded or move into a shared build/release config file so auto-update and issue-reporting skill share the same source of truth.
