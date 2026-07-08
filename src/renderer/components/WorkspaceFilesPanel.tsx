import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Code2, Copy, FilePlus, FileText, Folder, FolderOpen, FolderInput, FolderPlus, Lock, MoreHorizontal, Pencil, Save, Search, Trash2, WrapText, X } from "lucide-react";
import type { ExternalTarget, OpenWorkspaceTarget, WorkspaceEntry, WorkspaceFile } from "../../shared/contracts";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { FileTypeIcon } from "./FileTypeIcon";
import { MarkdownContent, normalizeFileLinkPath } from "./MarkdownContent";

const CodePreview = lazy(() => import("./CodePreview").then((module) => ({ default: module.CodePreview })));

const parentPath = (path: string): string => path.split(/[\\/]/).slice(0, -1).join("/");

export function WorkspaceFilesPanel({ workspace, target, locked = false }: { workspace: string; target: string | null; locked?: boolean }): React.JSX.Element {
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [externalChanged, setExternalChanged] = useState(false);
  const [treeWidth, setTreeWidth] = useState(() => {
    const stored = Number(localStorage.getItem("devil-codex:file-tree-width"));
    return Number.isFinite(stored) && stored >= 160 ? stored : 260;
  });
  const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry | null } | null>(null);
  const [dialog, setDialog] = useState<{ action: "rename" | "move" | "new-file" | "new-folder" | "delete"; base: string; title: string; value: string; message?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const openWithRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Refs so the fs-change listener (registered once per workspace) reads the
  // latest tree/selection/edit state without re-subscribing on every keystroke.
  const expandedRef = useRef(expanded);
  const selectedRef = useRef(selected);
  const editingRef = useRef(editing);
  const dirtyRef = useRef(false);
  expandedRef.current = expanded;
  selectedRef.current = selected;
  editingRef.current = editing;
  dirtyRef.current = editing && selected ? draft !== selected.content : false;
  useOutsideDismiss(openWithRef, () => setOpenWith(false), openWith);
  useOutsideDismiss(fileMenuRef, () => setFileMenu(false), fileMenu);
  useOutsideDismiss(menuRef, () => setMenu(null), Boolean(menu));
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  const load = useCallback(async (path: string): Promise<void> => {
    const entries = await window.devilCodex.listWorkspaceDirectory({ cwd: workspace, path });
    setDirectories((current) => ({ ...current, [path]: entries }));
  }, [workspace]);

  const openFile = useCallback(async (path: string): Promise<void> => {
    const normalized = normalizeFileLinkPath(path);
    try {
      const file = await window.devilCodex.readWorkspaceFile({ cwd: workspace, path: normalized });
      setSelected(file);
      setEditing(false);
      setExternalChanged(false);
      setError("");
    }
    catch (reason) { setError(String(reason)); }
  }, [workspace]);

  useEffect(() => { setDirectories({}); setSelected(null); setExpanded(new Set([""])); setEditing(false); void load(""); }, [load]);
  useEffect(() => { void window.devilCodex.listOpenWorkspaceTargets().then(setOpenTargets).catch(() => undefined); }, []);

  // Live workspace watch: reload every open directory (so renames/moves/new
  // files appear) and refresh the open file. A mid-edit external change is
  // flagged instead of clobbering the user's unsaved draft.
  useEffect(() => {
    if (!workspace) return;
    void window.devilCodex.watchWorkspaceFiles({ cwd: workspace }).catch(() => undefined);
    const dispose = window.devilCodex.onWorkspaceFilesChanged((payload) => {
      if (payload.cwd && normalizeFileLinkPath(payload.cwd) !== normalizeFileLinkPath(workspace) && payload.cwd !== workspace) return;
      void (async () => {
        await Promise.all(Array.from(expandedRef.current).map((dir) => load(dir).catch(() => undefined)));
        const sel = selectedRef.current;
        if (!sel) return;
        if (editingRef.current && dirtyRef.current) { setExternalChanged(true); return; }
        try {
          const fresh = await window.devilCodex.readWorkspaceFile({ cwd: workspace, path: sel.path });
          setSelected(fresh);
          if (editingRef.current) setDraft(fresh.content);
        } catch { /* file may have been deleted/moved */ }
      })();
    });
    return () => { dispose(); void window.devilCodex.unwatchWorkspaceFiles({ cwd: workspace }).catch(() => undefined); };
  }, [workspace, load]);

  // The AI grabbed write access mid-edit: drop edit mode so we never race a
  // model-driven change with a manual save.
  useEffect(() => { if (locked) { setEditing(false); setMenu(null); setDialog(null); } }, [locked]);

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
  const canEdit = Boolean(selected && selected.kind === "text" && !locked);
  const dirty = editing && selected ? draft !== selected.content : false;

  const startEdit = (): void => {
    if (!selected || selected.kind !== "text" || locked) return;
    setDraft(selected.content);
    setExternalChanged(false);
    setEditing(true);
    setFileMenu(false);
  };
  const cancelEdit = (): void => { setEditing(false); setExternalChanged(false); };
  const save = async (): Promise<void> => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      await window.devilCodex.writeWorkspaceFile({ cwd: workspace, path: selected.path, content: draft });
      setSelected({ ...selected, content: draft });
      setEditing(false);
      setExternalChanged(false);
      setNotice("저장했습니다.");
      window.setTimeout(() => setNotice(""), 2500);
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };

  const startTreeResize = (event: React.MouseEvent): void => {
    event.preventDefault();
    const onMove = (move: MouseEvent): void => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = Math.max(160, Math.min(rect.width - 220, rect.right - move.clientX));
      setTreeWidth(next);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      setTreeWidth((width) => { localStorage.setItem("devil-codex:file-tree-width", String(Math.round(width))); return width; });
    };
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const openExternal = async (app: ExternalTarget): Promise<void> => {
    setOpenWith(false);
    const result = await window.devilCodex.openWorkspace({ cwd: fullPath, target: app });
    if (!result.ok) setError(result.detail || "파일을 열지 못했습니다.");
  };
  const copy = async (text: string): Promise<void> => { await navigator.clipboard.writeText(text); setFileMenu(false); };

  const openMenu = (event: React.MouseEvent, entry: WorkspaceEntry | null): void => {
    event.preventDefault();
    event.stopPropagation();
    if (locked) return;
    // Drop any stray text selection so the native copy menu (main-process
    // context-menu handler keys off selectionText) does not stack on top of
    // this tree menu.
    window.getSelection()?.removeAllRanges();
    // Clamp so the menu never opens off-screen (approx. size; good enough).
    const x = Math.min(event.clientX, window.innerWidth - 184);
    const y = Math.min(event.clientY, window.innerHeight - 200);
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), entry });
  };
  const startDialog = (action: "rename" | "move" | "new-file" | "new-folder" | "delete", entry: WorkspaceEntry | null): void => {
    setMenu(null);
    if (action === "rename" && entry) setDialog({ action, base: entry.path, title: "이름 변경", value: entry.name });
    else if (action === "move" && entry) setDialog({ action, base: entry.path, title: "이동 (워크스페이스 기준 경로)", value: entry.path });
    else if (action === "delete" && entry) setDialog({ action, base: entry.path, title: `'${entry.name}' 삭제`, value: "", message: `${entry.kind === "folder" ? "폴더와 그 안의 모든 항목을" : "이 파일을"} 삭제합니다. 되돌릴 수 없습니다.` });
    else if (action === "new-file") setDialog({ action, base: entry?.path ?? "", title: entry ? `${entry.name}에 새 파일` : "새 파일 (루트)", value: "" });
    else if (action === "new-folder") setDialog({ action, base: entry?.path ?? "", title: entry ? `${entry.name}에 새 폴더` : "새 폴더 (루트)", value: "" });
  };
  const submitDialog = async (): Promise<void> => {
    if (!dialog || busy) return;
    const value = dialog.value.trim();
    if (dialog.action !== "delete" && !value) return;
    setBusy(true);
    try {
      if (dialog.action === "delete") {
        await window.devilCodex.deleteWorkspaceEntry({ cwd: workspace, path: dialog.base });
        if (selectedRef.current && (selectedRef.current.path === dialog.base || selectedRef.current.path.startsWith(`${dialog.base}/`))) { setSelected(null); setEditing(false); }
        await load(parentPath(dialog.base)).catch(() => undefined);
        setNotice("삭제했습니다."); window.setTimeout(() => setNotice(""), 2500);
      } else if (dialog.action === "rename") {
        const parent = parentPath(dialog.base);
        const to = parent ? `${parent}/${value}` : value;
        await window.devilCodex.renameWorkspaceEntry({ cwd: workspace, from: dialog.base, to });
        await Promise.all([load(parent).catch(() => undefined)]);
        if (selectedRef.current?.path === dialog.base) await openFile(to);
      } else if (dialog.action === "move") {
        const from = dialog.base;
        await window.devilCodex.renameWorkspaceEntry({ cwd: workspace, from, to: value });
        await Promise.all([load(parentPath(from)).catch(() => undefined), load(parentPath(value)).catch(() => undefined)]);
        if (selectedRef.current?.path === from) await openFile(value);
      } else {
        const kind = dialog.action === "new-folder" ? "folder" as const : "file" as const;
        const path = dialog.base ? `${dialog.base}/${value}` : value;
        await window.devilCodex.createWorkspaceEntry({ cwd: workspace, path, kind });
        if (dialog.base) setExpanded((current) => new Set(current).add(dialog.base));
        await load(dialog.base).catch(() => undefined);
        if (kind === "file") await openFile(path);
      }
      setDialog(null);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const rows = useMemo(() => {
    const render = (dir: string, depth: number): React.JSX.Element[] => (directories[dir] ?? []).flatMap((entry) => {
      if (query && !entry.name.toLowerCase().includes(query) && entry.kind === "file") return [];
      const open = expanded.has(entry.path);
      const row = <button type="button" className={selected?.path === entry.path ? "active" : ""} style={{ paddingLeft: 10 + depth * 18 }} key={entry.path} onContextMenu={(event) => openMenu(event, entry)} onClick={() => {
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
        {editing
          ? <><button type="button" className="file-open-with" onClick={() => void save()} disabled={saving || !dirty}><Save size={15} /><span>{saving ? "저장 중…" : "저장"}</span></button><button type="button" className="file-icon-action" onClick={cancelEdit} aria-label="편집 취소"><X size={17} /></button></>
          : <button type="button" className="file-open-with" onClick={startEdit} disabled={!canEdit} title={locked ? "AI가 편집 중에는 수정할 수 없습니다" : undefined}>{locked ? <Lock size={15} /> : <Pencil size={15} />}<span>편집</span></button>}
        <div className="file-action-wrap" ref={openWithRef}><button type="button" className="file-open-with" onClick={() => setOpenWith((value) => !value)} disabled={!selected || openTargets.length === 0}><Code2 size={15} /><span>다음으로 열기</span><ChevronDown size={13} /></button>{openWith && <div className="file-popover">{openTargets.map((target) => <button key={target.id} onClick={() => void openExternal(target.id)}>{target.label}</button>)}</div>}</div>
        <div className="file-action-wrap" ref={fileMenuRef}><button type="button" className="file-icon-action" onClick={() => setFileMenu((value) => !value)} disabled={!selected} aria-label="파일 메뉴"><MoreHorizontal size={17} /></button>{fileMenu && <div className="file-popover file-options"><button onClick={() => void copy(fullPath)}><Copy size={15} />경로 복사</button><button onClick={() => void copy(selected?.content || "")}><FileText size={15} />파일 내용 복사</button><button onClick={() => { setWrap((value) => !value); setFileMenu(false); }}><WrapText size={15} />자동 줄 바꿈 {wrap ? "해제" : "사용"}</button></div>}</div>
        <button type="button" className={treeOpen ? "file-icon-action active" : "file-icon-action"} onClick={() => setTreeOpen((value) => !value)} aria-label="파일 트리 열기/닫기"><FolderOpen size={17} /></button>
      </div>
    </header>
    {locked && <div className="file-lock-banner"><Lock size={13} /> AI가 파일을 수정하는 중입니다. 실시간으로 반영되며 직접 편집은 잠시 비활성화됩니다.</div>}
    {editing && externalChanged && <div className="file-lock-banner">이 파일이 외부에서 변경되었습니다. 저장하면 현재 편집 내용으로 덮어씁니다.</div>}
    <div ref={bodyRef} className={`workspace-file-body${treeOpen ? "" : " tree-closed"}`} style={treeOpen ? { gridTemplateColumns: `minmax(0, 1fr) ${treeWidth}px` } : undefined}>
      <main>{editing && selected
        ? <textarea className="file-editor" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Tab") { event.preventDefault(); const el = event.currentTarget; const start = el.selectionStart; const end = el.selectionEnd; const next = `${draft.slice(0, start)}  ${draft.slice(end)}`; setDraft(next); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; }); }
          else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
        }} />
        : selected?.kind === "image" ? <img src={selected.content} alt={selected.path} /> : selected?.kind === "text" && isMarkdown ? <div className="workspace-markdown"><MarkdownContent text={selected.content} onOpenFile={(path) => void openFile(path)} /></div> : selected?.kind === "text" ? <Suspense fallback={<div className="file-empty">코드 불러오는 중…</div>}><CodePreview path={selected.path} code={selected.content} wrap={wrap} /></Suspense> : selected ? <pre>{selected.content}</pre> : <div className="file-empty"><FolderOpen size={36} /><strong>파일 열기</strong><span>워크스페이스 트리에서 파일을 선택하세요</span></div>}</main>
      <aside>{treeOpen && <div className="tree-resizer" onMouseDown={startTreeResize} role="separator" aria-orientation="vertical" title="트리 너비 조절" />}<label><Search size={15} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="파일 필터링…" /></label><div className="workspace-tree" onContextMenu={(event) => openMenu(event, null)}>{rows}<div className="workspace-tree-pad" onContextMenu={(event) => openMenu(event, null)} /></div></aside>
    </div>
    {menu && <div ref={menuRef} className="file-context-menu" style={{ top: menu.y, left: menu.x }}>
      {menu.entry?.kind === "folder" && <><button onClick={() => startDialog("new-file", menu.entry)}><FilePlus size={15} />새 파일</button><button onClick={() => startDialog("new-folder", menu.entry)}><FolderPlus size={15} />새 폴더</button><div className="file-context-sep" /></>}
      {!menu.entry && <><button onClick={() => startDialog("new-file", null)}><FilePlus size={15} />새 파일 (루트)</button><button onClick={() => startDialog("new-folder", null)}><FolderPlus size={15} />새 폴더 (루트)</button></>}
      {menu.entry && <><button onClick={() => startDialog("rename", menu.entry)}><Pencil size={15} />이름 변경</button><button onClick={() => startDialog("move", menu.entry)}><FolderInput size={15} />위치 이동</button><button className="danger" onClick={() => startDialog("delete", menu.entry)}><Trash2 size={15} />삭제</button></>}
    </div>}
    {dialog && <div className="file-dialog-backdrop" onMouseDown={() => setDialog(null)}>
      <form className="file-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitDialog(); }}>
        <strong>{dialog.title}</strong>
        {dialog.message
          ? <p className="file-dialog-message">{dialog.message}</p>
          : <input autoFocus value={dialog.value} onChange={(event) => setDialog((current) => current ? { ...current, value: event.target.value } : current)} onKeyDown={(event) => { if (event.key === "Escape") setDialog(null); }} placeholder={dialog.action === "move" ? "예: src/foo/bar.ts" : "이름 입력"} />}
        <div className="file-dialog-actions"><button type="button" onClick={() => setDialog(null)}>취소</button><button type="submit" className={dialog.action === "delete" ? "danger" : "primary"} disabled={busy || (dialog.action !== "delete" && !dialog.value.trim())}>{busy ? "처리 중…" : dialog.action === "delete" ? "삭제" : "확인"}</button></div>
      </form>
    </div>}
    {notice && <div className="file-save-notice">{notice}</div>}
    {error && <button className="file-error" onClick={() => setError("")}>{error} ×</button>}
  </div>;
}
