import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Folder, Globe2, MessageSquarePlus, MoreVertical, Plus, RotateCcw, ScanLine, Send, X } from "lucide-react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowserState, ProviderAuthStatus, ProviderId, ProviderInfo, ThreadAttachment, ThreadHistoryItem, WorkspaceChange, WorkspaceChanges, WorkspaceDiff } from "../../shared/contracts";
import type { ToolKind } from "./ToolLauncherMenu";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";
import { MarkdownContent } from "./MarkdownContent";
import { AttachmentGallery } from "./AttachmentCards";
import { useAttachments } from "../hooks/useAttachments";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { parseUnifiedDiff, toSplitDiffRows, type ParsedDiffLine } from "./unifiedDiff";

export type ContentTool = Exclude<ToolKind, "terminal">;

type ElectronWebview = HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };

// Runs inside the guest page: hover-highlight elements, click to pick. Resolves
// with the clicked element's rect/selector (or null on ESC/cancel). Exposes
// window.__devilCancelPick so the host button can cancel.
const INSPECTOR_SCRIPT = `(function(){return new Promise(function(resolve){
  var prev=document.getElementById('__devil_inspect__'); if(prev)prev.remove();
  var ov=document.createElement('div'); ov.id='__devil_inspect__';
  ov.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;background:rgba(43,108,255,.18);border:2px solid #2b6cff;border-radius:3px;box-shadow:0 0 0 9999px rgba(0,0,0,.02)';
  (document.body||document.documentElement).appendChild(ov); var cur=null; var done=false;
  function move(e){var el=document.elementFromPoint(e.clientX,e.clientY); if(!el||el===ov)return; cur=el; var r=el.getBoundingClientRect(); ov.style.left=r.left+'px'; ov.style.top=r.top+'px'; ov.style.width=r.width+'px'; ov.style.height=r.height+'px';}
  function cleanup(){if(done)return;done=true;document.removeEventListener('mousemove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);try{ov.remove()}catch(_){};window.__devilCancelPick=null;}
  function click(e){e.preventDefault();e.stopPropagation();var el=cur||document.elementFromPoint(e.clientX,e.clientY);cleanup();if(!el){resolve(null);return;}var r=el.getBoundingClientRect();var cls=(el.className&&typeof el.className==='string')?('.'+el.className.trim().split(/\\s+/).slice(0,2).join('.')):'';var sel=(el.tagName||'').toLowerCase()+(el.id?('#'+el.id):'')+cls;resolve({rect:{x:Math.max(0,r.left),y:Math.max(0,r.top),width:r.width,height:r.height},selector:sel});}
  function key(e){if(e.key==='Escape'){cleanup();resolve(null);}}
  window.__devilCancelPick=function(){cleanup();resolve(null);};
  document.addEventListener('mousemove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);
});})();`;
type SideChatTarget = { thread: { id: string; label: string }; model: string; provider: ProviderId; cwd: string; providers: ProviderInfo[] };
const sideChatModelPageSize = 10;
const emptyAuth: ProviderAuthStatus = { codex: false, claude: false, copilot: false };

function providerUsableForPicker(provider: ProviderInfo, auth: ProviderAuthStatus): boolean {
  if (!provider.models.length) return false;
  if (provider.kind === "login") {
    if (provider.id === "codex") return provider.modelsLoaded || provider.models.length > 0;
    return Boolean(provider.authProvider && auth[provider.authProvider] && provider.modelsLoaded);
  }
  return provider.keyRequired ? provider.credentialSource !== "none" && provider.modelsLoaded : provider.modelsLoaded;
}

