import { type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowRight, CornerDownLeft, FolderTree, GitBranch, Laptop, Plus, Square, Target, X } from "lucide-react";
import { ModelPicker } from "./ModelPicker";
import type { ContextUsage, ProviderId, ProviderInfo, ReasoningEffort, ResponseSpeed, ThreadAttachment } from "../../shared/contracts";
import { ApprovalPicker, type ApprovalMode } from "./ApprovalPicker";
import { ComposerSuggestions, suggestionsFor, type ComposerSuggestion, type SlashCommandId } from "./ComposerSuggestions";
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
const APPROVAL_MODE_KEY = "devil-codex:approval-mode";
const COMPOSER_DRAFTS_KEY = "devil-codex:composer-drafts";
type ComposerDraftSnapshot = { draft: string; goalMode: boolean; attachments: ComposerAttachment[]; skills: string[]; updatedAt: number };

function readComposerDrafts(): Record<string, ComposerDraftSnapshot> {
  try {
    const raw = JSON.parse(localStorage.getItem(COMPOSER_DRAFTS_KEY) ?? "{}") as Record<string, ComposerDraftSnapshot>;
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key && typeof value?.draft === "string"));
  } catch {
    return {};
  }
}

function readComposerDraft(key: string): Omit<ComposerDraftSnapshot, "updatedAt"> {
  const stored = readComposerDrafts()[key];
  return {
    draft: stored?.draft ?? "",
    goalMode: stored?.goalMode === true,
    attachments: Array.isArray(stored?.attachments) ? stored.attachments : [],
    skills: Array.isArray(stored?.skills) ? stored.skills.filter((item) => typeof item === "string") : [],
  };
}

function writeComposerDraft(key: string, snapshot: Omit<ComposerDraftSnapshot, "updatedAt">): void {
  if (!key) return;
  try {
    const drafts = readComposerDrafts();
    if (!snapshot.draft.trim() && !snapshot.goalMode && snapshot.attachments.length === 0 && snapshot.skills.length === 0) delete drafts[key];
    else drafts[key] = { ...snapshot, updatedAt: Date.now() };
    const compact = Object.fromEntries(Object.entries(drafts).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, 80));
    localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(compact));
  } catch {
    try {
      const drafts = readComposerDrafts();
      drafts[key] = {
        ...snapshot,
        attachments: snapshot.attachments.map(({ content: _content, url: _url, ...item }) => item),
        updatedAt: Date.now(),
      };
      localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Draft persistence is best-effort; quota errors should not block typing.
    }
  }
}

function clearComposerDraft(key: string): void {
  if (!key) return;
  try {
    const drafts = readComposerDrafts();
    delete drafts[key];
    localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Ignore storage failures.
  }
}

