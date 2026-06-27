import { useEffect, useState } from "react";
import { Check, GitBranch, GitCommitHorizontal, GitPullRequestDraft, Plus, UploadCloud, X } from "lucide-react";
import type { GitBranchInfo, WorkspaceChanges } from "../../shared/contracts";

export function GitWorkflowDialog({ cwd, changes, onClose, onRefresh, onError }: {
  cwd: string;
  changes: WorkspaceChanges;
  onClose: () => void;
  onRefresh: () => Promise<WorkspaceChanges>;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState(() => new Set(changes.files.map((file) => file.path)));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"stage" | "unstage" | "commit" | "push" | "pr" | "branch" | null>(null);
  const [result, setResult] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const paths = [...selected];

  useEffect(() => { void window.devilCodex.listGitBranches({ cwd }).then(setBranches).catch((error) => onError(`브랜치 목록 실패: ${String(error)}`)); }, [cwd]);

  const reloadBranches = async (): Promise<void> => setBranches(await window.devilCodex.listGitBranches({ cwd }));
  const changeBranch = async (branch: string, create = false): Promise<void> => {
    setBusy("branch");
    try {
      await window.devilCodex.switchGitBranch({ cwd, branch, create });
      setNewBranch("");
      await Promise.all([reloadBranches(), onRefresh()]);
    } catch (error) { onError(`브랜치 ${create ? "생성" : "전환"} 실패: ${String(error)}`); }
    finally { setBusy(null); }
  };

  const run = async (kind: "stage" | "unstage" | "commit" | "push" | "pr"): Promise<void> => {
    setBusy(kind);
    setResult("");
    try {
      if (kind === "stage") await window.devilCodex.stageWorkspaceFiles({ cwd, paths });
      if (kind === "unstage") await window.devilCodex.unstageWorkspaceFiles({ cwd, paths });
      if (kind === "commit") {
        if (paths.length) await window.devilCodex.stageWorkspaceFiles({ cwd, paths });
        setResult(await window.devilCodex.commitWorkspace({ cwd, message, paths }));
        setMessage("");
      }
      if (kind === "push") setResult((await window.devilCodex.pushWorkspace({ cwd })) || "Push 완료");
      if (kind === "pr") setResult(await window.devilCodex.createPullRequest({ cwd, draft: true }));
      const refreshed = await onRefresh();
      setSelected(new Set(refreshed.files.map((file) => file.path)));
    } catch (error) {
      onError(`${kind === "stage" ? "스테이징" : kind === "unstage" ? "스테이징 해제" : kind === "commit" ? "커밋" : kind === "push" ? "Push" : "Pull Request"} 실패: ${String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (path: string): void => setSelected((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  return <div className="git-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="git-dialog" role="dialog" aria-modal="true" aria-label="커밋 또는 푸시">
      <header><span><GitCommitHorizontal size={19} /><strong>커밋 또는 푸시</strong></span><button type="button" onClick={onClose} aria-label="닫기"><X size={18} /></button></header>
      <div className="git-dialog-branches">
        <GitBranch size={15} />
        <select value={changes.branch} disabled={busy !== null} onChange={(event) => void changeBranch(event.target.value)}>{branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.current ? "✓ " : ""}{branch.name}{branch.remote ? " · 원격" : ""}</option>)}</select>
        <input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newBranch.trim()) void changeBranch(newBranch, true); }} placeholder="새 브랜치 이름" />
        <button type="button" disabled={busy !== null || !newBranch.trim()} onClick={() => void changeBranch(newBranch, true)}><Plus size={14} />생성</button>
      </div>
      <div className="git-dialog-files">
        {changes.files.length === 0 ? <p>변경 사항이 없습니다.</p> : changes.files.map((file) => <label key={file.path}>
          <input type="checkbox" checked={selected.has(file.path)} onChange={() => toggle(file.path)} />
          <span className="git-check">{selected.has(file.path) && <Check size={13} />}</span>
          <strong>{file.path}</strong><small>{file.staged ? "스테이징됨" : file.status === "??" ? "새 파일" : file.status}</small>
        </label>)}
      </div>
      <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="커밋 메시지" rows={3} />
      {result && <pre className="git-dialog-result">{result}</pre>}
      <footer>
        <button type="button" disabled={busy !== null || paths.length === 0} onClick={() => void run("stage")}>{busy === "stage" ? "스테이징 중…" : "선택 항목 스테이징"}</button>
        <button type="button" disabled={busy !== null || !changes.files.some((file) => file.staged && selected.has(file.path))} onClick={() => void run("unstage")}>{busy === "unstage" ? "해제 중…" : "스테이징 해제"}</button>
        <button type="button" disabled={busy !== null || paths.length === 0 || !message.trim()} onClick={() => void run("commit")}>{busy === "commit" ? "커밋 중…" : "커밋"}</button>
        <button type="button" className="primary" disabled={busy !== null} onClick={() => void run("push")}><UploadCloud size={15} />{busy === "push" ? "Push 중…" : "Push"}</button>
        <button type="button" disabled={busy !== null || changes.branch === "main" || changes.branch === "master" || changes.branch === "detached"} title={changes.branch === "main" || changes.branch === "master" ? "feature branch에서 사용할 수 있습니다" : "Draft Pull Request 생성"} onClick={() => void run("pr")}><GitPullRequestDraft size={15} />{busy === "pr" ? "PR 생성 중…" : "초안 PR"}</button>
      </footer>
    </section>
  </div>;
}
