import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Bot, Check, ChevronDown, ChevronRight, ClipboardPaste, Copy, Eraser, Pin, PinOff, RotateCcw, Search, SquareTerminal, Trash2 } from "lucide-react";
import type { TerminalShellId, TerminalShellProfile } from "../../shared/contracts";
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
type TerminalViewState = {
  sessionId: string | null;
  shell: string;
  shellId: TerminalShellId;
  buffer: string;
  entries: CommandEntry[];
  inputBuffer: string;
  activeEntryId: string | null;
  commandSeq: number;
  historyOpen: boolean;
};

const COMMAND_LIMIT = 80;
const OUTPUT_LIMIT = 24000;
const PREVIEW_LIMIT = 4200;
const COMMAND_SETTLE_MS = 2200;
const TERMINAL_BUFFER_LIMIT = 120_000;
const terminalStates = new Map<string, TerminalViewState>();

function storedTerminalShell(): TerminalShellId {
  try {
    const value = JSON.parse(localStorage.getItem("devil-codex:settings") ?? "{}")?.terminalShell;
    return ["auto", "wsl", "git-bash", "pwsh", "powershell", "cmd"].includes(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

function stripAnsi(text: string): string {
  const withoutAnsi = text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n\r/g, "\n")
    .replace(/\r/g, "\n");
  let normalized = "";
  for (const char of withoutAnsi) {
    if (char === "\b" || char === "\u007f") {
      normalized = normalized.slice(0, -1);
      continue;
    }
    normalized += char;
  }
  return normalized.replace(/[ \t]+\n/g, "\n");
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
  terminalKey,
  onShell,
  onSendToComposer,
  onOpenPath,
}: {
  active: boolean;
  workspace: string;
  dock?: TerminalDock;
  terminalKey?: string;
  onShell: (shell: string) => void;
  onSendToComposer?: (text: string) => void;
  onOpenPath?: (path: string) => void;
}): React.JSX.Element {
  const stateKey = terminalKey ?? `${dock}:${workspace}`;
  const saved = terminalStates.get(stateKey);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(saved?.sessionId ?? null);
  const lastSize = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const resizeTerminal = useRef<() => void>(() => undefined);
  const pasteClipboard = useRef<() => void>(() => undefined);
  const copySelection = useRef<() => boolean>(() => false);
  const outputBuffer = useRef(saved?.buffer ?? "");
  const inputBuffer = useRef(saved?.inputBuffer ?? "");
  const activeEntryId = useRef<string | null>(saved?.activeEntryId ?? null);
  const commandSeq = useRef(saved?.commandSeq ?? 0);
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingOutput = useRef(new Map<string, string>());
  const outputFrame = useRef<number | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState("");
  const [shell, setShell] = useState(saved?.shell ?? "연결 중...");
  const [profiles, setProfiles] = useState<TerminalShellProfile[]>([]);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(saved?.historyOpen ?? dock === "bottom");
  const [historyQuery, setHistoryQuery] = useState("");
  const [entries, setEntries] = useState<CommandEntry[]>(saved?.entries ?? []);
  const [shellId, setShellId] = useState<TerminalShellId>(() => saved?.shellId ?? storedTerminalShell());
  const shellRef = useRef(shell);
  const historyOpenRef = useRef(historyOpen);
  const entriesRef = useRef(entries);
  useEffect(() => { shellRef.current = shell; }, [shell]);
  useEffect(() => { historyOpenRef.current = historyOpen; }, [historyOpen]);
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  useEffect(() => {
    const onSettingsChanged = (): void => setShellId(storedTerminalShell());
    window.addEventListener("devil-codex:settings-changed", onSettingsChanged);
    return () => window.removeEventListener("devil-codex:settings-changed", onSettingsChanged);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.devilCodex.listTerminalShells().then((list) => {
      if (alive) setProfiles(list);
    }).catch(() => {
      if (alive) setProfiles([]);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!shellMenuOpen) return;
    const close = (event: PointerEvent): void => {
      if ((event.target as Element | null)?.closest(".terminal-shell-picker")) return;
      setShellMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [shellMenuOpen]);

  const rememberState = (): void => {
    terminalStates.set(stateKey, {
      sessionId: sessionId.current,
      shell: shellRef.current,
      shellId,
      buffer: outputBuffer.current,
      entries: entriesRef.current,
      inputBuffer: inputBuffer.current,
      activeEntryId: activeEntryId.current,
      commandSeq: commandSeq.current,
      historyOpen: historyOpenRef.current,
    });
  };

  const switchShell = (nextShellId: TerminalShellId): void => {
    setShellMenuOpen(false);
    if (nextShellId === shellId) {
      term.current?.focus();
      return;
    }
    if (sessionId.current) {
      void window.devilCodex.closeTerminal({ id: sessionId.current });
      sessionId.current = null;
    }
    outputBuffer.current = "";
    inputBuffer.current = "";
    activeEntryId.current = null;
    lastSize.current = { cols: 0, rows: 0 };
    setShell("연결 중...");
    onShell("연결 중...");
    terminalStates.delete(stateKey);
    setShellId(nextShellId);
  };

  const showError = (message: string): void => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = setTimeout(() => {
      setError("");
      errorTimer.current = null;
    }, 3200);
  };

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
      { id, command: clean, output: "", startedAt: Date.now(), pinned: false, collapsed: false, status: "running" as const },
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
    pendingOutput.current.set(id, `${pendingOutput.current.get(id) ?? ""}${data}`);
    if (outputFrame.current == null) {
      outputFrame.current = requestAnimationFrame(() => {
        outputFrame.current = null;
        const chunks = pendingOutput.current;
        pendingOutput.current = new Map();
        setEntries((current) => current.map((entry) => {
          const chunk = chunks.get(entry.id);
          return chunk ? { ...entry, output: compactOutput(`${entry.output}${chunk}`), status: "running" } : entry;
        }));
      });
    }
    scheduleSettle(id);
  };

  const writeCommand = (command: string): void => {
    if (!sessionId.current) return;
    startCommand(command);
    void window.devilCodex.writeTerminal({ id: sessionId.current, data: `${command}\r` });
    term.current?.focus();
  };

  const copyText = (text: string): void => {
    void (async () => {
      try {
        await window.devilCodex.clipboardWriteText({ text });
        setError("");
      } catch (reason) {
        console.warn("[terminal] clipboard write failed", reason);
        showError("텍스트를 클립보드에 복사할 수 없습니다.");
      }
    })();
  };

  const copyToClipboard = async (text: string, failureMessage: string): Promise<boolean> => {
    try {
      await window.devilCodex.clipboardWriteText({ text });
      setError("");
      return true;
    } catch {
      showError(failureMessage);
      return false;
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
    const scheduleResize = (delays = [40, 120, 280, 520, 900]): void => {
      requestAnimationFrame(() => requestAnimationFrame(resize));
      delays.forEach((delay) => resizeTimers.push(setTimeout(resize, delay)));
    };
    const observer = new ResizeObserver(() => scheduleResize([30, 120]));
    observer.observe(host.current);
    const dockEl = host.current.closest(".bottom-dock");
    if (dockEl) observer.observe(dockEl);
    const onTransitionEnd = (event: Event): void => {
      if (event.target === dockEl) scheduleResize([0, 80, 220]);
    };
    dockEl?.addEventListener("transitionend", onTransitionEnd);
    if ("fonts" in document) {
      void document.fonts.ready.then(() => {
        if (!disposed) scheduleResize([0, 140]);
      });
    }

    // The PTY can emit its first prompt before createTerminal resolves and sets
    // sessionId; buffer those early chunks and flush once the id is known.
    const pending: Array<{ id: string; data: string }> = [];
    const stream = window.devilCodex.onTerminalData((event) => {
      if (sessionId.current) {
        if (event.id === sessionId.current) {
          outputBuffer.current = `${outputBuffer.current}${event.data}`.slice(-TERMINAL_BUFFER_LIMIT);
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
        bridgeText = await window.devilCodex.clipboardReadText();
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
          showError("클립보드 텍스트를 읽을 수 없습니다.");
          view.focus();
        }
      })();
    };
    copySelection.current = () => {
      const selection = view.getSelection();
      if (!selection) return false;
      void (async () => {
        const copied = await copyToClipboard(selection, "선택한 터미널 텍스트를 복사할 수 없습니다.");
        if (!copied) return;
        view.clearSelection();
        view.focus();
      })();
      return true;
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
      const copyCombo = (command && key === "c") || (event.ctrlKey && event.shiftKey && key === "c");
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
      void (async () => {
        const copied = await copyToClipboard(selection, "선택한 터미널 텍스트를 복사할 수 없습니다.");
        if (!copied) return;
        view.clearSelection();
        view.focus();
      })();
    };
    hostEl.addEventListener("paste", onPaste, { capture: true });
    hostEl.addEventListener("copy", onCopy);

    void (async () => {
      resize();
      scheduleResize([0, 80, 180]);
      try {
        const session = await window.devilCodex.createTerminal({ cwd: workspace, cols: view.cols || 100, rows: view.rows || 24, key: terminalKey, shellId });
        if (disposed) {
          if (!terminalKey) void window.devilCodex.closeTerminal({ id: session.id });
          return;
        }
        sessionId.current = session.id;
        const replay = session.buffer ?? outputBuffer.current;
        if (replay) {
          outputBuffer.current = replay.slice(-TERMINAL_BUFFER_LIMIT);
          view.write(replay);
        }
        for (const event of pending) if (event.id === session.id) {
          outputBuffer.current = `${outputBuffer.current}${event.data}`.slice(-TERMINAL_BUFFER_LIMIT);
          view.write(event.data);
          appendOutput(event.data);
        }
        pending.length = 0;
        lastSize.current = { cols: view.cols, rows: view.rows };
        setShell(session.shellLabel ?? session.shell);
        onShell(session.shellLabel ?? session.shell);
        view.focus();
        scheduleResize();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "터미널을 시작할 수 없습니다.");
      }
    })();

    return () => {
      disposed = true;
      observer.disconnect();
      dockEl?.removeEventListener("transitionend", onTransitionEnd);
      stream();
      onData.dispose();
      resizeTimers.forEach(clearTimeout);
      hostEl.removeEventListener("paste", onPaste, { capture: true });
      hostEl.removeEventListener("copy", onCopy);
      rememberState();
      if (sessionId.current && !terminalKey) void window.devilCodex.closeTerminal({ id: sessionId.current });
      settleTimers.current.forEach((timer) => clearTimeout(timer));
      settleTimers.current.clear();
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = null;
      if (outputFrame.current != null) cancelAnimationFrame(outputFrame.current);
      outputFrame.current = null;
      pendingOutput.current.clear();
      if (!terminalKey) {
        sessionId.current = null;
        inputBuffer.current = "";
        activeEntryId.current = null;
      }
      view.dispose();
      term.current = null;
      fit.current = null;
      resizeTerminal.current = () => undefined;
      pasteClipboard.current = () => undefined;
      copySelection.current = () => false;
    };
  }, [active, workspace, onShell, stateKey, terminalKey, shellId]);

  useEffect(() => { rememberState(); }, [shell, shellId, entries, historyOpen, stateKey]);

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
        <div className="terminal-shell-picker" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="terminal-shell-trigger" onClick={() => setShellMenuOpen((value) => !value)} aria-label="터미널 Shell 선택" title="터미널 Shell 선택"><SquareTerminal size={15} /><ChevronDown size={13} /></button>
          {shellMenuOpen && <div className="terminal-shell-menu">
            {(profiles.length ? profiles : [{ id: "auto" as TerminalShellId, label: "자동", available: true, detail: "shell 목록을 불러오는 중" }]).map((profile) => (
              <button type="button" key={profile.id} className={profile.id === shellId ? "active" : ""} disabled={!profile.available} onClick={() => switchShell(profile.id)}>
                <span><strong>{profile.label}</strong>{profile.detail && <small>{profile.detail}</small>}</span>
                {profile.id === shellId && <Check size={14} />}
              </button>
            ))}
          </div>}
        </div>
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
