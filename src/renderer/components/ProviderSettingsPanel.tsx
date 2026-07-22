import { AlertTriangle, Check, KeyRound, LogIn, LogOut, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderAccount, ProviderAuthStatus, ProviderId, ProviderInfo, ProviderRequestLogEntry, ProviderSettings } from "../../shared/contracts";
import { providerAccountModelCount, providerAccountReady, selectableApiProvider } from "../providerReadiness";

const emptyAuth: ProviderAuthStatus = { codex: false, claude: false, copilot: false, antigravity: false, kimi: false };
const notifyProviderAuthChanged = (): void => { window.dispatchEvent(new Event("devil-codex:provider-auth-changed")); };

function authedFor(provider: ProviderInfo, auth: ProviderAuthStatus): boolean {
  if (!provider.authProvider) return false;
  return auth[provider.authProvider];
}

function visibleLoginAccounts(provider: ProviderInfo, auth: ProviderAuthStatus): ProviderAccount[] {
  return authedFor(provider, auth) ? provider.accounts : [];
}

function loginStatusLabel(provider: ProviderInfo, auth: ProviderAuthStatus): string {
  if (!authedFor(provider, auth)) return "로그인 안 됨";
  if (provider.id === "codex") return "로그인됨";
  const accounts = visibleLoginAccounts(provider, auth);
  return accounts.length > 1 ? `${accounts.length}개 계정 로그인됨` : "로그인됨";
}

function keyStatusLabel(provider: ProviderInfo): string {
  if (provider.id === "opencode-free") return selectableApiProvider(provider) ? "API 키 없이 사용 가능 · 무료 모델 확인됨" : "API 키 없이 사용 가능 · 모델 확인 필요";
  if (!provider.keyRequired) {
    const account = provider.accounts.find((item) => providerAccountReady(provider, item));
    return account ? `로컬 endpoint 연결됨 · ${providerAccountModelCount(provider, account)}개 모델` : "로컬 endpoint 확인 필요 · 모델 새로고침을 실행하세요";
  }
  const suffix = provider.modelsLoaded ? "모델 확인됨" : "모델 확인 필요";
  if (provider.credentialSource === "keychain") return `API 키 ${provider.accounts.length || 1}개 · Keychain · ${suffix}`;
  if (provider.credentialSource === "environment") return `API 키 · .env.local · ${suffix}`;
  return "연결 안 됨";
}

function accountName(account: ProviderAccount): string {
  return account.email || account.label || account.id;
}

function capabilityBadgeClass(value: string): string {
  if (value === "native" || value === "good") return "good";
  if (value === "limited" || value === "sidecar") return "limited";
  if (value === "experimental") return "experimental";
  return "";
}

function capabilityBadge(label: string, value: string): React.JSX.Element {
  return <i className={capabilityBadgeClass(value)}>{label}: {value}</i>;
}

function compatibilityFor(provider: ProviderId, model: string, requestLog: ProviderRequestLogEntry[]): { tone: "unknown" | "good" | "warn" | "bad"; label: string; detail: string } {
  const entries = requestLog.filter((entry) => entry.provider === provider && entry.model === model);
  if (!entries.length) return { tone: "unknown", label: "미검증", detail: "아직 실제 요청 기록 없음" };
  const successes = entries.filter((entry) => entry.status === "completed").length;
  const failures = entries.filter((entry) => entry.status === "failed").length;
  const latest = entries[0];
  if (latest?.status === "failed") {
    return {
      tone: "bad",
      label: "최근 실패",
      detail: latest.errorType ? `${latest.errorType} · 성공 ${successes} / 실패 ${failures}` : `성공 ${successes} / 실패 ${failures}`,
    };
  }
  if (failures > successes) return { tone: "warn", label: "불안정", detail: `성공 ${successes} / 실패 ${failures}` };
  return { tone: "good", label: "동작 확인", detail: `성공 ${successes} / 실패 ${failures}` };
}

