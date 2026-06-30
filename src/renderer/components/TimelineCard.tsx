import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Blocks, Check, ChevronDown, Copy, FilePlus2, Info, Languages, Pencil, RotateCcw, Send, ThumbsDown, ThumbsUp, X } from "lucide-react";
import type { ThreadAttachment, ThreadHistoryItem, WorkspaceChanges } from "../../shared/contracts";
import { MarkdownContent } from "./MarkdownContent";
import { splitMessageImages } from "./messageAttachments";
import { SkillTokens, splitSkillTokens } from "./SkillTokens";
import { TurnActivity } from "./TurnActivity";
import { AttachmentGallery } from "./AttachmentCards";

function ChangesCard({ changes, turnId, canRollback, rollbackBusy, onRollback, onReview, onOpenFile }: { changes: WorkspaceChanges; turnId?: string; canRollback: boolean; rollbackBusy: boolean; onRollback: (turnId: string) => void; onReview: () => void; onOpenFile: (path: string) => void }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (changes.files.length === 0) return null;
  const visible = expanded ? changes.files : changes.files.slice(0, 3);
  return <section className="timeline-changes">
    <header><span className="changes-summary"><span className="changes-icon"><FilePlus2 size={19} /></span><span><strong>파일 {changes.files.length}개 편집함</strong><small><i>+{changes.additions}</i> <b>-{changes.deletions}</b></small></span></span><span className="changes-actions"><button type="button" className="changes-undo" disabled={!turnId || !canRollback || rollbackBusy} title={canRollback ? "이 AI turn이 만든 파일 변경만 실행 취소" : "이 turn의 원본 파일 변경을 찾을 수 없습니다"} onClick={() => turnId && onRollback(turnId)}>{rollbackBusy ? "취소 중…" : "실행 취소"} <RotateCcw size={14} /></button><button type="button" onClick={onReview}>리뷰</button></span></header>
    <div>{visible.map((file) => <button type="button" className="changes-file" key={file.path} onClick={() => onOpenFile(file.path)}><span>{file.path}</span><span><i>+{file.additions}</i> <b>-{file.deletions}</b></span></button>)}</div>
    {changes.files.length > 3 && <button type="button" className="changes-more" onClick={() => setExpanded((value) => !value)}>{expanded ? "접기" : `${changes.files.length - 3}개 파일 더 보기`} <ChevronDown className={expanded ? "open" : ""} size={15} /></button>}
  </section>;
}

const hideAppDirectives = (text: string): string => text.replace(/::git-(?:stage|commit|push|create-branch|create-pr)\{[^}]*\}/g, "").replace(/\n{3,}/g, "\n\n").trim();
const hideEditedContinuationContext = (text: string): string => {
  const marker = "[수정된 사용자 메시지]\n";
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length).trim() : text;
};

function hideAttachmentBlock(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === "첨부 파일:") { skipping = true; continue; }
    if (skipping && line.trim().startsWith("- ")) continue;
    skipping = false;
    output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function imagePathAttachments(paths: string[]): ThreadAttachment[] {
  return paths.map((path) => ({ kind: "image", path, name: path.split("/").at(-1) ?? "image" }));
}

