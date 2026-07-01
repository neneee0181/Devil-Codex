import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalSession({ active, workspace, onShell }: { active: boolean; workspace: string; onShell: (shell: string) => void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const lastSize = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const resizeTerminal = useRef<() => void>(() => undefined);
  const pasteClipboard = useRef<() => void>(() => undefined);
  const copySelection = useRef<() => boolean>(() => false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active || !workspace || !host.current) return;
    let disposed = false;

    const view = new Xterm({
      cursorBlink: true,
      allowProposedApi: true,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      theme: { background: "#121212", foreground: "#d8d8d8", cursor: "#f5f5f5", cursorAccent: "#121212", selectionBackground: "#3a4a5e" },
    });
    const fitter = new FitAddon();
    view.loadAddon(fitter);
    view.open(host.current);
    term.current = view;
    fit.current = fitter;

    const resize = (): void => {
      if (!host.current?.clientWidth || !host.current.clientHeight) return;
      try { fitter.fit(); } catch { return; }
      if (!sessionId.current) return;
      if (view.cols === lastSize.current.cols && view.rows === lastSize.current.rows) return;
      lastSize.current = { cols: view.cols, rows: view.rows };
      void window.devilCodex.resizeTerminal({ id: sessionId.current, cols: view.cols, rows: view.rows });
    };
    resizeTerminal.current = resize;
    const resizeTimers: Array<ReturnType<typeof setTimeout>> = [];
    const scheduleResize = (): void => {
      requestAnimationFrame(resize);
      [60, 180, 360].forEach((delay) => resizeTimers.push(setTimeout(resize, delay)));
    };
    const observer = new ResizeObserver(() => requestAnimationFrame(resize));
    observer.observe(host.current);

    // The PTY can emit its first prompt before createTerminal resolves and sets
    // sessionId; buffer those early chunks and flush once the id is known.
    const pending: Array<{ id: string; data: string }> = [];
    const stream = window.devilCodex.onTerminalData((event) => {
      if (sessionId.current) { if (event.id === sessionId.current) view.write(event.data); }
      else pending.push(event);
    });
    // passthrough: every keystroke (incl. control, IME-composed text) goes to
    // the PTY, which echoes back; xterm handles editing, clear, selection.
    const onData = view.onData((data) => {
      if (sessionId.current) void window.devilCodex.writeTerminal({ id: sessionId.current, data });
    });
    const pasteText = (text: string): void => {
      if (!text || !sessionId.current) return;
      setError("");
      view.paste(text);
      view.focus();
    };
    pasteClipboard.current = () => {
      try { pasteText(window.devilCodex.clipboardReadText()); }
      catch { setError("클립보드 텍스트를 읽을 수 없습니다."); }
    };
    copySelection.current = () => {
      const selection = view.getSelection();
      if (!selection) return false;
      try {
        window.devilCodex.clipboardWriteText({ text: selection });
        setError("");
        view.clearSelection();
        view.focus();
        return true;
      } catch {
        setError("선택한 터미널 텍스트를 복사할 수 없습니다.");
        return false;
      }
    };
    view.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      const pasteCombo = (command && key === "v") || (event.ctrlKey && event.shiftKey && key === "v") || (event.shiftKey && key === "insert");
      if (pasteCombo) {
        event.preventDefault();
        pasteClipboard.current();
        return false;
      }
      const copyCombo = command && key === "c";
      if (copyCombo && view.getSelection()) {
        event.preventDefault();
        copySelection.current();
        return false;
      }
      return true;
    });
    const hostEl = host.current;
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      event.preventDefault();
      pasteText(text);
    };
    const onCopy = (event: ClipboardEvent): void => {
      const selection = view.getSelection();
      if (!selection) return;
      event.preventDefault();
      event.clipboardData?.setData("text/plain", selection);
      window.devilCodex.clipboardWriteText({ text: selection });
      setError("");
      view.clearSelection();
      view.focus();
    };
    hostEl.addEventListener("paste", onPaste);
    hostEl.addEventListener("copy", onCopy);

    void (async () => {
      try { fitter.fit(); } catch { /* host not laid out yet */ }
      try {
        const session = await window.devilCodex.createTerminal({ cwd: workspace, cols: view.cols || 100, rows: view.rows || 24 });
        if (disposed) { void window.devilCodex.closeTerminal({ id: session.id }); return; }
        sessionId.current = session.id;
        for (const event of pending) if (event.id === session.id) view.write(event.data);
        pending.length = 0;
        lastSize.current = { cols: view.cols, rows: view.rows };
        onShell(session.shell);
        view.focus();
        scheduleResize();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "터미널을 시작할 수 없습니다.");
      }
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      stream();
      onData.dispose();
      resizeTimers.forEach(clearTimeout);
      hostEl.removeEventListener("paste", onPaste);
      hostEl.removeEventListener("copy", onCopy);
      if (sessionId.current) void window.devilCodex.closeTerminal({ id: sessionId.current });
      sessionId.current = null;
      view.dispose();
      term.current = null;
      fit.current = null;
      resizeTerminal.current = () => undefined;
      pasteClipboard.current = () => undefined;
      copySelection.current = () => false;
    };
  }, [active, workspace, onShell]);

  useEffect(() => {
    if (!active) return;
    const focusAndResize = (): void => {
      resizeTerminal.current();
      term.current?.focus();
    };
    const timers = [setTimeout(focusAndResize, 90), setTimeout(focusAndResize, 340), setTimeout(focusAndResize, 680)];
    requestAnimationFrame(focusAndResize);
    return () => timers.forEach(clearTimeout);
  }, [active]);

  return <div
    className="terminal-session"
    onPointerDown={() => term.current?.focus()}
    onContextMenu={(event) => {
      event.preventDefault();
      if (!copySelection.current()) pasteClipboard.current();
    }}
  >
    <div className="terminal-xterm" ref={host} />
    {error && <div className="terminal-error">{error}</div>}
  </div>;
}
