import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Code2, Copy, FileText, Folder, FolderOpen, MoreHorizontal, Search, WrapText } from "lucide-react";
import type { ExternalTarget, OpenWorkspaceTarget, WorkspaceEntry, WorkspaceFile } from "../../shared/contracts";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { FileTypeIcon } from "./FileTypeIcon";
import { MarkdownContent, normalizeFileLinkPath } from "./MarkdownContent";

const CodePreview = lazy(() => import("./CodePreview").then((module) => ({ default: module.CodePreview })));

const parentPath = (path: string): string => path.split(/[\\/]/).slice(0, -1).join("/");

export function WorkspaceFilesPanel({ workspace, target }: { workspace: string; target: string | null }): React.JSX.Element {
  const [directories, setDirectories] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [selected, setSelected] = useState<WorkspaceFile | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);
  const [openWith, setOpenWith] = useState(false);
  const [fileMenu, setFileMenu] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [openTargets, setOpenTargets] = useState<OpenWorkspaceTarget[]>([]);
  const openWithRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(openWithRef, () => setOpenWith(false), openWith);
  useOutsideDismiss(fileMenuRef, () => setFileMenu(false), fileMenu);

  const load = useCallback(async (path: string): Promise<void> => {
    const entries = await window.devilCodex.listWorkspaceDirectory({ cwd: workspace, path });
    setDirectories((current) => ({ ...current, [path]: entries }));
  }, [workspace]);

  const openFile = useCallback(async (path: string): Promise<void> => {
    const normalized = normalizeFileLinkPath(path);
    try { setSelected(await window.devilCodex.readWorkspaceFile({ cwd: workspace, path: normalized })); setError(""); }
    catch (reason) { setError(String(reason)); }
  }, [workspace]);

  useEffect(() => { setDirectories({}); setSelected(null); setExpanded(new Set([""])); void load(""); }, [load]);
  useEffect(() => { void window.devilCodex.listOpenWorkspaceTargets().then(setOpenTargets).catch(() => undefined); }, []);
  useEffect(() => {
    if (!target) return;
    const normalizedTarget = normalizeFileLinkPath(target);
    const fallbackTargets = Array.from(new Set([
      normalizedTarget,
      normalizedTarget.replace(/^\.memoc\//i, "memoc/"),
      normalizedTarget.split("/").at(-1) ?? normalizedTarget,
    ].filter(Boolean)));
    Promise.all(fallbackTargets.map((query) => window.devilCodex.findWorkspaceFile({ cwd: workspace, query }).catch(() => null))).then(async (matches) => {
      const path = matches.find(Boolean);
      if (!path) { setError(`파일을 찾을 수 없습니다: ${normalizedTarget}`); return; }
      const parents: string[] = [""];
      let parent = parentPath(path);
      while (parent) { parents.push(parent); parent = parentPath(parent); }
      for (const dir of parents) await load(dir);
      setExpanded(new Set(parents));
      await openFile(path);
    });
  }, [target, workspace, load, openFile]);

  const query = filter.trim().toLowerCase();
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).at(-1) || workspace;
  const parts = selected?.path.split(/[\\/]/).filter(Boolean) ?? [];
  const fullPath = selected ? `${workspace.replace(/[\\/]$/, "")}/${selected.path}` : workspace;
  const isMarkdown = Boolean(selected && /\.mdx?$/i.test(selected.path));
  const openExternal = async (app: ExternalTarget): Promise<void> => {
    setOpenWith(false);
    const result = await window.devilCodex.openWorkspace({ cwd: fullPath, target: app });
    if (!result.ok) setError(result.detail || "파일을 열지 못했습니다.");
  };
  const copy = async (text: string): Promise<void> => { await navigator.clipboard.writeText(text); setFileMenu(false); };
  const rows = useMemo(() => {
    const render = (dir: string, depth: number): React.JSX.Element[] => (directories[dir] ?? []).flatMap((entry) => {
      if (query && !entry.name.toLowerCase().includes(query) && entry.kind === "file") return [];
      const open = expanded.has(entry.path);
      const row = <button type="button" className={selected?.path === entry.path ? "active" : ""} style={{ paddingLeft: 10 + depth * 18 }} key={entry.path} onClick={() => {
        if (entry.kind === "file") { void openFile(entry.path); return; }
        setExpanded((current) => { const next = new Set(current); if (open) next.delete(entry.path); else next.add(entry.path); return next; });
        if (!open && !directories[entry.path]) void load(entry.path);
      }}>{entry.kind === "folder" ? <><ChevronRight className={open ? "open" : ""} size={14} />{open ? <FolderOpen size={16} /> : <Folder size={16} />}</> : <><span className="tree-spacer" /><FileTypeIcon name={entry.name} /></>}<span>{entry.name}</span></button>;
      return entry.kind === "folder" && open ? [row, ...render(entry.path, depth + 1)] : [row];
    });
    return render("", 0);
  }, [directories, expanded, selected, query, load, openFile]);

  return <div className="workspace-files">
    <header>
      <nav className="file-breadcrumb" title={fullPath}><span>{workspaceName}</span>{parts.map((part, index) => <span key={`${index}-${part}`}><ChevronRight size={13} />{part}</span>)}</nav>
      <div className="file-header-actions">
        <div className="file-action-wrap" ref={openWithRef}><button type="button" className="file-open-with" onClick={() => setOpenWith((value) => !value)} disabled={!selected || openTargets.length === 0}><Code2 size={15} /><span>다음으로 열기</span><ChevronDown size={13} /></button>{openWith && <div className="file-popover">{openTargets.map((target) => <button key={target.id} onClick={() => void openExternal(target.id)}>{target.label}</button>)}</div>}</div>
        <div className="file-action-wrap" ref={fileMenuRef}><button type="button" className="file-icon-action" onClick={() => setFileMenu((value) => !value)} disabled={!selected} aria-label="파일 메뉴"><MoreHorizontal size={17} /></button>{fileMenu && <div className="file-popover file-options"><button onClick={() => void copy(fullPath)}><Copy size={15} />경로 복사</button><button onClick={() => void copy(selected?.content || "")}><FileText size={15} />파일 내용 복사</button><button onClick={() => { setWrap((value) => !value); setFileMenu(false); }}><WrapText size={15} />자동 줄 바꿈 {wrap ? "해제" : "사용"}</button></div>}</div>
        <button type="button" className={treeOpen ? "file-icon-action active" : "file-icon-action"} onClick={() => setTreeOpen((value) => !value)} aria-label="파일 트리 열기/닫기"><FolderOpen size={17} /></button>
      </div>
    </header>
    <div className={`workspace-file-body${treeOpen ? "" : " tree-closed"}`}>
      <main>{selected?.kind === "image" ? <img src={selected.content} alt={selected.path} /> : selected?.kind === "text" && isMarkdown ? <div className="workspace-markdown"><MarkdownContent text={selected.content} onOpenFile={(path) => void openFile(path)} /></div> : selected?.kind === "text" ? <Suspense fallback={<div className="file-empty">코드 불러오는 중…</div>}><CodePreview path={selected.path} code={selected.content} wrap={wrap} /></Suspense> : selected ? <pre>{selected.content}</pre> : <div className="file-empty"><FolderOpen size={36} /><strong>파일 열기</strong><span>워크스페이스 트리에서 파일을 선택하세요</span></div>}</main>
      <aside><label><Search size={15} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="파일 필터링…" /></label><div className="workspace-tree">{rows}</div></aside>
    </div>
    {error && <button className="file-error" onClick={() => setError("")}>{error} ×</button>}
  </div>;
}
