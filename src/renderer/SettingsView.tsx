import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CreditCard, Globe2, Search, TerminalSquare } from "lucide-react";
import { useCodexSettings } from "./hooks/useCodexSettings";
import { useProviderUsage } from "./hooks/useProviderUsage";
import { ProviderSettingsPanel } from "./components/ProviderSettingsPanel";
import type { AppInfo, ProviderId, ProviderRequestLogEntry, ProviderSettings, ProviderTokenUsage, ProviderUsageEntry } from "../shared/contracts";

type Config = {
  approval: string;
  sandbox: string;
  devilMcpEnabled: boolean;
  englishOutput: boolean;
  sidecarWebSearch: boolean;
  sidecarVision: boolean;
  sidecarWebSearchLimit: number;
  sidecarVisionLimit: number;
};

const defaults: Config = {
  approval: "요청 시", sandbox: "읽기 전용", devilMcpEnabled: false, englishOutput: false, sidecarWebSearch: false, sidecarVision: false, sidecarWebSearchLimit: 3, sidecarVisionLimit: 3,
};

const groups = [
  { label: "설정", items: [["구성", TerminalSquare], ["연결", Globe2], ["사용량 및 청구", CreditCard]] },
] as const;

export function SettingsView({ active, appInfo, onSelect, onBack, providerSettings, providerState, onProviderSelect, onProviderSaveKey, onProviderClearKey, onProviderRefreshModels }: { active: string; appInfo: AppInfo | null; onSelect: (value: string) => void; onBack: () => void; providerSettings: ProviderSettings | null; providerState: "loading" | "saved" | "error"; onProviderSelect: (input: { provider: ProviderId; model: string }) => Promise<void>; onProviderSaveKey: (input: { provider: ProviderId; key: string }) => Promise<void>; onProviderClearKey: (provider: ProviderId) => Promise<void>; onProviderRefreshModels: (provider: Exclude<ProviderId, "codex">) => Promise<void> }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [config, setConfig] = useState<Config>(() => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("devil-codex:settings") ?? "{}") }; } catch { return defaults; }
  });
  const codex = useCodexSettings();
  useEffect(() => { if (!codex.settings) return; setConfig((current) => ({ ...current, approval: approvalLabel(codex.settings.approvalPolicy), sandbox: sandboxLabel(codex.settings.sandboxMode), devilMcpEnabled: codex.settings.devilMcpEnabled, englishOutput: codex.settings.englishOutput })); }, [codex.settings]);
  useEffect(() => { localStorage.setItem("devil-codex:settings", JSON.stringify(config)); }, [config]);
  const visible = useMemo(() => groups.map((group) => ({ ...group, items: group.items.filter(([name]) => name.toLowerCase().includes(query.toLowerCase())) })).filter((group) => group.items.length), [query]);
  const update = <K extends keyof Config>(key: K, value: Config[K]): void => {
    setConfig((current) => ({ ...current, [key]: value }));
    if (!codex.settings) return;
    if (key === "approval") codex.save({ ...codex.settings, approvalPolicy: approvalValue(String(value)) });
    if (key === "sandbox") codex.save({ ...codex.settings, sandboxMode: sandboxValue(String(value)) });
    if (key === "devilMcpEnabled") codex.save({ ...codex.settings, devilMcpEnabled: Boolean(value) });
    if (key === "englishOutput") codex.save({ ...codex.settings, englishOutput: Boolean(value) });
  };

  return <div className="settings-view">
    <aside className="settings-sidebar">
      <button className="settings-back" onClick={onBack}>← <span>앱으로 돌아가기</span></button>
      <label className="settings-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="설정 검색..." /></label>
      <nav>{visible.map((group) => <div className="settings-group" key={group.label}><p>{group.label}</p>{group.items.map(([name, Icon]) => <button className={active === name ? "active" : ""} key={name} onClick={() => onSelect(name)}><Icon size={18} strokeWidth={1.8} />{name}</button>)}</div>)}</nav>
    </aside>
    <section className="settings-content">
      <AnimatePresence mode="wait"><motion.div key={active} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: .16 }} className="settings-page">
        <SettingsPage active={active} appInfo={appInfo} config={config} update={update} backendState={codex.state} providerSettings={providerSettings} providerState={providerState} onProviderSelect={onProviderSelect} onProviderSaveKey={onProviderSaveKey} onProviderClearKey={onProviderClearKey} onProviderRefreshModels={onProviderRefreshModels} />
      </motion.div></AnimatePresence>
    </section>
  </div>;
}

