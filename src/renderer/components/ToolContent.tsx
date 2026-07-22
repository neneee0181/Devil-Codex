import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Folder, FolderOpen, Globe2, MessageSquarePlus, MoreVertical, Plus, RotateCcw, ScanLine, Search, Send, Sparkles, X } from "lucide-react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentRuntimeId, BrowserState, ProviderAccount, ProviderAuthStatus, ProviderId, ProviderInfo, ProviderModel, ThreadApprovalPolicy, ThreadAttachment, ThreadHistoryItem, ThreadSandboxMode, WorkspaceChange, WorkspaceChanges, WorkspaceDiff, WorkspaceEntry } from "../../shared/contracts";
import type { ToolKind } from "./ToolLauncherMenu";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";
import { MarkdownContent } from "./MarkdownContent";
import { AttachmentGallery } from "./AttachmentCards";
import { TurnActivity } from "./TurnActivity";
import { useAttachments } from "../hooks/useAttachments";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";
import { parseUnifiedDiff, toSplitDiffRows, type ParsedDiffLine } from "./unifiedDiff";

export type ContentTool = Exclude<ToolKind, "terminal">;

type ElectronWebview = HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };

function readBrowserPersistentSession(): boolean {
  try {
    const settings = JSON.parse(localStorage.getItem("devil-codex:settings") ?? "{}") as { browserPersistentSession?: unknown };
    return settings.browserPersistentSession !== false;
  } catch {
    return true;
  }
}

const BROWSER_SESSION_URLS_KEY = "devil-codex:browser-session-urls";

function readBrowserSessionUrls(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(BROWSER_SESSION_URLS_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

function rememberBrowserSessionUrl(key: string, url: string): void {
  if (!url || url === "about:blank") return;
  localStorage.setItem(BROWSER_SESSION_URLS_KEY, JSON.stringify({ ...readBrowserSessionUrls(), [key]: url }));
}

function browserInitialUrl(key: string): string {
  return readBrowserSessionUrls()[key] || "about:blank";
}

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
type SideChatTarget = { thread: { id: string; label: string }; runtime: AgentRuntimeId; model: string; provider: ProviderId; accountId?: string; cwd: string; providers: ProviderInfo[]; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode };
const sideChatModelPageSize = 10;
const emptyAuth: ProviderAuthStatus = { codex: false, claude: false, copilot: false, antigravity: false, kimi: false };
const SIDE_CHAT_DRAFTS_KEY = "devil-codex:side-chat-drafts";

function readSideChatDrafts(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDE_CHAT_DRAFTS_KEY) ?? "{}") as Record<string, string>;
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key && typeof value === "string"));
  } catch {
    return {};
  }
}

function readSideChatDraft(threadId: string): string {
  return readSideChatDrafts()[threadId] ?? "";
}

