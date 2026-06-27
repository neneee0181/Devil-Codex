import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowDown, ArrowLeft, Blocks, CheckSquare, Command, FileSearch, FolderOpen, MessageSquarePlus, Pin, Search, Settings } from "lucide-react";
import type { ThreadSummary } from "../../shared/contracts";
import { isPrimaryModifier, shortcut } from "../shortcuts";

export type CommandId =
  | "new-thread"
  | "search"
  | "thread-find"
  | "settings"
  | "archive"
  | "review"
  | "terminal"
  | "files"
  | "plugins"
  | "open-folder"
  | "toggle-pin"
  | "side-chat"
  | "back"
  | "forward";

type PaletteCommand = {
  id: CommandId;
  section: string;
  label: string;
  detail?: string;
  shortcut?: string;
  icon: typeof Command;
  disabled?: boolean;
};

type Row =
  | { kind: "thread"; id: string; thread: ThreadSummary; shortcut?: string }
  | { kind: "command"; id: CommandId; command: PaletteCommand };

const commands: PaletteCommand[] = [
  { id: "new-thread", section: "제안", label: "새 채팅", shortcut: shortcut("⌘N"), icon: MessageSquarePlus },
  { id: "open-folder", section: "제안", label: "폴더 열기", shortcut: shortcut("⌘O"), icon: FolderOpen },
  { id: "settings", section: "제안", label: "설정", shortcut: shortcut("⌘,"), icon: Settings },
  { id: "files", section: "제안", label: "파일 검색", shortcut: shortcut("⌘P"), icon: Search },
  { id: "new-thread", section: "채팅", label: "새 빠른 채팅", shortcut: shortcut("⌥⌘N"), icon: MessageSquarePlus },
  { id: "archive", section: "채팅", label: "채팅 보관", shortcut: shortcut("⇧⌘A"), icon: Archive },
  { id: "toggle-pin", section: "채팅", label: "고정 켜기/끄기", shortcut: shortcut("⌥⌘P"), icon: Pin },
  { id: "side-chat", section: "채팅", label: "사이드 채팅 열기", shortcut: shortcut("⌥⌘S"), icon: MessageSquarePlus },
  { id: "back", section: "탐색", label: "이전 채팅", shortcut: shortcut("⇧⌘["), icon: ArrowLeft },
  { id: "forward", section: "탐색", label: "다음 채팅", shortcut: shortcut("⇧⌘]"), icon: ArrowDown },
  { id: "thread-find", section: "탐색", label: "찾기", shortcut: shortcut("⌘F"), icon: FileSearch },
  { id: "review", section: "프로젝트", label: "커밋 또는 푸시", icon: CheckSquare },
  { id: "plugins", section: "스킬", label: "스킬로 이동", icon: Blocks },
  { id: "plugins", section: "구성", label: "MCP", icon: Blocks },
];

function basenamePath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path || "Codex";
}

function commandMatches(command: PaletteCommand, query: string): boolean {
  if (!query) return true;
  return `${command.section} ${command.label} ${command.detail ?? ""}`.toLowerCase().includes(query);
}

function threadMatches(thread: ThreadSummary, query: string): boolean {
  if (!query) return true;
  return `${thread.title} ${thread.preview} ${thread.cwd}`.toLowerCase().includes(query);
}

