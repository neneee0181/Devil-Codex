import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Bot, ChevronDown, ChevronRight, ClipboardPaste, Copy, Eraser, Pin, PinOff, RotateCcw, Search, Trash2 } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

type TerminalDock = "bottom" | "right";
type CommandEntry = {
  id: string;
  command: string;
  output: string;
  startedAt: number;
  pinned: boolean;
  collapsed: boolean;
  status: "running" | "done";
};

const COMMAND_LIMIT = 80;
const OUTPUT_LIMIT = 24000;
const PREVIEW_LIMIT = 4200;
const COMMAND_SETTLE_MS = 2200;

function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function compactOutput(text: string, limit = OUTPUT_LIMIT): string {
  const clean = stripAnsi(text);
  return clean.length > limit ? clean.slice(clean.length - limit) : clean;
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || path;
}

function normalizePathCandidate(raw: string, workspace: string): string {
  const trimmed = raw.replace(/^[("'`]+|[)"'`,;]+$/g, "").replace(/:(\d+)(?::\d+)?$/, "");
  const normalized = trimmed.replace(/\\/g, "/");
  const root = workspace.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

function pathCandidates(text: string, workspace: string): string[] {
  const matches = text.match(/(?:[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\.{1,2}[\\/]|[\w.-]+[\\/])[\w./\\ -]+\.\w{1,12}(?::\d+(?::\d+)?)?)/g) ?? [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of matches) {
    const path = normalizePathCandidate(match, workspace);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= 4) break;
  }
  return paths;
}

function formatForComposer(entry: CommandEntry): string {
  const output = compactOutput(entry.output || "(출력 없음)", 8000);
  return `터미널 명령 결과를 확인해줘.\n\n명령:\n\`\`\`text\n${entry.command}\n\`\`\`\n\n출력:\n\`\`\`text\n${output}\n\`\`\``;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value);
}

function outputHasError(output: string): boolean {
  return /\b(error|failed|failure|exception|traceback|unauthorized|denied|fatal)\b/i.test(output);
}

function skipInputEscape(data: string, start: number): number {
  const marker = data[start + 1];
  if (!marker) return start + 1;
  if (marker === "[") {
    let index = start + 2;
    while (index < data.length) {
      const code = data.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
      index += 1;
    }
    return data.length;
  }
  if (marker === "]") {
    let index = start + 2;
    while (index < data.length) {
      if (data[index] === "\u0007") return index + 1;
      if (data[index] === "\u001b" && data[index + 1] === "\\") return index + 2;
      index += 1;
    }
    return data.length;
  }
  return start + 2;
}

export function TerminalSession({
  active,
  workspace,
  dock = "bottom",
  onShell,
  onSendToComposer,
  onOpenPath,
}: {
  active: boolean;
  workspace: string;
  dock?: TerminalDock;
  onShell: (shell: string) => void;
  onSendToComposer?: (text: string) => void;
  onOpenPath?: (path: string) => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const lastSize = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const resizeTerminal = useRef<() => void>(() => undefined);
  const pasteClipboard = useRef<() => void>(() => undefined);
  const copySelection = useRef<() => boolean>(() => false);
  const inputBuffer = useRef("");
  const activeEntryId = useRef<string | null>(null);
  const commandSeq = useRef(0);
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [error, setError] = useState("");
  const [shell, setShell] = useState("연결 중...");
  const [historyOpen, setHistoryOpen] = useState(dock === "bottom");
  const [historyQuery, setHistoryQuery] = useState("");
  const [entries, setEntries] = useState<CommandEntry[]>([]);

  const settleEntry = (id: string): void => {
    const timer = settleTimers.current.get(id);
    if (timer) clearTimeout(timer);
    settleTimers.current.delete(id);
    if (activeEntryId.current === id) activeEntryId.current = null;
    setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, status: "done" as const } : entry));
  };

  const scheduleSettle = (id: string): void => {
    const timer = settleTimers.current.get(id);
    if (timer) clearTimeout(timer);
    settleTimers.current.set(id, setTimeout(() => settleEntry(id), COMMAND_SETTLE_MS));
  };

  const removeEntry = (id: string): void => {
    const timer = settleTimers.current.get(id);
    if (timer) clearTimeout(timer);
    settleTimers.current.delete(id);
    if (activeEntryId.current === id) activeEntryId.current = null;
    setEntries((current) => current.filter((entry) => entry.id !== id));
  };

  const startCommand = (command: string): void => {
    const clean = command.trim();
    if (!clean) return;
    const id = `cmd-${Date.now()}-${commandSeq.current++}`;
    activeEntryId.current = id;
    setEntries((current) => [
      { id, command: clean, output: "", startedAt: Date.now(), pinned: false, collapsed: false, status: "running" },
      ...current.map((entry) => entry.status === "running" ? { ...entry, status: "done" as const } : entry),
    ].slice(0, COMMAND_LIMIT));
    scheduleSettle(id);
  };

  const trackInput = (data: string): void => {
    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (char === "\r" || char === "\n") {
        startCommand(inputBuffer.current);
        inputBuffer.current = "";
      } else if (char === "\u0003") {
        inputBuffer.current = "";
      } else if (char === "\u0015") {
        inputBuffer.current = "";
      } else if (char === "\u0017") {
        inputBuffer.current = inputBuffer.current.trimEnd().replace(/\S+\s*$/, "");
      } else if (char === "\u001b") {
        index = skipInputEscape(data, index);
        continue;
      } else if (char === "\u007f" || char === "\b") {
        inputBuffer.current = inputBuffer.current.slice(0, -1);
      } else if (char >= " ") {
        inputBuffer.current += char;
      }
      index += 1;
    }
  };

  const appendOutput = (data: string): void => {
    const id = activeEntryId.current;
    if (!id) return;
    setEntries((current) => current.map((entry) => (
      entry.id === id ? { ...entry, output: compactOutput(`${entry.output}${data}`), status: "running" } : entry
    )));
    scheduleSettle(id);
  };

  const writeCommand = (command: string): void => {
    if (!sessionId.current) return;
    startCommand(command);
    void window.devilCodex.writeTerminal({ id: sessionId.current, data: `${command}\r` });
    term.current?.focus();
  };

  const copyText = (text: string): void => {
    try {
      window.devilCodex.clipboardWriteText({ text });
      setError("");
    } catch {
      setError("텍스트를 클립보드에 복사할 수 없습니다.");
    }
  };

  const visibleEntries = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    const filtered = query ? entries.filter((entry) => `${entry.command}\n${entry.output}`.toLowerCase().includes(query)) : entries;
    return [...filtered].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.startedAt - a.startedAt);
  }, [entries, historyQuery]);

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
      if (sessionId.current) {
        if (event.id === sessionId.current) {
          view.write(event.data);
          appendOutput(event.data);
        }
      }
      else pending.push(event);
    });
    // passthrough: every keystroke (incl. control, IME-composed text) goes to
    // the PTY, which echoes back; xterm handles editing, clear, selection.
    const onData = view.onData((data) => {
      trackInput(data);
      if (sessionId.current) void window.devilCodex.writeTerminal({ id: sessionId.current, data });
    });
    const pasteText = (text: string): void => {
      if (!text || !sessionId.current) return;
      setError("");
      view.paste(text);
      view.focus();
    };
    const readClipboardText = async (): Promise<string> => {
      let bridgeText: string | null = null;
      let bridgeError: unknown;
      try {
        bridgeText = window.devilCodex.clipboardReadText();
        if (bridgeText) return bridgeText;
      } catch (reason) {
        bridgeError = reason;
      }
      if (navigator.clipboard?.readText) {
        try {
          const webText = await navigator.clipboard.readText();
          if (webText) return webText;
        } catch {
          // Fall back to the preload result/error below.
        }
      }
      if (bridgeText !== null) return bridgeText;
      throw bridgeError ?? new Error("Clipboard text read failed");
    };
    pasteClipboard.current = () => {
      void (async () => {
        try { pasteText(await readClipboardText()); }
        catch {
          setError("클립보드 텍스트를 읽을 수 없습니다.");
          view.focus();
        }
      })();
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
        return true;
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
      event.stopPropagation();
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
    hostEl.addEventListener("paste", onPaste, { capture: true });
    hostEl.addEventListener("copy", onCopy);

    void (async () => {
      try { fitter.fit(); } catch { /* host not laid out yet */ }
      try {
        const session = await window.devilCodex.createTerminal({ cwd: workspace, cols: view.cols || 100, rows: view.rows || 24 });
        if (disposed) { void window.devilCodex.closeTerminal({ id: session.id }); return; }
        sessionId.current = session.id;
        for (const event of pending) if (event.id === session.id) {
          view.write(event.data);
          appendOutput(event.data);
        }
        pending.length = 0;
        lastSize.current = { cols: view.cols, rows: view.rows };
        setShell(session.shell);
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
      hostEl.removeEventListener("paste", onPaste, { capture: true });
      hostEl.removeEventListener("copy", onCopy);
      if (sessionId.current) void window.devilCodex.closeTerminal({ id: sessionId.current });
      settleTimers.current.forEach((timer) => clearTimeout(timer));
      settleTimers.current.clear();
      sessionId.current = null;
      inputBuffer.current = "";
      activeEntryId.current = null;
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
    className={`terminal-session terminal-wave terminal-${dock}${historyOpen ? " history-open" : ""}`}
    onPointerDown={() => term.current?.focus()}
    onContextMenu={(event) => {
      event.preventDefault();
      if (!copySelection.current()) pasteClipboard.current();
    }}
  >
    <div className="terminal-wave-toolbar">
      <div className="terminal-wave-title">
        <span className="terminal-live-dot" />
        <strong>{shell.split(/[\\/]/).at(-1) || shell}</strong>
        <small title={workspace}>{workspace}</small>
      </div>
      <div className="terminal-wave-actions">
        <button type="button" onClick={(event) => { event.stopPropagation(); setHistoryOpen((value) => !value); resizeTerminal.current(); }} aria-label={historyOpen ? "명령 기록 숨기기" : "명령 기록 보기"} title={historyOpen ? "명령 기록 숨기기" : "명령 기록 보기"}>{historyOpen ? <ChevronRight size={15} /> : <ChevronLeftIcon />}</button>
        <button type="button" onClick={(event) => { event.stopPropagation(); copySelection.current(); }} aria-label="선택 복사" title="선택 복사"><Copy size={15} /></button>
        <button type="button" onClick={(event) => { event.stopPropagation(); pasteClipboard.current(); }} aria-label="붙여넣기" title="붙여넣기"><ClipboardPaste size={15} /></button>
        <button type="button" onClick={(event) => { event.stopPropagation(); term.current?.clear(); term.current?.focus(); }} aria-label="터미널 화면 지우기" title="터미널 화면 지우기"><Eraser size={15} /></button>
        <button type="button" onClick={(event) => { event.stopPropagation(); resizeTerminal.current(); term.current?.focus(); }} aria-label="터미널 맞춤" title="터미널 맞춤"><RotateCcw size={15} /></button>
      </div>
    </div>
    <div className="terminal-wave-body">
      <div className="terminal-xterm" ref={host} />
      {historyOpen && <aside className="terminal-command-panel" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <strong>명령 블록</strong>
          <small>{entries.length}개</small>
        </header>
        <label className="terminal-command-search">
          <Search size={14} />
          <input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="명령/출력 검색" />
        </label>
        <div className="terminal-command-list">
          {visibleEntries.length === 0 ? <p>{entries.length === 0 ? "아직 실행한 명령이 없습니다." : "검색 결과 없음"}</p> : visibleEntries.map((entry) => {
            const output = compactOutput(entry.output, PREVIEW_LIMIT).trim();
            const paths = pathCandidates(output, workspace);
            const danger = outputHasError(output);
            return <article key={entry.id} className={`terminal-command-card${entry.pinned ? " pinned" : ""}${danger ? " danger" : ""}`}>
              <header>
                <button type="button" className="terminal-command-collapse" onClick={() => setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, collapsed: !item.collapsed } : item))} aria-label={entry.collapsed ? "명령 펼치기" : "명령 접기"}>
                  {entry.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <span>
                  <strong title={entry.command}>{entry.command}</strong>
                  <small>{entry.status === "running" ? "실행 중" : "완료 추정"} · {formatTime(entry.startedAt)}</small>
                </span>
              </header>
              {!entry.collapsed && <>
                <pre>{output || (entry.status === "running" ? "출력 대기 중..." : "출력 없음")}</pre>
                {paths.length > 0 && <div className="terminal-path-row">{paths.map((path) => <button type="button" key={path} title={path} onClick={() => onOpenPath?.(path)}>{shortPath(path)}</button>)}</div>}
                <footer>
                  <button type="button" onClick={() => copyText(entry.command)} title="명령 복사"><Copy size={13} />명령</button>
                  <button type="button" onClick={() => copyText(output || entry.output)} title="출력 복사"><Copy size={13} />출력</button>
                  <button type="button" onClick={() => writeCommand(entry.command)} title="다시 실행"><RotateCcw size={13} />재실행</button>
                  <button type="button" onClick={() => onSendToComposer?.(formatForComposer(entry))} title="채팅 입력으로 보내기"><Bot size={13} />AI</button>
                  <button type="button" onClick={() => setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, pinned: !item.pinned } : item))} title={entry.pinned ? "고정 해제" : "고정"}>{entry.pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
                  <button type="button" onClick={() => removeEntry(entry.id)} title="기록 삭제"><Trash2 size={13} /></button>
                </footer>
              </>}
            </article>;
          })}
        </div>
      </aside>}
    </div>
    {error && <div className="terminal-error">{error}</div>}
  </div>;
}

function ChevronLeftIcon(): React.JSX.Element {
  return <ChevronRight size={15} style={{ transform: "rotate(180deg)" }} />;
}