function SideChatModelPicker({ value, providers, onChange }: { value: { provider: ProviderId; model: string }; providers: ProviderInfo[]; onChange: (pick: { provider: ProviderId; model: string }) => void }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState<ProviderAuthStatus>(emptyAuth);
  const [expanded, setExpanded] = useState<Set<ProviderId>>(() => new Set([value.provider]));
  const [visibleCounts, setVisibleCounts] = useState<Partial<Record<ProviderId, number>>>({});
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const close = (): void => setOpen(false);
  useOutsideDismiss(root, close, open, menuRef);

  useEffect(() => {
    if (open) void window.devilCodex.providerAuthStatus().then(setAuth).catch(() => undefined);
  }, [open]);
  useEffect(() => window.devilCodex.onProviderAuth(setAuth), []);

  const connected = providers.filter((provider) => providerUsableForPicker(provider, auth));
  const activeProvider = connected.find((provider) => provider.id === value.provider) ?? providers.find((provider) => provider.id === value.provider);
  const activeModel = activeProvider?.models.find((model) => model.id === value.model);

  useEffect(() => {
    const selectedStillUsable = connected.some((provider) => provider.id === value.provider && provider.models.some((model) => model.id === value.model));
    const fallback = connected[0]?.models[0];
    if (!selectedStillUsable && connected[0] && fallback) onChange({ provider: connected[0].id, model: fallback.id });
  }, [connected, onChange, value.model, value.provider]);

  useEffect(() => {
    if (!open) {
      setVisibleCounts({});
      setExpanded(new Set([value.provider]));
    }
  }, [open, value.provider]);

  const updateMenuPosition = (): void => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, Math.max(260, window.innerWidth - 16));
    const maxHeight = Math.min(520, window.innerHeight - 16);
    const gap = 8;
    const left = Math.min(window.innerWidth - width - gap, Math.max(gap, rect.right - width));
    const below = rect.bottom + gap;
    const above = rect.top - gap - maxHeight;
    const top = below + maxHeight <= window.innerHeight - gap ? below : Math.max(gap, above);
    setMenuPos({ left, top });
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  const toggleProvider = (id: ProviderId): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const visibleCount = (provider: ProviderInfo): number => {
    const selectedIndex = provider.id === value.provider ? provider.models.findIndex((item) => item.id === value.model) : -1;
    const selectedPage = selectedIndex >= 0 ? Math.ceil((selectedIndex + 1) / sideChatModelPageSize) * sideChatModelPageSize : sideChatModelPageSize;
    return Math.min(provider.models.length, Math.max(visibleCounts[provider.id] ?? sideChatModelPageSize, selectedPage));
  };
  const showMore = (provider: ProviderInfo): void => setVisibleCounts((current) => ({ ...current, [provider.id]: Math.min(provider.models.length, visibleCount(provider) + sideChatModelPageSize) }));
  const choose = (provider: ProviderInfo, model: { id: string }): void => {
    onChange({ provider: provider.id, model: model.id });
    close();
  };

  return <div className="side-chat-model-picker" ref={root} data-popover-root>
    <button type="button" className="side-chat-model-trigger" onClick={() => setOpen((current) => !current)} title={`${activeProvider?.label ?? value.provider} · ${activeModel?.label ?? value.model}`}>
      <span>{activeModel?.label ?? value.model}</span>
      <ChevronDown size={13} />
    </button>
    {createPortal(
      <AnimatePresence>
        {open && <motion.div ref={menuRef} className="side-chat-model-menu" style={{ left: menuPos.left, top: menuPos.top }} initial={{ opacity: 0, y: 4, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 3, scale: .98 }} transition={{ duration: .14, ease: [.4, 0, .2, 1] }}>
          <div className="model-section-label">모델</div>
          {connected.length === 0 && <p className="model-provider-empty">설정 → 연결에서 사용 가능한 모델을 먼저 연결하세요.</p>}
          {connected.map((provider) => {
            const isExpanded = expanded.has(provider.id);
            const count = visibleCount(provider);
            const remaining = provider.models.length - count;
            return <div className="model-picker-provider-group" key={provider.id}>
              <div className="model-picker-provider-head">
                <button type="button" className="model-provider-toggle" aria-expanded={isExpanded} onClick={() => toggleProvider(provider.id)}>
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span><strong>{provider.label}</strong><small>{provider.id === value.provider && activeModel ? activeModel.label : `${provider.models.length}개 모델`}</small></span>
                </button>
              </div>
              <AnimatePresence initial={false}>
                {isExpanded && <motion.div className="model-provider-options" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .16, ease: [.4, 0, .2, 1] }}>
                  {provider.models.slice(0, count).map((model) => <button type="button" className="model-option" key={model.id} onClick={() => choose(provider, model)}>
                    <span className="model-option-label"><strong>{model.label || model.id}</strong>{model.capability && <small><i className={`cap ${model.capability.diagnostics}`}>{model.capability.diagnostics}</i><i>tool {model.capability.tools ?? "unknown"}</i><i>img {model.capability.images ?? "unknown"}</i></small>}</span>
                    {provider.id === value.provider && model.id === value.model && <Check size={15} />}
                  </button>)}
                  {remaining > 0 && <button type="button" className="model-show-more" onClick={() => showMore(provider)}><span>더보기</span><small>{Math.min(sideChatModelPageSize, remaining)}개 더 보기 · {count}/{provider.models.length}</small></button>}
                </motion.div>}
              </AnimatePresence>
            </div>;
          })}
        </motion.div>}
      </AnimatePresence>,
      document.body,
    )}
  </div>;
}

