import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, ChevronRight, LogIn, LogOut, Zap } from "lucide-react";
import type { ContextUsage, ProviderAccount, ProviderAuthStatus, ProviderId, ProviderInfo, ProviderModel, ReasoningEffort, ResponseSpeed } from "../../shared/contracts";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";

const efforts: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "낮음" },
  { value: "medium", label: "중간" },
  { value: "high", label: "높음" },
  { value: "xhigh", label: "매우 높음" },
];
const speeds: Array<{ value: ResponseSpeed; label: string; detail: string }> = [
  { value: "standard", label: "표준", detail: "기본 속도" },
  { value: "fast", label: "고속", detail: "1.5x speed, increased usage" },
];
const emptyAuth: ProviderAuthStatus = { codex: false, claude: false, copilot: false, antigravity: false };
const modelPageSize = 10;
const notifyProviderAuthChanged = (): void => window.dispatchEvent(new Event("devil-codex:provider-auth-changed"));

function capabilityLabel(value: string | undefined): string {
  if (value === "native") return "native";
  if (value === "limited") return "limited";
  if (value === "sidecar") return "sidecar";
  if (value === "none") return "none";
  return "unknown";
}

function capabilityTitle(provider: ProviderInfo, modelId: string): string {
  const model = provider.models.find((item) => item.id === modelId);
  const cap = model?.capability;
  if (!cap) return "capability metadata 없음";
  return [
    `tools: ${capabilityLabel(cap.tools)}`,
    `images: ${capabilityLabel(cap.images)}`,
    `webSearch: ${capabilityLabel(cap.webSearch)}`,
    `diagnostics: ${cap.diagnostics}`,
    ...(cap.notes ?? []),
  ].join("\n");
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

function selectableApiProvider(provider: ProviderInfo): boolean {
  // Hosted API providers ship valid default models in the catalog, so a usable
  // credential is enough — don't also require a live model refresh, which can
  // fail (offline) or get wiped, hiding a perfectly working provider. Local
  // providers (ollama/vllm/lm-studio) have no fixed models, so they still need
  // a successfully loaded list.
  if (provider.keyRequired) return provider.accounts.some((account) => account.credentialSource !== "none" && (account.models?.length ?? provider.models.length) > 0);
  return provider.modelsLoaded;
}

function accountModels(provider: ProviderInfo, account: ProviderAccount | undefined): ProviderModel[] {
  return account?.models?.length ? account.models : provider.models;
}

function accountLabel(account: ProviderAccount): string {
  return account.email || account.label || account.id;
}

export function ModelPicker({ model, providerId, accountId, providers, contextUsage, reasoningEffort, responseSpeed, runtime, onModelChange, onReasoningEffortChange, onResponseSpeedChange }: { model: string; providerId: ProviderId; accountId?: string; providers: ProviderInfo[]; contextUsage?: ContextUsage; reasoningEffort: ReasoningEffort; responseSpeed: ResponseSpeed; runtime?: "codex" | "claude-code"; onModelChange: (input: { provider: ProviderId; accountId?: string; model: string }) => void; onReasoningEffortChange: (value: ReasoningEffort) => void; onResponseSpeedChange: (value: ResponseSpeed) => void }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const speedButtonRef = useRef<HTMLButtonElement>(null);
  const speedSubmenuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<"speed" | null>(null);
  const [speedSubmenuPos, setSpeedSubmenuPos] = useState({ left: 0, top: 0 });
  const [auth, setAuth] = useState<ProviderAuthStatus>(emptyAuth);
  const [busy, setBusy] = useState<string | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<ProviderId>>(() => new Set([providerId]));
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(() => new Set([`${providerId}:${accountId ?? "default"}`]));
  const [visibleModelCounts, setVisibleModelCounts] = useState<Record<string, number>>({});
  const close = (): void => { setOpen(false); setSubmenu(null); };
  useOutsideDismiss(root, close, open, speedSubmenuRef);

  const [notice, setNotice] = useState("");
  const refreshAuth = (): void => { void window.devilCodex.providerAuthStatus().then(setAuth).catch(() => undefined); };
  useEffect(() => { if (open) refreshAuth(); }, [open]);
  useEffect(() => {
    if (open) return;
    setVisibleModelCounts({});
    setExpandedProviders(new Set([providerId]));
    setExpandedAccounts(new Set([`${providerId}:${accountId ?? "default"}`]));
  }, [open, providerId, accountId]);
  useEffect(() => window.devilCodex.onProviderAuth((status) => { setAuth(status); setNotice(""); setBusy(null); }), []);

  const updateSpeedSubmenuPosition = (): void => {
    const rect = speedButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 232;
    const height = 150;
    const gap = 8;
    const left = rect.right + gap + width > window.innerWidth - gap ? Math.max(gap, rect.left - gap - width) : rect.right + gap;
    const top = Math.min(window.innerHeight - height - gap, Math.max(gap, rect.top - 8));
    setSpeedSubmenuPos({ left, top });
  };
  useLayoutEffect(() => {
    if (!open || submenu !== "speed") return undefined;
    updateSpeedSubmenuPosition();
    window.addEventListener("resize", updateSpeedSubmenuPosition);
    window.addEventListener("scroll", updateSpeedSubmenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateSpeedSubmenuPosition);
      window.removeEventListener("scroll", updateSpeedSubmenuPosition, true);
    };
  }, [open, submenu]);

  const active = providers.find((provider) => provider.id === providerId);
  const activeAccount = active?.accounts.find((account) => account.id === accountId) ?? active?.accounts[0];
  const selected = active ? accountModels(active, activeAccount).find((item) => item.id === model) : undefined;
  const effortLabel = efforts.find((item) => item.value === reasoningEffort)?.label ?? "중간";
  const speedLabel = speeds.find((item) => item.value === responseSpeed)?.label ?? "표준";
  const contextPercent = contextUsage ? Math.min(100, Math.max(0, Math.round((contextUsage.usedTokens / contextUsage.maxTokens) * 100))) : 0;
  const authedFor = (provider: ProviderInfo): boolean => provider.authProvider ? auth[provider.authProvider] : false;
  const visibleAccountsFor = (provider: ProviderInfo): ProviderAccount[] => provider.kind === "login" && !authedFor(provider) ? [] : provider.accounts;
  const connected = providers.filter((provider) => provider.kind === "login"
    ? authedFor(provider) && provider.modelsLoaded
    : selectableApiProvider(provider));

  useEffect(() => {
    if (!open) return;
    setExpandedProviders((current) => {
      if (current.has(providerId)) return current;
      const next = new Set(current);
      next.add(providerId);
      return next;
    });
    setExpandedAccounts((current) => {
      const key = `${providerId}:${accountId ?? "default"}`;
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, [open, providerId, accountId]);

  const toggleProvider = (id: ProviderId): void => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const accountKey = (provider: ProviderInfo, account?: ProviderAccount): string => `${provider.id}:${account?.id ?? "default"}`;
  const toggleAccount = (provider: ProviderInfo, account?: ProviderAccount): void => {
    const key = accountKey(provider, account);
    setExpandedAccounts((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const visibleModelCount = (provider: ProviderInfo, account?: ProviderAccount): number => {
    const models = accountModels(provider, account);
    const selectedIndex = provider.id === providerId && (!account?.id || account.id === accountId) ? models.findIndex((item) => item.id === model) : -1;
    const selectedPage = selectedIndex >= 0 ? Math.ceil((selectedIndex + 1) / modelPageSize) * modelPageSize : modelPageSize;
    return Math.min(models.length, Math.max(visibleModelCounts[accountKey(provider, account)] ?? modelPageSize, selectedPage));
  };
  const showMoreModels = (provider: ProviderInfo, account?: ProviderAccount): void => {
    setVisibleModelCounts((current) => {
      const key = accountKey(provider, account);
      const models = accountModels(provider, account);
      const nextCount = Math.min(models.length, visibleModelCount(provider, account) + modelPageSize);
      return { ...current, [key]: nextCount };
    });
  };

  const login = async (provider: ProviderInfo): Promise<void> => {
    const authKey = provider.authProvider;
    if (!authKey) return;
    setBusy(provider.id);
    const info = await window.devilCodex.providerLogin({ provider: authKey }).catch(() => null);
    // Copilot device flow emits a provider:auth event when done (clears busy).
    if (info?.userCode) { setNotice(`GitHub에서 코드 입력: ${info.userCode}`); return; }
    // codex / claude open a browser with no device code and emit no event, so
    // poll status and clear "로그인 중" once logged in (or after a timeout).
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const status = await window.devilCodex.providerAuthStatus().catch(() => null);
      if (status) { setAuth(status); if (status[authKey]) break; }
    }
    notifyProviderAuthChanged();
    setBusy(null);
  };
  const logout = async (provider: ProviderInfo): Promise<void> => {
    if (!provider.authProvider) return;
    setBusy(provider.id);
    setAuth(await window.devilCodex.providerLogout({ provider: provider.authProvider }).catch(() => auth));
    notifyProviderAuthChanged();
    setBusy(null);
  };

  return (
    <div className="model-picker" ref={root} data-popover-root>
      {contextUsage && (
        <div className="model-context-wrap">
          <button type="button" className="model-context-meter" aria-label={`컨텍스트 창 ${contextPercent}% 참`} style={{ "--context-percent": `${contextPercent}%` } as CSSProperties}>
            <span />
          </button>
          <div className="model-context-tooltip" role="tooltip">
            <small>컨텍스트 창:</small>
            <strong>{contextPercent}% 참</strong>
            <span>{formatTokens(contextUsage.usedTokens)}/{formatTokens(contextUsage.maxTokens)} 개의 토큰 사용</span>
          </div>
        </div>
      )}
      <button type="button" className="model-trigger" onClick={() => { setOpen((value) => !value); setSubmenu(null); }}>
        <span className="model-trigger-name">{selected?.label ?? model}</span>
        {runtime !== "claude-code" && <span className="model-trigger-meta">{effortLabel}</span>}
        <ChevronDown size={14} />
      </button>
      <AnimatePresence>{open && (
        <motion.div className="model-picker-menu" initial={{ opacity: 0, y: 8, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: .98 }} transition={{ duration: .14, ease: [.4, 0, .2, 1] }}>
          <div className="model-section-label">모델</div>
          {notice && <div className="model-login-notice">{notice}</div>}
          {connected.length === 0 && <p className="model-provider-empty">설정 → 연결에서 로그인하거나 API 키를 저장하세요.</p>}
          {connected.map((provider) => {
            const canAuth = provider.kind === "login" && Boolean(provider.authProvider);
            const loggedIn = authedFor(provider);
            const expanded = expandedProviders.has(provider.id);
            const visibleAccounts = visibleAccountsFor(provider);
            const selectedAccount = visibleAccounts.find((account) => account.id === accountId) ?? visibleAccounts[0];
            const selectedModel = accountModels(provider, selectedAccount).find((item) => item.id === model);
            return (
              <div className="model-picker-provider-group" key={provider.id}>
                <div className="model-picker-provider-head">
                  <button type="button" className="model-provider-toggle" aria-expanded={expanded} onClick={() => toggleProvider(provider.id)}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>
                      <strong>{provider.label}</strong>
                      <small>{provider.id === providerId && selectedModel ? `${selectedAccount ? `${accountLabel(selectedAccount)} · ` : ""}${selectedModel.label}` : `${visibleAccounts.length || 1}개 계정`}</small>
                    </span>
                  </button>
                  {canAuth && (loggedIn
                    ? <button type="button" className="model-auth out" disabled={busy === provider.id} onClick={() => void logout(provider)}><LogOut size={12} />{busy === provider.id ? "…" : "로그아웃"}</button>
                    : <button type="button" className="model-auth in" disabled={busy === provider.id} onClick={() => void login(provider)}><LogIn size={12} />{busy === provider.id ? "로그인 중…" : "로그인"}</button>)}
                </div>
                <AnimatePresence initial={false}>
                  {expanded && (
                    <motion.div className="model-provider-options" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .16, ease: [.4, 0, .2, 1] }}>
                      {(visibleAccounts.length ? visibleAccounts : [undefined]).map((account) => {
                        const models = accountModels(provider, account);
                        const count = visibleModelCount(provider, account);
                        const visibleModels = models.slice(0, count);
                        const remaining = models.length - count;
                        const selectedHere = provider.id === providerId && (!account?.id || account.id === accountId);
                        const accountExpanded = expandedAccounts.has(accountKey(provider, account));
                        const accountTitle = account ? accountLabel(account) : provider.label;
                        const accountDetail = account
                          ? account.credentialSource === "environment" ? "환경 변수" : account.credentialKind === "local" ? "로컬" : `${models.length}개 모델`
                          : `${models.length}개 모델`;
                        return (
                          <div className="model-account-group" key={account?.id ?? `${provider.id}:default`}>
                            <button type="button" className={`model-account-head ${selectedHere ? "active" : ""}`} aria-expanded={accountExpanded} onClick={() => toggleAccount(provider, account)}>
                              {accountExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              <span><strong>{accountTitle}</strong><small>{selectedHere && selectedModel ? selectedModel.label : accountDetail}</small></span>
                              {selectedHere && <Check size={14} />}
                            </button>
                            {accountExpanded && <>
                              {visibleModels.map((item) => (
                                <button type="button" className="model-option" key={`${account?.id ?? "default"}:${item.id}`} title={capabilityTitle(provider, item.id)} onClick={() => { onModelChange({ provider: provider.id, accountId: account?.id, model: item.id }); close(); }}>
                                  <span className="model-option-label">
                                    <strong>{item.label}</strong>
                                    {item.capability && <small>
                                      <i className={`cap ${item.capability.diagnostics}`}>{item.capability.diagnostics}</i>
                                      <i>tool {capabilityLabel(item.capability.tools)}</i>
                                      <i>img {capabilityLabel(item.capability.images)}</i>
                                    </small>}
                                  </span>
                                  {selectedHere && item.id === model && <Check size={15} />}
                                </button>
                              ))}
                              {remaining > 0 && (
                                <button type="button" className="model-show-more" onClick={() => showMoreModels(provider, account)}>
                                  <span>더보기</span>
                                  <small>{Math.min(modelPageSize, remaining)}개 더 보기 · {count}/{models.length}</small>
                                </button>
                              )}
                            </>}
                          </div>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
          {runtime !== "claude-code" && <>
            {/* 추론/속도 map to Codex app-server turn params; Claude Code turns
                ignore them, so the menu hides them there to avoid dead controls. */}
            <div className="menu-divider" />
            <div className="model-section-label">추론</div>
            {efforts.map((item) => <button type="button" className="model-option" key={item.value} onClick={() => onReasoningEffortChange(item.value)}><span>{item.label}</span>{item.value === reasoningEffort && <Check size={15} />}</button>)}
            <button ref={speedButtonRef} type="button" className={submenu === "speed" ? "model-option sub active" : "model-option sub"} onClick={() => {
              if (submenu === "speed") { setSubmenu(null); return; }
              updateSpeedSubmenuPosition();
              setSubmenu("speed");
            }}><span>속도 · {speedLabel}</span><ChevronRight size={14} /></button>
          </>}
        </motion.div>
      )}</AnimatePresence>
      {submenu === "speed" && createPortal(
        <div ref={speedSubmenuRef} className="model-submenu" style={{ left: speedSubmenuPos.left, top: speedSubmenuPos.top }}>
          <div className="model-section-label">속도</div>
          {speeds.map((item) => <button type="button" className="model-option speed-choice" key={item.value} onClick={() => { onResponseSpeedChange(item.value); setSubmenu(null); }}><Zap size={14} /><span><strong>{item.label}</strong><small>{item.detail}</small></span>{item.value === responseSpeed && <Check size={15} />}</button>)}
        </div>,
        document.body,
      )}
    </div>
  );
}
