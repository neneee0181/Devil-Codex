import { Search, X } from "lucide-react";

export function ThreadFind({ query, count, onChange, onClose }: { query: string; count: number; onChange: (query: string) => void; onClose: () => void }): React.JSX.Element {
  return <div className="thread-find" role="search"><Search size={15} /><input autoFocus value={query} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} placeholder="현재 채팅에서 찾기" /><small>{query ? `${count}개` : ""}</small><button type="button" onClick={onClose} aria-label="찾기 닫기"><X size={15} /></button></div>;
}