export function ToolContent({ active, workspace, fileTarget, changes, selectedDiff, diffBusy, onBrowserAsk, subagents, onOpenSubagent, onNewSideChat, onSelectDiff, onSendReviewComment, onApplyHunk }: { active: ContentTool; workspace: string; fileTarget: string | null; changes: WorkspaceChanges; selectedDiff: WorkspaceDiff | null; diffBusy: boolean; onBrowserAsk?: (attachment: import("../../shared/contracts").ThreadAttachment, text?: string) => void; subagents?: Array<{ id: string; label: string }>; onOpenSubagent?: (id: string, label: string) => void; onNewSideChat?: () => void; onSelectDiff: (file: WorkspaceChange) => void; onSendReviewComment: (input: { path: string; line: number; side: "old" | "new"; text: string }) => void; onApplyHunk: (input: { path: string; hunk: string; action: "stage" | "revert" }) => Promise<void> }): React.JSX.Element {
  if (active === "review") return <div className="utility-review"><div className="review-summary"><h2>변경 사항</h2><p><i>+{changes.additions}</i> <b>-{changes.deletions}</b> · {changes.files.length}개 파일</p></div><div className="review-files">{changes.files.map((file) => <button className={selectedDiff?.path === file.path ? "active" : ""} key={`${file.status}:${file.path}`} onClick={() => onSelectDiff(file)}><span>{file.status === "??" ? "새 파일" : file.status}</span><strong>{file.path}</strong><em><i>+{file.additions}</i> <b>-{file.deletions}</b></em></button>)}</div><DiffPreview diff={selectedDiff} loading={diffBusy} onSend={onSendReviewComment} onApplyHunk={onApplyHunk} /></div>;
  if (active === "files") return <WorkspaceFilesPanel workspace={workspace} target={fileTarget} />;
  if (active === "side-chat") return <div className="side-chat-launcher">
    <button type="button" className="side-chat-new" onClick={() => onNewSideChat?.()}><Plus size={15} />새 사이드 채팅</button>
    {(subagents ?? []).length > 0 && <div className="side-chat-launcher-caption">사이드 채팅 · 하위 에이전트</div>}
    {(subagents ?? []).map((agent) => <button type="button" key={agent.id} className="side-chat-launcher-row" onClick={() => onOpenSubagent?.(agent.id, agent.label)}><Bot size={15} /><span>{agent.label}</span></button>)}
    {(subagents ?? []).length === 0 && <p className="side-chat-launcher-empty">아직 대화가 없습니다. 새 사이드 채팅으로 시작하면 여기 목록에 추가됩니다.</p>}
  </div>;
  if (active === "browser") return <BrowserPanel onAsk={onBrowserAsk} />;
  const label = { files: "파일" }[active] ?? active;
  return <div className="utility-empty"><Folder /><strong>{label}</strong><small>실제 Codex backend 연결 예정</small></div>;
}

