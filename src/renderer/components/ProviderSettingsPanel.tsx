import { Check, KeyRound, LogIn, LogOut, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderAuthStatus, ProviderId, ProviderInfo, ProviderRequestLogEntry, ProviderSettings } from "../../shared/contracts";

const emptyAuth: ProviderAuthStatus = { codex: false, claude: false, copilot: false };

function authedFor(provider: ProviderInfo, auth: ProviderAuthStatus): boolean {
  if (!provider.authProvider) return false;
  return auth[provider.authProvider];
}

function loginStatusLabel(provider: ProviderInfo, auth: ProviderAuthStatus): string {
  return authedFor(provider, auth) ? "로그인됨" : "로그인 안 됨";
}

function keyStatusLabel(provider: ProviderInfo): string {
  if (!provider.keyRequired) return "API 키 필요 없음 · 로컬 endpoint";
  const suffix = provider.modelsLoaded ? "모델 확인됨" : "모델 확인 필요";
  if (provider.credentialSource === "keychain") return `API 키 · macOS Keychain · ${suffix}`;
  if (provider.credentialSource === "environment") return `API 키 · .env.local · ${suffix}`;
  return "연결 안 됨";
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

export function ProviderSettingsPanel({ settings, state, onSelect, onSaveKey, onClearKey, onRefreshModels }: { settings: ProviderSettings | null; state: "loading" | "saved" | "error"; onSelect: (input: { provider: ProviderId; model: string }) => Promise<void>; onSaveKey: (input: { provider: ProviderId; key: string }) => Promise<void>; onClearKey: (provider: ProviderId) => Promise<void>; onRefreshModels: (provider: Exclude<ProviderId, "codex">) => Promise<void> }): React.JSX.Element {
  const [keys, setKeys] = useState<Partial<Record<ProviderId, string>>>({});
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
  const loginProviders = settings.providers.filter((provider) => provider.kind === "login");
  const apiProviders = settings.providers.filter((provider) => provider.kind === "apikey");
  const save = async (provider: ProviderInfo): Promise<void> => {
    const key = (keys[provider.id] ?? "").trim();
    if (!key) return;
    await onSaveKey({ provider: provider.id, key });
    setKeys((current) => ({ ...current, [provider.id]: "" }));
  };

  const login = async (provider: ProviderInfo): Promise<void> => {
    const authKey = provider.authProvider;
    if (!authKey) return;
    setBusy(provider.id);
    const info = await window.devilCodex.providerLogin({ provider: authKey }).catch(() => null);
    // Copilot device flow emits a provider:auth event (clears busy). codex/claude
    // open a browser with no event — poll status and clear "로그인 중" when done.
    if (info?.userCode) { setNotice(`GitHub에서 코드 입력: ${info.userCode} (${info.verificationUri})`); return; }
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const status = await window.devilCodex.providerAuthStatus().catch(() => null);
      if (status) { setAuth(status); if (status[authKey]) break; }
    }
    setBusy(null);
  };
  const logout = async (provider: ProviderInfo): Promise<void> => {
    if (!provider.authProvider) return;
    setBusy(provider.id);
    setAuth(await window.devilCodex.providerLogout({ provider: provider.authProvider }).catch(() => auth));
    setBusy(null);
  };

  const setKeyDraft = (provider: ProviderInfo, value: string): void => setKeys((current) => ({ ...current, [provider.id]: value }));

  const providerCard = (provider: ProviderInfo, sub: string): React.JSX.Element => {
    const activeCard = provider.id === active.id;
    const keyValue = keys[provider.id] ?? "";
    const connected = provider.kind === "login" ? authedFor(provider, auth) : provider.credentialSource !== "none";
    return <article key={provider.id} className={`provider-card ${activeCard ? "active" : ""} ${connected ? "connected" : ""}`}>
      <button type="button" className="provider-choice" onClick={() => { setViewingId(provider.id); setNotice(""); }}>
        <span><strong>{provider.label}</strong><small><i className="provider-dot" />{sub}</small></span>
        {activeCard && <Check size={16} />}
      </button>
      {activeCard && provider.kind === "login" && provider.authProvider && <div className="provider-inline-panel">
        <div><strong>{provider.label} 로그인</strong><p>{loginStatusLabel(provider, auth)}</p></div>
        <div className="provider-key-actions">{authedFor(provider, auth)
          ? <button type="button" className="provider-btn danger" disabled={busy === provider.id} onClick={() => void logout(provider)}><LogOut size={14} />{busy === provider.id ? "처리 중…" : "로그아웃"}</button>
          : <button type="button" className="provider-btn primary" disabled={busy === provider.id} onClick={() => void login(provider)}><LogIn size={14} />{busy === provider.id ? "로그인 중…" : "로그인"}</button>}</div>
        {notice && <p className="provider-notice inline">{notice}</p>}
      </div>}
      {activeCard && provider.kind === "apikey" && <div className="provider-inline-panel">
        <div><strong>{provider.label} 연결 상태</strong><p>{keyStatusLabel(provider)}</p></div>
        {!provider.keyRequired
          ? <p className="provider-local-note">로컬 OpenAI-compatible 서버가 실행 중이면 모델 목록 새로고침 후 picker에 표시됩니다.</p>
          : provider.credentialSource === "none"
          ? <div className="provider-key-input"><input type="password" value={keyValue} onChange={(event) => setKeyDraft(provider, event.target.value)} placeholder={`${provider.label} API 키`} autoComplete="off" /><button type="button" className="provider-btn primary" disabled={!keyValue.trim() || state === "loading"} onClick={() => void save(provider)}>Keychain에 저장</button></div>
          : <div className="provider-key-actions">{provider.credentialSource === "keychain" && <button type="button" className="provider-btn" onClick={() => void onClearKey(provider.id)}><Trash2 size={14} />저장 키 삭제</button>}<div className="provider-key-input"><input type="password" value={keyValue} onChange={(event) => setKeyDraft(provider, event.target.value)} placeholder="키 교체" autoComplete="off" /><button type="button" className="provider-btn primary" disabled={!keyValue.trim() || state === "loading"} onClick={() => void save(provider)}>교체</button></div></div>}
      </div>}
    </article>;
  };

  return <>
    <h1>연결</h1>
    <p className="page-lead">로그인 Provider는 자체 세션(OAuth)을 사용하고, API 키 Provider는 OS Keychain으로 암호화해 저장합니다.</p>

    <section><h2>로그인 Provider</h2><div className="provider-grid">{loginProviders.map((provider) => providerCard(provider, loginStatusLabel(provider, auth)))}</div></section>

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
              <span><strong>{entry.provider}</strong><small>{entry.model}</small></span>
              <span>{entry.route}</span>
              <span>{parts}</span>
              <span>{sidecar}</span>
              <span>{entry.durationMs !== undefined ? `${Math.round(entry.durationMs / 1000)}s` : when}</span>
              <b>{entry.status === "completed" ? "성공" : entry.status === "failed" ? "실패" : "진행 중"}</b>
              {entry.error && <small className="provider-request-log-error">{entry.errorType ? `[${entry.errorType}] ` : ""}{entry.error}</small>}
            </div>;
          })}</div>
          : <p className="provider-empty-log">아직 외부 Provider 요청 로그가 없습니다.</p>}
      </div>
    </section>

    {state === "error" && <p className="provider-error">설정 저장에 실패했습니다. macOS Keychain 접근 권한을 확인하세요.</p>}
  </>;
}
