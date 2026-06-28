import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { motion } from "motion/react";

export function PermissionWarningDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return createPortal(<div className="permission-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><motion.div className="permission-dialog" initial={{ opacity: 0, scale: .97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} role="alertdialog" aria-modal="true" aria-labelledby="permission-warning-title"><AlertTriangle size={24} /><h2 id="permission-warning-title">전체 권한을 사용하시겠습니까?</h2><p>Codex가 승인 없이 인터넷과 컴퓨터의 모든 파일에 접근하고 명령을 실행할 수 있습니다. 신뢰할 수 있는 작업에서만 사용하세요.</p><div><button type="button" onClick={onCancel}>취소</button><button type="button" className="danger" onClick={onConfirm}>전체 권한 사용</button></div></motion.div></div>, document.body);
}
