import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bell, Check, ChevronDown, ChevronRight, Copy, CreditCard, Globe2, QrCode, RefreshCw, Search, TerminalSquare, Wifi, X } from "lucide-react";
import { useCodexSettings } from "./hooks/useCodexSettings";
import { useProviderUsage } from "./hooks/useProviderUsage";
import { ProviderSettingsPanel } from "./components/ProviderSettingsPanel";
import { estimateProviderUsageCost } from "./providerPricing";
import type { AgentRuntimeId, AppInfo, DevilMcpStatus, ProviderId, ProviderRequestLogEntry, ProviderSettings, ProviderTokenUsage, ProviderUsageEntry, RemoteClient, RemoteControlMode, RemoteControlStatus, RemoteDevice, TerminalShellId, TerminalShellProfile, ThreadSummary } from "../shared/contracts";

type Config = {
  approval: string;
  sandbox: string;
  devilMcpEnabled: boolean;
  askUserMcpEnabled: boolean;
  subagentMcpEnabled: boolean;
  englishOutput: boolean;
  stockBridgeEnabled: boolean;
  stockBridgeWebSearch: boolean;
  stockBridgeVision: boolean;
  sidecarWebSearch: boolean;
  sidecarVision: boolean;
  sidecarWebSearchLimit: number;
  sidecarVisionLimit: number;
  nvidiaRateLimitRpm: number;
  notificationsEnabled: boolean;
  notifyOnTurnComplete: boolean;
  notifyOnApproval: boolean;
  notifyOnAsk: boolean;
  browserPersistentSession: boolean;
  terminalShell: TerminalShellId;
};

const defaults: Config = {
  approval: "요청 시", sandbox: "읽기 전용", devilMcpEnabled: false, askUserMcpEnabled: true, subagentMcpEnabled: true, englishOutput: false, stockBridgeEnabled: true, stockBridgeWebSearch: false, stockBridgeVision: false, sidecarWebSearch: false, sidecarVision: false, sidecarWebSearchLimit: 3, sidecarVisionLimit: 3, nvidiaRateLimitRpm: 40, notificationsEnabled: true, notifyOnTurnComplete: true, notifyOnApproval: true, notifyOnAsk: true, browserPersistentSession: true, terminalShell: "auto",
};

const REMOTE_INSTALL_URL = "https://tailscale.com/download";
const TAILSCALE_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
const TAILSCALE_ADMIN_FUNNEL_URL = "https://login.tailscale.com/admin/machines";

const groups = [
  { label: "설정", items: [["구성", TerminalSquare], ["연결", Globe2], ["알림", Bell], ["사용량 및 청구", CreditCard]] },
] as const;

export function SettingsView({ active, appInfo, onSelect, onBack, providerSettings, providerState, onProviderSelect, onProviderSaveKey, onProviderClearKey, onProviderRefreshModels }: { active: string; appInfo: AppInfo | null; onSelect: (value: string) => void; onBack: () => void; providerSettings: ProviderSettings | null; providerState: "loading" | "saved" | "error"; onProviderSelect: (input: { provider: ProviderId; accountId?: string; model: string }) => Promise<void>; onProviderSaveKey: (input: { provider: ProviderId; key: string; accountId?: string; label?: string }) => Promise<void>; onProviderClearKey: (provider: ProviderId, accountId?: string) => Promise<void>; onProviderRefreshModels: (provider: Exclude<ProviderId, "codex">, accountId?: string) => Promise<void> }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [config, setConfig] = useState<Config>(() => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("devil-codex:settings") ?? "{}") }; } catch { return defaults; }
  });
  const [terminalShells, setTerminalShells] = useState<TerminalShellProfile[]>([]);
  const codex = useCodexSettings();
  useEffect(() => {
    const settings = codex.settings;
    if (!settings) return;
    setConfig((current) => ({ ...current, approval: approvalLabel(settings.approvalPolicy), sandbox: sandboxLabel(settings.sandboxMode), devilMcpEnabled: settings.devilMcpEnabled, askUserMcpEnabled: settings.askUserMcpEnabled, subagentMcpEnabled: settings.subagentMcpEnabled, englishOutput: settings.englishOutput, stockBridgeEnabled: settings.stockBridgeEnabled, stockBridgeWebSearch: settings.stockBridgeWebSearch, stockBridgeVision: settings.stockBridgeVision }));
  }, [codex.settings]);
  useEffect(() => {
    let active = true;
    void window.devilCodex.listTerminalShells()
      .then((profiles) => { if (active) setTerminalShells(profiles); })
      .catch(() => { if (active) setTerminalShells([]); });
    return () => { active = false; };
  }, []);
  useEffect(() => { localStorage.setItem("devil-codex:settings", JSON.stringify(config)); }, [config]);
  const visible = useMemo(() => groups.map((group) => ({ ...group, items: group.items.filter(([name]) => name.toLowerCase().includes(query.toLowerCase())) })).filter((group) => group.items.length), [query]);
  const update = <K extends keyof Config>(key: K, value: Config[K]): void => {
    setConfig((current) => ({ ...current, [key]: value }));
    window.dispatchEvent(new CustomEvent("devil-codex:settings-changed", { detail: { key, value } }));
    const settings = codex.settings;
    if (!settings) return;
    if (key === "approval") codex.save({ ...settings, approvalPolicy: approvalValue(String(value)) });
    if (key === "sandbox") codex.save({ ...settings, sandboxMode: sandboxValue(String(value)) });
    if (key === "devilMcpEnabled") codex.save({ ...settings, devilMcpEnabled: Boolean(value) });
    if (key === "askUserMcpEnabled") codex.save({ ...settings, askUserMcpEnabled: Boolean(value) });
    if (key === "subagentMcpEnabled") codex.save({ ...settings, subagentMcpEnabled: Boolean(value) });
    if (key === "englishOutput") codex.save({ ...settings, englishOutput: Boolean(value) });
    if (key === "stockBridgeEnabled") codex.save({ ...settings, stockBridgeEnabled: Boolean(value) });
    if (key === "stockBridgeWebSearch") codex.save({ ...settings, stockBridgeWebSearch: Boolean(value) });
    if (key === "stockBridgeVision") codex.save({ ...settings, stockBridgeVision: Boolean(value) });
  };

  return <div className="settings-view">
    <aside className="settings-sidebar">
      <button className="settings-back" onClick={onBack}>← <span>앱으로 돌아가기</span></button>
      <label className="settings-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="설정 검색..." /></label>
      <nav>{visible.map((group) => <div className="settings-group" key={group.label}><p>{group.label}</p>{group.items.map(([name, Icon]) => <button className={active === name ? "active" : ""} key={name} onClick={() => onSelect(name)}><Icon size={18} strokeWidth={1.8} />{name}</button>)}</div>)}</nav>
    </aside>
    <section className="settings-content">
      <AnimatePresence mode="wait"><motion.div key={active} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: .16 }} className="settings-page">
        <SettingsPage active={active} appInfo={appInfo} config={config} update={update} backendState={codex.state} terminalShells={terminalShells} providerSettings={providerSettings} providerState={providerState} onProviderSelect={onProviderSelect} onProviderSaveKey={onProviderSaveKey} onProviderClearKey={onProviderClearKey} onProviderRefreshModels={onProviderRefreshModels} />
      </motion.div></AnimatePresence>
    </section>
  </div>;
}

