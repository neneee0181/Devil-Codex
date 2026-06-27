import { type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowRight, CornerDownLeft, FolderTree, GitBranch, Laptop, Plus, Square, Target, X } from "lucide-react";
import { ModelPicker } from "./ModelPicker";
import type { ContextUsage, ProviderId, ProviderInfo, ReasoningEffort, ResponseSpeed, ThreadAttachment } from "../../shared/contracts";
import { ApprovalPicker, type ApprovalMode } from "./ApprovalPicker";
import { ComposerSuggestions, suggestionsFor, type ComposerSuggestion } from "./ComposerSuggestions";
import type { CaretPosition } from "./composerCaret";
import { editorSkills, editorText, getEditorCaretPosition, getEditorTextBeforeCaret, insertInlineSkill, insertPlainTextAtSelection, plainTextFromClipboard, removeEditorTrigger } from "./composerEditor";
import { AttachmentGallery } from "./AttachmentCards";

type SuggestionTrigger = {
  sigil: "$" | "/";
  query: string;
  position: CaretPosition;
  tokenLength: number;
};

export type ComposerAttachment = ThreadAttachment;

const LONG_PASTE_THRESHOLD = 1800;

export type ComposerInput = {
  prompt: string;
  approvalMode: ApprovalMode;
  goalMode: boolean;
  attachments: ComposerAttachment[];
  skills: string[];
  reasoningEffort: ReasoningEffort;
  responseSpeed: ResponseSpeed;
};

