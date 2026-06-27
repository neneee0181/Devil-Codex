# Bundled codex app-server (M4-A2)

Drop the platform `codex` binary here to ship it inside the packaged app:

- macOS / Linux: `vendor/codex/codex`
- Windows: `vendor/codex/codex.exe`

electron-builder copies this folder to `resources/codex/` in the build.
At runtime `app-server.cts` → `codexBin()` resolves in this order:

1. `DEVIL_CODEX_BIN` env override
2. bundled `resources/codex/codex(.exe)`
3. `codex` on PATH (dev / unbundled fallback)

The bundled binary still reads the user's shared `~/.codex`, so stock-Codex
sync keeps working. Binaries are git-ignored; add them in CI or before a
release build. Source: `openai/codex` (Apache-2.0).