function SettingsPage({ active, appInfo, config, update, backendState, terminalShells, providerSettings, providerState, onProviderSelect, onProviderSaveKey, onProviderClearKey, onProviderRefreshModels }: { active: string; appInfo: AppInfo | null; config: Config; update: <K extends keyof Config>(key: K, value: Config[K]) => void; backendState: "loading" | "saved" | "error"; terminalShells: TerminalShellProfile[]; providerSettings: ProviderSettings | null; providerState: "loading" | "saved" | "error"; onProviderSelect: (input: { provider: ProviderId; accountId?: string; model: string }) => Promise<void>; onProviderSaveKey: (input: { provider: ProviderId; key: string; accountId?: string; label?: string }) => Promise<void>; onProviderClearKey: (provider: ProviderId, accountId?: string) => Promise<void>; onProviderRefreshModels: (provider: Exclude<ProviderId, "codex">, accountId?: string) => Promise<void> }): React.JSX.Element {
  const usage = useProviderUsage(active === "사용량 및 청구");
  const [configurationTab, setConfigurationTab] = useState<ConfigurationTab>("기본");
  if (active === "구성") return <ConfigurationSettings tab={configurationTab} onTabChange={setConfigurationTab} appInfo={appInfo} config={config} update={update} backendState={backendState} terminalShells={terminalShells} providerSettings={providerSettings} />;
  if (active === "알림") return <><h1>알림</h1><p className="page-lead">Devil Codex 창이 숨겨져 있거나 포커스가 없을 때만 시스템 알림을 표시합니다. 창을 보고 있는 동안에는 기존 화면 표시만 사용합니다.</p><section><h2>데스크톱 알림</h2><div className="setting-card"><Row title="백그라운드 알림" detail="끄면 아래 세부 항목과 무관하게 모든 시스템 알림을 보내지 않습니다."><Toggle value={config.notificationsEnabled} onChange={(v) => update("notificationsEnabled", v)} /></Row><Row title="작업 완료" detail="AI 작업이 완료되거나 실패했을 때 알려줍니다. 대기열에 다음 메시지가 있으면 마지막 작업이 끝날 때 알려줍니다."><Toggle value={config.notifyOnTurnComplete} onChange={(v) => update("notifyOnTurnComplete", v)} /></Row><Row title="승인 요청" detail="명령 실행 또는 파일 변경 승인이 필요할 때 알려줍니다."><Toggle value={config.notifyOnApproval} onChange={(v) => update("notifyOnApproval", v)} /></Row><Row title="질문 요청" detail="AI가 선택지 질문 모달을 띄워 사용자 입력을 기다릴 때 알려줍니다."><Toggle value={config.notifyOnAsk} onChange={(v) => update("notifyOnAsk", v)} /></Row></div></section></>;
  if (active === "사용량 및 청구") return <ProviderUsagePage report={usage.report} requestLog={usage.requestLog} providerSettings={providerSettings} state={usage.state} onRefresh={() => void usage.refresh()} />;
  if (active === "연결") return <ProviderSettingsPanel settings={providerSettings} state={providerState} onSelect={onProviderSelect} onSaveKey={onProviderSaveKey} onClearKey={onProviderClearKey} onRefreshModels={onProviderRefreshModels} />;
  return <><h1>{active}</h1><p>준비 중입니다.</p></>;
}

type ConfigurationTab = "기본" | "도구" | "원격" | "Bridge" | "Sidecar";
const configurationTabs: Array<{ id: ConfigurationTab; detail: string }> = [
  { id: "기본", detail: "권한, 앱 및 작업 환경" },
  { id: "도구", detail: "MCP와 하위 에이전트" },
  { id: "원격", detail: "다른 기기에서의 접속" },
  { id: "Bridge", detail: "순정 Codex 연동" },
  { id: "Sidecar", detail: "외부 모델 보조 기능" },
];

