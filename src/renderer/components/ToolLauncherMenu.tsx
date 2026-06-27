import { FileText, Folder, Globe2, MessageSquarePlus, SquareTerminal } from "lucide-react";
import { shortcut } from "../shortcuts";

export type ToolKind = "review" | "terminal" | "browser" | "files" | "side-chat";

const tools: Array<{ kind: ToolKind; label: string; shortcut?: string; icon: typeof FileText }> = [
  { kind: "review", label: "검토", shortcut: shortcut("⌃⇧G"), icon: FileText },
  { kind: "terminal", label: "터미널", icon: SquareTerminal },
  { kind: "browser", label: "브라우저", shortcut: shortcut("⌘T"), icon: Globe2 },
  { kind: "files", label: "파일", shortcut: shortcut("⌘P"), icon: Folder },
  { kind: "side-chat", label: "사이드 채팅", shortcut: shortcut("⌥⌘S"), icon: MessageSquarePlus },
];

export function ToolLauncherMenu({ onSelect, compact = false }: { onSelect: (tool: ToolKind) => void; compact?: boolean }): React.JSX.Element {
  return <nav className={compact ? "tool-launcher compact" : "tool-launcher"}>{tools.map(({ kind, label, shortcut, icon: Icon }) => <button type="button" key={kind} onClick={() => onSelect(kind)}><Icon />{label}{shortcut && <kbd>{shortcut}</kbd>}</button>)}</nav>;
}