export function TimelineCard({ item, changes, showChanges, canRollback, rollbackBusy, translatable, onRollback, onReview, onOpenFile, onEditUserMessage }: { item: ThreadHistoryItem; changes: WorkspaceChanges; showChanges: boolean; canRollback: boolean; rollbackBusy: boolean; translatable?: boolean; onRollback: (turnId: string) => void; onReview: () => void; onOpenFile: (path: string) => void; onEditUserMessage?: (item: ThreadHistoryItem, text: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [showTranslation, setShowTranslation] = useState(false);
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState(false);
  const reduceMotion = useReducedMotion();
  if (item.kind === "activity") return <TurnActivity item={item} onOpenFile={onOpenFile} />;
  if (item.kind === "system" && item.title === "모델 변경") {
    return <motion.article layout="position" className="timeline-item model-change-notice" initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={reduceMotion ? undefined : { opacity: 1, y: 0 }} transition={reduceMotion ? { duration: 0 } : { duration: .18, ease: [.22, 1, .36, 1] }}>
      <span />
      <strong><Blocks size={14} />{item.text}<Info size={13} /></strong>
      <span />
    </motion.article>;
  }
  const toggleTranslate = async (sourceText: string): Promise<void> => {
    if (showTranslation) { setShowTranslation(false); return; }
    setShowTranslation(true);
    setTranslateError(false);
    if (translation !== null) return;
    setTranslating(true);
    try { setTranslation(await window.devilCodex.translate({ text: sourceText, to: "ko" })); }
    catch { setTranslateError(true); setShowTranslation(false); }
    finally { setTranslating(false); }
  };
  const label = item.title ?? (item.kind === "user" ? "나" : item.kind === "agent" ? "Codex" : "시스템");
  const visibleItemText = item.kind === "user" ? hideEditedContinuationContext(item.text) : item.text;
  const message = item.kind === "user" ? splitMessageImages(visibleItemText) : { text: hideAppDirectives(item.text), images: [] };
  // Stock Codex repeats pasted images in the text as temp paths (now gone) AND
  // as base64 content parts. When we already have real image attachments, skip
  // the text-path duplicates so they don't render as "이미지 없음".
  const ownImages = item.attachments ?? [];
  const hasContentImage = ownImages.some((att) => att.kind === "image");
  const attachments = item.kind === "user" ? [...ownImages, ...(hasContentImage ? [] : imagePathAttachments(message.images))] : [];
  const userText = item.kind === "user" && attachments.length > 0 ? hideAttachmentBlock(message.text) : message.text;
  const userMessage = item.kind === "user" ? splitSkillTokens(userText) : { skills: [], text: message.text };
  const copy = async (): Promise<void> => {
    await navigator.clipboard?.writeText(item.kind === "user" ? userMessage.text : item.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const startEdit = (): void => {
    setDraft(userMessage.text);
    setEditing(true);
  };
  const submitEdit = (): void => {
    const next = draft.trim();
    if (!next) return;
    setEditing(false);
    onEditUserMessage?.(item, next);
  };

  return <motion.article layout="position" className={`timeline-item ${item.kind}${item.status === "inProgress" ? " pending" : ""}`} initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={reduceMotion ? undefined : { opacity: 1, y: 0 }} transition={reduceMotion ? { duration: 0 } : { duration: .2, ease: [.22, 1, .36, 1] }}>
    <div className="item-label-row">
      <span className="item-label">{label}</span>
      {item.kind === "agent" && translatable && <button type="button" className={`translate-toggle ${showTranslation ? "on" : ""}`} disabled={translating} title={showTranslation ? "원문 보기" : "한글로 번역"} onClick={() => void toggleTranslate(userMessage.text)}><Languages size={13} />{translating ? "번역 중…" : showTranslation ? "원문" : "한글"}</button>}
    </div>
    {translateError && <div className="translate-error">번역 실패 · 다시 시도해 주세요.</div>}
    {attachments.length > 0 && <AttachmentGallery attachments={attachments} align="end" />}
    <div className={item.kind === "user" ? "timeline-user-bubble" : undefined}>
      <SkillTokens skills={userMessage.skills} />
      {item.kind === "user" && editing
        ? <div className="timeline-edit-box">
            <textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submitEdit(); if (event.key === "Escape") setEditing(false); }} />
            <div><button type="button" onClick={() => setEditing(false)}><X size={14} />취소</button><button type="button" className="primary" disabled={!draft.trim()} onClick={submitEdit}><Send size={14} />보내기</button></div>
          </div>
        : <MarkdownContent text={item.kind === "agent" && showTranslation && translation ? translation : userMessage.text} onOpenFile={onOpenFile} />}
      {item.kind === "user" && item.status === "inProgress" && <small className="timeline-pending-label">대기 중</small>}
    </div>
    {item.kind === "user" && !editing && <div className="timeline-actions user-actions"><button type="button" onClick={() => void copy()} aria-label="메시지 복사">{copied ? <Check size={16} /> : <Copy size={16} />}</button><button type="button" onClick={startEdit} aria-label="메시지 편집"><Pencil size={16} /></button></div>}
    {item.kind === "agent" && <div className="timeline-actions"><button type="button" onClick={() => void copy()} aria-label="응답 복사">{copied ? <Check size={16} /> : <Copy size={16} />}</button><button type="button" aria-label="좋아요"><ThumbsUp size={16} /></button><button type="button" aria-label="싫어요"><ThumbsDown size={16} /></button></div>}
    {showChanges && <ChangesCard changes={changes} turnId={item.turnId} canRollback={canRollback} rollbackBusy={rollbackBusy} onRollback={onRollback} onReview={onReview} onOpenFile={onOpenFile} />}
  </motion.article>;
}
