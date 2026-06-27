import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Hand, ShieldAlert, ShieldCheck } from "lucide-react";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { PermissionWarningDialog } from "./PermissionWarningDialog";

export type ApprovalMode = "ask" | "agent" | "full";

const options: Array<{ mode: ApprovalMode; label: string; detail: string; icon: typeof Hand }> = [
  { mode: "ask", label: "승인 요청", detail: "외부 파일 수정 및 인터넷 사용 시 항상 확인", icon: Hand },
  { mode: "agent", label: "나 대신 승인", detail: "잠재적으로 위험한 것으로 감지된 작업에만 승인을 요청합니다", icon: ShieldCheck },
  { mode: "full", label: "전체 권한", detail: "인터넷과 컴퓨터의 모든 파일에 제한 없이 액세스", icon: ShieldAlert },
];

export function ApprovalPicker({ value, onChange, onOpen }: { value: ApprovalMode; onChange: (value: ApprovalMode) => void; onOpen?: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useOutsideDismiss(root, () => setOpen(false), open);
  const selected = options.find((option) => option.mode === value) ?? options[1];
  const choose = (mode: ApprovalMode): void => {
    setOpen(false);
    if (mode === "full") { setWarningOpen(true); return; }
    onChange(mode);
  };

  return <><div className="approval-picker" ref={root} data-popover-root><button type="button" className="text-chip" onClick={() => { onOpen?.(); setOpen((current) => !current); }}><ShieldCheck size={15} />{selected.label}<ChevronDown size={13} /></button><AnimatePresence>{open && <motion.div className="approval-menu" initial={{ opacity: 0, y: 4, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 3, scale: .98 }}><header>Codex 작업 승인은 어떻게 해야 하나요?</header>{options.map(({ mode, label, detail, icon: Icon }) => <button type="button" key={mode} className={value === mode ? "active" : ""} onClick={() => choose(mode)}><Icon size={18} /><span><strong>{label}</strong><small>{detail}</small></span>{value === mode && <Check size={18} />}</button>)}</motion.div>}</AnimatePresence></div><AnimatePresence>{warningOpen && <PermissionWarningDialog onCancel={() => setWarningOpen(false)} onConfirm={() => { onChange("full"); setWarningOpen(false); }} />}</AnimatePresence></>;
}
