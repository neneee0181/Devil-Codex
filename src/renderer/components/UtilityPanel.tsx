import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { ProviderId, ProviderInfo, ThreadAttachment, ThreadHistoryItem, WorkspaceChange, WorkspaceChanges, WorkspaceDiff } from "../../shared/contracts";
import { DockTabStrip } from "./DockTabStrip";
import { TerminalSession } from "./TerminalSession";
import { ToolContent, SideChat, type ContentTool } from "./ToolContent";
import { ToolLauncherMenu, type ToolKind } from "./ToolLauncherMenu";

export function UtilityPanel({
  open,
  tabs,
  active,
  workspace,
  fileTarget,
  projectName,
  changes,
  selectedDiff,
  diffBusy,
  subagentLabels,
  subagentList,
  subagentCtx,
  subagentHistory,
  subagentBusy,
  expanded,
  onBrowserAsk,
  onTerminalAsk,
  onTerminalOpenPath,
  subagentPick,
  onToggleExpanded,
  onSubagentPick,
  onSubagentHistory,
  onOpenSubagent,
  onNewSideChat,
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
  tabs: string[];
  active: string | null;
  workspace: string;
  fileTarget: string | null;
  projectName: string;
  changes: WorkspaceChanges;
  selectedDiff: WorkspaceDiff | null;
  diffBusy: boolean;
  subagentLabels: Record<string, string>;
  subagentList: Array<{ id: string; label: string }>;
  subagentCtx: { model: string; provider: ProviderId; cwd: string; providers: ProviderInfo[] };
  subagentHistory: Record<string, ThreadHistoryItem[]>;
  subagentBusy: Record<string, boolean>;
  expanded: boolean;
  onBrowserAsk: (attachment: ThreadAttachment, text?: string) => void;
  onTerminalAsk: (text: string) => void;
  onTerminalOpenPath: (path: string) => void;
  subagentPick: Record<string, { provider: ProviderId; model: string }>;
  onToggleExpanded: () => void;
  onSubagentPick: (id: string, pick: { provider: ProviderId; model: string }) => void;
  onSubagentHistory: (id: string, items: ThreadHistoryItem[]) => void;
  onOpenSubagent: (id: string, label: string) => void;
  onNewSideChat: () => void;
  onSelect: (tool: string) => void;
  onAdd: (tool: ToolKind) => void;
  onCloseTab: (tool: string) => void;
  onSelectDiff: (file: WorkspaceChange) => void;
  onSendReviewComment: (input: { path: string; line: number; side: "old" | "new"; text: string }) => void;
  onApplyHunk: (input: { path: string; hunk: string; action: "stage" | "revert" }) => Promise<void>;
  onClose: () => void;
  onResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
}): React.JSX.Element {
  const [shell, setShell] = useState("연결 중…");
  const setShellStable = useCallback((value: string) => setShell(value), []);
  const subId = active?.startsWith("subagent:") ? active.slice("subagent:".length)
    : active?.startsWith("sidechat:") ? active.slice("sidechat:".length) : null;

  return (
    <aside className={`utility-panel${open ? " open" : ""}${expanded ? " expanded" : ""}`} aria-hidden={!open}>
      <div className="utility-resize" onPointerDown={onResize} />
      <header className="dock-header">
        <DockTabStrip dock="right" tabs={tabs} active={active} projectName={projectName} shell={shell} subagentLabels={subagentLabels} onSelect={onSelect} onAdd={onAdd} onCloseTab={onCloseTab} />
        <button type="button" onClick={onToggleExpanded} aria-label={expanded ? "우측 패널 축소" : "우측 패널 전체 화면"} title={expanded ? "우측 패널 축소" : "우측 패널 전체 화면"}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        <button type="button" onClick={onClose} aria-label="우측 패널 닫기"><X size={17} /></button>
      </header>
      {active === "terminal" && <TerminalSession active={open} workspace={workspace} dock="right" onShell={setShellStable} onSendToComposer={onTerminalAsk} onOpenPath={onTerminalOpenPath} />}
      {subId && <SideChat key={subId} target={{ thread: { id: subId, label: subagentLabels[subId] || "서브에이전트" }, ...subagentCtx }} history={subagentHistory[subId]} busy={Boolean(subagentBusy[subId])} pick={subagentPick[subId]} onPick={(p) => onSubagentPick(subId, p)} onHistory={(items) => onSubagentHistory(subId, items)} />}
      {active && active !== "terminal" && !subId && <ToolContent active={active as ContentTool} workspace={workspace} fileTarget={fileTarget} changes={changes} selectedDiff={selectedDiff} diffBusy={diffBusy} onBrowserAsk={onBrowserAsk} subagents={subagentList} onOpenSubagent={onOpenSubagent} onNewSideChat={onNewSideChat} onSelectDiff={onSelectDiff} onSendReviewComment={onSendReviewComment} onApplyHunk={onApplyHunk} />}
      {!active && <ToolLauncherMenu onSelect={onAdd} />}
    </aside>
  );
}
