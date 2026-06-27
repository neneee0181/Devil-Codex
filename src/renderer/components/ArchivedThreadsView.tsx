import { Archive, ArrowLeft, RotateCcw } from "lucide-react";
import type { ThreadSummary } from "../../shared/contracts";

export function ArchivedThreadsView({ threads, loading, onBack, onOpen, onRestore, relativeTime }: { threads: ThreadSummary[]; loading: boolean; onBack: () => void; onOpen: (thread: ThreadSummary) => void; onRestore: (thread: ThreadSummary) => void; relativeTime: (timestamp: number) => string }): React.JSX.Element {
  return <div className="page-view archived-threads"><button className="view-back" onClick={onBack}><ArrowLeft size={16} />앱으로 돌아가기</button><h1>보관된 채팅</h1><p>실제 Codex app-server의 보관된 thread 목록입니다.</p>{loading ? <div className="feature-empty">불러오는 중…</div> : threads.length === 0 ? <div className="feature-empty"><Archive /><strong>보관된 채팅 없음</strong></div> : <div className="archived-list">{threads.map((thread) => <div key={thread.id}><button type="button" onClick={() => onOpen(thread)}><strong>{thread.title}</strong><span>{thread.preview || "미리보기 없음"}</span><time>{relativeTime(thread.updatedAt)}</time></button><button type="button" className="restore" onClick={() => onRestore(thread)}><RotateCcw size={14} />복원</button></div>)}</div>}</div>;
}