function storedApprovalMode(): ApprovalMode {
  const value = localStorage.getItem(APPROVAL_MODE_KEY);
  return value === "ask" || value === "agent" || value === "full" ? value : "agent";
}

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
  draftKey,
  busy,
  queued = [],
  onEditQueued,
  onRemoveQueued,
  onSteerQueued,
  connected,
  model,
  providerId,
  accountId,
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
  onSlashCommand,
  petVisible,
}: {
  draftKey: string;
  busy: boolean;
  queued?: Array<{ id: string; text: string }>;
  onEditQueued?: (id: string, text: string) => void;
  onRemoveQueued?: (id: string) => void;
  onSteerQueued?: (id: string) => void;
  connected: boolean;
  model: string;
  providerId: ProviderId;
  accountId?: string;
  providers: ProviderInfo[];
  codexConnected: boolean;
  contextUsage?: ContextUsage;
  reasoningEffort: ReasoningEffort;
  responseSpeed: ResponseSpeed;
  projectContext?: { name: string; branch: string };
  skillOptions: Array<{ name: string; description: string }>;
  inject?: { attachments?: ComposerAttachment[]; text?: string; nonce: number } | null;
  onModelChange: (input: { provider: ProviderId; accountId?: string; model: string }) => void;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  onResponseSpeedChange: (value: ResponseSpeed) => void;
  onSubmit: (input: ComposerInput) => void;
  onStop: () => void;
  onSlashCommand: (command: SlashCommandId) => void;
  petVisible: boolean;
}): React.JSX.Element {
  const initialDraft = useMemo(() => readComposerDraft(draftKey), []);
  const [draft, setDraft] = useState(initialDraft.draft);
  const [approvalMode, setApprovalModeState] = useState<ApprovalMode>(() => storedApprovalMode());
  const [goalMode, setGoalMode] = useState(initialDraft.goalMode);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(initialDraft.attachments);
  const [skills, setSkills] = useState<string[]>(initialDraft.skills);
  const [trigger, setTrigger] = useState<SuggestionTrigger | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const editor = useRef<HTMLDivElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const latestDraft = useRef<Omit<ComposerDraftSnapshot, "updatedAt">>(initialDraft);
  const suggestions = useMemo(() => trigger ? suggestionsFor(trigger.sigil, trigger.query, skillOptions, { model, reasoningEffort, responseSpeed, approvalMode, petVisible }) : [], [trigger, skillOptions, model, reasoningEffort, responseSpeed, approvalMode, petVisible]);
  const attachmentsReady = attachments.every((item) => item.kind !== "image" || Boolean(item.url));
  const setApprovalMode = (value: ApprovalMode): void => {
    setApprovalModeState(value);
    localStorage.setItem(APPROVAL_MODE_KEY, value);
  };

  useLayoutEffect(() => {
    if (editor.current) editor.current.innerText = draft;
  }, []);

  useEffect(() => {
    latestDraft.current = { draft, goalMode, attachments, skills };
    writeComposerDraft(draftKey, latestDraft.current);
  }, [draftKey, draft, goalMode, attachments, skills]);

  useEffect(() => () => {
    writeComposerDraft(draftKey, latestDraft.current);
  }, [draftKey]);

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
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const entries = selected.map((file, index) => {
      const realPath = window.devilCodex.getFilePath(file);
      const displayName = file.name || (realPath ? realPath.split(/[\\/]/).at(-1) : "") || "clipboard-image.png";
      const path = realPath || `clipboard:${stamp}-${index}-${displayName}`;
      const item = { path, name: displayName, kind: isImageFile(file, realPath || displayName) ? "image" as const : "file" as const, mime: file.type || undefined, size: file.size };
      return { file, item, realPath };
    });
    setAttachments((current) => [...current, ...entries.map(({ item, realPath }) => item).filter((item, index) => {
      const realPath = entries[index].realPath;
      return !realPath || !current.some((existing) => existing.path === realPath);
    })]);
    void Promise.all(entries.map(async ({ file, item, realPath }) => {
      if (item.kind === "image") {
        const localPreview = realPath ? await window.devilCodex.previewLocalImage({ path: realPath }).catch(() => null) : null;
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

  const submitCommandPrompt = (prompt: string): void => {
    onSubmit({ prompt, approvalMode, goalMode: false, attachments: [], skills: [], reasoningEffort, responseSpeed });
  };

  const runCommand = (name: SlashCommandId): void => {
    if (name === "goal" || name === "plan") { setGoalMode(true); return; }
    if (name === "init") {
      submitCommandPrompt("프로젝트 루트의 AGENTS.md를 현재 프로젝트에 맞게 생성하거나 업데이트해줘.");
      return;
    }
    if (name === "memory") {
      submitCommandPrompt("현재 대화와 작업 상태에서 장기 기억으로 남겨야 할 결정, 선호, 진행 상황을 정리하고 필요한 프로젝트 메모리 파일을 업데이트해줘.");
      return;
    }
    onSlashCommand(name);
  };

  const chooseSuggestion = (item: ComposerSuggestion): void => {
    if (!trigger) return;
    const name = item.id.slice(item.id.indexOf(":") + 1);
    if (item.kind === "command") {
      if (editor.current) {
        removeEditorTrigger(editor.current, trigger.tokenLength);
        setDraft(editorText(editor.current));
        setSkills(editorSkills(editor.current));
      }
      runCommand(name as SlashCommandId);
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
    latestDraft.current = { draft: "", goalMode: false, attachments: [], skills: [] };
    setDraft("");
    setAttachments([]);
    setSkills([]);
    setGoalMode(false);
    setTrigger(null);
    clearComposerDraft(draftKey);
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
          <ModelPicker model={model} providerId={providerId} accountId={accountId} providers={providers} codexConnected={codexConnected} contextUsage={contextUsage} reasoningEffort={reasoningEffort} responseSpeed={responseSpeed} onModelChange={onModelChange} onReasoningEffortChange={onReasoningEffortChange} onResponseSpeedChange={onResponseSpeedChange} />
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