function writeSideChatDraft(threadId: string, draft: string): void {
  if (!threadId) return;
  try {
    const drafts = readSideChatDrafts();
    if (draft.trim()) drafts[threadId] = draft;
    else delete drafts[threadId];
    localStorage.setItem(SIDE_CHAT_DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Draft persistence is best-effort.
  }
}

function providerUsableForPicker(provider: ProviderInfo, auth: ProviderAuthStatus): boolean {
  if (provider.kind === "login") {
    if (provider.id === "codex") return provider.modelsLoaded || provider.models.length > 0;
    return Boolean(provider.authProvider && auth[provider.authProvider] && provider.modelsLoaded);
  }
  if (provider.id === "opencode-free") return provider.models.length > 0;
  return provider.accounts.some((account) => account.credentialSource !== "none" && (account.models?.length ?? provider.models.length) > 0);
}

function accountModels(provider: ProviderInfo, account: ProviderAccount | undefined): ProviderModel[] {
  return account?.models?.length ? account.models : provider.models;
}

function accountLabel(account: ProviderAccount): string {
  return account.email || account.label || account.id;
}

function accountKey(provider: ProviderInfo, account?: ProviderAccount): string {
  return `${provider.id}:${account?.id ?? "default"}`;
}

type SideChatPick = { provider: ProviderId; accountId?: string; model: string; auto?: boolean };
type SideChatModelCandidate = SideChatPick & { label: string; score: number };

function pickLabel(providers: ProviderInfo[], pick: SideChatPick): string {
  const provider = providers.find((item) => item.id === pick.provider);
  const account = provider?.accounts.find((item) => item.id === pick.accountId);
  const model = provider ? accountModels(provider, account).find((item) => item.id === pick.model) : undefined;
  return `${provider?.label ?? pick.provider}${account ? ` · ${accountLabel(account)}` : ""} · ${model?.label ?? pick.model}`;
}

function hasUsableCredentials(provider: ProviderInfo, account: ProviderAccount | undefined): boolean {
  if (provider.id === "codex") return true;
  if (provider.id === "opencode-free") return Boolean(account && (account.models?.length ?? provider.models.length) > 0);
  if (provider.kind === "login") return Boolean(account && provider.modelsLoaded);
  if (!provider.keyRequired) return Boolean(account && account.credentialSource !== "none" && (account.models?.length ?? provider.models.length) > 0);
  return Boolean(account && account.credentialSource !== "none" && (account.models?.length ?? provider.models.length) > 0);
}

function sideChatProviderCandidates(provider: ProviderInfo): Array<{ account?: ProviderAccount; models: ProviderModel[] }> {
  const accounts = provider.accounts.length ? provider.accounts : [undefined];
  return accounts.flatMap((account) => {
    if (!hasUsableCredentials(provider, account)) return [];
    const models = accountModels(provider, account);
    return models.length ? [{ account, models }] : [];
  });
}

function scoreSideChatModel(provider: ProviderInfo, model: ProviderModel, text: string): number {
  const id = `${provider.id}:${model.id}`.toLowerCase();
  const capability = model.capability;
  const codeTask = /(code|코드|수정|버그|리팩|테스트|파일|구현|review|리뷰|diff|build|lint|typecheck)/i.test(text);
  let score = 0;
  if (capability?.tools === "native") score += 60;
  else if (capability?.tools === "limited") score += 28;
  else if (capability?.tools === "unknown") score += 8;
  if (capability?.diagnostics === "good") score += 45;
  else if (capability?.diagnostics === "limited") score += 22;
  else if (capability?.diagnostics === "experimental") score += 6;
  const providerScore: Partial<Record<ProviderId, number>> = {
    codex: 44,
    anthropic: 40,
    openai: 38,
    copilot: 34,
    google: 28,
    openrouter: 24,
    xai: 22,
    mistral: 20,
    moonshot: 20,
    deepseek: 16,
    "openrouter-free": 6,
    ollama: 4,
    vllm: 4,
    "lm-studio": 4,
  };
  score += providerScore[provider.id] ?? 14;
  if (/\b(codex|code|codestral|kimi|sonnet|gpt-5|claude|opus|grok-code)\b/.test(id)) score += codeTask ? 22 : 12;
  if (/\b(pro|large|reasoner|opus)\b/.test(id)) score += codeTask ? 12 : 6;
  if (/\b(mini|haiku|flash|highspeed|fast|nano)\b/.test(id)) score += codeTask ? 3 : 12;
  if (id.includes("free")) score -= 18;
  if (id.includes("experimental")) score -= 8;
  return score;
}

function sideChatModelCandidates(providers: ProviderInfo[], text: string, current: SideChatPick): SideChatModelCandidate[] {
  const rows = providers.flatMap((provider) => sideChatProviderCandidates(provider).flatMap(({ account, models }) => models.map((model) => ({
    provider: provider.id,
    accountId: account?.id,
    model: model.id,
    label: pickLabel(providers, { provider: provider.id, accountId: account?.id, model: model.id }),
    score: scoreSideChatModel(provider, model, text),
  }))));
  const seen = new Set<string>();
  const ranked = rows
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      const key = `${item.provider}:${item.accountId ?? "default"}:${item.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const currentCandidate: SideChatModelCandidate = {
    ...current,
    label: pickLabel(providers, current),
    score: -1,
  };
  const recommended = ranked.filter((item) => !(item.provider === current.provider && item.accountId === current.accountId && item.model === current.model)).slice(0, 3);
  return [...recommended, currentCandidate];
}

function SideChatModelPicker({ value, providers, onChange }: { value: SideChatPick; providers: ProviderInfo[]; onChange: (pick: SideChatPick) => void }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState<ProviderAuthStatus>(emptyAuth);
  const [expanded, setExpanded] = useState<Set<ProviderId>>(() => new Set([value.provider]));
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(() => new Set([`${value.provider}:${value.accountId ?? "default"}`]));
  const [visibleCounts, setVisibleCounts] = useState<Partial<Record<string, number>>>({});
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const close = (): void => setOpen(false);
  useOutsideDismiss(root, close, open, menuRef);

  useEffect(() => {
    if (open) void window.devilCodex.providerAuthStatus().then(setAuth).catch(() => undefined);
  }, [open]);
  useEffect(() => window.devilCodex.onProviderAuth(setAuth), []);

  const connected = providers.filter((provider) => providerUsableForPicker(provider, auth));
  const activeProvider = connected.find((provider) => provider.id === value.provider) ?? providers.find((provider) => provider.id === value.provider);
  const activeAccount = activeProvider?.accounts.find((account) => account.id === value.accountId) ?? activeProvider?.accounts[0];
  const activeModel = activeProvider ? accountModels(activeProvider, activeAccount).find((model) => model.id === value.model) : undefined;
  const authedFor = (provider: ProviderInfo): boolean => provider.authProvider ? auth[provider.authProvider] : false;
  const visibleAccountsFor = (provider: ProviderInfo): ProviderAccount[] => provider.kind === "login" && !authedFor(provider) ? [] : provider.accounts;

  useEffect(() => {
    const selectedStillUsable = connected.some((provider) => provider.id === value.provider
      && (visibleAccountsFor(provider).length ? visibleAccountsFor(provider) : [undefined]).some((account) => (!account?.id || account.id === value.accountId) && accountModels(provider, account).some((model) => model.id === value.model)));
    const fallbackProvider = connected[0];
    const fallbackAccount = fallbackProvider ? (visibleAccountsFor(fallbackProvider)[0] ?? undefined) : undefined;
    const fallback = fallbackProvider ? accountModels(fallbackProvider, fallbackAccount)[0] : undefined;
    if (!selectedStillUsable && fallbackProvider && fallback) onChange({ provider: fallbackProvider.id, accountId: fallbackAccount?.id, model: fallback.id });
  }, [connected, onChange, value.accountId, value.model, value.provider]);

  useEffect(() => {
    if (!open) {
      setVisibleCounts({});
      setExpanded(new Set([value.provider]));
      setExpandedAccounts(new Set([`${value.provider}:${value.accountId ?? "default"}`]));
    }
  }, [open, value.accountId, value.provider]);

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
  const toggleAccount = (provider: ProviderInfo, account?: ProviderAccount): void => {
    const key = accountKey(provider, account);
    setExpandedAccounts((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const visibleCount = (provider: ProviderInfo, account?: ProviderAccount): number => {
    const models = accountModels(provider, account);
    const selectedIndex = provider.id === value.provider && (!account?.id || account.id === value.accountId) ? models.findIndex((item) => item.id === value.model) : -1;
    const selectedPage = selectedIndex >= 0 ? Math.ceil((selectedIndex + 1) / sideChatModelPageSize) * sideChatModelPageSize : sideChatModelPageSize;
    return Math.min(models.length, Math.max(visibleCounts[accountKey(provider, account)] ?? sideChatModelPageSize, selectedPage));
  };
  const showMore = (provider: ProviderInfo, account?: ProviderAccount): void => {
    const models = accountModels(provider, account);
    setVisibleCounts((current) => ({ ...current, [accountKey(provider, account)]: Math.min(models.length, visibleCount(provider, account) + sideChatModelPageSize) }));
  };
  const choose = (provider: ProviderInfo, account: ProviderAccount | undefined, model: { id: string }): void => {
    onChange({ provider: provider.id, accountId: account?.id, model: model.id, auto: false });
    close();
  };
  const setAuto = (): void => {
    onChange({ ...value, auto: true });
    close();
  };

  return <div className="side-chat-model-picker" ref={root} data-popover-root>
    <button type="button" className="side-chat-model-trigger" onClick={() => setOpen((current) => !current)} title={`${activeProvider?.label ?? value.provider}${activeAccount ? ` · ${accountLabel(activeAccount)}` : ""} · ${activeModel?.label ?? value.model}`}>
      <span>{activeModel?.label ?? value.model}</span>
      <ChevronDown size={13} />
    </button>
    {createPortal(
      <AnimatePresence>
        {open && <motion.div ref={menuRef} className="side-chat-model-menu" style={{ left: menuPos.left, top: menuPos.top }} initial={{ opacity: 0, y: 4, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 3, scale: .98 }} transition={{ duration: .14, ease: [.4, 0, .2, 1] }}>
          <div className="model-section-label">모델</div>
          <button type="button" className={`model-option side-chat-auto-option ${value.auto !== false ? "active" : ""}`} onClick={setAuto}>
            <span className="model-option-label"><strong>자동 추천</strong><small><i>fallback 2회</i><i>tool 우선</i></small></span>
            {value.auto !== false && <Check size={15} />}
          </button>
          {connected.length === 0 && <p className="model-provider-empty">설정 → 연결에서 사용 가능한 모델을 먼저 연결하세요.</p>}
          {connected.map((provider) => {
            const isExpanded = expanded.has(provider.id);
            const visibleAccounts = visibleAccountsFor(provider);
            const selectedAccount = visibleAccounts.find((account) => account.id === value.accountId) ?? visibleAccounts[0];
            const selectedModel = accountModels(provider, selectedAccount).find((model) => model.id === value.model);
            return <div className="model-picker-provider-group" key={provider.id}>
              <div className="model-picker-provider-head">
                <button type="button" className="model-provider-toggle" aria-expanded={isExpanded} onClick={() => toggleProvider(provider.id)}>
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span><strong>{provider.label}</strong><small>{provider.id === value.provider && selectedModel ? `${selectedAccount ? `${accountLabel(selectedAccount)} · ` : ""}${selectedModel.label}` : `${visibleAccounts.length || 1}개 계정`}</small></span>
                </button>
              </div>
              <AnimatePresence initial={false}>
                {isExpanded && <motion.div className="model-provider-options" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .16, ease: [.4, 0, .2, 1] }}>
                  {(visibleAccounts.length ? visibleAccounts : [undefined]).map((account) => {
                    const models = accountModels(provider, account);
                    const count = visibleCount(provider, account);
                    const remaining = models.length - count;
                    const selectedHere = provider.id === value.provider && (!account?.id || account.id === value.accountId);
                    const accountExpanded = expandedAccounts.has(accountKey(provider, account));
                    const accountTitle = account ? accountLabel(account) : provider.label;
                    const accountDetail = account
                      ? account.credentialSource === "environment" ? "환경 변수" : account.credentialKind === "local" ? "로컬" : `${models.length}개 모델`
                      : `${models.length}개 모델`;
                    return <div className="model-account-group" key={account?.id ?? `${provider.id}:default`}>
                      <button type="button" className={`model-account-head ${selectedHere ? "active" : ""}`} aria-expanded={accountExpanded} onClick={() => toggleAccount(provider, account)}>
                        {accountExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <span><strong>{accountTitle}</strong><small>{selectedHere && selectedModel ? selectedModel.label : accountDetail}</small></span>
                        {selectedHere && <Check size={14} />}
                      </button>
                      {accountExpanded && <>
                        {models.slice(0, count).map((model) => <button type="button" className="model-option" key={`${account?.id ?? "default"}:${model.id}`} onClick={() => choose(provider, account, model)}>
                          <span className="model-option-label"><strong>{model.label || model.id}</strong>{model.capability && <small><i className={`cap ${model.capability.diagnostics}`}>{model.capability.diagnostics}</i><i>tool {model.capability.tools ?? "unknown"}</i><i>img {model.capability.images ?? "unknown"}</i></small>}</span>
                          {selectedHere && model.id === value.model && <Check size={15} />}
                        </button>)}
                        {remaining > 0 && <button type="button" className="model-show-more" onClick={() => showMore(provider, account)}><span>더보기</span><small>{Math.min(sideChatModelPageSize, remaining)}개 더 보기 · {count}/{models.length}</small></button>}
                      </>}
                    </div>;
                  })}
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

export function ToolContent({ active, workspace, fileTarget, filesLocked = false, changes, selectedDiff, diffBusy, browserSessionKey = "__global__", onBrowserAsk, subagents, onOpenSubagent, onNewSideChat, sideChatCreating, onSelectDiff, onSendReviewComment, onApplyHunk }: { active: ContentTool; workspace: string; fileTarget: string | null; filesLocked?: boolean; changes: WorkspaceChanges; selectedDiff: WorkspaceDiff | null; diffBusy: boolean; browserSessionKey?: string; onBrowserAsk?: (attachment: import("../../shared/contracts").ThreadAttachment, text?: string) => void; subagents?: Array<{ id: string; label: string }>; onOpenSubagent?: (id: string, label: string) => void; onNewSideChat?: () => void; sideChatCreating?: boolean; onSelectDiff: (file: WorkspaceChange) => void; onSendReviewComment: (input: { path: string; line: number; side: "old" | "new"; text: string }) => void; onApplyHunk: (input: { path: string; hunk: string; action: "stage" | "revert" }) => Promise<void> }): React.JSX.Element {
  if (active === "review") return <div className="utility-review"><div className="review-summary"><h2>변경 사항</h2><p><i>+{changes.additions}</i> <b>-{changes.deletions}</b> · {changes.files.length}개 파일</p></div><div className="review-files">{changes.files.map((file) => <button className={selectedDiff?.path === file.path ? "active" : ""} key={`${file.status}:${file.path}`} onClick={() => onSelectDiff(file)}><span>{file.status === "??" ? "새 파일" : file.status}</span><strong>{file.path}</strong><em><i>+{file.additions}</i> <b>-{file.deletions}</b></em></button>)}</div><DiffPreview diff={selectedDiff} loading={diffBusy} onSend={onSendReviewComment} onApplyHunk={onApplyHunk} /></div>;
  if (active === "files") return <WorkspaceFilesPanel workspace={workspace} target={fileTarget} locked={filesLocked} />;
  if (active === "side-chat") return <div className="side-chat-launcher">
    <button type="button" className="side-chat-new" disabled={sideChatCreating} onClick={() => onNewSideChat?.()}>{sideChatCreating ? <span className="side-chat-spinner" /> : <Plus size={15} />}{sideChatCreating ? "사이드 채팅 만드는 중…" : "새 사이드 채팅"}</button>
  </div>;
  if (active === "browser") return <BrowserPanel key={browserSessionKey} browserSessionKey={browserSessionKey} workspace={workspace} fileTarget={fileTarget} changes={changes} onAsk={onBrowserAsk} />;
  const label = { files: "파일" }[active] ?? active;
  return <div className="utility-empty"><Folder /><strong>{label}</strong><small>실제 Codex backend 연결 예정</small></div>;
}

// Embedded browser ("브라우저" tab). Renders a real Chromium guest as a DOM
// <webview> (so modals/popovers layer above it via z-index). The guest's
// WebContents is captured in the main process so user + AI control share one
// path; this component owns the address bar + nav + page tools.
export function BrowserPanel({ browserSessionKey, visible = true, workspace, fileTarget, changes, onAsk }: { browserSessionKey: string; visible?: boolean; workspace: string; fileTarget: string | null; changes: WorkspaceChanges; onAsk?: (attachment: ThreadAttachment, text?: string) => void }): React.JSX.Element {
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
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [contextInserting, setContextInserting] = useState(false);
  const [contextText, setContextText] = useState("");
  const [contextQuestion, setContextQuestion] = useState("");
  const [contextUploadPaths, setContextUploadPaths] = useState<string[]>([]);
  const [contextNotice, setContextNotice] = useState("");
  const [browserPersistentSession, setBrowserPersistentSession] = useState(readBrowserPersistentSession);
  const browserPartition = browserPersistentSession ? "persist:devil-browser" : "devil-browser-guest";
  const initialBrowserUrl = useRef(browserInitialUrl(browserSessionKey));

  useEffect(() => {
    const off = window.devilCodex.onBrowserState(({ key, state: next }) => { if (key === browserSessionKey) setState(next); });
    return off;
  }, [browserSessionKey]);
  useEffect(() => {
    const onSettingsChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
      if (detail?.key === "browserPersistentSession") setBrowserPersistentSession(detail.value !== false);
    };
    window.addEventListener("devil-codex:settings-changed", onSettingsChanged);
    return () => window.removeEventListener("devil-codex:settings-changed", onSettingsChanged);
  }, []);
  useEffect(() => { rememberBrowserSessionUrl(browserSessionKey, state.url); }, [browserSessionKey, state.url]);
  useEffect(() => { if (!editing) setDraft(state.url === "about:blank" ? "" : state.url); }, [state.url, editing]);

  const go = (): void => { void window.devilCodex.browserNavigate({ key: browserSessionKey, url: draft }); setEditing(false); };
  const setZoomBy = (delta: number): void => { void window.devilCodex.browserZoom({ key: browserSessionKey, delta }).then((f) => setZoom(Math.round(f * 100))); };
  const resetZoom = (): void => { void window.devilCodex.browserZoom({ key: browserSessionKey, reset: true }).then((f) => setZoom(Math.round(f * 100))); };

  // Screenshot the page and hand it to the composer to ask about.
  const screenshotToComposer = async (): Promise<void> => {
    const shot = await window.devilCodex.browserScreenshot({ key: browserSessionKey });
    if (shot) onAsk?.({ name: `browser-${Date.now()}.png`, kind: "image", url: shot, mime: "image/png" });
  };

  const webviewRef = useRef<ElectronWebview | null>(null);
  const browserRegisteredRef = useRef(false);
  const contextFileInputRef = useRef<HTMLInputElement>(null);
  const lastUploadRef = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (!visible || !browserRegisteredRef.current) return;
    void window.devilCodex.browserFocus({ key: browserSessionKey }).then(setState);
  }, [browserSessionKey, visible]);
  useEffect(() => {
    const webview = webviewRef.current as (ElectronWebview & { getWebContentsId?: () => number }) | null;
    if (!webview) return;
    const register = (): void => {
      const id = webview.getWebContentsId?.();
      if (!id) return;
      void window.devilCodex.browserRegister({ key: browserSessionKey, webContentsId: id }).then((next) => {
        browserRegisteredRef.current = true;
        if (visible) setState(next);
      });
    };
    webview.addEventListener("dom-ready", register);
    return () => webview.removeEventListener("dom-ready", register);
  }, [browserSessionKey]);

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
        const shot = await window.devilCodex.browserCaptureRect({ key: browserSessionKey, ...picked.rect });
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

  const openChatGpt = (): void => {
    void window.devilCodex.browserNavigate({ key: browserSessionKey, url: "https://chatgpt.com/" });
    setDraft("https://chatgpt.com/");
    setAssistantOpen(false);
  };

  const buildContextForWebAi = async (): Promise<{ text: string; uploadPaths: string[] }> => {
    const fileLimit = 5;
    const diffLimit = 2200;
    const contentLimit = 1800;
    const files = [...changes.files].filter((file) => file.status !== "D").slice(0, fileLimit);
    const uploadPaths = files.map((file) => absoluteWorkspacePath(workspace, file.path));
    const sections: string[] = [
      "You are helping with a local coding task in Devil-Codex.",
      "",
      "Use the attached files plus the context below to answer the user's next question. The local file paths are only labels; you cannot access them directly unless the files are uploaded with this message.",
      "",
      "## Workspace",
      workspace || "(no workspace selected)",
      "",
      "## Current Browser Page",
      `${state.title || "(untitled)"} — ${state.url || "(no url)"}`,
    ];
    if (fileTarget) sections.push("", "## Currently Open File Target", fileTarget);
    sections.push("", "## Git/Workspace Summary", `Branch: ${changes.branch || "(unknown)"}`, `Changed files: ${changes.files.length}`, `Additions: +${changes.additions}`, `Deletions: -${changes.deletions}`);
    if (!files.length) {
      sections.push("", "## Relevant Files", "No changed files were detected.");
    } else {
      sections.push("", "## Relevant Files", "파일 목록 + 핵심 변경 요약:");
      for (const file of files) {
        const absolutePath = absoluteWorkspacePath(workspace, file.path);
        sections.push("", `### ${file.path}`, `Status: ${file.status} · +${file.additions} -${file.deletions}`, `Uploaded file candidate: ${absolutePath}`);
        const diff = await window.devilCodex.getWorkspaceDiff({ cwd: workspace, path: file.path }).catch(() => null);
        if (diff?.text) sections.push("", "Diff excerpt:", fenced(diff.text.slice(0, diffLimit), "diff"));
        const content = await window.devilCodex.readWorkspaceFile({ cwd: workspace, path: file.path }).catch(() => null);
        if (content?.kind === "text" && content.content.trim()) sections.push("", "File excerpt:", fenced(content.content.slice(0, contentLimit), languageForPath(file.path)));
      }
    }
    return { text: sections.join("\n").slice(0, 24000), uploadPaths };
  };

  const openContextModal = async (): Promise<void> => {
    setAssistantOpen(false);
    setContextOpen(true);
    setContextNotice("");
    setContextBusy(true);
    try {
      const context = await buildContextForWebAi();
      setContextText(context.text);
      setContextQuestion("");
      setContextUploadPaths(context.uploadPaths);
    }
    catch (error) { setContextNotice(`컨텍스트 생성 실패: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setContextBusy(false); }
  };

  const insertContextIntoPage = async (): Promise<void> => {
    if (contextInserting) return;
    const text = formatWebAiPrompt(contextText, contextQuestion);
    if (!text || !webviewRef.current) return;
    setContextInserting(true);
    setContextNotice("");
    try {
      const ok = await webviewRef.current.executeJavaScript(CHAT_INPUT_FOCUS_SCRIPT).catch(() => false) as boolean;
      if (!ok) {
        setContextNotice("ChatGPT/Claude 입력창을 찾지 못했습니다. 입력창을 한 번 클릭한 뒤 다시 눌러주세요.");
        return;
      }
      await window.devilCodex.browserAiType({ key: browserSessionKey, text });
      if (contextUploadPaths.length) {
        const uploadKey = contextUploadPaths.map((path) => path.toLowerCase()).sort().join("\n");
        const recentDuplicate = lastUploadRef.current?.key === uploadKey && Date.now() - lastUploadRef.current.at < 30_000;
        if (recentDuplicate) {
          setContextNotice("컨텍스트는 입력창에 넣었습니다. 같은 파일을 방금 첨부해서 중복 업로드는 건너뛰었습니다.");
          setContextOpen(false);
          return;
        }
        const uploaded = await window.devilCodex.browserUploadFiles({ key: browserSessionKey, paths: contextUploadPaths });
        setContextNotice(uploaded.ok
          ? `컨텍스트를 입력창에 넣고 관련 파일 ${uploaded.count}개를 첨부했습니다. 확인 후 직접 전송하세요.`
          : `컨텍스트는 입력창에 넣었지만 파일 첨부는 실패했습니다: ${uploaded.detail ?? "알 수 없는 오류"}`);
        if (!uploaded.ok) return;
        lastUploadRef.current = { key: uploadKey, at: Date.now() };
      } else {
        setContextNotice("컨텍스트를 웹 입력창에 넣었습니다. 변경 파일이 없어 첨부할 파일은 없습니다.");
      }
      setContextOpen(false);
    } finally {
      setContextInserting(false);
    }
  };

  const addContextFiles = (files: FileList | null): void => {
    const paths = Array.from(files ?? []).map((file) => window.devilCodex.getFilePath(file)).filter(Boolean);
    if (!paths.length) return;
    setContextUploadPaths((current) => [...current, ...paths.filter((path) => !current.includes(path))]);
  };

  const removeContextFile = (path: string): void => {
    setContextUploadPaths((current) => current.filter((item) => item !== path));
  };
  const isBrowserEmpty = !state.url || state.url === "about:blank";

  return <div className="browser-panel" style={{ display: visible ? undefined : "none" }}>
    <div className="browser-toolbar">
      <button onClick={() => void window.devilCodex.browserBack({ key: browserSessionKey })} disabled={!state.canGoBack} aria-label="뒤로"><ChevronLeft size={16} /></button>
      <button onClick={() => void window.devilCodex.browserForward({ key: browserSessionKey })} disabled={!state.canGoForward} aria-label="앞으로"><ChevronRight size={16} /></button>
      <button onClick={() => void (state.loading ? window.devilCodex.browserStop({ key: browserSessionKey }) : window.devilCodex.browserReload({ key: browserSessionKey }))} aria-label="새로고침">{state.loading ? <X size={15} /> : <RotateCcw size={15} />}</button>
      <button className={assistantOpen ? "active" : ""} onClick={() => setAssistantOpen((open) => !open)} aria-label="웹 AI 도우미" title="웹 AI 도우미"><Bot size={16} /></button>
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
          <button onClick={() => { void window.devilCodex.browserHardReload({ key: browserSessionKey }); setMenuOpen(false); }}>강제 새로고침</button>
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
          <button onClick={() => { void window.devilCodex.browserClearCookies({ key: browserSessionKey }); setMenuOpen(false); }}>쿠키 지우기</button>
          <button onClick={() => { void window.devilCodex.browserClearCache({ key: browserSessionKey }); setMenuOpen(false); }}>캐시 지우기</button>
        </div>}
      </div>
    </div>
    {findOpen && <div className="browser-find">
      <input autoFocus value={findText} placeholder="페이지에서 찾기" onChange={(e) => { setFindText(e.target.value); void window.devilCodex.browserFind({ key: browserSessionKey, text: e.target.value }); }} onKeyDown={(e) => { if (e.key === "Enter") void window.devilCodex.browserFind({ key: browserSessionKey, text: findText, findNext: true }); if (e.key === "Escape") { void window.devilCodex.browserStopFind({ key: browserSessionKey }); setFindOpen(false); } }} />
      <button onClick={() => { void window.devilCodex.browserStopFind({ key: browserSessionKey }); setFindOpen(false); setFindText(""); }}><X size={14} /></button>
    </div>}
    <div className="browser-host">
      {state.loading && <span className="browser-load-bar" aria-label="페이지 불러오는 중" />}
      {/* @ts-expect-error webview is an Electron intrinsic element */}
      <webview key={browserPartition} ref={webviewRef} src={initialBrowserUrl.current} partition={browserPartition} allowpopups="true" style={{ width: "100%", height: "100%", border: 0 }} onDomReady={() => { const id = (webviewRef.current as unknown as { getWebContentsId?: () => number } | null)?.getWebContentsId?.(); if (id) void window.devilCodex.browserRegister({ key: browserSessionKey, webContentsId: id }).then((next) => { browserRegisteredRef.current = true; if (visible) setState(next); }); }} />
      {isBrowserEmpty && <div className="browser-host-empty">
        <Globe2 />
        <strong>브라우징 시작</strong>
        <small>페이지를 열려면 URL을 입력하세요.</small>
      </div>}
      {picking && <div className="browser-pick-hint"><span>요소 위에 마우스를 올리고 클릭하세요 · 취소하려면 버튼을 다시 누르세요</span></div>}
    </div>
    {annotation && <div className="browser-annotate-bar">
      <img src={annotation.shot} alt="선택 요소" />
      <input autoFocus value={note} placeholder={`${annotation.selector} — 질문…`} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitAnnotation(); if (e.key === "Escape") { setAnnotation(null); setNote(""); } }} />
      <button onClick={submitAnnotation}><Send size={14} /></button>
      <button onClick={() => { setAnnotation(null); setNote(""); }}><X size={14} /></button>
    </div>}
    {assistantOpen && <div className="browser-context-backdrop compact" onMouseDown={(event) => { if (event.target === event.currentTarget) setAssistantOpen(false); }}>
      <div className="browser-assistant-modal">
        <header><span><Bot size={17} /><strong>웹 AI 도우미</strong></span><button onClick={() => setAssistantOpen(false)}><X size={15} /></button></header>
        <button type="button" onClick={openChatGpt}><Globe2 size={17} /><span><strong>GPT로 가기</strong><small>우측 브라우저에서 ChatGPT 웹을 엽니다.</small></span></button>
        <button type="button" disabled={!workspace || contextBusy} onClick={() => void openContextModal()}><FileText size={17} /><span><strong>현재 컨텍스트 보내기</strong><small>작업 요약을 입력창에 넣고 관련 변경 파일 첨부를 시도합니다.</small></span></button>
      </div>
    </div>}
    {contextOpen && <div className="browser-context-backdrop">
      <div className="browser-context-modal">
        <header><span><Bot size={17} /><strong>현재 컨텍스트 보내기</strong></span><button onClick={() => setContextOpen(false)}><X size={15} /></button></header>
        <p>Devil-Codex가 로컬 변경 파일과 diff 일부를 모아 웹 AI 입력창에 넣고, 가능한 경우 관련 실제 파일도 첨부합니다. 내부 AI가 대신 질문하는 게 아니라, 아래 내용을 사용자가 확인한 뒤 ChatGPT/Claude 웹에서 직접 전송하는 방식입니다.</p>
        <div className="browser-context-body">
          <ContextProjectFilePicker workspace={workspace} selectedPaths={contextUploadPaths} onAdd={(path) => setContextUploadPaths((current) => current.includes(path) ? current : [...current, path])} />
          <section className="browser-context-files">
            <div><strong>첨부 시도 파일 {contextUploadPaths.length}개</strong><button type="button" onClick={() => contextFileInputRef.current?.click()}><Plus size={13} />파일 추가</button></div>
            <input ref={contextFileInputRef} className="file-input" type="file" multiple onChange={(event) => { addContextFiles(event.target.files); event.target.value = ""; }} />
            {contextUploadPaths.length === 0 ? <small>아직 첨부할 파일이 없습니다.</small> : contextUploadPaths.map((path) => {
              const label = displayPathLabel(path);
              return <span key={path} className="browser-context-file-row" title={path}>
                <b>{label.name}</b>
                <small>{label.parent}</small>
                <button type="button" aria-label={`${path} 제거`} onClick={() => removeContextFile(path)}><X size={12} /></button>
              </span>;
            })}
          </section>
        </div>
        <textarea value={contextText} onChange={(event) => setContextText(event.target.value)} placeholder={contextBusy ? "컨텍스트 생성 중..." : "보낼 컨텍스트"} />
        <label className="browser-context-question">
          <span>사용자 질문</span>
          <textarea value={contextQuestion} onChange={(event) => setContextQuestion(event.target.value)} placeholder="ChatGPT에게 마지막으로 물어볼 내용을 입력하세요. 예: 이 변경의 문제점과 개선 방향을 리뷰해줘." />
        </label>
        {contextNotice && <small className="browser-context-notice">{contextNotice}</small>}
        <footer>
          <button onClick={() => setContextOpen(false)}>취소</button>
          <button className="primary" disabled={contextBusy || contextInserting || !contextText.trim()} onClick={() => void insertContextIntoPage()}>{contextBusy ? "생성 중..." : contextInserting ? "넣는 중..." : "입력창에 넣기"}</button>
        </footer>
      </div>
    </div>}
  </div>;
}

function fenced(text: string, lang = ""): string {
  return `\`\`\`${lang}\n${text.replace(/```/g, "'''")}\n\`\`\``;
}

