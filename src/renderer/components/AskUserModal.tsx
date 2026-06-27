import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check, HelpCircle, X } from "lucide-react";
import type { AskAnswer, AskRequest } from "../../shared/contracts";

// Modal that renders an MCP `ask_user` request (Codex / external models pausing
// to ask the user a multiple-choice question). Mirrors Claude Code's built-in
// AskUserQuestion UX: selectable option chips per question + a free-text "직접
// 입력" fallback, blocking until the user submits or dismisses.
export function AskUserModal(): React.JSX.Element | null {
  const [request, setRequest] = useState<AskRequest | null>(null);
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  useEffect(() => window.devilCodex.onAsk((req) => { setRequest(req); setSelected({}); setCustom({}); }), []);

  if (!request) return null;
  const questions = request.questions;

  const answersFor = (index: number): string[] => {
    const picks = selected[index] ?? [];
    const free = (custom[index] ?? "").trim();
    return free ? [...picks, free] : picks;
  };
  const complete = questions.every((_, index) => answersFor(index).length > 0);

  const toggle = (index: number, label: string, multi: boolean): void => {
    setSelected((current) => {
      const existing = current[index] ?? [];
      if (multi) return { ...current, [index]: existing.includes(label) ? existing.filter((l) => l !== label) : [...existing, label] };
      return { ...current, [index]: existing.includes(label) ? [] : [label] };
    });
  };

  const finish = (answers: AskAnswer[] | null): void => {
    void window.devilCodex.askRespond({ id: request.id, answers });
    setRequest(null);
  };
  const submit = (): void => finish(questions.map((q, index) => ({ question: q.question, header: q.header, answers: answersFor(index) })));

  return createPortal(
    <AnimatePresence>
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(null); }}>
        <motion.div className="ask-dialog" initial={{ opacity: 0, scale: .97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: 6 }} transition={{ duration: .16, ease: [.4, 0, .2, 1] }} role="dialog" aria-modal="true">
          <header><span><HelpCircle size={18} /><strong>질문</strong></span><button type="button" onClick={() => finish(null)} aria-label="닫기"><X size={18} /></button></header>
          <div className="ask-body">
            {questions.map((q, index) => {
              const picks = selected[index] ?? [];
              return <section className="ask-question" key={index}>
                {q.header && <span className="ask-header-chip">{q.header}</span>}
                <h3>{q.question}</h3>
                <div className="ask-options">
                  {q.options.map((option) => {
                    const on = picks.includes(option.label);
                    const recommended = /\((추천|recommended)\)/i.test(option.label);
                    return <button type="button" key={option.label} className={`ask-option${on ? " on" : ""}${recommended ? " recommended" : ""}`} onClick={() => toggle(index, option.label, Boolean(q.multiSelect))}>
                      <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                      {on && <Check size={16} />}
                    </button>;
                  })}
                </div>
                <input className="ask-custom" value={custom[index] ?? ""} onChange={(event) => setCustom((c) => ({ ...c, [index]: event.target.value }))} placeholder="직접 입력…" />
              </section>;
            })}
          </div>
          <footer>
            <button type="button" className="secondary" onClick={() => finish(null)}>취소</button>
            <button type="button" className="primary" disabled={!complete} onClick={submit}>보내기</button>
          </footer>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  );
}