function SettingsPage({ active, appInfo, config, update, backendState, providerSettings, providerState, onProviderSelect, onProviderSaveKey, onProviderClearKey, onProviderRefreshModels }: { active: string; appInfo: AppInfo | null; config: Config; update: <K extends keyof Config>(key: K, value: Config[K]) => void; backendState: "loading" | "saved" | "error"; providerSettings: ProviderSettings | null; providerState: "loading" | "saved" | "error"; onProviderSelect: (input: { provider: ProviderId; model: string }) => Promise<void>; onProviderSaveKey: (input: { provider: ProviderId; key: string }) => Promise<void>; onProviderClearKey: (provider: ProviderId) => Promise<void>; onProviderRefreshModels: (provider: Exclude<ProviderId, "codex">) => Promise<void> }): React.JSX.Element {
  const usage = useProviderUsage(active === "사용량 및 청구");
  if (active === "구성") return <><h1>구성</h1><p className="page-lead">승인 정책 및 샌드박스 설정을 구성합니다. <span className={`settings-save-state ${backendState}`}>{backendState === "loading" ? "저장 중…" : backendState === "saved" ? "config.toml 저장됨" : "저장 실패"}</span></p><section><h2>사용자 지정 config.toml 설정</h2><div className="setting-card"><Row title="승인 정책" detail="Codex가 승인을 요청할 시점을 선택합니다"><Select value={config.approval} options={["요청 시", "항상", "사용 안 함"]} onChange={(v) => update("approval", v)} /></Row><Row title="샌드박스 설정" detail="명령을 실행하는 동안 수행할 수 있는 작업 범위"><Select value={config.sandbox} options={["읽기 전용", "작업 공간 쓰기", "전체 접근"]} onChange={(v) => update("sandbox", v)} /></Row></div></section><section><h2>Devil MCP 도구</h2><p className="section-help">브라우저와 컴퓨터 제어 도구는 켠 동안에만 Codex MCP 목록에 등록됩니다.</p><div className="setting-card"><Row title="브라우저/컴퓨터 제어 MCP" detail="필요할 때만 켜세요. 끄면 공유 config.toml에서 Devil MCP 블록을 제거하고 app-server를 다시 연결합니다."><Toggle value={config.devilMcpEnabled} onChange={(v) => update("devilMcpEnabled", v)} /></Row></div></section><section><h2>영어 응답 + 번역</h2><p className="section-help">켜면 한글로 질문해도 모델은 영어로만 답합니다(토큰 절약). 각 AI 답변 우측의 번역 토글을 켜면 무료 번역기로 한글로 볼 수 있습니다. 끄면 영어 강제 프롬프트만 제거됩니다.</p><div className="setting-card"><Row title="모델 영어 응답" detail="사용자 언어와 무관하게 모델 출력을 영어로 고정합니다. 코드/경로/명령어는 그대로 둡니다."><Toggle value={config.englishOutput} onChange={(v) => update("englishOutput", v)} /></Row></div></section><section><h2>외부 모델 Sidecar</h2><p className="section-help">외부 모델에서만 사용하는 보조 Codex 기능입니다. Codex 모델은 항상 순정 app-server 직통 경로를 유지합니다.</p><div className="setting-card"><Row title="웹 검색 sidecar" detail="외부 모델이 web_search 도구를 호출하면 Codex sidecar가 실제 웹 검색을 실행하고 결과를 모델에게 다시 전달합니다."><Toggle value={config.sidecarWebSearch} onChange={(v) => update("sidecarWebSearch", v)} /></Row><Row title="웹 검색 최대 요청 수" detail="모델이 한 요청에서 검색을 반복 호출할 때 폭주를 막습니다."><Select value={String(config.sidecarWebSearchLimit)} options={["1", "2", "3", "5"]} onChange={(v) => update("sidecarWebSearchLimit", Number(v))} /></Row><Row title="이미지 설명 sidecar" detail="이미지를 못 보는 외부 모델에 Codex vision 설명을 전달할 준비 상태로 둡니다. 현재는 진단 표시까지 지원합니다."><Toggle value={config.sidecarVision} onChange={(v) => update("sidecarVision", v)} /></Row><Row title="이미지 설명 최대 요청 수" detail="여러 이미지/반복 설명 호출의 비용과 지연을 제한합니다."><Select value={String(config.sidecarVisionLimit)} options={["1", "2", "3", "5"]} onChange={(v) => update("sidecarVisionLimit", Number(v))} /></Row></div></section></>;
  if (active === "사용량 및 청구") return <ProviderUsagePage report={usage.report} requestLog={usage.requestLog} providerSettings={providerSettings} state={usage.state} onRefresh={() => void usage.refresh()} />;
  if (active === "연결") return <ProviderSettingsPanel settings={providerSettings} state={providerState} onSelect={onProviderSelect} onSaveKey={onProviderSaveKey} onClearKey={onProviderClearKey} onRefreshModels={onProviderRefreshModels} />;
  return <><h1>{active}</h1><p>준비 중입니다.</p></>;
}

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }): React.JSX.Element { return <div className="setting-row"><div><strong>{title}</strong>{detail && <p>{detail}</p>}</div><div>{children}</div></div>; }
function Toggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }): React.JSX.Element { return <button className={`switch ${value ? "on" : ""}`} onClick={() => onChange(!value)} aria-pressed={value}><i /></button>; }
function Select({ value, options, onChange }: { value: string; options: string[]; onChange?: (value: string) => void }): React.JSX.Element { return <select value={value} onChange={(e) => onChange?.(e.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select>; }
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
type Pricing = { input: number; output: number; cachedInput?: number; label: string };

function ProviderUsagePage({ report, requestLog, providerSettings, state, onRefresh }: { report: { entries: ProviderUsageEntry[] } | null; requestLog: ProviderRequestLogEntry[]; providerSettings: ProviderSettings | null; state: string; onRefresh: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<UsageTab>("devil");
  const entries = report?.entries ?? [];
  const devil = useMemo(() => summarizeDevilUsage(requestLog, providerSettings), [requestLog, providerSettings]);
  return <><div className="usage-head"><span><h1>사용량 및 청구</h1><p>공식 Provider 한도와 Devil Codex에서 프록시한 모델별 토큰 사용량을 함께 확인합니다. 금액은 Provider 공개 단가 기준의 추정치입니다.</p></span><button className="secondary" onClick={onRefresh} disabled={state === "loading"}>{state === "loading" ? "새로고침 중…" : "새로고침"}</button></div>
    <div className="usage-tabs" role="tablist" aria-label="사용량 보기">
      <button type="button" className={tab === "devil" ? "active" : ""} onClick={() => setTab("devil")}>Devil 사용량</button>
      <button type="button" className={tab === "quota" ? "active" : ""} onClick={() => setTab("quota")}>Provider 한도</button>
    </div>
    {tab === "devil" ? <DevilUsageTab summary={devil} state={state} /> : <section><h2>Provider 한도</h2>{state === "error" && <p className="provider-error">사용량을 불러오지 못했습니다.</p>}{!entries.length && state !== "loading"
      ? <div className="setting-card usage-empty"><strong>로그인된 Provider가 없습니다.</strong><p>연결 설정에서 Codex, Claude Code, GitHub Copilot 중 하나에 로그인하면 여기에 표시됩니다.</p></div>
      : <div className="usage-provider-grid">{entries.map((entry) => <ProviderUsageCard key={entry.provider} entry={entry} />)}</div>}</section>}</>;
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
  return <div className="setting-card usage-provider-card"><header><span><strong>{entry.label}</strong><small>{entry.connected ? "로그인됨" : "로그인 안 됨"}</small></span><small>{formatUpdated(entry.updatedAt)}</small></header>
    {entry.windows.length ? <div>{entry.windows.map((window) => <UsageWindow key={window.label} title={window.label} remaining={window.remainingPercent} resetsAt={window.resetsAt} />)}</div> : <p className={entry.error ? "usage-error" : "usage-unavailable"}>{entry.error ? `오류: ${entry.error}` : entry.unavailable ?? "표시할 사용량 데이터가 없습니다."}</p>}</div>;
}

function UsageWindow({ title, remaining, resetsAt }: { title: string; remaining: number; resetsAt?: string | number | null }): React.JSX.Element {
  const level = remaining < 20 ? "danger" : remaining < 50 ? "warning" : "healthy";
  return <div className={`usage-row ${level}`}><span><strong>{title} 사용 한도</strong><small>{formatReset(resetsAt)}</small></span><progress value={remaining} max="100" /><b>{Math.round(remaining)}% 남음</b></div>;
}

function formatUpdated(value: number): string { return new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }); }
function formatReset(value: string | number | null | undefined): string {
  if (value == null) return "초기화 시간 알 수 없음";
  const normalized = typeof value === "number" && value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} 초기화`;
}

function approvalLabel(value: string): string { return value === "never" ? "사용 안 함" : value === "untrusted" ? "항상" : "요청 시"; }
function approvalValue(label: string): string { return label === "사용 안 함" ? "never" : label === "항상" ? "untrusted" : "on-request"; }
function sandboxLabel(value: string): string { return value === "read-only" ? "읽기 전용" : value === "danger-full-access" ? "전체 접근" : "작업 공간 쓰기"; }
function sandboxValue(label: string): string { return label === "읽기 전용" ? "read-only" : label === "전체 접근" ? "danger-full-access" : "workspace-write"; }

function summarizeDevilUsage(entries: ProviderRequestLogEntry[], settings: ProviderSettings | null): { rows: ModelUsageRow[]; totalTokens: number; estimatedCost: number; pricedTokens: number; requests: number; completed: number; failed: number } {
  const labels = new Map<ProviderId, string>((settings?.providers ?? []).map((provider) => [provider.id, provider.label]));
  const rows = new Map<string, ModelUsageRow>();
  for (const entry of entries) {
    const key = `${entry.provider}:${entry.model}`;
    const current = rows.get(key) ?? {
      key,
      provider: entry.provider,
      providerLabel: entry.provider === "unknown" ? "알 수 없음" : labels.get(entry.provider) ?? providerFallbackLabel(entry.provider),
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
      const cost = estimateUsageCost(entry.provider, entry.model, entry.usage);
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
  row.inputTokens += usage.inputTokens;
  row.cachedInputTokens += cached;
  row.outputTokens += usage.outputTokens;
  row.reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
  row.totalTokens += usage.inputTokens + usage.outputTokens;
}

function estimateUsageCost(provider: ProviderId | "unknown", model: string, usage: ProviderTokenUsage): { cost: number; pricedTokens: number } {
  const pricing = pricingFor(provider, model);
  if (!pricing) return { cost: 0, pricedTokens: 0 };
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const inputCost = uncachedInput * pricing.input / 1_000_000;
  const cachedCost = cached * (pricing.cachedInput ?? pricing.input) / 1_000_000;
  const outputCost = usage.outputTokens * pricing.output / 1_000_000;
  return { cost: inputCost + cachedCost + outputCost, pricedTokens: usage.inputTokens + usage.outputTokens };
}

function pricingFor(provider: ProviderId | "unknown", model: string): Pricing | null {
  const id = model.toLowerCase();
  if (provider === "openai" || provider === "codex") {
    if (id.includes("gpt-5.5-pro") || id.includes("gpt-5.4-pro")) return { input: 15, output: 90, cachedInput: 1.5, label: "OpenAI pro" };
    if (id.includes("gpt-5.5") || id.includes("gpt-5.4")) return { input: 1.25, output: 10, cachedInput: 0.125, label: "OpenAI GPT-5" };
    if (id.includes("gpt-5")) return { input: 1.25, output: 10, cachedInput: 0.125, label: "OpenAI GPT-5" };
    if (id.includes("gpt-4.1-mini")) return { input: 0.4, output: 1.6, cachedInput: 0.1, label: "OpenAI GPT-4.1 mini" };
    if (id.includes("gpt-4.1")) return { input: 2, output: 8, cachedInput: 0.5, label: "OpenAI GPT-4.1" };
  }
  if (provider === "anthropic" || provider === "claude-code") {
    if (id.includes("haiku")) return { input: 0.8, output: 4, cachedInput: 0.08, label: "Claude Haiku" };
    if (id.includes("opus")) return { input: 15, output: 75, cachedInput: 1.5, label: "Claude Opus" };
    if (id.includes("sonnet") || id.includes("claude")) return { input: 3, output: 15, cachedInput: 0.3, label: "Claude Sonnet" };
  }
  if (provider === "google") {
    if (id.includes("flash-lite")) return { input: 0.1, output: 0.4, label: "Gemini Flash-Lite" };
    if (id.includes("flash")) return { input: 0.3, output: 2.5, label: "Gemini Flash" };
    if (id.includes("pro")) return { input: 1.25, output: 10, label: "Gemini Pro" };
  }
  if (provider === "deepseek") {
    if (id.includes("reasoner")) return { input: 0.55, output: 2.19, cachedInput: 0.14, label: "DeepSeek Reasoner" };
    return { input: 0.27, output: 1.1, cachedInput: 0.07, label: "DeepSeek Chat" };
  }
  return null;
}

function providerFallbackLabel(provider: ProviderId): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google Gemini";
  if (provider === "deepseek") return "DeepSeek";
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