function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ({ ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", css: "css", json: "json", md: "md", py: "py", cts: "ts", mjs: "js", cjs: "js" } as Record<string, string>)[ext] ?? "";
}

function absoluteWorkspacePath(workspace: string, path: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) return path;
  return `${workspace.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
}

function formatWebAiPrompt(context: string, question: string): string {
  const trimmedContext = context.trim();
  const trimmedQuestion = question.trim() || "첨부 파일과 위 컨텍스트를 바탕으로 현재 작업을 검토하고, 중요한 문제점과 다음 액션을 알려줘.";
  return `${trimmedContext}\n\n## User Question\n${trimmedQuestion}`.trim();
}

function displayPathLabel(path: string): { name: string; parent: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? path;
  if (parts.length <= 2) return { name, parent: parts.slice(0, -1).join("\\") };
  return { name, parent: `${parts[0]}\\...\\${parts.at(-2)}` };
}

function ContextProjectFilePicker({ workspace, selectedPaths, onAdd }: { workspace: string; selectedPaths: string[]; onAdd: (absolutePath: string) => void }): React.JSX.Element {
  const [directories, setDirectories] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (path: string): Promise<void> => {
    if (!workspace) return;
    try {
      const entries = await window.devilCodex.listWorkspaceDirectory({ cwd: workspace, path });
      setDirectories((current) => ({ ...current, [path]: entries }));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [workspace]);

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set([""]));
    setFilter("");
    void load("");
  }, [load]);

  const query = filter.trim().toLowerCase();
  const selected = new Set(selectedPaths.map((path) => path.toLowerCase()));
  const rows = useCallback((dir: string, depth: number): React.JSX.Element[] => (directories[dir] ?? []).flatMap((entry) => {
    if (query && !entry.name.toLowerCase().includes(query) && entry.kind === "file") return [];
    const open = expanded.has(entry.path);
    const absolutePath = absoluteWorkspacePath(workspace, entry.path);
    const isSelected = selected.has(absolutePath.toLowerCase());
    const row = <button type="button" className={isSelected ? "selected" : ""} style={{ paddingLeft: 10 + depth * 16 }} key={entry.path} onClick={() => {
      if (entry.kind === "file") { onAdd(absolutePath); return; }
      setExpanded((current) => { const next = new Set(current); if (open) next.delete(entry.path); else next.add(entry.path); return next; });
      if (!open && !directories[entry.path]) void load(entry.path);
    }}>
      {entry.kind === "folder" ? <>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? <FolderOpen size={15} /> : <Folder size={15} />}</> : <><span className="tree-spacer" /><FileText size={14} /></>}
      <span>{entry.name}</span>
      {entry.kind === "file" && <em>{isSelected ? "추가됨" : "첨부"}</em>}
    </button>;
    return entry.kind === "folder" && open ? [row, ...rows(entry.path, depth + 1)] : [row];
  }), [directories, expanded, load, onAdd, query, selected, workspace]);

  return <section className="browser-context-picker">
    <div><strong>프로젝트 파일</strong><small>파일을 클릭하면 첨부 목록에 추가됩니다.</small></div>
    <label><Search size={14} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="파일 검색..." /></label>
    <div className="browser-context-tree">{rows("", 0)}</div>
    {error && <small className="browser-context-picker-error">{error}</small>}
  </section>;
}

