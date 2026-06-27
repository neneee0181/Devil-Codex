---
memoc: true
type: worklog
scope: project-memory
created: 2026-06-22T03:46:30
updated: 2026-06-22T03:46:30
status: active
tags:
  - memoc
  - memoc/worklog
---
# Fix terminal: node-pty spawn-helper not executable

actor: neneee0181
actor_source: git config user.name
branch: main
status: done
created: 2026-06-22T03:46:30

## Summary

- Root cause: `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` shipped as `-rw-r--r--` (not executable) → `posix_spawnp failed` → PTY never starts, terminal dead. node-pty itself loads fine (N-API prebuild, Electron-ABI compatible).
- Fix: `chmod +x` the spawn-helper, plus durable `scripts/fix-pty.cjs` wired as `postinstall` so reinstalls re-apply +x to every `prebuilds/*/spawn-helper`.
- Added `build.asarUnpack: node_modules/node-pty/**` so the helper stays an executable file (not inside asar) in packaged builds. No design/UX change — existing native-input + PTY-scrollback terminal kept.

## Changed Files

- `package.json` (postinstall script + asarUnpack)
- `scripts/fix-pty.cjs` (new)

## Verification

- `ELECTRON_RUN_AS_NODE=1 electron -e <pty spawn test>` → "PTY WORKS" (was "posix_spawnp failed" before chmod).
- `node scripts/fix-pty.cjs` re-applies +x. `npm run build` passes.

## Follow-up

- If terminal breaks again after `npm install`, confirm postinstall ran (`ls -l node_modules/node-pty/prebuilds/*/spawn-helper` should be `-rwxr-xr-x`).

## Addendum (2026-06-22) — typed input not visible

- After PTY fixed, user saw no typed text. Root cause via CDP (remote-debugging-port 9222, Input/Runtime domains): the `.terminal-command input` was visible/enabled but NOT focused on dock open (`document.activeElement` was body) → OS keystrokes went nowhere. DOM-level value binding + colors were fine all along.
- Fixes in `TerminalSession.tsx`: robust autofocus on open (rAF + setTimeout 80ms/320ms to outlast the .28s flex-basis dock animation); explicit Enter handling in `onKeyDown` (CDP-confirmed implicit form submit was unreliable) via shared `runCommand()`; dedupe `resize` (skip when cols/rows unchanged) to stop SIGWINCH prompt-spam during the open animation. Added visible green `❯` prompt marker (`.terminal-prompt`).
- Verified via CDP e2e: type "echo HELLO_TERM" → input shows it → Enter → input clears → output contains `HELLO_TERM`. `npm run build` passes.

## Addendum 2 (2026-06-22) — inline xterm terminal

- User wanted typing inline next to the live `user@host %` prompt, not a detached bottom input box with its own `❯`. Replaced the native-input + stripped-`<pre>` approach with **xterm.js** (`@xterm/xterm` + `@xterm/addon-fit`, already deps) in `TerminalSession.tsx`. Passthrough only: `term.onData → writeTerminal`, `onTerminalData → term.write` (NO local echo — the prior xterm attempt double-echoed, which is why it had been reverted). Removed `terminalText.ts` (dead) and the `.terminal-output/.terminal-command/.terminal-prompt/input` CSS; added `.terminal-xterm` fill rules.
- Why it works now: the spawn-helper chmod fix means the PTY actually emits data; and xterm v6 renders via DOM (CDP showed `canvasCount: 0`), so the earlier "Electron-invisible canvas" worry doesn't apply. xterm's hidden textarea also handles IME/Korean and the inline cursor for free.
- Verified via CDP (port 9222): xterm `.xterm-rows` shows the real zsh prompt; `Input.insertText("echo INLINE_OK")` appears inline after `%` (single echo, no doubling); Enter runs it (`INLINE_OK` in output); textarea auto-focused on dock open. `npm run build` passes.

## Addendum 3 (2026-06-22) — xterm rendered blank (compositing bug, the real reason it was reverted before)

- Symptom: terminal dock fully black; `.xterm-rows` had correct text + non-zero glyph spans (w≈322), color #d8d8d8, visible — but NOT painted. CDP `Page.captureScreenshot` confirmed blank; `elementFromPoint` over a row returned the host, not the span. So it was always a PAINT problem, not data/focus/size. This is the same "Electron-invisible xterm" the prior agent hit and why they fell back to a native input.
- Root cause: Electron/Chromium compositing — xterm's DOM-renderer rows get promoted to a layer that lays out but never recomposites after writes. Diagnosis method: injected CSS via CDP and screenshotted iteratively.
- Fix (in `TerminalSession.tsx` + `styles.css`): (1) `transform: translateZ(0)` on `.xterm-screen`/`.xterm-rows` to own a layer; (2) a coalesced per-frame **opacity nudge** on `.xterm` fired from `view.write(data, nudge)`, the settle timers, and after create — this invalidates the layer so it repaints. Static translateZ alone was NOT enough; the nudge is required.
- Verified via CDP on a FRESH reload (no injection): prompt + block cursor paint; `Input.insertText` shows inline next to `%`. Build passes.
- Follow-up: if terminal goes blank again, the nudge or translateZ was removed. Consider `@xterm/addon-webgl` as a sturdier long-term renderer.

## Addendum 4 (2026-06-22) — xterm abandoned; plain <pre> passthrough + portal menu

- xterm's Electron compositing blank was NOT reliably fixable: CDP/devtools attachment masks the bug (CDP screenshots looked fine) but the user (no devtools) still saw black, and the translateZ+nudge hack was unverifiable/insufficient in real use. Decision: drop xterm entirely.
- New terminal = plain `<pre>` passthrough (paints reliably, no layer promotion):
  - `terminalBuffer.ts`: minimal terminal model — strips CSI/OSC escapes, applies CR/LF/BS/TAB into a line/col buffer; rAF-coalesced render into `<pre>`.
  - `TerminalSession.tsx`: a transparent overlay `<textarea>` captures keys (IME via onCompositionEnd/onInput, control keys via keydown → control bytes incl `\x1b[…` arrows, `\x7f` backspace, `\x03` ctrl-c) and sends to the PTY; the PTY echoes back into the `<pre>` so typing shows inline next to the real `%` prompt. Removed `@xterm/*` usage + the `xterm.css` import.
- Dock `+` launcher didn't open: the menu lived inside the dock (`.terminal{overflow:hidden}`) and under the absolute terminal capture overlay → clipped/hidden; the right dock's copy also ran off-screen. Fix: render `.dock-tab-menu` through `createPortal(document.body)` with `position:fixed` anchored to the `+` button rect (clamped to viewport). `useOutsideDismiss` gained an optional `ignoreRef` so clicking the toggle doesn't double-close.
- Verified via CDP screenshot (fresh reload): prompt + typed `echo HELLO` paint inline; bottom `+` opens the launcher (검토/터미널/브라우저/파일/사이드 채팅) on top of the dock. Build passes.

## Related

- [Activity](../../../activity.md)
- [Worklog](../../README.md)
- [Actor](../../../actors/neneee0181.md)