function mergeThreads(primary: ThreadSummary[], fallback: ThreadSummary[]): ThreadSummary[] {
  const byId = new Map<string, ThreadSummary>();
  for (const thread of [...primary, ...fallback]) byId.set(thread.id, thread);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function CommandPalette({
  recentThreads,
  activeThreadId,
  hasActiveThread,
  onClose,
  onOpenThread,
  onRun,
}: {
  recentThreads: ThreadSummary[];
  activeThreadId: string | null;
  hasActiveThread: boolean;
  onClose: () => void;
  onOpenThread: (thread: ThreadSummary) => void;
  onRun: (id: CommandId) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [remoteThreads, setRemoteThreads] = useState<ThreadSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const normalized = query.trim().toLowerCase();

  useEffect(() => {
    if (!normalized) { setRemoteThreads([]); setSearching(false); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void window.devilCodex.searchThreads({ query }).then((results) => {
        if (live) setRemoteThreads(results);
      }).catch(() => {
        if (live) setRemoteThreads([]);
      }).finally(() => {
        if (live) setSearching(false);
      });
    }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, normalized]);

  const visibleThreads = useMemo(() => {
    if (!normalized) return recentThreads.slice(0, 9);
    return mergeThreads(remoteThreads, recentThreads.filter((thread) => threadMatches(thread, normalized))).slice(0, 12);
  }, [recentThreads, remoteThreads, normalized]);

  const visibleCommands = useMemo(() => commands
    .filter((command) => commandMatches(command, normalized))
    .filter((command) => command.id !== "toggle-pin" || hasActiveThread)
    .filter((command) => command.id !== "side-chat" || hasActiveThread)
    .filter((command) => command.id !== "thread-find" || hasActiveThread), [hasActiveThread, normalized]);

  const rows = useMemo<Row[]>(() => [
    ...visibleThreads.map((thread, index) => ({ kind: "thread" as const, id: `thread:${thread.id}`, thread, shortcut: index < 9 ? shortcut(`⌘${index + 1}`) : undefined })),
    ...visibleCommands.map((command, index) => ({ kind: "command" as const, id: `${command.id}:${index}`, command })),
  ], [visibleThreads, visibleCommands]);

  useEffect(() => setActive(0), [query, rows.length]);

  const runRow = (row: Row | undefined): void => {
    if (!row) return;
    if (row.kind === "thread") onOpenThread(row.thread);
    else if (!row.command.disabled) onRun(row.command.id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(rows.length, 1));
      return;
    }
    if (event.key === "Enter") { event.preventDefault(); runRow(rows[active]); return; }
    if (isPrimaryModifier(event) && /^[1-9]$/.test(event.key)) {
      const thread = visibleThreads[Number(event.key) - 1];
      if (thread) { event.preventDefault(); onOpenThread(thread); }
    }
  };

  let rowIndex = 0;
  return <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="채팅 검색 및 명령 실행">
      <header>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="채팅을 검색하거나 명령어를 실행하세요" />
      </header>
      <div className="command-palette-scroll">
        {visibleThreads.length > 0 && <PaletteSection title="채팅">
          {visibleThreads.map((thread) => {
            const index = rowIndex++;
            return <button key={thread.id} className={`palette-row${index === active ? " active" : ""}${thread.id === activeThreadId ? " current" : ""}`} type="button" onMouseEnter={() => setActive(index)} onClick={() => onOpenThread(thread)}>
              <span className="palette-row-title">{thread.title || "새 채팅"}</span>
              <small>{basenamePath(thread.cwd)}</small>
              {index < 9 && <kbd>{shortcut(`⌘${index + 1}`)}</kbd>}
            </button>;
          })}
        </PaletteSection>}

        {searching && <p className="palette-hint">검색 중...</p>}

        {visibleCommands.length > 0 && [...new Set(visibleCommands.map((command) => command.section))].map((section) => <PaletteSection key={section} title={section}>
          {visibleCommands.filter((command) => command.section === section).map((command) => {
            const Icon = command.icon;
            const index = rowIndex++;
            return <button key={`${section}:${command.label}:${command.id}`} className={`palette-row command${index === active ? " active" : ""}`} type="button" onMouseEnter={() => setActive(index)} onClick={() => runRow({ kind: "command", id: command.id, command })}>
              <Icon size={18} />
              <span className="palette-row-title">{command.label}</span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>;
          })}
        </PaletteSection>)}

        {!searching && rows.length === 0 && <p className="palette-hint">일치하는 채팅이나 명령 없음</p>}
      </div>
    </section>
  </div>;
}

function PaletteSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return <section className="palette-section"><h2>{title}</h2><div>{children}</div></section>;
}