// Embedded browser ("브라우저" tab). Renders a real Chromium guest as a DOM
// <webview> (so modals/popovers layer above it via z-index). The guest's
// WebContents is captured in the main process so user + AI control share one
// path; this component owns the address bar + nav + page tools.
function BrowserPanel({ onAsk }: { onAsk?: (attachment: ThreadAttachment, text?: string) => void }): React.JSX.Element {
  const [state, setState] = useState<BrowserState>({ url: "", title: "", loading: false, canGoBack: false, canGoForward: false });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [zoom, setZoom] = useState(100);
  const [picking, setPicking] = useState(false);
  const [annotation, setAnnotation] = useState<{ selector: string; shot: string } | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    void window.devilCodex.browserState().then(setState).catch(() => undefined);
    const off = window.devilCodex.onBrowserState(setState);
    return off;
  }, []);
  useEffect(() => { if (!editing) setDraft(state.url === "about:blank" ? "" : state.url); }, [state.url, editing]);

  const go = (): void => { void window.devilCodex.browserNavigate({ url: draft }); setEditing(false); };
  const setZoomBy = (delta: number): void => { void window.devilCodex.browserZoom({ delta }).then((f) => setZoom(Math.round(f * 100))); };
  const resetZoom = (): void => { void window.devilCodex.browserZoom({ reset: true }).then((f) => setZoom(Math.round(f * 100))); };

  // Screenshot the page and hand it to the composer to ask about.
  const screenshotToComposer = async (): Promise<void> => {
    const shot = await window.devilCodex.browserScreenshot();
    if (shot) onAsk?.({ name: `browser-${Date.now()}.png`, kind: "image", url: shot, mime: "image/png" });
  };

  const webviewRef = useRef<ElectronWebview | null>(null);

  // Annotate (DevTools-style): inject a picker into the guest <webview> that
  // hover-highlights elements; click selects one. We then crop a screenshot to
  // its rect. Toggling the button (or ESC in-page) cancels.
  const pickElement = async (): Promise<void> => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (picking) { void wv.executeJavaScript("window.__devilCancelPick&&window.__devilCancelPick()").catch(() => undefined); setPicking(false); return; }
    setPicking(true);
    try {
      const picked = await wv.executeJavaScript(INSPECTOR_SCRIPT) as { rect: { x: number; y: number; width: number; height: number }; selector: string } | null;
      if (picked) {
        const shot = await window.devilCodex.browserCaptureRect(picked.rect);
        if (shot) setAnnotation({ selector: picked.selector, shot });
      }
    } catch { /* navigation/cancel */ } finally {
      setPicking(false);
    }
  };
  const submitAnnotation = (): void => {
    if (!annotation) return;
    onAsk?.({ name: `browser-element-${Date.now()}.png`, kind: "image", url: annotation.shot, mime: "image/png" }, `브라우저에서 선택한 요소(${annotation.selector})에 대해: ${note || "이 부분 설명해줘"}`);
    setAnnotation(null);
    setNote("");
  };

  return <div className="browser-panel">
    <div className="browser-toolbar">
      <button onClick={() => void window.devilCodex.browserBack()} disabled={!state.canGoBack} aria-label="뒤로"><ChevronLeft size={16} /></button>
      <button onClick={() => void window.devilCodex.browserForward()} disabled={!state.canGoForward} aria-label="앞으로"><ChevronRight size={16} /></button>
      <button onClick={() => void (state.loading ? window.devilCodex.browserStop() : window.devilCodex.browserReload())} aria-label="새로고침">{state.loading ? <X size={15} /> : <RotateCcw size={15} />}</button>
      <input
        className="browser-url"
        value={draft}
        placeholder="주소 입력 또는 검색"
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => { setEditing(true); event.target.select(); }}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => { if (event.key === "Enter") go(); }}
      />
      <button onClick={() => void screenshotToComposer()} aria-label="스크린샷"><ScanLine size={16} /></button>
      <button className={picking ? "active" : ""} onClick={() => void pickElement()} disabled={picking} aria-label="요소 선택해 질문"><MessageSquarePlus size={16} /></button>
      <div className="browser-menu-wrap">
        <button className={menuOpen ? "active" : ""} onClick={() => setMenuOpen((v) => !v)} aria-label="더보기"><MoreVertical size={16} /></button>
        {menuOpen && <div className="browser-menu" onMouseLeave={() => setMenuOpen(false)}>
          <button onClick={() => { void window.devilCodex.browserHardReload(); setMenuOpen(false); }}>강제 새로고침</button>
          <button onClick={() => { setFindOpen(true); setMenuOpen(false); }}>페이지에서 찾기</button>
          <div className="browser-menu-divider" />
          <div className="browser-menu-zoom">
            <span>확대/축소</span>
            <button onClick={() => setZoomBy(-0.1)}>−</button>
            <em>{zoom}%</em>
            <button onClick={() => setZoomBy(0.1)}>+</button>
            <button onClick={resetZoom} aria-label="초기화"><RotateCcw size={13} /></button>
          </div>
          <div className="browser-menu-divider" />
          <button onClick={() => { void window.devilCodex.browserClearCookies(); setMenuOpen(false); }}>쿠키 지우기</button>
          <button onClick={() => { void window.devilCodex.browserClearCache(); setMenuOpen(false); }}>캐시 지우기</button>
        </div>}
      </div>
    </div>
    {findOpen && <div className="browser-find">
      <input autoFocus value={findText} placeholder="페이지에서 찾기" onChange={(e) => { setFindText(e.target.value); void window.devilCodex.browserFind({ text: e.target.value }); }} onKeyDown={(e) => { if (e.key === "Enter") void window.devilCodex.browserFind({ text: findText, findNext: true }); if (e.key === "Escape") { void window.devilCodex.browserStopFind(); setFindOpen(false); } }} />
      <button onClick={() => { void window.devilCodex.browserStopFind(); setFindOpen(false); setFindText(""); }}><X size={14} /></button>
    </div>}
    <div className="browser-host">
      {/* @ts-expect-error webview is an Electron intrinsic element */}
      <webview ref={webviewRef} src="about:blank" partition="persist:devil-browser" allowpopups="true" style={{ width: "100%", height: "100%", border: 0 }} />
      {picking && <div className="browser-pick-hint"><span>요소 위에 마우스를 올리고 클릭하세요 · 취소하려면 버튼을 다시 누르세요</span></div>}
    </div>
    {annotation && <div className="browser-annotate-bar">
      <img src={annotation.shot} alt="선택 요소" />
      <input autoFocus value={note} placeholder={`${annotation.selector} — 질문…`} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitAnnotation(); if (e.key === "Escape") { setAnnotation(null); setNote(""); } }} />
      <button onClick={submitAnnotation}><Send size={14} /></button>
      <button onClick={() => { setAnnotation(null); setNote(""); }}><X size={14} /></button>
    </div>}
  </div>;
}

