import { useEffect, useState } from "react";
import { Check, GitFork, Plus, X } from "lucide-react";
import type { GitWorktreeInfo } from "../../shared/contracts";

export function WorktreeDialog({ cwd, onClose, onOpen, onError }: {
  cwd: string;
  onClose: () => void;
  onOpen: (path: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [branch, setBranch] = useState("codex/");
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => setWorktrees(await window.devilCodex.listGitWorktrees({ cwd }));
  useEffect(() => { void load().catch((error) => onError(`작업 트리 목록 실패: ${String(error)}`)); }, [cwd]);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const created = await window.devilCodex.createGitWorktree({ cwd, branch });
      await load();
      onOpen(created.path);
      onClose();
    } catch (error) { onError(`작업 트리 생성 실패: ${String(error)}`); }
    finally { setBusy(false); }
  };

  return <div className="git-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="worktree-dialog" role="dialog" aria-modal="true" aria-label="영구 작업 트리">
      <header><span><GitFork size={19} /><strong>영구 작업 트리</strong></span><button type="button" onClick={onClose} aria-label="닫기"><X size={18} /></button></header>
      <div className="worktree-create"><input autoFocus value={branch} onChange={(event) => setBranch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && branch.trim()) void create(); }} placeholder="codex/feature-name" /><button type="button" disabled={busy || !branch.trim()} onClick={() => void create()}><Plus size={15} />{busy ? "생성 중…" : "생성"}</button></div>
      <div className="worktree-list">{worktrees.map((item) => <button type="button" key={item.path} className={item.path === cwd ? "active" : ""} onClick={() => { onOpen(item.path); onClose(); }}><GitFork size={16} /><span><strong>{item.branch}</strong><small>{item.path}</small></span>{item.path === cwd && <Check size={15} />}</button>)}</div>
      <footer>새 작업 트리는 현재 저장소 옆에 생성됩니다.</footer>
    </section>
  </div>;
}
