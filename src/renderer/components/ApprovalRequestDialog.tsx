import { FilePenLine, ShieldAlert, SquareTerminal } from "lucide-react";
import { motion } from "motion/react";
import type { ApprovalDecision, ApprovalPrompt } from "../../shared/contracts";

export function ApprovalRequestDialog({ prompt, responding, onDecision }: { prompt: ApprovalPrompt; responding: boolean; onDecision: (decision: ApprovalDecision) => void }): React.JSX.Element {
  const command = prompt.kind === "command";
  const allowSession = prompt.availableDecisions.includes("acceptForSession");
  const allowOnce = prompt.availableDecisions.includes("accept");
  const rejectDecision: ApprovalDecision = prompt.availableDecisions.includes("decline") ? "decline" : "cancel";
  // No backdrop-click dismiss: this blocks a running tool call, so a stray
  // click outside must never silently reject it. Use 거부/허용 buttons only.
  return <div className="approval-request-backdrop" role="presentation"><motion.section className="approval-request-dialog" initial={{ opacity: 0, y: 10, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} role="alertdialog" aria-modal="true" aria-labelledby="approval-request-title">
    <header>{command ? <SquareTerminal size={20} /> : <FilePenLine size={20} />}<div><h2 id="approval-request-title">{command ? "명령 실행 승인" : "파일 변경 승인"}</h2><p>Codex가 작업을 계속하려면 승인이 필요합니다.</p></div><ShieldAlert size={19} /></header>
    {prompt.reason && <p className="approval-reason">{prompt.reason}</p>}
    {command && <pre>{prompt.command || "명령 정보 없음"}</pre>}
    <dl>{prompt.cwd && <><dt>작업 위치</dt><dd>{prompt.cwd}</dd></>}{prompt.grantRoot && <><dt>접근 요청</dt><dd>{prompt.grantRoot}</dd></>}</dl>
    <footer><button type="button" disabled={responding} onClick={() => onDecision(rejectDecision)}>거부</button>{allowSession && <button type="button" disabled={responding} onClick={() => onDecision("acceptForSession")}>이 세션 동안 허용</button>}{allowOnce && <button type="button" className="primary" disabled={responding} onClick={() => onDecision("accept")}>{responding ? "처리 중…" : "허용"}</button>}</footer>
  </motion.section></div>;
}
