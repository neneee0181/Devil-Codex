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
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active || !workspace || !host.current) return;
    let disposed = false;

    const view = new Xterm({
      cursorBlink: true,
      allowProposedApi: true,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
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
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "터미널을 시작할 수 없습니다.");
      }
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      stream();
      onData.dispose();
      if (sessionId.current) void window.devilCodex.closeTerminal({ id: sessionId.current });
      sessionId.current = null;
      view.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [active, workspace, onShell]);

  useEffect(() => {
    if (!active) return;
    const focus = (): void => term.current?.focus();
    const timers = [setTimeout(focus, 90), setTimeout(focus, 340)];
    requestAnimationFrame(focus);
    return () => timers.forEach(clearTimeout);
  }, [active]);

  return <div className="terminal-session" onPointerDown={() => term.current?.focus()}>
    <div className="terminal-xterm" ref={host} />
    {error && <div className="terminal-error">{error}</div>}
  </div>;
}
