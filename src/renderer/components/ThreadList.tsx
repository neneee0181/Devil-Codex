import { AnimatePresence, motion } from "motion/react";
import { Archive, ChevronDown, ChevronRight, Folder, FolderOpen, GitFork, MoreHorizontal, Pencil, Pin, PinOff, SquarePen, Trash2 } from "lucide-react";
import type { ThreadRef, ThreadSummary } from "../../shared/contracts";

type ThreadListProps = {
  projectName: string;
  expanded: boolean;
  menuOpen: boolean;
  pinned: boolean;
  threads: ThreadSummary[];
  activeThread: ThreadRef | null;
  onToggle: () => void;
  onMenu: () => void;
  onNewThread: () => void;
  onPin: () => void;
  onShowFinder: () => void;
  onCreateWorktree: () => void;
  onRename: () => void;
  onArchived: () => void;
  onRemove: () => void;
  onOpen: (thread: ThreadSummary) => void;
  onArchive: (thread: ThreadSummary) => void;
  relativeTime: (timestamp: number) => string;
};

export function ThreadList({ projectName, expanded, menuOpen, pinned, threads, activeThread, onToggle, onMenu, onNewThread, onPin, onShowFinder, onCreateWorktree, onRename, onArchived, onRemove, onOpen, onArchive, relativeTime }: ThreadListProps): React.JSX.Element {
  return <><div className="sidebar-label">프로젝트</div><div className="project-group" data-shell-popover-root><div className={menuOpen ? "project-row menu-open" : "project-row"}><button className="project-toggle" onClick={onToggle}><Folder size={17} /><strong>{projectName}</strong>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button><button className="project-action" onClick={onMenu} aria-label="프로젝트 메뉴"><MoreHorizontal size={17} /></button><button className="project-action" onClick={onNewThread} aria-label={`${projectName}에서 새 채팅`} title={`${projectName}에서 새 채팅`}><SquarePen size={16} /></button></div><AnimatePresence>{menuOpen && <motion.div className="project-menu popup-motion" initial={{ opacity: 0, scale: .97, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: -3 }} transition={{ duration: .14 }}><button onClick={onPin}>{pinned ? <PinOff /> : <Pin />}{pinned ? "프로젝트 고정 해제" : "프로젝트 고정"}</button><button onClick={onShowFinder}><FolderOpen />Finder에서 보기</button><button onClick={onCreateWorktree}><GitFork />영구 작업 트리 생성</button><button onClick={onRename}><Pencil />프로젝트 이름 변경</button><button onClick={onArchived}><Archive />채팅 보관</button><div className="menu-divider" /><button className="danger" onClick={onRemove}><Trash2 />제거하기</button></motion.div>}</AnimatePresence></div>{expanded && <div className="thread-list">{threads.length === 0 ? <div className="thread-empty">스레드 없음</div> : threads.map((summary) => <div className={activeThread?.id === summary.id ? "thread-row active" : "thread-row"} key={summary.id}><button className="thread-open" onClick={() => onOpen(summary)} title={summary.preview}>{summary.title}</button><time>{relativeTime(summary.updatedAt)}</time><button className="thread-more" onClick={() => onArchive(summary)} title="보관"><MoreHorizontal size={15} /></button></div>)}</div>}</>;
}