const CHAT_INPUT_FOCUS_SCRIPT = `(function(){
  var selectors=[
    '#prompt-textarea',
    'textarea[data-testid="prompt-textarea"]',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div[contenteditable="true"][data-testid="textbox"]',
    'div[contenteditable="true"]',
    'textarea',
    'input[type="text"]'
  ];
  for(var i=0;i<selectors.length;i++){
    var el=document.querySelector(selectors[i]);
    if(el){
      try{el.scrollIntoView({block:'center'});el.focus();return true;}catch(e){return false;}
    }
  }
  return false;
})()`;

// Conversation state is lifted to the parent (history/onHistory) so it survives
// tab switches and the optimistic message isn't lost on reload.
export function SideChat({ target, history, busy, pick, lockedModel = false, onPick, onHistory, onOpenFile }: { target: SideChatTarget; history: ThreadHistoryItem[] | undefined; busy: boolean; pick?: SideChatPick; lockedModel?: boolean; onPick: (pick: SideChatPick) => void; onHistory: (items: ThreadHistoryItem[]) => void; onOpenFile: (path: string) => void }): React.JSX.Element {
  const { thread, cwd, providers, approvalPolicy, sandboxMode } = target;
  // A delegated subagent thread runs on its own provider/runtime (e.g. DeepSeek
  // through the Codex app-server) regardless of the parent chat's runtime. The
  // spawn pick (locked, auto:false) carries the child's actual provider, so
  // derive runtime/account from it — otherwise a Claude-mode parent would read
  // and continue a Codex-runtime child through the wrong history path.
  const spawn = lockedModel && pick && pick.auto === false ? pick : undefined;
  const runtime: AgentRuntimeId = spawn ? "codex" : target.runtime;
  const accountId = spawn ? spawn.accountId : target.accountId;
  const [loaded, setLoaded] = useState(history !== undefined);
  const [draft, setDraft] = useState(() => readSideChatDraft(thread.id));
  const [sending, setSending] = useState(false);
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  // Picked model is persisted by the parent (per subagent) so it survives tab switches.
  const picked = pick ?? { provider: target.provider, accountId: target.accountId, model: target.model, auto: true };
  const attach = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { writeSideChatDraft(thread.id, draft); }, [thread.id, draft]);

  const load = useCallback(async (): Promise<void> => {
    try { onHistory(await window.devilCodex.readThread({ id: thread.id, runtime, accountId })); }
    catch { onHistory([]); }
    finally { setLoaded(true); }
  // onHistory identity changes per render; intentionally only depend on thread.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, runtime, accountId]);

  // Seed past conversation once; new turns stream in live via app-server events.
  useEffect(() => { if (history === undefined) void load(); else setLoaded(true); }, [thread.id, history, load]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [history, busy, sending]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const atts = attach.attachments;
    if ((!text && atts.length === 0) || sending || busy || !attach.ready) return;
    setDraft("");
    writeSideChatDraft(thread.id, "");
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
      const attempts = picked.auto === false ? [{ ...picked, label: pickLabel(providers, picked), score: 0 }] : sideChatModelCandidates(providers, text, picked);
      let lastError: unknown;
      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index]!;
        try {
          setModelStatus(`${index === 0 ? "추천" : "fallback"}: ${attempt.label}`);
          if (attempt.auto !== picked.auto || attempt.provider !== picked.provider || attempt.accountId !== picked.accountId || attempt.model !== picked.model) onPick({ provider: attempt.provider, accountId: attempt.accountId, model: attempt.model, auto: picked.auto !== false });
          // Best-effort resume: a freshly created side-chat thread has no rollout yet
          // (already loaded from createThread), so a failed resume is fine — proceed.
          if (runtime === "codex" && attempt.provider === "codex") await window.devilCodex.resumeThread({ id: thread.id, model: attempt.model }).catch(() => undefined);
          console.log("[devil-sidechat] send", { threadId: thread.id, ...attempt });
          await window.devilCodex.sendTurn({ threadId: thread.id, cwd, text: text || "첨부 파일을 확인해줘.", model: attempt.model, runtime, provider: attempt.provider, accountId: attempt.accountId ?? accountId, subagent: true, attachments: images, attachmentDetails: atts, ...(approvalPolicy ? { approvalPolicy } : {}), ...(sandboxMode ? { sandboxMode } : {}) });
          lastError = undefined;
          setModelStatus(`사용 모델: ${attempt.label}`);
          break;
        } catch (error) {
          lastError = error;
          if (index === attempts.length - 1) throw error;
          setModelStatus(`실패 후 fallback: ${attempt.label}`);
        }
      }
      if (lastError) throw lastError;
      // Fallback: live events may not stream for a non-active thread; poll the
      // thread until the agent reply lands, then show the authoritative history.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const fresh = await window.devilCodex.readThread({ id: thread.id, runtime, accountId }).catch(() => [] as ThreadHistoryItem[]);
        if (fresh.filter((m) => m.kind === "agent").length > baseAgentCount) { onHistory(fresh); break; }
      }
    } catch (error) {
      onHistory([...seeded, { id: `err-${Date.now()}`, kind: "agent", text: `요청 실패: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally {
      setSending(false);
      window.setTimeout(() => setModelStatus(null), 3500);
    }
  };

  // Keep the child thread's work events in the same rich card format as the
  // main timeline. Previously this panel dropped activities entirely, which
  // left file diffs to appear only as any raw text an agent happened to write.
  const messages = (history ?? []).filter((item) => item.kind === "user" || item.kind === "agent" || (item.kind === "activity" && Boolean(item.activities?.length)));
  const working = busy || sending;
  return <div className="side-chat">
    <header className="side-chat-head"><Bot size={15} /><strong>{thread.label}</strong>
      {!lockedModel && picked.auto !== false && <span className="side-chat-auto-badge" title="작업 성격과 provider capability를 기준으로 모델을 자동 추천하고 실패 시 fallback합니다."><Sparkles size={12} />자동</span>}
      {lockedModel
        ? <button type="button" className="side-chat-model-trigger locked" title={`${pickLabel(providers, picked)} · 하위 에이전트 실행 모델`} disabled><span>{pickLabel(providers, picked)}</span></button>
        : <SideChatModelPicker value={picked} providers={providers} onChange={onPick} />}
    </header>
    <div className="side-chat-body" ref={bodyRef}>
      {!loaded ? <div className="side-chat-loading"><span className="side-chat-spinner" /><strong>사이드 채팅 불러오는 중</strong><i /><i /><i /></div>
        : messages.length === 0 && !working ? <em className="side-chat-empty">대화 내용이 없습니다.</em>
        : messages.map((item) => item.kind === "activity"
          ? <div key={item.id} className="side-chat-activity"><TurnActivity item={item} onOpenFile={onOpenFile} /></div>
          : <div key={item.id} className={`side-chat-bubble ${item.kind}`}>
              {item.attachments?.length ? <AttachmentGallery attachments={item.attachments} align={item.kind === "user" ? "end" : "start"} /> : null}
              {item.text && <MarkdownContent text={item.text} onOpenFile={onOpenFile} />}
            </div>)}
      {working && <div className="side-chat-working"><span className="side-chat-spinner" />{modelStatus ?? "작업 중…"}</div>}
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
  const [pendingRevertHunk, setPendingRevertHunk] = useState<string | null>(null);
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
  const applyHunk = async (hunk: string, action: "stage" | "revert", confirmed = false): Promise<void> => {
    if (action === "revert" && !confirmed) {
      setPendingRevertHunk(hunk);
      return;
    }
    setHunkBusy(hunk);
    try { await onApplyHunk({ path: diff.path, hunk, action }); } finally { setHunkBusy(null); }
  };
  const openComment = (line: ParsedDiffLine | undefined): void => { if (line?.oldLine != null || line?.newLine != null) { setCommentLine(line); setComment(""); } };
  const changeMode = (next: "unified" | "split"): void => { setMode(next); setCommentLine(null); };
  const reviewForm = commentLine && <div className="inline-review-comment"><header><strong>{diff.path}:{commentLine.newLine ?? commentLine.oldLine}</strong><button type="button" onClick={() => setCommentLine(null)}><X size={14} /></button></header><textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send(); }} placeholder="이 줄에 대한 의견을 입력하세요" /><button type="button" disabled={!comment.trim()} onClick={send}><Send size={13} />Codex에 보내기</button></div>;
  return <>
  <section className="diff-preview-panel"><header><FileText size={15} /><strong>{diff.path}</strong><span className="diff-mode"><button type="button" className={mode === "unified" ? "active" : ""} onClick={() => changeMode("unified")}>Unified</button><button type="button" className={mode === "split" ? "active" : ""} onClick={() => changeMode("split")}>Split</button></span><span><i>+{diff.additions}</i> <b>-{diff.deletions}</b></span></header>{mode === "unified" ? <div className="diff-lines">{lines.map((line) => <div key={line.id}>
    {line.kind === "hunk" && line.hunk && <div className="diff-hunk-actions"><code>{line.text}</code><button type="button" disabled={hunkBusy !== null} onClick={() => void applyHunk(line.hunk!, "stage")}>hunk 스테이징</button><button type="button" disabled={hunkBusy !== null} onClick={() => void applyHunk(line.hunk!, "revert")}><RotateCcw size={12} />되돌리기</button></div>}
    {line.kind !== "hunk" && <button type="button" className={`diff-line ${line.kind}`} disabled={line.oldLine == null && line.newLine == null} onClick={() => openComment(line)}><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><code>{line.text || " "}</code></button>}
    {commentLine?.id === line.id && reviewForm}
  </div>)}</div> : <><div className="split-diff-lines">{toSplitDiffRows(lines).map((row) => row.hunk ? <div className="split-hunk" key={row.id}>{row.hunk.text}</div> : <div className="split-row" key={row.id}><button type="button" className={`split-cell ${row.old?.kind ?? "empty"}`} disabled={!row.old} onClick={() => openComment(row.old)}><span>{row.old?.oldLine ?? ""}</span><code>{row.old?.text.replace(/^[+-]/, "") ?? ""}</code></button><button type="button" className={`split-cell ${row.next?.kind ?? "empty"}`} disabled={!row.next} onClick={() => openComment(row.next)}><span>{row.next?.newLine ?? ""}</span><code>{row.next?.text.replace(/^[+-]/, "") ?? ""}</code></button></div>)}</div>{reviewForm}</>}</section>
  {pendingRevertHunk && <ConfirmActionDialog title="hunk 되돌리기" message="이 hunk의 작업공간 변경을 되돌릴까요?" confirmLabel="되돌리기" onCancel={() => setPendingRevertHunk(null)} onConfirm={() => { const hunk = pendingRevertHunk; setPendingRevertHunk(null); void applyHunk(hunk, "revert", true); }} />}
  </>;
}

function ConfirmActionDialog({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <motion.section className="confirm-dialog" initial={{ opacity: 0, scale: .97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: 6 }} transition={{ duration: .16, ease: [.4, 0, .2, 1] }} role="alertdialog" aria-modal="true">
        <header><h2>{title}</h2><button type="button" onClick={onCancel} aria-label="닫기"><X size={18} /></button></header>
        <p>{message}</p>
        <footer>
          <button type="button" className="secondary" onClick={onCancel}>취소</button>
          <button type="button" className="danger" onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </motion.section>
    </div>,
    document.body,
  );
}