function ConfigurationSettings({ tab, onTabChange, appInfo, config, update, backendState, terminalShells, providerSettings }: { tab: ConfigurationTab; onTabChange: (tab: ConfigurationTab) => void; appInfo: AppInfo | null; config: Config; update: <K extends keyof Config>(key: K, value: Config[K]) => void; backendState: "loading" | "saved" | "error"; terminalShells: TerminalShellProfile[]; providerSettings: ProviderSettings | null }): React.JSX.Element {
  const codex = useCodexSettings();
  const [devilMcpStatus, setDevilMcpStatus] = useState<DevilMcpStatus | null>(null);
  const [devilMcpStatusLoading, setDevilMcpStatusLoading] = useState(false);
  const refreshDevilMcpStatus = useCallback((): void => {
    setDevilMcpStatusLoading(true);
    void window.devilCodex.devilMcpStatus()
      .then(setDevilMcpStatus)
      .catch(() => setDevilMcpStatus({ state: "error", detail: "현재 MCP 상태를 확인하지 못했습니다.", browserServer: false, computerServer: false, browserRegistered: false, computerRegistered: false, checkedAt: Date.now() }))
      .finally(() => setDevilMcpStatusLoading(false));
  }, []);
  useEffect(() => {
    if (tab === "도구") refreshDevilMcpStatus();
  }, [tab, config.devilMcpEnabled, config.stockBridgeEnabled, backendState, refreshDevilMcpStatus]);
  const stockBridgeModels = codex.settings?.stockBridgeModels ?? [];
  const saveStockBridgeModels = (models: string[]): void => {
    if (codex.settings) codex.save({ ...codex.settings, stockBridgeModels: models });
  };
  return <>
    <h1>구성</h1>
    <p className="page-lead">설정을 목적별로 나눴습니다. <span className={`settings-save-state ${backendState}`}>{backendState === "loading" ? "저장 중…" : backendState === "saved" ? "config.toml 저장됨" : "저장 실패"}</span></p>
    <div className="configuration-tabs" role="tablist" aria-label="구성 설정 탭">
      {configurationTabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} onClick={() => onTabChange(item.id)}><strong>{item.id}</strong><small>{item.detail}</small></button>)}
    </div>
    {tab === "기본" && <>
      <section><h2>앱 정보</h2><div className="setting-card app-version-card"><Row title="Devil Codex 현재 버전" detail="현재 실행 중인 데스크톱 앱 버전입니다. 업데이트 확인이나 설치 빌드 검증 때 기준으로 사용합니다."><span className="app-version-badge">{appInfo?.version ? `v${appInfo.version}` : "확인 중..."}</span></Row><Row title="플랫폼" detail="앱이 감지한 현재 실행 환경입니다."><span className="app-version-platform">{appInfo?.platform ?? "unknown"}</span></Row></div></section>
      <section><h2>권한과 샌드박스</h2><div className="setting-card"><Row title="승인 정책" detail="Codex가 승인을 요청할 시점을 선택합니다"><Select value={config.approval} options={["요청 시", "항상", "사용 안 함"]} onChange={(v) => update("approval", v)} /></Row><Row title="샌드박스 설정" detail="명령을 실행하는 동안 수행할 수 있는 작업 범위"><Select value={config.sandbox} options={["읽기 전용", "작업 공간 쓰기", "전체 접근"]} onChange={(v) => update("sandbox", v)} /></Row></div></section>
      <section><h2>작업 환경</h2><div className="setting-card"><Row title="기본 터미널 Shell" detail="새 터미널 탭을 열 때 사용할 shell입니다. 자동은 WSL, Git Bash, PowerShell 7, Windows PowerShell, cmd 순서로 선택합니다."><ShellSelect value={config.terminalShell} profiles={terminalShells} onChange={(v) => update("terminalShell", v)} /></Row><Row title="브라우저 프로필 저장" detail="켜면 쿠키와 로그인 상태를 앱 재시작 후에도 유지합니다. 변경 시 열린 브라우저 탭은 새 세션으로 다시 만들어집니다."><Toggle value={config.browserPersistentSession} onChange={(v) => update("browserPersistentSession", v)} /></Row><Row title="모델 영어 응답" detail="켜면 한글로 질문해도 모델은 영어로 답하고, 각 응답의 번역 토글로 한글을 볼 수 있습니다."><Toggle value={config.englishOutput} onChange={(v) => update("englishOutput", v)} /></Row></div></section>
    </>}
    {tab === "도구" && <section><h2>Devil MCP 도구</h2><p className="section-help">작업 중에만 필요한 기능을 켜 두면 모델이 알맞은 MCP 도구를 선택할 수 있습니다.</p><div className="setting-card"><Row title="AI 질문 모달 MCP" detail="모델이 애매한 요구사항이나 중요한 트레이드오프를 객관식으로 물을 때 사용합니다."><Toggle value={config.askUserMcpEnabled} onChange={(v) => update("askUserMcpEnabled", v)} /></Row><Row title="하위 에이전트 MCP" detail="등록된 provider/model에 독립 작업을 위임합니다. 위임된 작업도 현재 Codex 권한 설정을 넘지 않습니다."><Toggle value={config.subagentMcpEnabled} onChange={(v) => update("subagentMcpEnabled", v)} /></Row><Row title="브라우저/컴퓨터 제어 MCP" detail="켜면 브라우저와 컴퓨터 제어 도구를 MCP 목록에 등록합니다."><Toggle value={config.devilMcpEnabled} onChange={(v) => update("devilMcpEnabled", v)} /></Row></div><DevilMcpStatusCard status={devilMcpStatus} loading={devilMcpStatusLoading} onRefresh={refreshDevilMcpStatus} /></section>}
    {tab === "원격" && <section><h2>원격 제어</h2><p className="section-help">휴대폰이나 다른 브라우저에서 Devil Codex에 접속할 수 있게 합니다.</p><RemoteControlSection /></section>}
    {tab === "Bridge" && <section><h2>순정 Codex Bridge</h2><p className="section-help">순정 GPT 모델은 항상 먼저 보이고, 아래에서 고른 외부 모델만 그 뒤에 순서대로 표시됩니다. Bridge를 끄면 선택 목록은 보존하지만 순정 Codex에는 외부 모델을 노출하지 않습니다.</p><div className="setting-card"><Row title="순정 Codex에서 외부 모델 사용" detail="끄면 관리 config와 자동실행 브릿지를 제거하고 순정 Codex 기본 상태로 되돌립니다."><Toggle value={config.stockBridgeEnabled} onChange={(v) => update("stockBridgeEnabled", v)} /></Row><Row title="순정 Codex에 표시할 모델" detail="추가한 외부 모델만 순정 Codex 선택기에 표시합니다. 위·아래 버튼으로 표시 순서를 정합니다."><StockBridgeModelPicker providers={providerSettings?.providers ?? []} selected={stockBridgeModels} onChange={saveStockBridgeModels} /></Row><Row title="웹 검색 sidecar" detail="외부 모델의 web_search 호출을 Codex 검색으로 실행하고 결과를 다시 전달합니다."><Toggle value={config.stockBridgeWebSearch} onChange={(v) => update("stockBridgeWebSearch", v)} disabled={!config.stockBridgeEnabled} /></Row><Row title="이미지 설명 sidecar" detail="이미지를 못 보는 외부 모델에 Codex vision 설명을 전달합니다."><Toggle value={config.stockBridgeVision} onChange={(v) => update("stockBridgeVision", v)} disabled={!config.stockBridgeEnabled} /></Row></div></section>}
    {tab === "Sidecar" && <section><h2>외부 모델 Sidecar</h2><p className="section-help">Devil Codex 앱 안에서 외부 모델이 사용하는 보조 기능입니다. Codex 모델은 항상 직접 경로를 유지합니다.</p><div className="setting-card"><Row title="웹 검색 sidecar" detail="외부 모델이 web_search 도구를 호출하면 실제 검색을 실행하고 결과를 다시 전달합니다."><Toggle value={config.sidecarWebSearch} onChange={(v) => update("sidecarWebSearch", v)} /></Row><Row title="웹 검색 최대 요청 수" detail="한 요청에서 검색이 반복될 때의 폭주를 막습니다."><Select value={String(config.sidecarWebSearchLimit)} options={["1", "2", "3", "5"]} onChange={(v) => update("sidecarWebSearchLimit", Number(v))} /></Row><Row title="이미지 설명 sidecar" detail="이미지를 볼 수 없는 외부 모델에 텍스트 설명을 전달합니다."><Toggle value={config.sidecarVision} onChange={(v) => update("sidecarVision", v)} /></Row><Row title="이미지 설명 최대 요청 수" detail="여러 이미지나 반복 설명의 비용과 지연을 제한합니다."><Select value={String(config.sidecarVisionLimit)} options={["1", "2", "3", "5"]} onChange={(v) => update("sidecarVisionLimit", Number(v))} /></Row><Row title="NVIDIA NIM RPM 제한" detail="NVIDIA hosted endpoint의 429를 줄이기 위한 분당 요청 제한입니다. 0은 제한을 끕니다."><NumberInput value={config.nvidiaRateLimitRpm} min={0} max={240} onChange={(v) => update("nvidiaRateLimitRpm", v)} /></Row></div></section>}
  </>;
}

function DevilMcpStatusCard({ status, loading, onRefresh }: { status: DevilMcpStatus | null; loading: boolean; onRefresh: () => void }): React.JSX.Element {
  const label = !status || loading ? "확인 중" : status.state === "ready" ? "사용 가능" : status.state === "disabled" ? "꺼짐" : status.state === "bridge" ? "Bridge로 비활성" : "오류";
  return <div className={`devil-mcp-status ${status?.state ?? "checking"}`}>
    <div><strong>브라우저/컴퓨터 MCP 상태 <span>{label}</span></strong><p>{status?.detail ?? "제어 서버와 MCP 등록 상태를 확인하고 있습니다."}</p>{status && <small>브라우저 서버 {status.browserServer ? "연결됨" : "없음"} · 컴퓨터 서버 {status.computerServer ? "연결됨" : "없음"} · MCP 등록 {status.browserRegistered && status.computerRegistered ? "완료" : "미완료"}</small>}</div>
    <button type="button" onClick={onRefresh} disabled={loading} aria-label="MCP 상태 새로고침"><RefreshCw size={15} className={loading ? "spin" : ""} /> 확인</button>
  </div>;
}

type StockBridgeModelChoice = { id: string; provider: string; account: string; label: string };

function hasConnectedCredential(provider: ProviderSettings["providers"][number]): boolean {
  if (provider.id === "opencode-free") return true;
  return provider.accounts.some((account) => account.credentialSource === "keychain" || account.credentialSource === "environment" || account.credentialSource === "desktop");
}