export function Composer({
  busy,
  queued = [],
  onEditQueued,
  onRemoveQueued,
  onSteerQueued,
  connected,
  model,
  providerId,
  providers,
  codexConnected,
  contextUsage,
  reasoningEffort,
  responseSpeed,
  projectContext,
  skillOptions,
  inject,
  onModelChange,
  onReasoningEffortChange,
  onResponseSpeedChange,
  onSubmit,
  onStop,
  onReview,
  onStatus,
  onMcp,
  onFeedback,
}: {
  busy: boolean;
  queued?: Array<{ id: string; text: string }>;
  onEditQueued?: (id: string, text: string) => void;
  onRemoveQueued?: (id: string) => void;
  onSteerQueued?: (id: string) => void;
  connected: boolean;
  model: string;
  providerId: ProviderId;
  providers: ProviderInfo[];
  codexConnected: boolean;
  contextUsage?: ContextUsage;
  reasoningEffort: ReasoningEffort;
  responseSpeed: ResponseSpeed;
  projectContext?: { name: string; branch: string };
  skillOptions: Array<{ name: string; description: string }>;
  inject?: { attachments?: ComposerAttachment[]; text?: string; nonce: number } | null;
  onModelChange: (input: { provider: ProviderId; model: string }) => void;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  onResponseSpeedChange: (value: ResponseSpeed) => void;
  onSubmit: (input: ComposerInput) => void;
  onStop: () => void;
  onReview: () => void;
  onStatus: () => void;
  onMcp: () => void;
  onFeedback: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("agent");
  const [goalMode, setGoalMode] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [trigger, setTrigger] = useState<SuggestionTrigger | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const editor = useRef<HTMLDivElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const suggestions = useMemo(() => trigger ? suggestionsFor(trigger.sigil, trigger.query, skillOptions) : [], [trigger, skillOptions]);
  const attachmentsReady = attachments.every((item) => item.kind !== "image" || Boolean(item.url));

  // Inject a browser screenshot/annotation into the composer so the user can ask
  // about the page (keyed on nonce so repeats re-fire).
  useEffect(() => {
    if (!inject) return;
    if (inject.attachments?.length) setAttachments((prev) => [...prev, ...inject.attachments!]);
    if (inject.text) {
      setDraft(inject.text);
      if (editor.current) { editor.current.innerText = inject.text; }
    }
    requestAnimationFrame(() => editor.current?.focus());
  }, [inject?.nonce]);

  useEffect(() => {
    if (!trigger) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target !== editor.current && !target.closest(".composer-suggestions")) setTrigger(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [trigger]);

  const isImageFile = (file: File, path: string): boolean => file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test(path);
  const isTextFile = (file: File, path: string): boolean => file.type.startsWith("text/") || /\.(txt|md|markdown|json|csv|tsv|ya?ml|toml|log|xml|html|css|tsx?|jsx?|cjs|mjs|py|rb|go|rs|java|kt|swift|sh|zsh|bash|sql)$/i.test(path);

  const readFileAsDataUrl = (file: File): Promise<string | null> => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

  const readFileAsText = (file: File): Promise<string | null> => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });

  const textToDataUrl = (text: string): string => `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;

  const addAttachmentFiles = (files: FileList | File[]): void => {
    const selected = Array.from(files);
    if (!selected.length) return;
    const next = selected.map((file) => {
      const path = window.devilCodex.getFilePath(file) || file.name;
      return { path, name: file.name || path.split("/").at(-1) || path, kind: isImageFile(file, path) ? "image" as const : "file" as const, mime: file.type || undefined, size: file.size };
    });
    setAttachments((current) => [...current, ...next.filter((item) => !current.some((existing) => existing.path === item.path))]);
    void Promise.all(next.map(async (item) => {
      const file = selected.find((candidate) => (window.devilCodex.getFilePath(candidate) || candidate.name) === item.path);
      if (!file) return;
      if (item.kind === "image") {
        const localPreview = await window.devilCodex.previewLocalImage({ path: item.path }).catch(() => null);
        const dataUrl = localPreview ?? (await readFileAsDataUrl(file));
        if (!dataUrl) return;
        setAttachments((current) => current.map((existing) => existing.path === item.path ? { ...existing, url: dataUrl } : existing));
        return;
      }
      if (isTextFile(file, item.path)) {
        const content = await readFileAsText(file);
        if (!content) return;
        setAttachments((current) => current.map((existing) => existing.path === item.path ? { ...existing, content, url: textToDataUrl(content) } : existing));
      }
    }));
  };

  const addTextAttachment = (text: string): void => {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const name = `pasted-text-${stamp}.txt`;
    const attachment: ComposerAttachment = {
      path: name,
      name,
      kind: "file",
      mime: "text/plain",
      size: new TextEncoder().encode(text).length,
      content: text,
      url: textToDataUrl(text),
    };
    setAttachments((current) => [...current, attachment]);
  };

  const addAttachments = (event: ChangeEvent<HTMLInputElement>): void => {
    addAttachmentFiles(event.target.files ?? []);
    event.target.value = "";
  };

  const removeAttachment = (key: string): void => {
    // Match the same fallback key the gallery emits (path → url → name) so
    // injected attachments without a path (browser screenshots) can be removed.
    setAttachments((current) => current.filter((item) => (item.path ?? item.url ?? item.name) !== key));
  };

  const updateTrigger = (element: HTMLDivElement): void => {
    const textBeforeCaret = getEditorTextBeforeCaret(element);
    const match = textBeforeCaret?.match(/(?:^|\s)([$/])([^\s$/]*)$/);
    if (!match) {
      setTrigger(null);
      return;
    }
    const token = `${match[1]}${match[2]}`;
    const position = getEditorCaretPosition(element);
    if (!position) return;
    const menuWidth = 600;
    const menuHeight = match[1] === "/" ? 390 : 300;
    const composerRect = element.closest(".composer")?.getBoundingClientRect();
    if (composerRect) {
      position.left = Math.max(8, Math.min(composerRect.left + 12, window.innerWidth - menuWidth - 8));
      position.top = Math.max(8, composerRect.top - menuHeight - 10);
    } else {
      position.left = Math.max(8, Math.min(position.left, window.innerWidth - menuWidth - 8));
      position.top = Math.max(8, position.top - menuHeight - 10);
    }

    setTrigger({ sigil: match[1] as "$" | "/", query: match[2], position, tokenLength: token.length });
    setActiveSuggestion(0);
  };

  const runCommand = (name: string): void => {
    if (name === "review") onReview();
    else if (name === "status") onStatus();
    else if (name === "goal" || name === "plan") setGoalMode(true);
    else if (name === "mcp") onMcp();
    else if (name === "feedback") onFeedback();
    else if (name === "init") onSubmit({ prompt: "프로젝트 루트의 AGENTS.md를 현재 프로젝트에 맞게 생성하거나 업데이트해줘.", approvalMode, goalMode: false, attachments: [], skills: [] });
  };

  const chooseSuggestion = (item: ComposerSuggestion): void => {
    if (!trigger) return;
    const name = item.id.split(":")[1];
    if (item.kind === "command") {
      if (editor.current) removeEditorTrigger(editor.current, trigger.tokenLength);
      runCommand(name);
    } else if (editor.current && insertInlineSkill(editor.current, name, trigger.tokenLength, skillOptions.find((skill) => skill.name === name)?.name)) {
      setSkills(editorSkills(editor.current));
      setDraft(editorText(editor.current));
    }
    setTrigger(null);
    requestAnimationFrame(() => editor.current?.focus());
  };

  const submit = (): void => {
    const prompt = editor.current ? editorText(editor.current) : draft.trim();
    // No `busy` guard: while a turn runs, submitting queues the message (the
    // parent enqueues it and auto-sends when the current turn finishes).
    if ((!prompt && attachments.length === 0) || !attachmentsReady || !connected) return;
    onSubmit({ prompt, approvalMode, goalMode, attachments, skills, reasoningEffort, responseSpeed });
    clearDraft();
  };

  const clearDraft = (): void => {
    setDraft("");
    setAttachments([]);
    setSkills([]);
    setGoalMode(false);
    setTrigger(null);
    if (editor.current) editor.current.innerHTML = "";
  };

  const canSend = (draft.trim().length > 0 || attachments.length > 0) && attachmentsReady && connected;

  const onDraftKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (trigger && suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSuggestion((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(null);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        chooseSuggestion(suggestions[activeSuggestion]);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onDraftPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      addAttachmentFiles(files);
      return;
    }
    const text = plainTextFromClipboard(event);
    if (!text) return;
    event.preventDefault();
    if (text.length >= LONG_PASTE_THRESHOLD || text.split("\n").length >= 25) {
      addTextAttachment(text);
      return;
    }
    if (!insertPlainTextAtSelection(event.currentTarget, text)) return;
    setDraft(editorText(event.currentTarget));
    setSkills(editorSkills(event.currentTarget));
    updateTrigger(event.currentTarget);
  };

  const onComposerDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    addAttachmentFiles(files);
  };

  return (
    <form className="composer-wrap" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      {queued.length > 0 && <QueuedMessages items={queued} onEdit={onEditQueued} onRemove={onRemoveQueued} onSteer={onSteerQueued} />}
      <div className={attachments.length > 0 ? "composer has-attachments" : "composer"} onDragOver={(event) => event.preventDefault()} onDrop={onComposerDrop}>
        {attachments.length > 0 && (
          <AttachmentGallery attachments={attachments} onRemove={removeAttachment} />
        )}
        <div
          ref={editor}
          className="composer-editor"
          contentEditable={connected}
          role="textbox"
          aria-multiline="true"
          data-placeholder={busy ? "실행 중 — 입력하면 끝난 뒤 이어서 보냅니다" : "작업을 설명하거나 질문하세요"}
          onInput={(event) => { setDraft(editorText(event.currentTarget)); setSkills(editorSkills(event.currentTarget)); updateTrigger(event.currentTarget); }}
          onClick={(event) => updateTrigger(event.currentTarget)}
          onKeyUp={(event) => { if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) updateTrigger(event.currentTarget); }}
          onKeyDown={onDraftKeyDown}
          onPaste={onDraftPaste}
          suppressContentEditableWarning
        />
        {goalMode && (
          <div className="composer-context">
            {goalMode && <button type="button" onClick={() => setGoalMode(false)}><Target size={13} />목표 ×</button>}
          </div>
        )}
        <div className="composer-footer">
          <input ref={attachmentInput} className="file-input" type="file" multiple accept="image/*,.txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.yaml,.yml,.toml,.log,.xml,.html,.css,.ts,.tsx,.js,.jsx,.py,.sh,.sql,.rtf,.pdf,.docx" onChange={addAttachments} />
          <button type="button" className="add-button" aria-label="첨부" onClick={() => attachmentInput.current?.click()}><Plus size={19} /></button>
          <div className="composer-options">
            <ApprovalPicker value={approvalMode} onChange={setApprovalMode} onOpen={() => setTrigger(null)} />
            <button type="button" className={goalMode ? "text-chip active" : "text-chip"} onClick={() => { setTrigger(null); setGoalMode((active) => !active); }}><Target size={14} />목표</button>
          </div>
          <div className="composer-spacer" />
          <ModelPicker model={model} providerId={providerId} providers={providers} codexConnected={codexConnected} contextUsage={contextUsage} reasoningEffort={reasoningEffort} responseSpeed={responseSpeed} onModelChange={onModelChange} onReasoningEffortChange={onReasoningEffortChange} onResponseSpeedChange={onResponseSpeedChange} />
          {busy && !canSend
            ? <button type="button" className="send-button stop-button" aria-label="작업 중지" title="작업 중지" onClick={onStop}><Square size={14} fill="currentColor" /></button>
            : <button type="submit" className="send-button" disabled={!canSend} title={busy ? "대기열에 추가" : "보내기"}><ArrowRight size={18} /></button>}
        </div>
        {projectContext && <div className="composer-project-context"><span><FolderTree size={14} />{projectContext.name}</span><span><Laptop size={14} />로컬에서 작업</span><span><GitBranch size={14} />{projectContext.branch || "main"}</span></div>}
        <AnimatePresence>{trigger && suggestions.length > 0 && <ComposerSuggestions items={suggestions} activeIndex={activeSuggestion} position={trigger.position} onSelect={chooseSuggestion} />}</AnimatePresence>
      </div>
    </form>
  );
}

// Floating panel above the composer listing messages waiting to send. Each row
// is one line: click the text to edit · enter icon to steer (jump it now) · ✕
// to cancel before its turn fires.
function QueuedMessages({ items, onEdit, onRemove, onSteer }: {
  items: Array<{ id: string; text: string }>;
  onEdit?: (id: string, text: string) => void;
  onRemove?: (id: string) => void;
  onSteer?: (id: string) => void;
}) {
  return (
    <div className="queued-panel">
      {items.map((item) => (
        <QueuedRow key={item.id} item={item} onEdit={onEdit} onRemove={onRemove} onSteer={onSteer} />
      ))}
    </div>
  );
}

function QueuedRow({ item, onEdit, onRemove, onSteer }: {
  item: { id: string; text: string };
  onEdit?: (id: string, text: string) => void;
  onRemove?: (id: string) => void;
  onSteer?: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(item.text); }, [item.text]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const commit = (): void => {
    setEditing(false);
    const next = text.trim();
    if (next && next !== item.text.trim()) onEdit?.(item.id, next);
    else setText(item.text);
  };
  return (
    <div className="queued-row">
      {editing
        ? <input
            ref={inputRef}
            className="queued-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } if (event.key === "Escape") { event.preventDefault(); setText(item.text); setEditing(false); } }}
          />
        : <button type="button" className="queued-text" title="눌러서 편집" onClick={() => setEditing(true)}>{item.text || "(빈 메시지)"}</button>}
      <button type="button" className="queued-act" aria-label="지금 보내기(스티어링)" title="지금 보내기 · 현재 작업 중단" onClick={() => onSteer?.(item.id)}><CornerDownLeft size={14} /></button>
      <button type="button" className="queued-act" aria-label="대기 취소" title="취소" onClick={() => onRemove?.(item.id)}><X size={14} /></button>
    </div>
  );
}
