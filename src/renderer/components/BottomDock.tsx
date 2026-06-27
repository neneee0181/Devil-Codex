import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import type { WorkspaceChange, WorkspaceChanges, WorkspaceDiff } from "../../shared/contracts";
import { DockTabStrip } from "./DockTabStrip";
import { TerminalSession } from "./TerminalSession";
import { ToolContent } from "./ToolContent";
import type { ToolKind } from "./ToolLauncherMenu";

export function BottomDock({
  open,
  tabs,
  active,
  workspace,
  fileTarget,
  projectName,
  changes,
  selectedDiff,
  diffBusy,
  onSelect,
  onAdd,
  onCloseTab,
  onSelectDiff,
  onSendReviewComment,
  onApplyHunk,
  onClose,
  onResize,
}: {
  open: boolean;
  tabs: ToolKind[];
  active: ToolKind | null;
  workspace: string;
  fileTarget: string | null;
  projectName: string;
  changes: WorkspaceChanges;
  selectedDiff: WorkspaceDiff | null;
  diffBusy: boolean;
  onSelect: (tool: ToolKind) => void;
  onAdd: (tool: ToolKind) => void;
  onCloseTab: (tool: ToolKind) => void;
  onSelectDiff: (file: WorkspaceChange) => void;
  onSendReviewComment: (input: { path: string; line: number; side: "old" | "new"; text: string }) => void;
  onApplyHunk: (input: { path: string; hunk: string; action: "stage" | "revert" }) => Promise<void>;
  onClose: () => void;
  onResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
}): React.JSX.Element {
  const [shell, setShell] = useState("연결 중…");
  const setShellStable = useCallback((value: string) => setShell(value), []);

  return (
    <section className={`terminal bottom-dock${open ? " open" : ""}`} aria-hidden={!open}>
      <div
        className="terminal-resize"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          onResize(event);
        }}
        aria-label="하단 패널 높이 조절"
      />
      <header className="dock-header">
        <DockTabStrip dock="bottom" tabs={tabs} active={active} projectName={projectName} shell={shell} onSelect={onSelect} onAdd={onAdd} onCloseTab={onCloseTab} />
        <button type="button" onClick={onClose} aria-label="하단 패널 닫기"><X size={17} /></button>
      </header>
      <div className="bottom-dock-content">
        {active === "terminal" && <TerminalSession active={open} workspace={workspace} onShell={setShellStable} />}
        {active && active !== "terminal" && <ToolContent active={active} workspace={workspace} fileTarget={fileTarget} changes={changes} selectedDiff={selectedDiff} diffBusy={diffBusy} onSelectDiff={onSelectDiff} onSendReviewComment={onSendReviewComment} onApplyHunk={onApplyHunk} />}
      </div>
    </section>
  );
}