function mergeBridgeModels(...groups: Array<ProviderSettings["providers"][number]["models"] | undefined>): ProviderSettings["providers"][number]["models"] {
  const seen = new Set<string>();
  return groups.flatMap((group) => group ?? []).filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function StockBridgeModelPicker({ providers, selected, onChange }: { providers: ProviderSettings["providers"]; selected: string[]; onChange: (models: string[]) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const externalProviders = useMemo(() => providers.filter((provider) => provider.id !== "codex" && hasConnectedCredential(provider)), [providers]);
  const choices = useMemo(() => externalProviders.flatMap((provider) => {
    const accounts = provider.accounts.length ? provider.accounts : [undefined];
    return accounts.flatMap((account) => {
      const models = mergeBridgeModels(account?.models, provider.models);
      return models.map((model) => ({
        id: `${provider.id}${account?.id ? `@${encodeURIComponent(account.id)}` : ""}/${model.id}`,
        provider: provider.label,
        account: account?.email ?? account?.label ?? provider.label,
        label: model.label,
      }));
    });
  }).filter((choice, index, all) => all.findIndex((candidate) => candidate.id === choice.id) === index), [externalProviders]);
  const byId = useMemo(() => new Map(choices.map((choice) => [choice.id, choice])), [choices]);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (choice: StockBridgeModelChoice): boolean => !normalizedQuery || `${choice.label} ${choice.provider} ${choice.account}`.toLowerCase().includes(normalizedQuery);
  // Model buttons can be clicked before React renders the preceding choice.
  // Keep a committed ref so every click builds on the latest selection instead
  // of letting concurrent IPC saves overwrite earlier choices.
  const commitSelection = (next: string[]): void => {
    selectedRef.current = next;
    onChange(next);
  };
  const toggle = (id: string): void => {
    const current = selectedRef.current;
    commitSelection(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const move = (id: string, direction: -1 | 1): void => {
    const current = selectedRef.current;
    const index = current.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    commitSelection(next);
  };
  const toggleProvider = (id: string): void => setExpandedProviders((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleAccount = (id: string): void => setExpandedAccounts((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  return <div className="bridge-model-picker">
    <button type="button" className="bridge-model-picker-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span>{selected.length ? `${selected.length}개 모델을 Bridge에 표시` : "Bridge 모델 추가"}</span><ChevronDown size={15} /></button>
    {open && <div className="bridge-model-picker-menu">
      <label className="bridge-model-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="provider 또는 모델 검색" autoFocus /></label>
      {externalProviders.map((provider) => {
        const providerChoices = choices.filter((choice) => choice.provider === provider.label && matches(choice));
        if (normalizedQuery && !providerChoices.length) return null;
        const providerOpen = expandedProviders.has(provider.id) || Boolean(normalizedQuery);
        const accounts = provider.accounts.length ? provider.accounts : [undefined];
        return <div className="bridge-model-provider" key={provider.id}>
          <button type="button" className="bridge-model-provider-head" onClick={() => toggleProvider(provider.id)}>{providerOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span><strong>{provider.label}</strong><small>{providerChoices.length}개 모델</small></span></button>
          {providerOpen && accounts.map((account) => {
            const accountLabel = account?.email ?? account?.label ?? provider.label;
            const accountChoices = choices.filter((choice) => choice.provider === provider.label && choice.account === accountLabel && matches(choice));
            if (!accountChoices.length) return null;
            const key = `${provider.id}:${account?.id ?? "default"}`;
            const accountOpen = expandedAccounts.has(key) || Boolean(normalizedQuery);
            return <div className="bridge-model-account" key={key}>
              <button type="button" className="bridge-model-account-head" onClick={() => toggleAccount(key)}>{accountOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span><strong>{accountLabel}</strong><small>{accountChoices.length}개 모델</small></span></button>
              {accountOpen && accountChoices.map((choice) => <button type="button" className={`bridge-model-option ${selected.includes(choice.id) ? "selected" : ""}`} key={choice.id} onClick={() => toggle(choice.id)}><span><strong>{choice.label}</strong><small>{selected.includes(choice.id) ? "Bridge에 표시 중" : "클릭해서 Bridge에 추가"}</small></span>{selected.includes(choice.id) && <Check size={15} />}</button>)}
            </div>;
          })}
        </div>;
      })}
      {!choices.length && <p>연결된 외부 provider 모델이 없습니다.</p>}
    </div>}
    <div className="stock-model-picker-selected">{selected.length ? selected.map((id, index) => {
      const choice = byId.get(id);
      return <div key={id}><span><b>{index + 1}</b><strong>{choice?.label ?? id}</strong><small>{choice ? `${choice.provider} · ${choice.account}` : "사용할 수 없는 모델"}</small></span><button type="button" onClick={() => move(id, -1)} disabled={index === 0} aria-label={`${choice?.label ?? id} 위로 이동`}>↑</button><button type="button" onClick={() => move(id, 1)} disabled={index === selected.length - 1} aria-label={`${choice?.label ?? id} 아래로 이동`}>↓</button><button type="button" onClick={() => commitSelection(selectedRef.current.filter((item) => item !== id))} aria-label={`${choice?.label ?? id} 제거`}><X size={14} /></button></div>;
    }) : <p>외부 모델을 추가하지 않으면 순정 Codex에는 GPT 모델만 표시됩니다.</p>}</div>
  </div>;
}

function RemoteControlSection(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [action, setAction] = useState<"enable" | "disable" | "apply" | "regenerate" | "revoke" | "tailscale-up" | null>(null);
  const [selectedMode, setSelectedMode] = useState<RemoteControlMode>("funnel");
  const [error, setError] = useState<string | null>(null);
  const scopeCodex = useCodexSettings();
  const allowedThreadIds = scopeCodex.settings?.remoteAllowedThreadIds ?? [];
  const setAllowedThreadIds = (ids: string[]): void => {
    if (!scopeCodex.settings) return;
    scopeCodex.save({ ...scopeCodex.settings, remoteAllowedThreadIds: ids });
  };

  const reload = async (): Promise<void> => {
    setState("loading");
    setError(null);
    try {
      const next = await window.devilCodex.remoteStatus();
      setStatus(next);
      setSelectedMode("funnel");
      setState("ready");
    } catch (cause) {
      setState("error");
      setError(toErrorMessage(cause, "원격 제어 상태를 불러오지 못했습니다."));
    }
  };

  useEffect(() => { void reload(); }, []);
  useEffect(() => window.devilCodex.onRemoteStatus((next) => {
    setStatus(next);
    setSelectedMode("funnel");
    setError(null);
    setState("ready");
  }), []);

  const runAction = async (kind: "enable" | "disable" | "apply" | "regenerate" | "revoke", task: () => Promise<RemoteControlStatus>): Promise<void> => {
    setAction(kind);
    setError(null);
    try {
      const next = await task();
      setStatus(next);
      setSelectedMode("funnel");
      setState("ready");
    } catch (cause) {
      setError(toErrorMessage(cause, "원격 제어 작업에 실패했습니다."));
      setState("error");
    } finally {
      setAction(null);
    }
  };

  // Tailscale can be "installed but stopped/logged out" - this is the common
  // case right after a reboot or a manual `tailscale down`. Rather than
  // sending the user to a terminal, run `tailscale up` for them. If the
  // account needs interactive browser auth (fresh install / expired key),
  // the CLI hands back a login URL instead of connecting - open that in the
  // system browser so the user can finish it the same way `tailscale up`
  // would ask them to from a terminal.
  const tailscaleOffline = Boolean(status) && (!status!.tailscale.installed || !status!.tailscale.loggedIn);
  const runTailscaleUp = async (): Promise<void> => {
    setAction("tailscale-up");
    setError(null);
    try {
      const result = await window.devilCodex.remoteTailscaleUp();
      setStatus(result.status);
      setSelectedMode("funnel");
      if (result.authUrl) {
        setError(`Tailscale 로그인이 필요합니다. 브라우저에서 인증을 완료한 뒤 다시 시도하세요: ${result.authUrl}`);
        void window.devilCodex.openExternalUrl({ url: result.authUrl });
      }
      setState("ready");
    } catch (cause) {
      setError(toErrorMessage(cause, "Tailscale를 켜지 못했습니다."));
      setState("error");
    } finally {
      setAction(null);
    }
  };

  const tailscaleMessage = status?.tailscale.error
    ?? (!status?.tailscale.installed ? "Tailscale이 설치되어 있지 않습니다." : !status?.tailscale.loggedIn ? "Tailscale 로그인 또는 연결이 필요합니다." : null);
  const remoteErrorMessage = error ?? status?.error ?? tailscaleMessage;
  const isFunnelActivationError = /Funnel is not enabled|login\.tailscale\.com\/f\/funnel/i.test(remoteErrorMessage ?? "");
  const funnelActivationUrl = remoteErrorMessage?.match(/https:\/\/login\.tailscale\.com\/f\/funnel[^\s)"]*/i)?.[0] ?? TAILSCALE_ADMIN_FUNNEL_URL;
  const needsHttpsCertificateHelp = !isFunnelActivationError && /does not support getting TLS certs|tls cert|certificate|HTTPS Certificates|인증서/i.test(remoteErrorMessage ?? "");
  const disabled = state === "loading" || action !== null;
  const hasPendingModeChange = Boolean(status?.enabled && selectedMode !== status.mode);
  const handleModeChange = (_value: string): void => setSelectedMode("funnel");

  return <>
    <div className="setting-card">
      <Row title="원격 제어 사용" detail="켜면 현재 PC를 다른 기기에서 열 수 있는 임시 접속 주소와 인증 토큰을 준비합니다.">
        <Toggle value={Boolean(status?.enabled)} onChange={(value) => {
          if (value) void runAction("enable", () => window.devilCodex.remoteEnable({ mode: "funnel" }));
          else void runAction("disable", () => window.devilCodex.remoteDisable());
        }} disabled={disabled} />
      </Row>
      <Row title="접속 모드" detail="Funnel 공개 URL을 기본으로 사용하고, 같은 Tailnet에 붙은 휴대폰을 위한 직접 접속 주소도 함께 준비합니다.">
        <Select value={selectedMode} options={["funnel"]} onChange={handleModeChange} disabled={disabled} />
      </Row>
      {hasPendingModeChange && <Row title="모드 변경 대기" detail="현재 실행 모드와 선택한 모드가 다릅니다. 변경 적용을 누르면 서버와 QR을 새 모드로 다시 준비합니다.">
        <button className="secondary" onClick={() => void runAction("apply", () => window.devilCodex.remoteEnable({ mode: "funnel" }))} disabled={disabled}>변경 적용</button>
      </Row>}
      <Row title="현재 상태" detail="main 프로세스가 반환한 원격 제어 상태를 그대로 보여줍니다.">
        <div style={{ display: "grid", gap: 6, justifyItems: "end", textAlign: "right", minWidth: 220 }}>
          <strong>{statusLabel(status, state)}</strong>
          <span style={{ color: "#9a9a9a", fontSize: 12 }}>{status?.enabled ? `모드: ${status.mode}` : "비활성화됨"}</span>
          {status?.tokenPreview && <code style={inlineCodeStyle}>{status.tokenPreview}</code>}
        </div>
      </Row>
      <Row title="빠른 작업" detail="상태 재확인, 토큰 재발급, Tailscale 설치 페이지와 Admin Console HTTPS 설정 열기를 여기서 처리합니다.">
        <div style={actionGroupStyle}>
          <button className="secondary" onClick={() => void reload()} disabled={disabled}>재확인</button>
          <button className="secondary" onClick={() => void runAction("regenerate", () => window.devilCodex.remoteRegenerateToken())} disabled={disabled || !status?.enabled}>토큰 재발급</button>
          {tailscaleOffline && status?.tailscale.installed && <button className="secondary" onClick={() => void runTailscaleUp()} disabled={disabled}>{action === "tailscale-up" ? "Tailscale 켜는 중…" : "Tailscale 켜기"}</button>}
          <button className="secondary" onClick={() => void window.devilCodex.openExternalUrl({ url: REMOTE_INSTALL_URL })}>Tailscale 설치</button>
          <button className="secondary" onClick={() => void window.devilCodex.openExternalUrl({ url: TAILSCALE_ADMIN_DNS_URL })}>HTTPS 설정</button>
        </div>
      </Row>
    </div>

    {selectedMode === "funnel" && <p className="section-help" style={{ color: "#d6a86a", marginTop: 12 }}>Funnel은 공개 URL을 만듭니다. 휴대폰에서 공개 URL을 찾지 못하면 Tailscale 앱을 켠 뒤 아래의 직접 접속 주소를 사용하세요.</p>}
    {remoteErrorMessage && <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <p className="section-help" style={{ color: "#ef9a94", marginTop: 0 }}>{remoteErrorMessage}</p>
      {isFunnelActivationError && <>
        <p className="section-help" style={{ color: "#ef9a94", marginTop: 0 }}>Funnel이 tailnet에서 아직 활성화되지 않아 공개 URL/QR을 만들지 못했습니다. 아래 버튼으로 Tailscale Funnel을 활성화한 뒤 다시 변경 적용을 누르세요.</p>
        <p className="section-help" style={{ color: "#ef9a94", marginTop: 0 }}>이 전환이 실패하면 서버 재시작이 완료되지 않으므로 현재 URL/QR이 tailnet 주소로 남아 있어도 정상입니다.</p>
        <div style={actionGroupStyle}>
          <button className="secondary" onClick={() => void window.devilCodex.openExternalUrl({ url: funnelActivationUrl })}>Funnel 활성화</button>
        </div>
      </>}
      {needsHttpsCertificateHelp && <p className="section-help" style={{ color: "#ef9a94", marginTop: 0 }}>이 오류는 Tailscale 설치 문제라기보다 Tailscale Admin Console에서 HTTPS Certificates 또는 MagicDNS가 꺼져 있을 때 자주 나타납니다. Admin Console의 DNS/HTTPS 설정에서 해당 기능이 활성화되어 있는지 확인하세요.</p>}
    </div>}

    <div className="remote-access-grid">
      <RemoteAccessCard
        title="공개 Funnel"
        detail="Tailscale Funnel이 공개 HTTPS 주소로 PC의 원격 웹을 프록시합니다."
        icon={<Globe2 size={17} />}
        url={status?.url}
        qrDataUrl={status?.qrDataUrl}
        disabled={!status?.enabled}
      />
      <RemoteAccessCard
        title="Tailscale 직접"
        detail="휴대폰에도 Tailscale이 켜져 있으면 이 주소가 DNS/Funnel 문제를 우회합니다."
        icon={<Wifi size={17} />}
        url={status?.tailnetUrl}
        qrDataUrl={status?.tailnetQrDataUrl}
        disabled={!status?.enabled}
      />
    </div>

    <div className="setting-card" style={{ marginTop: 16 }}>
      <Row title="Tailscale 상태" detail="설치 여부, 로그인 상태, 호스트 정보를 확인합니다.">
        <div style={{ display: "grid", gap: 4, justifyItems: "end", textAlign: "right", minWidth: 240 }}>
          <strong>{status?.tailscale.installed ? status.tailscale.loggedIn ? "연결됨" : "설치됨" : "미설치"}</strong>
          {status?.tailscale.hostname && <span style={{ color: "#9a9a9a", fontSize: 12 }}>{status.tailscale.hostname}</span>}
          {status?.tailscale.tailnet && <span style={{ color: "#9a9a9a", fontSize: 12 }}>{status.tailscale.tailnet}</span>}
          {status?.tailscale.serviceUrl && <code style={inlineCodeStyle}>{status.tailscale.serviceUrl}</code>}
        </div>
      </Row>
    </div>

    <div className="setting-card" style={{ marginTop: 16 }}>
      <Row title="승인된 기기" detail="토큰을 통과한 뒤 로컬에서 승인된 기기 목록입니다. 해지하면 다시 승인 절차를 거쳐야 합니다.">
        <div style={{ ...valueBlockStyle, minWidth: 280, alignItems: "stretch" }}>
          {status?.devices.length ? status.devices.map((device) => <DeviceRow key={device.id} device={device} disabled={disabled} onRevoke={() => void runAction("revoke", () => window.devilCodex.remoteRevokeDevice({ deviceId: device.id }))} />) : <span style={{ color: "#9a9a9a", fontSize: 12 }}>승인된 기기가 없습니다.</span>}
        </div>
      </Row>
      <Row title="현재 클라이언트" detail="지금 접속 중이거나 최근에 붙어 있던 클라이언트 목록입니다.">
        <div style={{ ...valueBlockStyle, minWidth: 280, alignItems: "stretch" }}>
          {status?.clients.length ? status.clients.map((client) => <ClientRow key={client.id} client={client} />) : <span style={{ color: "#9a9a9a", fontSize: 12 }}>현재 접속 중인 클라이언트가 없습니다.</span>}
        </div>
      </Row>
    </div>

    <div className="setting-card" style={{ marginTop: 16 }}>
      <Row title="허용 스레드" detail="특정 프로젝트의 특정 스레드만 골라 원격 접속을 그 스레드로 제한합니다. 승인된 기기라도 여기서 허용하지 않은 스레드는 목록/대화/전송 전부 차단됩니다.">
        <span style={{ color: "#9a9a9a", fontSize: 12 }}>{allowedThreadIds.length ? `${allowedThreadIds.length}개 스레드 허용됨` : "원격 웹에 표시할 스레드 없음"}</span>
      </Row>
      <AllowedThreadsPicker allowed={allowedThreadIds} onChange={setAllowedThreadIds} />
    </div>
  </>;
}

function RemoteAccessCard({ title, detail, icon, url, qrDataUrl, disabled }: { title: string; detail: string; icon: React.ReactNode; url?: string; qrDataUrl?: string; disabled?: boolean }): React.JSX.Element {
  return <div className="remote-access-card">
    <div className="remote-access-head">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
    <div className="remote-access-body">
      {qrDataUrl ? <img src={qrDataUrl} alt={`${title} QR 코드`} /> : <div className="remote-qr-empty"><QrCode size={24} /><span>QR 준비 안 됨</span></div>}
      <div className="remote-access-url">
        <code>{url ?? "원격 제어를 켜면 주소가 표시됩니다."}</code>
        <button className="secondary" onClick={() => url && void window.devilCodex.clipboardWriteText({ text: url })} disabled={disabled || !url}><Copy size={14} />복사</button>
      </div>
    </div>
  </div>;
}

const ALLOWED_THREADS_RUNTIMES = [["codex", "코덱스"], ["claude-code", "클로드 코드"]] as const;

function AllowedThreadsPicker({ allowed, onChange }: { allowed: string[]; onChange: (ids: string[]) => void }): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [allThreads, setAllThreads] = useState<ThreadSummary[]>([]);
  const [runtimeTab, setRuntimeTab] = useState<AgentRuntimeId>("codex");
  const [selectedCwd, setSelectedCwd] = useState("");

  const reload = async (): Promise<void> => {
    setLoading(true);
    try {
      const [codexThreads, claudeThreads] = await Promise.all([
        window.devilCodex.listProjects({ archived: false, runtime: "codex" }).catch(() => [] as ThreadSummary[]),
        window.devilCodex.listProjects({ archived: false, runtime: "claude-code" }).catch(() => [] as ThreadSummary[]),
      ]);
      // Kept as two explicitly-tagged runtime lists (not merged/sorted
      // together) so the runtime tabs below can filter without re-deriving
      // which runtime each thread belongs to from a mixed array.
      setAllThreads([
        ...codexThreads.map((thread) => ({ ...thread, runtime: "codex" as const })),
        ...claudeThreads.map((thread) => ({ ...thread, runtime: "claude-code" as const })),
      ]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const byId = useMemo(() => new Map(allThreads.map((thread) => [thread.id, thread])), [allThreads]);
  const byCwd = useMemo(() => {
    const map = new Map<string, ThreadSummary[]>();
    for (const thread of allThreads) {
      if ((thread.runtime ?? "codex") !== runtimeTab) continue;
      map.set(thread.cwd, [...(map.get(thread.cwd) ?? []), thread]);
    }
    return map;
  }, [allThreads, runtimeTab]);
  const projectCwds = useMemo(() => [...byCwd.keys()].sort(), [byCwd]);
  // The select's own project list just changed with the tab - keep the
  // current pick only if it still exists under this runtime, else fall back
  // to the first project so the list below never silently shows "no cwd".
  useEffect(() => {
    if (selectedCwd && projectCwds.includes(selectedCwd)) return;
    setSelectedCwd(projectCwds[0] ?? "");
  }, [projectCwds, selectedCwd]);
  const threadsForSelected = selectedCwd ? byCwd.get(selectedCwd) ?? [] : [];

  const toggle = (id: string): void => onChange(allowed.includes(id) ? allowed.filter((item) => item !== id) : [...allowed, id]);

  return <div className="allowed-threads">
    <p className="section-help" style={{ margin: 0 }}>원격 웹은 여기서 허용한 스레드만 표시합니다. 비어 있으면 휴대폰에는 스레드 목록 대신 허용 스레드를 추가하라는 안내만 표시됩니다.</p>
    <div className="allowed-threads-tabs" role="tablist" aria-label="런타임 선택">
      {ALLOWED_THREADS_RUNTIMES.map(([id, label]) => <button key={id} type="button" className={runtimeTab === id ? "active" : ""} onClick={() => setRuntimeTab(id)}>{label}</button>)}
    </div>
    <div className="thread-picker-row">
      <select value={selectedCwd} onChange={(event) => setSelectedCwd(event.target.value)}>
        {!projectCwds.length && <option value="">프로젝트 없음</option>}
        {projectCwds.map((cwd) => <option key={cwd} value={cwd}>{cwd}</option>)}
      </select>
      <button type="button" className="secondary" onClick={() => void reload()} disabled={loading}>{loading ? "불러오는 중…" : "새로고침"}</button>
    </div>
    <div className="thread-list">
      {threadsForSelected.length ? threadsForSelected.map((thread) => {
        const checked = allowed.includes(thread.id);
        return (
        <label key={thread.id} className={`allowed-thread-option ${checked ? "checked" : ""}`}>
          <span className="allowed-thread-check" aria-hidden="true">{checked ? <Check size={14} /> : null}</span>
          <span className="allowed-thread-copy">
            <strong>{thread.title || thread.id}</strong>
            <small>{thread.model}{thread.runtime ? ` · ${thread.runtime}` : ""}</small>
          </span>
          <input type="checkbox" checked={checked} onChange={() => toggle(thread.id)} />
        </label>
        );
      }) : <span className="thread-list-empty">{selectedCwd ? "이 프로젝트에 스레드가 없습니다." : "먼저 프로젝트를 선택하세요."}</span>}
    </div>
    <div className="allowed-threads-summary">
      <strong>현재 허용된 스레드 ({allowed.length})</strong>
      <div className="thread-list" style={{ marginTop: 8 }}>
        {allowed.length ? allowed.map((id) => {
          const thread = byId.get(id);
          return <div key={id} style={listItemStyle}>
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <strong style={listStrongStyle}>{thread?.title || id}</strong>
              <small style={listSmallStyle}>{thread ? `${thread.cwd} · ${thread.runtime ?? "codex"}` : "알 수 없는 프로젝트"}</small>
            </span>
            <button type="button" className="secondary" onClick={() => toggle(id)}>제거</button>
          </div>;
        }) : <span className="thread-list-empty">아직 허용된 스레드가 없습니다. 원격 웹에는 안내 화면만 표시됩니다.</span>}
      </div>
    </div>
  </div>;
}

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }): React.JSX.Element { return <div className="setting-row"><div><strong>{title}</strong>{detail && <p>{detail}</p>}</div><div>{children}</div></div>; }
function Toggle({ value, onChange, disabled = false }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }): React.JSX.Element { return <button className={`switch ${value ? "on" : ""}`} onClick={() => { if (!disabled) onChange(!value); }} aria-pressed={value} disabled={disabled}><i /></button>; }
function Select({ value, options, onChange, disabled = false }: { value: string; options: string[]; onChange?: (value: string) => void; disabled?: boolean }): React.JSX.Element { return <select value={value} onChange={(e) => onChange?.(e.target.value)} disabled={disabled}>{options.map((option) => <option key={option}>{option}</option>)}</select>; }
function NumberInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (value: number) => void }): React.JSX.Element { return <input type="number" min={min} max={max} step={1} value={value} onChange={(event) => onChange(Math.max(min, Math.min(max, Math.floor(Number(event.target.value) || 0))))} />; }
function ShellSelect({ value, profiles, onChange }: { value: TerminalShellId; profiles: TerminalShellProfile[]; onChange: (value: TerminalShellId) => void }): React.JSX.Element {
  const list = profiles.length ? profiles : [{ id: "auto" as const, label: "자동", available: true, detail: "shell 목록을 불러오는 중" }];
  return <select value={value} onChange={(event) => onChange(event.target.value as TerminalShellId)}>
    {list.map((profile) => <option key={profile.id} value={profile.id} disabled={!profile.available}>{profile.label}{profile.available ? "" : ` - ${profile.detail ?? "사용 불가"}`}</option>)}
  </select>;
}

function DeviceRow({ device, disabled, onRevoke }: { device: RemoteDevice; disabled: boolean; onRevoke: () => void }): React.JSX.Element {
  return <div style={listItemStyle}>
    <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <strong style={listStrongStyle}>{device.name || device.id}</strong>
      <small style={listSmallStyle}>{[device.hostname, device.os, formatDateTime(device.lastSeenAt ?? device.createdAt)].filter(Boolean).join(" · ") || device.id}</small>
    </span>
    <button className="secondary" onClick={onRevoke} disabled={disabled}>해지</button>
  </div>;
}

function ClientRow({ client }: { client: RemoteClient }): React.JSX.Element {
  return <div style={listItemStyle}>
    <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <strong style={listStrongStyle}>{client.label || client.id}</strong>
      <small style={listSmallStyle}>{[client.ip, formatDateTime(client.lastSeenAt ?? client.createdAt)].filter(Boolean).join(" · ") || client.id}</small>
      {client.userAgent && <small style={listSmallStyle}>{client.userAgent}</small>}
    </span>
  </div>;
}

type UsageTab = "quota" | "devil";
type ModelUsageRow = {
  key: string;
  provider: ProviderId | "unknown";
  providerLabel: string;
  model: string;
  requests: number;
  completed: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  freshTokens: number;
  durationMs: number;
  estimatedCost: number;
  pricedTokens: number;
  cacheMisses: number;
  latestCacheMissReason?: string;
  latestCacheMissedInputTokens?: number;
};

function ProviderUsagePage({ report, requestLog, providerSettings, state, onRefresh }: { report: { entries: ProviderUsageEntry[] } | null; requestLog: ProviderRequestLogEntry[]; providerSettings: ProviderSettings | null; state: string; onRefresh: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<UsageTab>("quota");
  const entries = report?.entries ?? [];
  const devil = useMemo(() => summarizeDevilUsage(requestLog, providerSettings), [requestLog, providerSettings]);
  return <><div className="usage-head"><span><h1>사용량 및 청구</h1><p>공식 Provider 한도와 Devil Codex에서 프록시한 모델별 토큰 사용량을 함께 확인합니다. 금액은 Provider 공개 단가 기준의 추정치입니다.</p></span><button className="secondary" onClick={onRefresh} disabled={state === "loading"}>{state === "loading" ? "새로고침 중…" : "새로고침"}</button></div>
    <div className="usage-tabs" role="tablist" aria-label="사용량 보기">
      <button type="button" className={tab === "devil" ? "active" : ""} onClick={() => setTab("devil")}>Devil 사용량</button>
      <button type="button" className={tab === "quota" ? "active" : ""} onClick={() => setTab("quota")}>Provider 한도</button>
    </div>
    {tab === "devil" ? <DevilUsageTab summary={devil} state={state} /> : <section><h2>Provider 한도</h2>{state === "error" && <p className="provider-error">사용량을 불러오지 못했습니다.</p>}{!entries.length && state !== "loading"
      ? <div className="setting-card usage-empty"><strong>로그인된 Provider가 없습니다.</strong><p>연결 설정에서 Codex, Claude Code, GitHub Copilot 중 하나에 로그인하면 여기에 표시됩니다.</p></div>
      : <div className="usage-provider-grid">{entries.map((entry) => <ProviderUsageCard key={`${entry.provider}:${entry.accountId ?? entry.accountLabel ?? "default"}`} entry={entry} />)}</div>}</section>}</>;
}

function DevilUsageTab({ summary, state }: { summary: ReturnType<typeof summarizeDevilUsage>; state: string }): React.JSX.Element {
  const hasUsage = summary.rows.length > 0;
  return <section><h2>Devil Codex 모델별 사용량</h2>
    <div className="usage-summary-grid">
      <UsageMetric title="실사용 토큰" value={formatTokenCount(summary.freshTokens)} detail="신규 입력 + 캐시 생성 + 출력 (CLI /cost 비교 기준)" />
      <UsageMetric title="전체 처리량" value={formatTokenCount(summary.totalTokens)} detail={summary.cacheReadTokens > 0 ? `캐시 재사용 ${formatTokenCount(summary.cacheReadTokens)} 포함` : `${summary.completed}개 완료 요청`} />
      <UsageMetric title="예상 비용" value={summary.estimatedCost > 0 ? formatUsd(summary.estimatedCost) : "-"} detail={summary.pricedTokens > 0 ? "공개 단가 기준" : "단가 매칭 없음"} />
      {summary.cacheMisses > 0 && <UsageMetric title="캐시 미스" value={`${summary.cacheMisses}회`} detail="Provider가 캐시를 새로 만든 요청" />}
      <UsageMetric title="요청 수" value={`${summary.requests}회`} detail={summary.failed ? `${summary.failed}회 실패 포함` : "실패 없음"} />
    </div>
    {!hasUsage
      ? <div className="setting-card usage-empty"><strong>{state === "loading" ? "사용량을 불러오는 중입니다." : "아직 집계할 Devil 사용량이 없습니다."}</strong><p>외부 Provider 모델로 새 대화를 보내면 완료된 요청부터 토큰과 예상 비용이 쌓입니다.</p></div>
      : <div className="usage-model-list">{summary.rows.map((row) => <ModelUsageCard key={row.key} row={row} />)}</div>}
    <p className="usage-footnote">이 화면은 Devil Codex 로컬 프록시 요청 로그를 기준으로 합니다. 이전 버전에서 생성된 로그는 토큰 정보가 없을 수 있고, 가격은 세금/할인/캐시 정책에 따라 실제 청구액과 다를 수 있습니다.</p>
  </section>;
}

function UsageMetric({ title, value, detail }: { title: string; value: string; detail: string }): React.JSX.Element {
  return <div className="setting-card usage-metric"><small>{title}</small><strong>{value}</strong><span>{detail}</span></div>;
}

function ModelUsageCard({ row }: { row: ModelUsageRow }): React.JSX.Element {
  const knownCost = row.estimatedCost > 0 && row.pricedTokens > 0;
  return <div className="setting-card usage-model-card">
    <header><span><strong>{row.model}</strong><small>{row.providerLabel}</small></span><b>{knownCost ? formatUsd(row.estimatedCost) : "단가 미정"}</b></header>
    <div className="usage-model-stats">
      <span><small>실사용</small><strong>{formatTokenCount(row.freshTokens)}</strong></span>
      <span><small>입력</small><strong>{formatTokenCount(row.inputTokens)}</strong></span>
      <span><small>출력</small><strong>{formatTokenCount(row.outputTokens)}</strong></span>
      <span><small>요청</small><strong>{row.requests}회</strong></span>
    </div>
    <footer>
      {row.cacheReadTokens > 0 && <small>캐시 재사용 {formatTokenCount(row.cacheReadTokens)}</small>}
      {row.cacheCreationTokens > 0 && <small>캐시 생성 {formatTokenCount(row.cacheCreationTokens)}</small>}
      {row.cacheMisses > 0 && <small className="usage-cache-miss">캐시 미스 {row.cacheMisses}회{row.latestCacheMissReason ? ` · ${row.latestCacheMissReason}` : ""}{row.latestCacheMissedInputTokens ? ` · ${formatTokenCount(row.latestCacheMissedInputTokens)}` : ""}</small>}
      {row.reasoningOutputTokens > 0 && <small>추론 출력 {formatTokenCount(row.reasoningOutputTokens)}</small>}
      <small>평균 {formatDuration(row.completed ? row.durationMs / row.completed : 0)}</small>
      {row.failed > 0 && <small className="usage-failed">{row.failed}회 실패</small>}
    </footer>
  </div>;
}

function ProviderUsageCard({ entry }: { entry: ProviderUsageEntry }): React.JSX.Element {
  const account = entry.accountEmail || entry.accountLabel;
  return <div className="setting-card usage-provider-card"><header><span><strong>{entry.label}</strong><small>{[account, entry.connected ? "로그인됨" : "로그인 안 됨"].filter(Boolean).join(" · ")}</small></span><small>{formatUpdated(entry.updatedAt)}</small></header>
    {entry.windows.length ? <div>{entry.windows.map((window) => <UsageWindow key={window.label} title={window.label} used={window.usedPercent} remaining={window.remainingPercent} resetsAt={window.resetsAt} />)}</div> : <p className={entry.error ? "usage-error" : "usage-unavailable"}>{entry.error ? `오류: ${entry.error}` : entry.unavailable ?? "표시할 사용량 데이터가 없습니다."}</p>}</div>;
}

function UsageWindow({ title, used, remaining, resetsAt }: { title: string; used: number; remaining: number; resetsAt?: string | number | null }): React.JSX.Element {
  const level = remaining < 20 ? "danger" : remaining < 50 ? "warning" : "healthy";
  return <div className={`usage-row ${level}`}><span><strong>{title}</strong><small>{formatReset(resetsAt)}</small></span><progress value={used} max="100" /><b>{Math.round(used)}% 사용</b></div>;
}

function formatUpdated(value: number): string { return new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }); }
function formatReset(value: string | number | null | undefined): string {
  if (value == null) return "초기화 시간 알 수 없음";
  const normalized = typeof value === "number" && value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  const day = date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: true }).replace(/^(오전|오후)\s+/, "$1\u00a0");
  return `${day} ${time} 초기화`;
}

function approvalLabel(value: string): string { return value === "never" ? "사용 안 함" : value === "untrusted" ? "항상" : "요청 시"; }
function approvalValue(label: string): string { return label === "사용 안 함" ? "never" : label === "항상" ? "untrusted" : "on-request"; }
function sandboxLabel(value: string): string { return value === "read-only" ? "읽기 전용" : value === "danger-full-access" ? "전체 접근" : "작업 공간 쓰기"; }
function sandboxValue(label: string): string { return label === "읽기 전용" ? "read-only" : label === "전체 접근" ? "danger-full-access" : "workspace-write"; }

function summarizeDevilUsage(entries: ProviderRequestLogEntry[], settings: ProviderSettings | null): { rows: ModelUsageRow[]; totalTokens: number; freshTokens: number; cacheReadTokens: number; cacheMisses: number; estimatedCost: number; pricedTokens: number; requests: number; completed: number; failed: number } {
  const labels = new Map<ProviderId, string>((settings?.providers ?? []).map((provider) => [provider.id, provider.label]));
  const rows = new Map<string, ModelUsageRow>();
  for (const entry of entries) {
    const key = `${entry.provider}:${entry.accountId ?? "default"}:${entry.model}`;
    const current = rows.get(key) ?? {
      key,
      provider: entry.provider,
      providerLabel: [entry.provider === "unknown" ? "알 수 없음" : labels.get(entry.provider) ?? providerFallbackLabel(entry.provider), entry.accountLabel].filter(Boolean).join(" · "),
      model: entry.model || "unknown",
      requests: 0,
      completed: 0,
      failed: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      freshTokens: 0,
      durationMs: 0,
      estimatedCost: 0,
      pricedTokens: 0,
      cacheMisses: 0,
    };
    current.requests += 1;
    if (entry.status === "failed") current.failed += 1;
    if (entry.status === "completed") current.completed += 1;
    current.durationMs += entry.durationMs ?? 0;
    if (entry.usage) {
      addUsage(current, entry.usage);
      const cost = estimateProviderUsageCost(entry.provider, entry.model, entry.usage);
      current.estimatedCost += cost.cost;
      current.pricedTokens += cost.pricedTokens;
    }
    rows.set(key, current);
  }
  const sorted = [...rows.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
  return {
    rows: sorted,
    totalTokens: sorted.reduce((sum, row) => sum + row.totalTokens, 0),
    freshTokens: sorted.reduce((sum, row) => sum + row.freshTokens, 0),
    cacheReadTokens: sorted.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    cacheMisses: sorted.reduce((sum, row) => sum + row.cacheMisses, 0),
    estimatedCost: sorted.reduce((sum, row) => sum + row.estimatedCost, 0),
    pricedTokens: sorted.reduce((sum, row) => sum + row.pricedTokens, 0),
    requests: sorted.reduce((sum, row) => sum + row.requests, 0),
    completed: sorted.reduce((sum, row) => sum + row.completed, 0),
    failed: sorted.reduce((sum, row) => sum + row.failed, 0),
  };
}

function addUsage(row: ModelUsageRow, usage: ProviderTokenUsage): void {
  const cached = usage.cachedInputTokens ?? 0;
  const inputExcludesCache = cached > 0 && (usage.totalTokens ?? 0) >= usage.inputTokens + cached + usage.outputTokens;
  const inputIncludesCache = cached > 0 && !inputExcludesCache && usage.inputTokens >= cached;
  const uncachedInput = inputIncludesCache ? Math.max(0, usage.inputTokens - cached) : usage.inputTokens;
  // Entries logged before the read/write split treat all cached tokens as
  // creation-free reads, matching the old flat-cache display.
  const cacheRead = usage.cacheReadInputTokens
    ?? (usage.cacheCreationInputTokens != null ? Math.max(0, cached - usage.cacheCreationInputTokens) : cached);
  const cacheCreation = usage.cacheCreationInputTokens ?? Math.max(0, cached - cacheRead);
  row.inputTokens += uncachedInput;
  row.cachedInputTokens += cached;
  row.cacheReadTokens += cacheRead;
  row.cacheCreationTokens += cacheCreation;
  row.outputTokens += usage.outputTokens;
  row.reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
  row.totalTokens += Math.max(usage.totalTokens ?? 0, uncachedInput + cached + usage.outputTokens);
  // "Fresh" tokens exclude cache reads: what the model actually processed for
  // the first time. This is the number comparable to the stock CLI's /cost.
  row.freshTokens += uncachedInput + cacheCreation + usage.outputTokens;
  if (usage.cacheMissReason) {
    row.cacheMisses += 1;
    row.latestCacheMissReason = usage.cacheMissReason;
    row.latestCacheMissedInputTokens = usage.cacheMissedInputTokens;
  }
}

function providerFallbackLabel(provider: ProviderId): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "antigravity") return "Antigravity";
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google Gemini";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "openrouter-free") return "OpenRouter Free";
  return "Codex";
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return `${Math.round(value)}`;
}

function formatUsd(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function statusLabel(status: RemoteControlStatus | null, state: "loading" | "ready" | "error"): string {
  if (state === "loading") return "불러오는 중…";
  if (!status) return "상태 없음";
  if (status.enabled) return status.url ? "실행 중" : "준비 중";
  return "꺼짐";
}

function toErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cleanRemoteErrorMessage(cause.message) || fallback;
  if (typeof cause === "string" && cause) return cleanRemoteErrorMessage(cause) || fallback;
  return fallback;
}

function cleanRemoteErrorMessage(value: string): string {
  return value
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

function formatDateTime(value?: number): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const actionGroupStyle: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" };
const valueBlockStyle: React.CSSProperties = { display: "grid", gap: 8, justifyItems: "end", textAlign: "right" };
const inlineCodeStyle: React.CSSProperties = { maxWidth: 320, overflowWrap: "anywhere", color: "#d7d7d7", fontSize: 12, whiteSpace: "pre-wrap" };
const listItemStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center", width: "100%", border: "1px solid #373737", borderRadius: 8, background: "#2b2b2b", padding: "9px 10px" };
const listStrongStyle: React.CSSProperties = { overflowWrap: "anywhere", color: "#ededed", fontSize: 13, fontWeight: 600 };
const listSmallStyle: React.CSSProperties = { overflowWrap: "anywhere", color: "#9a9a9a", fontSize: 11, lineHeight: 1.35 };