export function ProviderSettingsPanel({ settings, state, error, onSelect, onSaveKey, onClearKey, onRefreshModels }: { settings: ProviderSettings | null; state: "loading" | "saved" | "error"; error: string; onSelect: (input: { provider: ProviderId; accountId?: string; model: string }) => Promise<void>; onSaveKey: (input: { provider: ProviderId; key: string; accountId?: string; label?: string }) => Promise<void>; onClearKey: (provider: ProviderId, accountId?: string) => Promise<void>; onRefreshModels: (provider: Exclude<ProviderId, "codex">, accountId?: string) => Promise<void> }): React.JSX.Element {
  const [keys, setKeys] = useState<Partial<Record<ProviderId, string>>>({});
  const [labels, setLabels] = useState<Partial<Record<ProviderId, string>>>({});
  const [auth, setAuth] = useState<ProviderAuthStatus>(emptyAuth);
  const [requestLog, setRequestLog] = useState<ProviderRequestLogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<ProviderId | null>(null);

  const [notice, setNotice] = useState("");
  const refreshAuth = (): void => { void window.devilCodex.providerAuthStatus().then(setAuth).catch(() => undefined); };
  const refreshRequestLog = (): void => { void window.devilCodex.providerRequestLog().then(setRequestLog).catch(() => undefined); };
  useEffect(() => { refreshAuth(); }, []);
  useEffect(() => { refreshRequestLog(); const timer = window.setInterval(refreshRequestLog, 5000); return () => window.clearInterval(timer); }, []);
  useEffect(() => window.devilCodex.onProviderAuth((status) => { setAuth(status); setNotice(""); setBusy(null); }), []);

  if (!settings) return <div className="empty-settings"><KeyRound size={28} /><strong>Provider 설정 불러오는 중…</strong></div>;
  const active = settings.providers.find((provider) => provider.id === (viewingId ?? settings.provider))!;
  const subscriptionProviders = settings.providers.filter((provider) => provider.subscription);
  const loginProviders = settings.providers.filter((provider) => provider.kind === "login" && !provider.subscription);
  const apiProviders = settings.providers.filter((provider) => provider.kind === "apikey" && !provider.subscription);
  const save = async (provider: ProviderInfo): Promise<void> => {
    const key = (keys[provider.id] ?? "").trim();
    if (!key) return;
    await onSaveKey({ provider: provider.id, key, label: labels[provider.id]?.trim() || undefined });
    setKeys((current) => ({ ...current, [provider.id]: "" }));
    setLabels((current) => ({ ...current, [provider.id]: "" }));
  };

  const login = async (provider: ProviderInfo): Promise<void> => {
    const authKey = provider.authProvider;
    if (!authKey) return;
    setBusy(provider.id);
    const info = await window.devilCodex.providerLogin({ provider: authKey }).catch(() => null);
    // Device flows emit provider:auth when done. Browser callback flows are
    // polled below so the button also recovers when no event arrives.
    if (info?.userCode) { setNotice(`${provider.label} 인증 코드: ${info.userCode} (${info.verificationUri})`); return; }
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const status = await window.devilCodex.providerAuthStatus().catch(() => null);
      if (status) { setAuth(status); if (status[authKey]) break; }
    }
    notifyProviderAuthChanged();
    setBusy(null);
  };
  const logout = async (provider: ProviderInfo, accountId?: string): Promise<void> => {
    if (!provider.authProvider) return;
    setBusy(`${provider.id}:${accountId ?? "all"}`);
    setAuth(await window.devilCodex.providerLogout({ provider: provider.authProvider, accountId }).catch(() => auth));
    notifyProviderAuthChanged();
    setBusy(null);
  };

  const setKeyDraft = (provider: ProviderInfo, value: string): void => setKeys((current) => ({ ...current, [provider.id]: value }));
  const setLabelDraft = (provider: ProviderInfo, value: string): void => setLabels((current) => ({ ...current, [provider.id]: value }));

  const providerCard = (provider: ProviderInfo, sub: string): React.JSX.Element => {
    const activeCard = provider.id === active.id;
    const keyValue = keys[provider.id] ?? "";
    const labelValue = labels[provider.id] ?? "";
    const loginAccounts = provider.kind === "login" ? visibleLoginAccounts(provider, auth) : [];
    const connected = provider.kind === "login" ? authedFor(provider, auth) : selectableApiProvider(provider);
    return <article key={provider.id} className={`provider-card ${activeCard ? "active" : ""} ${connected ? "connected" : ""}`}>
      <button type="button" className="provider-choice" onClick={() => { setViewingId(provider.id); setNotice(""); }}>
        <span><strong>{provider.label}</strong><small><i className="provider-dot" />{sub}</small></span>
        {activeCard && <Check size={16} />}
      </button>
      {activeCard && provider.kind === "login" && provider.authProvider && <div className="provider-inline-panel">
        <div><strong>{provider.label} 로그인</strong><p>{loginStatusLabel(provider, auth)}</p></div>
        {provider.id === "claude-code" && <p className="provider-risk-note">
          <AlertTriangle size={14} />
          <span>
            <strong>계정 정지 위험 — 직접 판단해서 사용하세요.</strong>
            Anthropic 소비자 약관은 Claude Free/Pro/Max 계정의 OAuth 토큰을 다른 제품·도구·서비스에서 쓰는 것을 금지합니다.
            2026년 1월부터 구독 토큰은 공식 Claude Code 클라이언트로 제한되고 있고, 그 과정에서 계정이 정지된 사례도 보고됐습니다.
            Devil Codex에서 Anthropic 모델을 약관 안에서 쓰려면 아래 <strong>Anthropic</strong> Provider에 API 키를 등록하세요.
          </span>
        </p>}
        {loginAccounts.length > 0 && <div className="provider-account-list">{loginAccounts.map((account) => <div className="provider-account-row" key={account.id}>
          <span><strong>{accountName(account)}</strong><small>{account.id}</small></span>
          <button type="button" className="provider-btn danger" disabled={busy === `${provider.id}:${account.id}`} onClick={() => void logout(provider, account.id)}><LogOut size={14} />로그아웃</button>
        </div>)}</div>}
        <div className="provider-key-actions">
          <button type="button" className="provider-btn primary" disabled={busy === provider.id} onClick={() => void login(provider)}><LogIn size={14} />{busy === provider.id ? "로그인 중…" : provider.id === "codex" && loginAccounts.length ? "다시 로그인" : loginAccounts.length ? "계정 추가" : "로그인"}</button>
        </div>
        {notice && <p className="provider-notice inline">{notice}</p>}
      </div>}
      {activeCard && provider.kind === "apikey" && <div className="provider-inline-panel">
        <div><strong>{provider.label} 연결 상태</strong><p>{keyStatusLabel(provider)}</p></div>
        {provider.accounts.length > 0 && <div className="provider-account-list">{provider.accounts.map((account) => <div className="provider-account-row" key={account.id}>
          <span><strong>{accountName(account)}</strong><small>{account.credentialSource === "environment" ? "환경 변수" : `${account.models?.length ?? provider.models.length}개 모델`}</small></span>
          <div className="provider-key-actions">
            <button type="button" className="provider-btn" onClick={() => void onRefreshModels(provider.id as Exclude<ProviderId, "codex">, account.id)}><RefreshCw size={14} />모델</button>
            {account.credentialSource === "keychain" && <button type="button" className="provider-btn" onClick={() => void onClearKey(provider.id, account.id)}><Trash2 size={14} />삭제</button>}
          </div>
        </div>)}</div>}
        {!provider.keyRequired
          ? <p className="provider-local-note">{provider.id === "opencode-free" ? "API 키 없이 OpenCode 무료 모델을 사용합니다. 무료 endpoint에는 데이터 보존/학습 사용 예외가 있으니 민감한 내용을 보내지 마세요." : "로컬 OpenAI-compatible 서버가 실행 중이면 모델 목록 새로고침 후 picker에 표시됩니다."}</p>
          : <div className="provider-key-input multi"><input type="text" value={labelValue} onChange={(event) => setLabelDraft(provider, event.target.value)} placeholder="계정 이름 예: work, personal" autoComplete="off" /><input type="password" value={keyValue} onChange={(event) => setKeyDraft(provider, event.target.value)} placeholder={`${provider.label}${provider.subscription ? " 구독" : ""} API 키`} autoComplete="off" /><button type="button" className="provider-btn primary" disabled={!keyValue.trim() || state === "loading"} onClick={() => void save(provider)}>키 추가</button></div>}
      </div>}
    </article>;
  };

  return <>
    <h1>연결</h1>
    <p className="page-lead">구독 Provider는 계정 OAuth를 사용하며, Z.AI GLM Coding Plan만 발급된 구독 API 키를 OS Keychain에 저장합니다.</p>

    <section><h2>구독 Provider</h2><div className="provider-grid">{subscriptionProviders.map((provider) => providerCard(provider, provider.kind === "login" ? loginStatusLabel(provider, auth) : keyStatusLabel(provider)))}</div></section>

    <section><h2>기타 로그인 Provider</h2><div className="provider-grid">{loginProviders.map((provider) => providerCard(provider, loginStatusLabel(provider, auth)))}</div></section>

    <section><h2>API 키 Provider</h2><div className="provider-grid">{apiProviders.map((provider) => providerCard(provider, keyStatusLabel(provider)))}</div></section>

    <section>
      <h2>Capability metadata</h2>
      <div className="setting-card provider-capability-card">
        <p>이 Provider 모델이 Devil proxy에서 어떤 기능을 안정적으로 쓸 수 있는지 표시합니다. Codex 모델은 항상 순정 app-server direct 경로입니다.</p>
        <div className="provider-capability-list">
          {active.models.map((model) => {
            const capability = model.capability;
            const compatibility = compatibilityFor(active.id, model.id, requestLog);
            return <div key={model.id} className="provider-capability-row">
              <span>
                <strong>{model.label}</strong>
                <small>{model.id}</small>
                <small className={`provider-compat ${compatibility.tone}`}>{compatibility.label} · {compatibility.detail}</small>
              </span>
              {capability
                ? <div className="provider-capability-badges">
                  {capabilityBadge("tools", capability.tools)}
                  {capabilityBadge("image", capability.images)}
                  {capabilityBadge("web", capability.webSearch)}
                  {capabilityBadge("diag", capability.diagnostics)}
                </div>
                : <small>metadata 없음</small>}
            </div>;
          })}
        </div>
      </div>
    </section>

    <section>
      <h2>Provider 요청 로그</h2>
      <div className="setting-card provider-request-log">
        <div className="provider-request-log-head">
          <p>최근 외부 Provider 요청의 성공/실패, route, sidecar 사용량을 보여줍니다. Codex 모델은 app-server direct라 여기에는 기록하지 않습니다.</p>
          <button type="button" className="provider-btn" onClick={refreshRequestLog}><RefreshCw size={14} />새로고침</button>
        </div>
        {requestLog.length
          ? <div className="provider-request-log-list">{requestLog.slice(0, 12).map((entry) => {
            const when = new Date(entry.startedAt).toLocaleTimeString();
            const sidecar = entry.sidecar ? `web ${entry.sidecar.webSearchRequests} · vision ${entry.sidecar.visionRequests}${entry.sidecar.failures.length ? ` · fail ${entry.sidecar.failures.length}` : ""}` : "sidecar 없음";
            const parts = `tools ${entry.tools ?? 0} · images ${entry.images ?? 0} · files ${entry.files ?? 0}`;
            return <div key={entry.id} className={`provider-request-log-row ${entry.status}`}>
              <span><strong>{entry.provider}</strong><small>{[entry.accountLabel, entry.model].filter(Boolean).join(" · ")}</small></span>
              <span>{entry.route}</span>
              <span>{parts}</span>
              <span>{sidecar}</span>
              <span>{entry.durationMs !== undefined ? `${Math.round(entry.durationMs / 1000)}s` : when}</span>
              <b>{entry.status === "completed" ? "성공" : entry.status === "failed" ? "실패" : "진행 중"}</b>
              {entry.finishReason && <small>finishReason: {entry.finishReason}</small>}
              {entry.error && <small className="provider-request-log-error">{entry.errorType ? `[${entry.errorType}] ` : ""}{entry.error}</small>}
            </div>;
          })}</div>
          : <p className="provider-empty-log">아직 외부 Provider 요청 로그가 없습니다.</p>}
      </div>
    </section>

    {state === "error" && <p className="provider-error" role="alert">작업을 완료하지 못했습니다. {error || "Provider 연결과 OS 자격 증명 저장소 상태를 확인하세요."}</p>}
  </>;
}
