import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import type { AgentRuntimeId, ProviderId, ProviderInfo, ThreadApprovalPolicy, ThreadHistoryItem, ThreadSandboxMode, WorkspaceChange, WorkspaceChanges, WorkspaceDiff } from "../../shared/contracts";
import { DockTabStrip } from "./DockTabStrip";
import { TerminalSession } from "./TerminalSession";
import { BrowserPanel, SideChat, ToolContent } from "./ToolContent";
import type { ToolKind } from "./ToolLauncherMenu";

export function BottomDock({
  open,
  tabs,
  active,
  workspace,
  fileTarget,
  filesLocked,
  projectName,
  changes,
  selectedDiff,
  diffBusy,
  subagentLabels,
  browserSessionKey,
  terminalSessionKey,
  subagentCtx,
  subagentHistory,
  subagentBusy,
  subagentPick,
  onTerminalAsk,
  onTerminalOpenPath,
  onSubagentPick,
  onSubagentHistory,
  onNewSideChat,
  sideChatCreating,
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
  filesLocked?: boolean;
  projectName: string;
  changes: WorkspaceChanges;
  selectedDiff: WorkspaceDiff | null;
  diffBusy: boolean;
  subagentLabels: Record<string, string>;
  browserSessionKey: string;
  terminalSessionKey: string;
  subagentCtx: { runtime: AgentRuntimeId; model: string; provider: ProviderId; accountId?: string; cwd: string; providers: ProviderInfo[]; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode };
  subagentHistory: Record<string, ThreadHistoryItem[]>;
  subagentBusy: Record<string, boolean>;
  subagentPick: Record<string, { provider: ProviderId; accountId?: string; model: string; auto?: boolean }>;
  onTerminalAsk: (text: string) => void;
  onTerminalOpenPath: (path: string) => void;
  onSubagentPick: (id: string, pick: { provider: ProviderId; accountId?: string; model: string; auto?: boolean }) => void;
  onSubagentHistory: (id: string, items: ThreadHistoryItem[]) => void;
  onNewSideChat: () => void;
  sideChatCreating?: boolean;
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
  const browserTabs = tabs.filter((tab) => tab.startsWith("browser:"));
  const subId = active?.startsWith("subagent:") ? active.slice("subagent:".length)
    : active?.startsWith("sidechat:") ? active.slice("sidechat:".length) : null;

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
        {active?.startsWith("terminal:") && <TerminalSession active={open} workspace={workspace} dock="bottom" terminalKey={active} onShell={setShellStable} onSendToComposer={onTerminalAsk} onOpenPath={onTerminalOpenPath} />}
        {browserTabs.map((tab) => <BrowserPanel key={tab} browserSessionKey={tab} visible={active === tab} workspace={workspace} fileTarget={fileTarget} changes={changes} />)}
        {subId && <SideChat key={subId} target={{ thread: { id: subId, label: subagentLabels[subId] || "사이드 채팅" }, ...subagentCtx }} history={subagentHistory[subId]} busy={Boolean(subagentBusy[subId])} pick={subagentPick[subId]} lockedModel={active?.startsWith("subagent:")} onPick={(p) => onSubagentPick(subId, p)} onHistory={(items) => onSubagentHistory(subId, items)} onOpenFile={onTerminalOpenPath} />}
        {active && !active.startsWith("terminal:") && !active.startsWith("browser:") && !subId && <ToolContent active={active as Exclude<ToolKind, "terminal">} workspace={workspace} fileTarget={fileTarget} filesLocked={filesLocked} changes={changes} selectedDiff={selectedDiff} diffBusy={diffBusy} browserSessionKey={browserSessionKey} onNewSideChat={onNewSideChat} sideChatCreating={sideChatCreating} onSelectDiff={onSelectDiff} onSendReviewComment={onSendReviewComment} onApplyHunk={onApplyHunk} />}
      </div>
    </section>
  );
}
