import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Activity, Bot, Check, ChevronRight, FilePenLine, FileSearch, Minimize2, Search, SquareTerminal, Wrench } from "lucide-react";
import type { ThreadActivityEntry, ThreadHistoryItem } from "../../shared/contracts";
import { AttachmentImageViewer } from "./AttachmentCards";
import { MarkdownContent } from "./MarkdownContent";

type CommandKind = "read" | "search" | "shell";

function durationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function shellCommand(command: string): string {
  const shellMatch = command.match(/\s-lc\s+["']([\s\S]+)["']$/);
  return shellMatch?.[1] ?? command;
}

function commandStatusLabel(entry: ThreadActivityEntry): string {
  if (entry.status === "failed") return "실행 실패";
  if (entry.status === "inProgress") return "실행 중";
  return "실행 완료";
}

function commandKind(command: string): CommandKind {
  if (/\brg\b/.test(command)) return "search";
  if (/SKILL\.md/.test(command) || /\b(?:cat|sed|head|tail|less)\b/.test(command)) return "read";
  return "shell";
}

function commandBasename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function skillReadLabel(command: string): string | undefined {
  const match = command.match(/\/skills\/([^/\s]+)\/SKILL\.md/);
  if (!match) return undefined;
  const name = match[1].replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  return `${name} 스킬 읽기`;
}

function fileReadLabels(command: string): string[] {
  const skill = skillReadLabel(command);
  if (skill) return [skill];
  const matches = command.match(/(?:^|[\s"'])([./~\w@-][^\s"']*\.(?:ts|tsx|cts|css|md|json|toml|yaml|yml|js|jsx|sh|txt))(?=[\s"']|$)/g) ?? [];
  const files = matches.map((value) => commandBasename(value.trim().replace(/^["']|["']$/g, ""))).filter((value) => !value.startsWith("-"));
  return [...new Set(files)].map((file) => `Read ${file}`);
}

function searchLabel(command: string): string {
  const quoted = command.match(/\brg\b(?:\s+-[^\s]+)*\s+["']([^"']+)["']/)?.[1];
  const bare = command.match(/\brg\b(?:\s+-[^\s]+)*\s+([^\s]+)/)?.[1];
  const query = quoted ?? bare ?? shellCommand(command);
  return `Searched for ${query}`;
}

function CommandEntry({ entry }: { entry: ThreadActivityEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const command = shellCommand(entry.title);
  const status = commandStatusLabel(entry);
  return <div className="activity-command">
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <SquareTerminal size={16} />
      <code title={command}>{command}</code>
      <small className={entry.status === "failed" ? "failed" : entry.status === "inProgress" ? "running" : "success"}>{status}</small>
      <ChevronRight className={open ? "open" : ""} size={15} />
    </button>
    {open && <div className="activity-command-output">
      <header>Command</header>
      <pre className="activity-command-full">{command}</pre>
      <header>Output</header>
      <pre>{entry.output || "출력 없음"}</pre>
      <footer className={entry.status === "failed" ? "failed" : "success"}>{entry.status === "failed" ? "실패" : <><Check size={14} /> 성공</>}</footer>
    </div>}
  </div>;
}

function CommandGroup({ kind, entries }: { kind: "read" | "search"; entries: ThreadActivityEntry[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(true);
  const lines = entries.flatMap((entry) => kind === "read" ? fileReadLabels(entry.title) : [searchLabel(entry.title)]).filter(Boolean);
  if (!lines.length) return null;
  const title = kind === "read" ? `파일 ${lines.length}개 읽음` : `코드 검색 ${entries.length}개`;
  const Icon = kind === "read" ? FileSearch : Search;
  return <div className="activity-command-group">
    <button type="button" onClick={() => setOpen((value) => !value)}>
      <Icon size={16} />
      <strong>{title}</strong>
      <ChevronRight className={open ? "open" : ""} size={15} />
    </button>
    {open && <div className="activity-command-group-lines">{lines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</div>}
  </div>;
}

function McpEntry({ entry }: { entry: ThreadActivityEntry }): React.JSX.Element {
  const images = entry.images ?? [];
  const running = entry.status === "inProgress";
  const reduceMotion = useReducedMotion();
  // Always toggleable (never disabled): a disabled button while the result is
  // still streaming silently swallowed the first clicks ("press several times
  // to open"). Open shows the text output, or a running/empty placeholder.
  const [open, setOpen] = useState(false);
  const [viewer, setViewer] = useState<{ src: string; name: string } | null>(null);
  const motionTransition = reduceMotion ? { duration: 0 } : { duration: .18, ease: [.22, 1, .36, 1] as const };
  const toggleOpen = (): void => setOpen((value) => !value);
  const showOutput = Boolean(entry.detail) || running || images.length === 0;
  return <div className="activity-mcp">
    <button
      type="button"
      className="activity-mcp-header"
      aria-expanded={open}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        toggleOpen();
      }}
      onClick={(event) => {
        if (event.detail === 0) toggleOpen();
      }}
    >
      <Wrench size={15} />
      <span>{entry.title}</span>
      {entry.status === "failed" && <b>실패</b>}
      <ChevronRight className={open ? "open" : ""} size={15} />
    </button>
    <AnimatePresence initial={false}>
      {open && <motion.div className="activity-mcp-body" initial={{ height: 0, opacity: 0, y: -3 }} animate={{ height: "auto", opacity: 1, y: 0 }} exit={{ height: 0, opacity: 0, y: -3 }} transition={motionTransition}>
        {images.length > 0 && <div className="activity-mcp-images">
          {images.map((src, index) => {
            const name = `tool image ${index + 1}`;
            return <button type="button" key={index} onClick={() => setViewer({ src, name })}><img src={src} alt={name} loading="lazy" /></button>;
          })}
        </div>}
        {showOutput && <pre className="activity-mcp-output">{entry.detail || (running ? "처리 중…" : "출력 없음")}</pre>}
      </motion.div>}
    </AnimatePresence>
    {viewer && <AttachmentImageViewer viewer={{ attachment: { name: viewer.name, kind: "image", url: viewer.src }, src: viewer.src }} onClose={() => setViewer(null)} />}
  </div>;
}

function WebSearchEntry({ entry }: { entry: ThreadActivityEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <div className="activity-web-search">
    <button type="button" onClick={() => setOpen((value) => !value)}>
      <Search size={16} />
      <span>{entry.title}</span>
      {entry.status === "failed" && <b>실패</b>}
      <ChevronRight className={open ? "open" : ""} size={15} />
    </button>
    {open && <div className="activity-web-search-detail">
      <header>Web search sidecar</header>
      <pre>{entry.detail || "검색 상세 정보 없음"}</pre>
    </div>}
  </div>;
}

function FileChangeEntry({ entry, onOpenFile }: { entry: ThreadActivityEntry; onOpenFile: (path: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return <div className="activity-files">
    <button type="button" className="activity-files-header" onClick={() => setOpen((value) => !value)}>
      <FilePenLine size={15} />
      <strong>{entry.title}</strong>
      <ChevronRight className={open ? "open" : ""} size={15} />
    </button>
    {open && entry.files?.map((file) => <button type="button" key={file.path} onClick={() => onOpenFile(file.path)}>편집함 <span>{file.path}</span><i>+{file.additions}</i><b>-{file.deletions}</b></button>)}
  </div>;
}

function SubagentEntry({ entry, onOpenFile }: { entry: ThreadActivityEntry; onOpenFile: (path: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ThreadHistoryItem[] | null>(null);
  const agentThreadId = entry.subagent?.agentThreadId;
  const statusLabel = entry.status === "inProgress" ? "실행 중" : entry.status === "failed" ? "중단됨" : "완료";
  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next && items === null && agentThreadId) {
      try { setItems(await window.devilCodex.readThread({ id: agentThreadId })); }
      catch { setItems([]); }
    }
  };
  const messages = (items ?? []).filter((item) => item.kind === "user" || item.kind === "agent");
  return <div className="activity-subagent">
    <button type="button" className="activity-subagent-header" onClick={() => void toggle()} disabled={!agentThreadId}>
      <Bot size={15} />
      <strong>{entry.title}</strong>
      <span className="subagent-status">{statusLabel}</span>
      {agentThreadId && <ChevronRight className={open ? "open" : ""} size={15} />}
    </button>
    {open && <div className="activity-subagent-body">
      {items === null ? <em>불러오는 중…</em>
        : messages.length === 0 ? <em>표시할 내용이 없습니다.</em>
        : messages.map((item) => <div key={item.id} className={`subagent-msg ${item.kind}`}><MarkdownContent text={item.text} onOpenFile={onOpenFile} /></div>)}
    </div>}
  </div>;
}

function diagnosticRows(detail: string): { values: Record<string, string>; notes: string[]; errors: string[] } {
  const values: Record<string, string> = {};
  const notes: string[] = [];
  const errors: string[] = [];
  for (const line of detail.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (key === "note") notes.push(value);
    else if (key === "error") errors.push(value);
    else values[key] = value;
  }
  return { values, notes, errors };
}

function DiagnosticEntry({ entry }: { entry: ThreadActivityEntry }): React.JSX.Element {
  const { values, notes, errors } = diagnosticRows(entry.detail ?? "");
  const chips = [
    ["approval", values.approvalPolicy],
    ["sandbox", values.sandbox],
    ["tools", values.tools],
    ["images", values.images],
    ["web", values.webSearch],
    ["diag", values.diagnostics],
  ].filter((item): item is [string, string] => Boolean(item[1]));
  const sidecars = [
    ["Web Search", values["sidecar.webSearch"]],
    ["Vision", values["sidecar.vision"]],
    ["Failures", values["sidecar.failures"]],
  ].filter((item): item is [string, string] => Boolean(item[1]));

  return <div className="activity-diagnostic">
    <header>
      <span><Activity size={15} />{entry.title}</span>
      {values.provider && <b>{values.provider}</b>}
    </header>
    <div className="diagnostic-hero">
      <span><small>model</small><strong>{values.model ?? "unknown"}</strong></span>
      <span><small>route</small><strong>{values.route ?? "unknown"}</strong></span>
      <span><small>reconcile</small><strong>{values.reconcile ?? "unknown"}</strong></span>
    </div>
    {chips.length > 0 && <div className="diagnostic-chips">{chips.map(([key, value]) => <i key={key} className={`diag-${value}`}>{key} {value}</i>)}</div>}
    {sidecars.length > 0 && <div className="diagnostic-sidecars">{sidecars.map(([key, value]) => <span key={key}><small>{key}</small>{value}</span>)}</div>}
    {errors.length > 0 && <div className="diagnostic-errors">{errors.map((error, index) => <p key={`${error}-${index}`}>{error}</p>)}</div>}
  </div>;
}

function ActivityEntry({ entry, onOpenFile }: { entry: ThreadActivityEntry; onOpenFile: (path: string) => void }): React.JSX.Element | null {
  if (entry.kind === "subagent") return <SubagentEntry entry={entry} onOpenFile={onOpenFile} />;
  if (entry.kind === "compaction") return <div className="activity-compaction"><span /><Minimize2 size={15} />{entry.title}<span /></div>;
  if (entry.kind === "command") return <CommandEntry entry={entry} />;
  if (entry.kind === "fileChange") return <FileChangeEntry entry={entry} onOpenFile={onOpenFile} />;
  if (entry.kind === "webSearch") return <WebSearchEntry entry={entry} />;
  if (entry.kind === "mcp") return <McpEntry entry={entry} />;
  if (entry.kind === "diagnostic") return <DiagnosticEntry entry={entry} />;
  if (!entry.detail) return null;
  const isDiagnosticMessage = /진단|provider diagnostic|provider 진단|not supported|지원하지 않습니다|현재 계정\/API 경로/i.test(`${entry.title}\n${entry.detail}`);
  const className = entry.kind === "reasoning" ? "activity-reasoning" : isDiagnosticMessage ? "activity-diagnostic-text" : "activity-message";
  return <div className={className}><MarkdownContent text={entry.detail} onOpenFile={onOpenFile} /></div>;
}

// Render activity entries in chronological order. Only *consecutive* read /
// search commands are merged into a group, so "read → message → read" shows two
// separate read groups in order (not one merged block at the top).
type Block =
  | { type: "group"; kind: "read" | "search"; entries: ThreadActivityEntry[]; key: string }
  | { type: "entry"; entry: ThreadActivityEntry };

function ActivityEntries({ entries, onOpenFile }: { entries: ThreadActivityEntry[]; onOpenFile: (path: string) => void }): React.JSX.Element {
  const blocks: Block[] = [];
  for (const entry of entries) {
    const groupKind = entry.kind === "command" ? (commandKind(entry.title) === "read" ? "read" : commandKind(entry.title) === "search" ? "search" : null) : null;
    if (groupKind) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === "group" && last.kind === groupKind) last.entries.push(entry);
      else blocks.push({ type: "group", kind: groupKind, entries: [entry], key: entry.id });
    } else {
      blocks.push({ type: "entry", entry });
    }
  }
  return <>
    {blocks.map((block) => block.type === "group"
      ? <CommandGroup key={block.key} kind={block.kind} entries={block.entries} />
      : <ActivityEntry key={block.entry.id} entry={block.entry} onOpenFile={onOpenFile} />)}
  </>;
}

function diagnosticSummary(entry: ThreadActivityEntry): string {
  const detail = entry.detail ?? "";
  const provider = detail.match(/^provider: (.+)$/m)?.[1] ?? "";
  const route = detail.match(/^route: (.+)$/m)?.[1] ?? "";
  const web = detail.match(/^sidecar\.webSearch: (.+)$/m)?.[1] ?? "";
  const failures = detail.match(/^sidecar\.failures: (.+)$/m)?.[1] ?? "";
  return [provider ? `provider ${provider}` : "", route, web ? `web ${web}` : "", failures && failures !== "none" ? `fail ${failures}` : ""].filter(Boolean).join(" · ");
}

function latestRunningEntry(entries: ThreadActivityEntry[]): ThreadActivityEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.status === "inProgress") return entry;
  }
  return undefined;
}

function normalizedActivityDetail(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function visibleActivityEntries(entries: ThreadActivityEntry[]): ThreadActivityEntry[] {
  const seenFailedMessages = new Set<string>();
  return entries.filter((entry) => {
    if (entry.kind !== "message" || entry.status !== "failed") return true;
    const detail = normalizedActivityDetail(entry.detail);
    if (!detail) return true;
    const key = `${entry.title ?? ""}:${detail}`;
    if (seenFailedMessages.has(key)) return false;
    seenFailedMessages.add(key);
    return true;
  });
}

function thinkingStatusText(entry: ThreadActivityEntry | undefined): string {
  if (!entry) return "생각중";
  if (entry.kind === "command") return commandKind(entry.title) === "search" ? "코드 살펴보는 중" : commandKind(entry.title) === "read" ? "파일 읽는 중" : "명령 실행 중";
  if (entry.kind === "mcp") return "도구 작업 중";
  if (entry.kind === "webSearch") return "웹 검색 중";
  if (entry.kind === "fileChange") return "변경 정리 중";
  if (entry.kind === "subagent") return "서브에이전트 작업 중";
  if (entry.kind === "reasoning") return "생각중";
  if (entry.kind === "message") return "응답 작성 중";
  return "생각중";
}

export function TurnActivity({ item, onOpenFile }: { item: ThreadHistoryItem; onOpenFile: (path: string) => void }): React.JSX.Element {
  const entries = visibleActivityEntries(item.activities ?? []);
  const hasRunningEntry = entries.some((entry) => entry.status === "inProgress");
  const running = item.status === "inProgress" || hasRunningEntry;
  const failed = !running && item.status === "failed";
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(running);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (failed) { setOpen(true); return; }
    if (!running) { setOpen(false); return; }
    setOpen(true);
    const timer = window.setInterval(() => setTick((value) => value + 1), 700);
    return () => window.clearInterval(timer);
  }, [failed, running]);
  const elapsed = running ? Date.now() - (item.startedAt ?? Date.now()) : item.durationMs ?? 0;
  const runningEntry = latestRunningEntry(entries);
  const diagnosticsEntries = entries.filter((entry) => entry.kind === "diagnostic");
  const summary = useMemo(() => {
    const commands = entries.filter((entry) => entry.kind === "command").length;
    const files = entries.filter((entry) => entry.kind === "fileChange").reduce((total, entry) => total + (entry.files?.length ?? 0), 0);
    const webSearches = entries.filter((entry) => entry.kind === "webSearch").length;
    const tools = entries.filter((entry) => entry.kind === "mcp").length;
    const subagents = entries.filter((entry) => entry.kind === "subagent").length;
    const diagnostics = entries.filter((entry) => entry.kind === "diagnostic").length;
    const labels = [files ? `파일 ${files}개 수정` : "", commands ? `명령어 ${commands}개 실행` : "", webSearches ? `웹 검색 ${webSearches}개` : "", tools ? `도구 ${tools}개 실행` : "", subagents ? `서브에이전트 ${subagents}개` : "", diagnostics ? `진단 ${diagnostics}개` : ""].filter(Boolean);
    return labels.join(" · ");
  }, [entries]);
  const label = running ? `${durationLabel(elapsed)} 동안 작업 중` : failed ? `${durationLabel(elapsed)} 동안 작업 실패` : `${durationLabel(elapsed)} 동안 작업`;
  const dots = ".".repeat((tick % 3) + 1);
  const liveStatus = running ? `${thinkingStatusText(runningEntry)}${dots}` : failed ? "작업 실패" : "작업 완료";

  const motionTransition = reduceMotion ? { duration: 0 } : { duration: .22, ease: [.22, 1, .36, 1] as const };

  return <motion.section layout="position" transition={motionTransition} className={`timeline-item turn-activity${open ? " open" : ""}${running ? " running" : ""}${failed ? " failed" : ""}`}>
    <button type="button" className="turn-activity-toggle" onClick={() => setOpen((value) => !value)}>
      <span className="turn-activity-title-group">
        <span>{label}</span>
        <span className={`turn-activity-live${running ? " running" : failed ? " failed" : ""}`}>
          <Bot size={14} />
          <span className="turn-activity-live-text">{liveStatus}</span>
        </span>
      </span>
      <span className="turn-activity-chevron" aria-hidden="true"><ChevronRight size={16} /></span>
    </button>
    <AnimatePresence initial={false}>
      {!open && diagnosticsEntries.length > 0 && <motion.div className="activity-diagnostic-strip" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={motionTransition}><Activity size={14} /><span>Provider 진단</span><small>{diagnosticSummary(diagnosticsEntries[0])}</small></motion.div>}
    </AnimatePresence>
    <AnimatePresence initial={false}>
      {open && <motion.div className="turn-activity-body" initial={{ height: 0, opacity: 0, y: -4 }} animate={{ height: "auto", opacity: 1, y: 0 }} exit={{ height: 0, opacity: 0, y: -4 }} transition={motionTransition}>
        <div className="activity-thinking-body">
          {summary && <div className="activity-summary"><SquareTerminal size={15} />{summary}</div>}
          <ActivityEntries entries={entries} onOpenFile={onOpenFile} />
          {running && <div className="activity-live-banner activity-live-banner-bottom"><span className="activity-live-pulse" /><Bot size={15} /><strong>{liveStatus}</strong></div>}
        </div>
      </motion.div>}
    </AnimatePresence>
  </motion.section>;
}
