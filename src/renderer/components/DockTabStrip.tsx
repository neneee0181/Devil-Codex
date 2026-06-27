import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Bot, FileText, Folder, Globe2, MessageSquarePlus, Plus, SquareTerminal, X } from "lucide-react";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { ToolLauncherMenu, type ToolKind } from "./ToolLauncherMenu";

const icons: Record<string, typeof FileText> = {
  review: FileText,
  terminal: SquareTerminal,
  browser: Globe2,
  files: Folder,
  "side-chat": MessageSquarePlus,
};

const labels: Record<string, string> = {
  review: "검토",
  terminal: "터미널",
  browser: "브라우저",
  files: "파일",
  "side-chat": "사이드 채팅",
};

const MENU_W = 218;

export function DockTabStrip({
  dock,
  tabs,
  active,
  projectName,
  shell,
  subagentLabels,
  onSelect,
  onAdd,
  onCloseTab,
}: {
  dock: "bottom" | "right";
  tabs: string[];
  active: string | null;
  projectName: string;
  shell?: string;
  subagentLabels?: Record<string, string>;
  onSelect: (tool: string) => void;
  onAdd: (tool: ToolKind) => void;
  onCloseTab: (tool: string) => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const addRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(menuRef, () => setMenuOpen(false), menuOpen, addRef);

  // Position the menu via a viewport portal so the dock's overflow/stacking
  // (and the terminal capture overlay) can't clip or hide it.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const r = addRef.current?.getBoundingClientRect();
    if (!r) return;
    const menuH = menuRef.current?.offsetHeight ?? 300;
    const left = Math.min(Math.max(8, dock === "right" ? r.right - MENU_W : r.left), window.innerWidth - MENU_W - 8);
    // Flip above the trigger when there isn't room below (e.g. bottom dock), and
    // clamp so the menu never runs past the top/bottom viewport edges.
    const below = r.bottom + 6;
    const flip = below + menuH > window.innerHeight - 8 && r.top - 6 - menuH > 8;
    const top = flip ? r.top - 6 - menuH : Math.min(below, window.innerHeight - menuH - 8);
    setPos({ left, top: Math.max(8, top) });
  }, [menuOpen, dock]);

  return (
    <div className={`dock-tab-strip ${dock}`}>
      {tabs.map((tool) => {
        const isSub = tool.startsWith("subagent:");
        const isSide = tool.startsWith("sidechat:");
        const chatId = isSub ? tool.slice("subagent:".length) : isSide ? tool.slice("sidechat:".length) : "";
        const Icon = isSub ? Bot : isSide ? MessageSquarePlus : icons[tool] ?? MessageSquarePlus;
        const label = isSub ? (subagentLabels?.[chatId] || "서브에이전트") : isSide ? (subagentLabels?.[chatId] || "사이드 채팅") : tool === "terminal" ? projectName : labels[tool] ?? tool;
        return (
          <button type="button" className={active === tool ? "dock-tab active" : "dock-tab"} key={tool} onClick={() => onSelect(tool)}>
            <Icon size={15} />
            <span>{label}</span>
            {tool === "terminal" && shell && <small>{shell}</small>}
            <i role="button" aria-label={`${label} 탭 닫기`} onClick={(event) => { event.stopPropagation(); onCloseTab(tool); }}><X size={12} /></i>
          </button>
        );
      })}
      <div className="dock-tab-add" ref={addRef}>
        <button type="button" onClick={() => setMenuOpen((value) => !value)} aria-label={`${dock === "bottom" ? "하단" : "우측"} 도구 추가`}><Plus size={17} /></button>
      </div>
      {createPortal(
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              ref={menuRef}
              className="dock-tab-menu"
              style={{ position: "fixed", left: pos.left, top: pos.top }}
              initial={{ opacity: 0, y: 4, scale: .98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: .98 }}
              transition={{ duration: .13 }}
            >
              <ToolLauncherMenu compact onSelect={(tool) => { onAdd(tool); setMenuOpen(false); }} />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