// Conversation state is lifted to the parent (history/onHistory) so it survives
// tab switches and the optimistic message isn't lost on reload.
export function SideChat({ target, history, busy, pick, onPick, onHistory }: { target: SideChatTarget; history: ThreadHistoryItem[] | undefined; busy: boolean; pick?: { provider: ProviderId; model: string }; onPick: (pick: { provider: ProviderId; model: string }) => void; onHistory: (items: ThreadHistoryItem[]) => void }): React.JSX.Element {
  const { thread, cwd, providers } = target;
  const [loaded, setLoaded] = useState(history !== undefined);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Picked model is persisted by the parent (per subagent) so it survives tab switches.
  const picked = pick ?? { provider: target.provider, model: target.model };
  const attach = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try { onHistory(await window.devilCodex.readThread({ id: thread.id })); }
    catch { onHistory([]); }
    finally { setLoaded(true); }
  // onHistory identity changes per render; intentionally only depend on thread.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  // Seed past conversation once; new turns stream in live via app-server events.
  useEffect(() => { if (history === undefined) void load(); else setLoaded(true); }, [thread.id, history, load]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [history, busy, sending]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const atts = attach.attachments;
    if ((!text && atts.length === 0) || sending || busy || !attach.ready) return;
    setDraft("");
    const images = atts.filter((a) => a.kind === "image").map((a) => a.url ?? a.path ?? "").filter(Boolean);
    setSending(true);
    // The app-server doesn't echo the turn input as a userMessage event for the
    // subagent thread, so add the user's message ourselves; live events then
    // append the agent reply after it.
    const seeded = [...(history ?? []), { id: `local-${Date.now()}`, kind: "user" as const, text, ...(atts.length ? { attachments: atts } : {}) }];
    onHistory(seeded);
    attach.clear();
    const baseAgentCount = (history ?? []).filter((m) => m.kind === "agent").length;
    try {
      // Best-effort resume: a freshly created side-chat thread has no rollout yet
      // (already loaded from createThread), so a failed resume is fine — proceed.
      if (picked.provider === "codex") await window.devilCodex.resumeThread({ id: thread.id, model: picked.model }).catch(() => undefined);
      console.log("[devil-sidechat] send", { threadId: thread.id, ...picked });
      await window.devilCodex.sendTurn({ threadId: thread.id, cwd, text: text || "첨부 파일을 확인해줘.", model: picked.model, provider: picked.provider, subagent: true, attachments: images, attachmentDetails: atts });
      // Fallback: live events may not stream for a non-active thread; poll the
      // thread until the agent reply lands, then show the authoritative history.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const fresh = await window.devilCodex.readThread({ id: thread.id }).catch(() => [] as ThreadHistoryItem[]);
        if (fresh.filter((m) => m.kind === "agent").length > baseAgentCount) { onHistory(fresh); break; }
      }
    } catch (error) {
      onHistory([...seeded, { id: `err-${Date.now()}`, kind: "agent", text: `요청 실패: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally {
      setSending(false);
    }
  };

  const messages = (history ?? []).filter((item) => item.kind === "user" || item.kind === "agent");
  const working = busy || sending;
  return <div className="side-chat">
    <header className="side-chat-head"><Bot size={15} /><strong>{thread.label}</strong>
      <SideChatModelPicker value={picked} providers={providers} onChange={onPick} />
    </header>
    <div className="side-chat-body" ref={bodyRef}>
      {!loaded ? <em className="side-chat-empty">불러오는 중…</em>
        : messages.length === 0 && !working ? <em className="side-chat-empty">대화 내용이 없습니다.</em>
        : messages.map((item) => <div key={item.id} className={`side-chat-bubble ${item.kind}`}>
            {item.attachments?.length ? <AttachmentGallery attachments={item.attachments} align={item.kind === "user" ? "end" : "start"} /> : null}
            {item.text && <MarkdownContent text={item.text} onOpenFile={() => undefined} />}
          </div>)}
      {working && <div className="side-chat-working"><span className="side-chat-spinner" />작업 중…</div>}
    </div>
    <div className="side-chat-compose" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const files = Array.from(event.dataTransfer.files ?? []); if (files.length) { event.preventDefault(); attach.addFiles(files); } }}>
      {attach.attachments.length > 0 && <AttachmentGallery attachments={attach.attachments} onRemove={attach.remove} />}
      <div className="side-chat-input">
        <input ref={fileInput} type="file" multiple className="file-input" accept="image/*,.txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.yaml,.yml,.toml,.log,.xml,.html,.css,.ts,.tsx,.js,.jsx,.py,.sh,.sql,.rtf,.pdf,.docx" onChange={(event) => { attach.addFiles(event.target.files ?? []); event.target.value = ""; }} />
        <button type="button" className="side-chat-attach" aria-label="첨부" onClick={() => fileInput.current?.click()}><Plus size={16} /></button>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={(event) => { const files = Array.from(event.clipboardData.files ?? []); if (files.length) { event.preventDefault(); attach.addFiles(files); } }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={`${thread.label}에게 보내기`} rows={2} />
        <button type="button" disabled={(!draft.trim() && attach.attachments.length === 0) || working || !attach.ready} onClick={() => void send()} aria-label="보내기"><Send size={15} /></button>
      </div>
    </div>
  </div>;
}

function DiffPreview({ diff, loading, onSend, onApplyHunk }: { diff: WorkspaceDiff | null; loading: boolean; onSend: (input: { path: string; line: number; side: "old" | "new"; text: string }) => void; onApplyHunk: (input: { path: string; hunk: string; action: "stage" | "revert" }) => Promise<void> }): React.JSX.Element {
  const [commentLine, setCommentLine] = useState<ParsedDiffLine | null>(null);
  const [comment, setComment] = useState("");
  const [hunkBusy, setHunkBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  if (loading) return <div className="diff-preview-panel muted">변경 사항을 불러오는 중…</div>;
  if (!diff) return <div className="diff-preview-panel muted">검토할 파일을 선택하세요.</div>;
  if (diff.binary) return <div className="diff-preview-panel muted">바이너리 파일은 line diff를 표시할 수 없습니다.</div>;
  const lines = parseUnifiedDiff(diff.text);
  const send = (): void => {
    if (!commentLine || !comment.trim()) return;
    const side = commentLine.newLine == null ? "old" : "new";
    onSend({ path: diff.path, line: commentLine.newLine ?? commentLine.oldLine ?? 0, side, text: comment.trim() });
    setComment("");
    setCommentLine(null);
  };
  const applyHunk = async (hunk: string, action: "stage" | "revert"): Promise<void> => {
    if (action === "revert" && !window.confirm("이 hunk의 작업공간 변경을 되돌릴까요?")) return;
    setHunkBusy(hunk);
    try { await onApplyHunk({ path: diff.path, hunk, action }); } finally { setHunkBusy(null); }
  };
  const openComment = (line: ParsedDiffLine | undefined): void => { if (line?.oldLine != null || line?.newLine != null) { setCommentLine(line); setComment(""); } };
  const changeMode = (next: "unified" | "split"): void => { setMode(next); setCommentLine(null); };
  const reviewForm = commentLine && <div className="inline-review-comment"><header><strong>{diff.path}:{commentLine.newLine ?? commentLine.oldLine}</strong><button type="button" onClick={() => setCommentLine(null)}><X size={14} /></button></header><textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send(); }} placeholder="이 줄에 대한 의견을 입력하세요" /><button type="button" disabled={!comment.trim()} onClick={send}><Send size={13} />Codex에 보내기</button></div>;
  return <section className="diff-preview-panel"><header><FileText size={15} /><strong>{diff.path}</strong><span className="diff-mode"><button type="button" className={mode === "unified" ? "active" : ""} onClick={() => changeMode("unified")}>Unified</button><button type="button" className={mode === "split" ? "active" : ""} onClick={() => changeMode("split")}>Split</button></span><span><i>+{diff.additions}</i> <b>-{diff.deletions}</b></span></header>{mode === "unified" ? <div className="diff-lines">{lines.map((line) => <div key={line.id}>
    {line.kind === "hunk" && line.hunk && <div className="diff-hunk-actions"><code>{line.text}</code><button type="button" disabled={hunkBusy !== null} onClick={() => void applyHunk(line.hunk!, "stage")}>hunk 스테이징</button><button type="button" disabled={hunkBusy !== null} onClick={() => void applyHunk(line.hunk!, "revert")}><RotateCcw size={12} />되돌리기</button></div>}
    {line.kind !== "hunk" && <button type="button" className={`diff-line ${line.kind}`} disabled={line.oldLine == null && line.newLine == null} onClick={() => openComment(line)}><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><code>{line.text || " "}</code></button>}
    {commentLine?.id === line.id && reviewForm}
  </div>)}</div> : <><div className="split-diff-lines">{toSplitDiffRows(lines).map((row) => row.hunk ? <div className="split-hunk" key={row.id}>{row.hunk.text}</div> : <div className="split-row" key={row.id}><button type="button" className={`split-cell ${row.old?.kind ?? "empty"}`} disabled={!row.old} onClick={() => openComment(row.old)}><span>{row.old?.oldLine ?? ""}</span><code>{row.old?.text.replace(/^[+-]/, "") ?? ""}</code></button><button type="button" className={`split-cell ${row.next?.kind ?? "empty"}`} disabled={!row.next} onClick={() => openComment(row.next)}><span>{row.next?.newLine ?? ""}</span><code>{row.next?.text.replace(/^[+-]/, "") ?? ""}</code></button></div>)}</div>{reviewForm}</>}</section>;
}
