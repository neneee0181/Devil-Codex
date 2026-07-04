import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bell, CreditCard, Globe2, Search, TerminalSquare } from "lucide-react";
import { useCodexSettings } from "./hooks/useCodexSettings";
import { useProviderUsage } from "./hooks/useProviderUsage";
import { ProviderSettingsPanel } from "./components/ProviderSettingsPanel";
import { estimateProviderUsageCost } from "./providerPricing";
import type { AppInfo, ProviderId, ProviderRequestLogEntry, ProviderSettings, ProviderTokenUsage, ProviderUsageEntry, TerminalShellId, TerminalShellProfile } from "../shared/contracts";

type Config = {
  approval: string;
  sandbox: string;
  devilMcpEnabled: boolean;
  englishOutput: boolean;
  sidecarWebSearch: boolean;
  sidecarVision: boolean;
  sidecarWebSearchLimit: number;
  sidecarVisionLimit: number;
  notificationsEnabled: boolean;
  notifyOnTurnComplete: boolean;
  notifyOnApproval: boolean;
  notifyOnAsk: boolean;
  browserPersistentSession: boolean;
  terminalShell: TerminalShellId;
};

const defaults: Config = {
  approval: "요청 시", sandbox: "읽기 전용", devilMcpEnabled: false, englishOutput: false, sidecarWebSearch: false, sidecarVision: false, sidecarWebSearchLimit: 3, sidecarVisionLimit: 3, notificationsEnabled: true, notifyOnTurnComplete: true, notifyOnApproval: true, notifyOnAsk: true, browserPersistentSession: true, terminalShell: "auto",
};

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
    setConfig((current) => ({ ...current, approval: approvalLabel(settings.approvalPolicy), sandbox: sandboxLabel(settings.sandboxMode), devilMcpEnabled: settings.devilMcpEnabled, englishOutput: settings.englishOutput }));
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
    if (key === "englishOutput") codex.save({ ...settings, englishOutput: Boolean(value) });
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
  if (active === "알림") return <><h1>알림</h1><p className="page-lead">Devil Codex 창이 숨겨져 있거나 포커스가 없을 때만 시스템 알림을 표시합니다. 창을 보고 있는 동안에는 기존 화면 표시만 사용합니다.</p><section><h2>데스크톱 알림</h2><div className="setting-card"><Row title="백그라운드 알림" detail="끄면 아래 세부 항목과 무관하게 모든 시스템 알림을 보내지 않습니다."><Toggle value={config.notificationsEnabled} onChange={(v) => update("notificationsEnabled", v)} /></Row><Row title="작업 완료" detail="AI 작업이 완료되거나 실패했을 때 알려줍니다. 대기열에 다음 메시지가 있으면 마지막 작업이 끝날 때 알려줍니다."><Toggle value={config.notifyOnTurnComplete} onChange={(v) => update("notifyOnTurnComplete", v)} /></Row><Row title="승인 요청" detail="명령 실행 또는 파일 변경 승인이 필요할 때 알려줍니다."><Toggle value={config.notifyOnApproval} onChange={(v) => update("notifyOnApproval", v)} /></Row><Row title="질문 요청" detail="AI가 선택지 질문 모달을 띄워 사용자 입력을 기다릴 때 알려줍니다."><Toggle value={config.notifyOnAsk} onChange={(v) => update("notifyOnAsk", v)} /></Row></div></section></>;
  if (active === "구성") return <><h1>구성</h1><p className="page-lead">승인 정책 및 샌드박스 설정을 구성합니다. <span className={`settings-save-state ${backendState}`}>{backendState === "loading" ? "저장 중…" : backendState === "saved" ? "config.toml 저장됨" : "저장 실패"}</span></p><section><h2>앱 정보</h2><div className="setting-card app-version-card"><Row title="Devil Codex 현재 버전" detail="현재 실행 중인 데스크톱 앱 버전입니다. 업데이트 확인이나 설치 빌드 검증 때 기준으로 사용합니다."><span className="app-version-badge">{appInfo?.version ? `v${appInfo.version}` : "확인 중..."}</span></Row><Row title="플랫폼" detail="앱이 감지한 현재 실행 환경입니다."><span className="app-version-platform">{appInfo?.platform ?? "unknown"}</span></Row></div></section><section><h2>사용자 지정 config.toml 설정</h2><div className="setting-card"><Row title="승인 정책" detail="Codex가 승인을 요청할 시점을 선택합니다"><Select value={config.approval} options={["요청 시", "항상", "사용 안 함"]} onChange={(v) => update("approval", v)} /></Row><Row title="샌드박스 설정" detail="명령을 실행하는 동안 수행할 수 있는 작업 범위"><Select value={config.sandbox} options={["읽기 전용", "작업 공간 쓰기", "전체 접근"]} onChange={(v) => update("sandbox", v)} /></Row></div></section><section><h2>내장 터미널</h2><div className="setting-card"><Row title="기본 터미널 Shell" detail="새 터미널 탭을 열 때 사용할 shell입니다. 자동은 WSL, Git Bash, PowerShell 7, Windows PowerShell, cmd 순서로 선택합니다."><ShellSelect value={config.terminalShell} profiles={terminalShells} onChange={(v) => update("terminalShell", v)} /></Row></div></section><section><h2>내장 브라우저</h2><div className="setting-card"><Row title="브라우저 프로필 저장" detail="켜면 쿠키, 로그인, localStorage, IndexedDB를 앱 재시작 후에도 유지합니다. 끄면 임시 게스트 세션으로 실행됩니다. 변경 시 열린 브라우저 탭은 새 세션으로 다시 만들어집니다."><Toggle value={config.browserPersistentSession} onChange={(v) => update("browserPersistentSession", v)} /></Row></div></section><section><h2>Devil MCP 도구</h2><p className="section-help">브라우저와 컴퓨터 제어 도구는 켠 동안에만 Codex MCP 목록에 등록됩니다.</p><div className="setting-card"><Row title="브라우저/컴퓨터 제어 MCP" detail="필요할 때만 켜세요. 끄면 공유 config.toml에서 Devil MCP 블록을 제거하고 app-server를 다시 연결합니다."><Toggle value={config.devilMcpEnabled} onChange={(v) => update("devilMcpEnabled", v)} /></Row></div></section><section><h2>영어 응답 + 번역</h2><p className="section-help">켜면 한글로 질문해도 모델은 영어로만 답합니다(토큰 절약). 각 AI 답변 우측의 번역 토글을 켜면 무료 번역기로 한글로 볼 수 있습니다. 끄면 영어 강제 프롬프트만 제거됩니다.</p><div className="setting-card"><Row title="모델 영어 응답" detail="사용자 언어와 무관하게 모델 출력을 영어로 고정합니다. 코드/경로/명령어는 그대로 둡니다."><Toggle value={config.englishOutput} onChange={(v) => update("englishOutput", v)} /></Row></div></section><section><h2>외부 모델 Sidecar</h2><p className="section-help">외부 모델에서만 사용하는 보조 Codex 기능입니다. Codex 모델은 항상 순정 app-server 직통 경로를 유지합니다.</p><div className="setting-card"><Row title="웹 검색 sidecar" detail="외부 모델이 web_search 도구를 호출하면 Codex sidecar가 실제 웹 검색을 실행하고 결과를 모델에게 다시 전달합니다."><Toggle value={config.sidecarWebSearch} onChange={(v) => update("sidecarWebSearch", v)} /></Row><Row title="웹 검색 최대 요청 수" detail="모델이 한 요청에서 검색을 반복 호출할 때 폭주를 막습니다."><Select value={String(config.sidecarWebSearchLimit)} options={["1", "2", "3", "5"]} onChange={(v) => update("sidecarWebSearchLimit", Number(v))} /></Row><Row title="이미지 설명 sidecar" detail="이미지를 못 보는 외부 모델에 Codex vision 설명을 전달할 준비 상태로 둡니다. 현재는 진단 표시까지 지원합니다."><Toggle value={config.sidecarVision} onChange={(v) => update("sidecarVision", v)} /></Row><Row title="이미지 설명 최대 요청 수" detail="여러 이미지/반복 설명 호출의 비용과 지연을 제한합니다."><Select value={String(config.sidecarVisionLimit)} options={["1", "2", "3", "5"]} onChange={(v) => update("sidecarVisionLimit", Number(v))} /></Row></div></section></>;
  if (active === "사용량 및 청구") return <ProviderUsagePage report={usage.report} requestLog={usage.requestLog} providerSettings={providerSettings} state={usage.state} onRefresh={() => void usage.refresh()} />;
  if (active === "연결") return <ProviderSettingsPanel settings={providerSettings} state={providerState} onSelect={onProviderSelect} onSaveKey={onProviderSaveKey} onClearKey={onProviderClearKey} onRefreshModels={onProviderRefreshModels} />;
  return <><h1>{active}</h1><p>준비 중입니다.</p></>;
}

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }): React.JSX.Element { return <div className="setting-row"><div><strong>{title}</strong>{detail && <p>{detail}</p>}</div><div>{children}</div></div>; }
function Toggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }): React.JSX.Element { return <button className={`switch ${value ? "on" : ""}`} onClick={() => onChange(!value)} aria-pressed={value}><i /></button>; }
function Select({ value, options, onChange }: { value: string; options: string[]; onChange?: (value: string) => void }): React.JSX.Element { return <select value={value} onChange={(e) => onChange?.(e.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select>; }
function ShellSelect({ value, profiles, onChange }: { value: TerminalShellId; profiles: TerminalShellProfile[]; onChange: (value: TerminalShellId) => void }): React.JSX.Element {
  const list = profiles.length ? profiles : [{ id: "auto" as const, label: "자동", available: true, detail: "shell 목록을 불러오는 중" }];
  return <select value={value} onChange={(event) => onChange(event.target.value as TerminalShellId)}>
    {list.map((profile) => <option key={profile.id} value={profile.id} disabled={!profile.available}>{profile.label}{profile.available ? "" : ` - ${profile.detail ?? "사용 불가"}`}</option>)}
  </select>;
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
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  durationMs: number;
  estimatedCost: number;
  pricedTokens: number;
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
      <UsageMetric title="전체 토큰" value={formatTokenCount(summary.totalTokens)} detail={`${summary.completed}개 완료 요청`} />
      <UsageMetric title="예상 비용" value={summary.estimatedCost > 0 ? formatUsd(summary.estimatedCost) : "-"} detail={summary.pricedTokens > 0 ? "공개 단가 기준" : "단가 매칭 없음"} />
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
      <span><small>전체 토큰</small><strong>{formatTokenCount(row.totalTokens)}</strong></span>
      <span><small>입력</small><strong>{formatTokenCount(row.inputTokens)}</strong></span>
      <span><small>출력</small><strong>{formatTokenCount(row.outputTokens)}</strong></span>
      <span><small>요청</small><strong>{row.requests}회</strong></span>
    </div>
    <footer>
      {row.cachedInputTokens > 0 && <small>캐시 입력 {formatTokenCount(row.cachedInputTokens)}</small>}
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
  const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time} 초기화`;
}

function approvalLabel(value: string): string { return value === "never" ? "사용 안 함" : value === "untrusted" ? "항상" : "요청 시"; }
function approvalValue(label: string): string { return label === "사용 안 함" ? "never" : label === "항상" ? "untrusted" : "on-request"; }
function sandboxLabel(value: string): string { return value === "read-only" ? "읽기 전용" : value === "danger-full-access" ? "전체 접근" : "작업 공간 쓰기"; }
function sandboxValue(label: string): string { return label === "읽기 전용" ? "read-only" : label === "전체 접근" ? "danger-full-access" : "workspace-write"; }

function summarizeDevilUsage(entries: ProviderRequestLogEntry[], settings: ProviderSettings | null): { rows: ModelUsageRow[]; totalTokens: number; estimatedCost: number; pricedTokens: number; requests: number; completed: number; failed: number } {
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
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      durationMs: 0,
      estimatedCost: 0,
      pricedTokens: 0,
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
  row.inputTokens += uncachedInput;
  row.cachedInputTokens += cached;
  row.outputTokens += usage.outputTokens;
  row.reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
  row.totalTokens += Math.max(usage.totalTokens ?? 0, uncachedInput + cached + usage.outputTokens);
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
