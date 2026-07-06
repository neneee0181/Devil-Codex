/// <reference types="vite/client" />

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { approvalPromptFromEvent } from "../renderer/approvalRequests";
import { estimateProviderUsageCost } from "../renderer/providerPricing";
import { applyTimelineEvent } from "../renderer/threadTimeline";
import type {
  AgentRuntimeId,
  AppServerEvent,
  ApprovalDecision,
  ApprovalPrompt,
  AskAnswer,
  AskRequest,
  ClaudeSlashCommandInfo,
  CodexSettings,
  ContextUsage,
  ProviderId,
  ProviderModel,
  ProviderSettings,
  ProviderUsageEntry,
  ProviderUsageReport,
  RuntimeStatus,
  ThreadHistoryItem,
  ThreadRef,
  ThreadSummary,
} from "../shared/contracts";
import { RemoteBridge, clearStoredToken, consumeHashToken, isAppServerEvent, isAskRequest, storedToken } from "./ws-bridge";
import "./styles.css";

consumeHashToken();

type Route =
  | { view: "projects" }
  | { view: "thread"; threadId: string; cwd?: string }
  | { view: "usage" };

type CreateThreadDraft = {
  cwd: string;
  model: string;
  provider?: ProviderId;
  runtime?: AgentRuntimeId;
  accountId?: string;
};

function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return { view: "projects" };
  if (raw === "/usage") return { view: "usage" };
  if (raw.startsWith("/thread/")) {
    const [, , threadId] = raw.split("/");
    const params = new URLSearchParams(raw.split("?")[1] ?? "");
    return { view: "thread", threadId: decodeURIComponent(threadId ?? ""), cwd: params.get("cwd") ?? undefined };
  }
  return { view: "projects" };
}

function setRoute(route: Route): void {
  const hash = route.view === "projects"
    ? "#/projects"
    : route.view === "usage"
      ? "#/usage"
      : `#/thread/${encodeURIComponent(route.threadId)}${route.cwd ? `?cwd=${encodeURIComponent(route.cwd)}` : ""}`;
  if (window.location.hash !== hash) window.location.hash = hash;
}

function formatTime(value?: number | string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatRelative(value?: number): string {
  if (!value) return "-";
  const seconds = Math.max(1, Math.round((Date.now() - value * 1000) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}분 전`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}시간 전`;
  return `${Math.round(seconds / 86_400)}일 전`;
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function threadMeta(thread: ThreadSummary | ThreadRef | null): { model: string; runtime?: AgentRuntimeId; provider?: ProviderId; accountId?: string; cwd: string } | null {
  if (!thread) return null;
  return {
    model: thread.model,
    runtime: thread.runtime,
    provider: "provider" in thread ? thread.provider : undefined,
    accountId: "accountId" in thread ? thread.accountId : undefined,
    cwd: thread.cwd,
  };
}

function threadLabel(thread: ThreadSummary | ThreadRef | null): string {
  if (!thread) return "";
  return "title" in thread && thread.title ? thread.title : thread.id;
}

function formatUsageWindow(entry: ProviderUsageEntry): string {
  if (!entry.windows.length) return "사용량 정보 없음";
  return entry.windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(" / ");
}

function messageText(item: ThreadHistoryItem): string {
  return item.text?.trim() || item.title?.trim() || "";
}

function modelOptions(providerSettings: ProviderSettings | null, codexModels: ProviderModel[]): Array<{ provider: ProviderId; model: string; accountId?: string }> {
  if (!providerSettings) {
    return codexModels.map((model) => ({ provider: "codex", model: model.id }));
  }
  const options: Array<{ provider: ProviderId; model: string; accountId?: string }> = [];
  for (const provider of providerSettings.providers) {
    const models = provider.id === "codex" && codexModels.length ? codexModels : provider.models;
    for (const model of models) options.push({ provider: provider.id, model: model.id });
    for (const account of provider.accounts) {
      for (const model of account.models ?? []) options.push({ provider: provider.id, model: model.id, accountId: account.id });
    }
  }
  const unique = new Map<string, { provider: ProviderId; model: string; accountId?: string }>();
  for (const entry of options) unique.set(`${entry.provider}:${entry.accountId ?? ""}:${entry.model}`, entry);
  return [...unique.values()];
}

function usageHeadline(history: ThreadHistoryItem[]): string | null {
  const activity = [...history].reverse().find((item) => item.kind === "activity");
  if (!activity?.cumulativeTokenUsage) return null;
  const provider = activity.provider ?? "unknown";
  const model = activity.model ?? "";
  const estimate = estimateProviderUsageCost(provider, model, activity.cumulativeTokenUsage);
  const total = activity.cumulativeTokenUsage.totalTokens ?? activity.cumulativeTokenUsage.inputTokens + activity.cumulativeTokenUsage.outputTokens;
  const pieces = [`누적 ${total.toLocaleString()} tok`];
  if (estimate.cost > 0) pieces.push(`약 $${estimate.cost.toFixed(4)}`);
  return pieces.join(" · ");
}

function App(): React.JSX.Element {
  const bridge = useMemo(() => new RemoteBridge(), []);
  const routeState = useMemo(routeFromHash, []);
  const [route, setRouteState] = useState<Route>(routeState);
  const [bridgeState, setBridgeState] = useState(bridge.getSnapshot());
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [codexSettings, setCodexSettings] = useState<CodexSettings | null>(null);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [codexModels, setCodexModels] = useState<ProviderModel[]>([]);
  const [slashCommands, setSlashCommands] = useState<ClaudeSlashCommandInfo[]>([]);
  const [usageReport, setUsageReport] = useState<ProviderUsageReport | null>(null);
  const [projectSummaries, setProjectSummaries] = useState<ThreadSummary[]>([]);
  const [threadSummaries, setThreadSummaries] = useState<ThreadSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [threadHistory, setThreadHistory] = useState<ThreadHistoryItem[]>([]);
  const [currentThread, setCurrentThread] = useState<ThreadSummary | ThreadRef | null>(null);
  const [composerText, setComposerText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalPrompt[]>([]);
  const [askRequest, setAskRequest] = useState<AskRequest | null>(null);
  const [respondingApproval, setRespondingApproval] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateThreadDraft>({ cwd: "", model: "" });
  const historyRef = useRef<ThreadHistoryItem[]>([]);

  useEffect(() => {
    return bridge.onState((snapshot) => setBridgeState(snapshot));
  }, [bridge]);

  useEffect(() => {
    const onHashChange = (): void => setRouteState(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) setRoute({ view: "projects" });
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    bridge.connect();
    return () => bridge.disconnect();
  }, [bridge]);

  async function refreshProjects(query = searchQuery): Promise<void> {
    const result = query.trim()
      ? await bridge.call<ThreadSummary[]>("thread:search", { query: query.trim(), archived: false })
      : await bridge.call<ThreadSummary[]>("thread:projects", { archived: false });
    setProjectSummaries(result);
    if (!query.trim() && !selectedProject && result[0]?.cwd) setSelectedProject(result[0].cwd);
  }

  async function refreshThreads(cwd: string): Promise<void> {
    if (!cwd) return;
    const result = await bridge.call<ThreadSummary[]>("thread:list", { cwd, archived: false });
    setThreadSummaries(result);
  }

  async function refreshUsage(force = false): Promise<void> {
    const usage = await bridge.call<ProviderUsageReport>("providers:usage", { force });
    setUsageReport(usage);
  }

  async function bootstrap(): Promise<void> {
    setBootstrapError(null);
    try {
      const [runtime, settings, providers, usage, models] = await Promise.all([
        bridge.call<RuntimeStatus>("runtime:status"),
        bridge.call<CodexSettings>("settings:load"),
        bridge.call<ProviderSettings>("providers:load"),
        bridge.call<ProviderUsageReport>("providers:usage", { force: true }),
        bridge.call<ProviderModel[]>("codex:models"),
      ]);
      setRuntimeStatus(runtime);
      setCodexSettings(settings);
      setProviderSettings(providers);
      setUsageReport(usage);
      setCodexModels(models);
      const defaultChoice = providers.provider ? { provider: providers.provider, model: providers.model, accountId: providers.accountId } : undefined;
      setCreateDraft((current) => ({
        cwd: current.cwd,
        model: current.model || defaultChoice?.model || models[0]?.id || "",
        provider: current.provider ?? defaultChoice?.provider,
        runtime: current.runtime,
        accountId: current.accountId ?? defaultChoice?.accountId,
      }));
      await refreshProjects("");
    } catch (error) {
      setBootstrapError(String(error));
    }
  }

  useEffect(() => {
    if (bridgeState.state !== "ready") return;
    void bootstrap();
  }, [bridgeState.state]);

  useEffect(() => {
    if (!selectedProject) return;
    setCreateDraft((current) => ({ ...current, cwd: current.cwd || selectedProject }));
    void refreshThreads(selectedProject);
  }, [selectedProject]);

  useEffect(() => {
    if (route.view !== "thread" || !route.threadId) return;
    const summary = threadSummaries.find((item) => item.id === route.threadId) ?? projectSummaries.find((item) => item.id === route.threadId) ?? currentThread;
    if (summary) {
      setCurrentThread(summary);
      if (summary.cwd) setSelectedProject(summary.cwd);
      if (summary.cwd) void refreshSlashCommands(summary.cwd, summary.model);
    }
    void openThread(route.threadId, summary ?? null);
  }, [route.view, route.view === "thread" ? route.threadId : "", threadSummaries, projectSummaries]);

  useEffect(() => {
    historyRef.current = threadHistory;
  }, [threadHistory]);

  useEffect(() => {
    const unsubApp = bridge.subscribe<unknown>("app-server:event", (payload) => {
      if (!isAppServerEvent(payload)) return;
      receiveAppServerEvent(payload);
    });
    const unsubAsk = bridge.subscribe<unknown>("ask:request", (payload) => {
      if (isAskRequest(payload)) setAskRequest(payload);
    });
    const unsubUsage = bridge.subscribe<unknown>("provider:usage-changed", () => { void refreshUsage(true); });
    const unsubStatus = bridge.subscribe<unknown>("app-server:status", (payload) => {
      if (payload && typeof payload === "object") {
        const record = payload as Partial<RuntimeStatus>;
        if (record.state && record.cwd !== undefined && record.detail !== undefined) setRuntimeStatus(record as RuntimeStatus);
      }
    });
    return () => {
      unsubApp();
      unsubAsk();
      unsubUsage();
      unsubStatus();
    };
  }, [bridge, currentThread, threadSummaries, projectSummaries]);

  async function refreshSlashCommands(cwd: string, model?: string): Promise<void> {
    try {
      const commands = await bridge.call<ClaudeSlashCommandInfo[]>("claude:slash-commands", { cwd, model });
      setSlashCommands(commands.slice(0, 8));
    } catch {
      setSlashCommands([]);
    }
  }

  function receiveAppServerEvent(event: AppServerEvent): void {
    const approval = approvalPromptFromEvent(event);
    if (approval) {
      setApprovalQueue((current) => current.some((item) => item.requestId === approval.requestId) ? current : [...current, approval]);
      return;
    }
    const params = (event.params ?? {}) as Record<string, unknown>;
    const eventThreadId = String(params.threadId ?? "");
    if (event.method === "turn/started" && eventThreadId && currentThread?.id === eventThreadId) setBusy(true);
    if (event.method === "turn/completed" && eventThreadId) {
      if (currentThread?.id === eventThreadId) setBusy(false);
      if (selectedProject) void refreshThreads(selectedProject);
      void refreshProjects("");
      void refreshUsage(true);
    }
    if (eventThreadId && currentThread?.id === eventThreadId) {
      const next = applyTimelineEvent(historyRef.current, event);
      historyRef.current = next;
      setThreadHistory(next);
    }
  }

  async function openThread(threadId: string, summary: ThreadSummary | ThreadRef | null): Promise<void> {
    setLoadingThread(true);
    try {
      const known = summary ?? threadSummaries.find((item) => item.id === threadId) ?? projectSummaries.find((item) => item.id === threadId) ?? null;
      if (known) {
        setCurrentThread(known);
        if (known.cwd) setSelectedProject(known.cwd);
        await bridge.call<ThreadRef>("thread:resume", { id: known.id, model: known.model, runtime: known.runtime, accountId: known.accountId }).catch(() => null);
      }
      const history = await bridge.call<ThreadHistoryItem[]>("thread:read", { id: threadId, runtime: known?.runtime, accountId: known?.accountId });
      historyRef.current = history;
      setThreadHistory(history);
    } catch (error) {
      setBootstrapError(String(error));
    } finally {
      setLoadingThread(false);
    }
  }

  async function connectRuntime(): Promise<void> {
    try {
      const status = await bridge.call<RuntimeStatus>("runtime:connect");
      setRuntimeStatus(status);
    } catch (error) {
      setBootstrapError(String(error));
    }
  }

  async function createThread(): Promise<void> {
    if (!createDraft.cwd.trim() || !createDraft.model.trim()) return;
    try {
      const thread = await bridge.call<ThreadRef>("thread:create", {
        cwd: createDraft.cwd.trim(),
        model: createDraft.model.trim(),
        provider: createDraft.provider,
        runtime: createDraft.runtime,
        accountId: createDraft.accountId,
        approvalPolicy: codexSettings?.approvalPolicy,
        sandboxMode: codexSettings?.sandboxMode,
        reasoningEffort: codexSettings?.reasoningEffort,
        responseSpeed: codexSettings?.responseSpeed,
      });
      await refreshProjects("");
      await refreshThreads(thread.cwd);
      setCurrentThread(thread);
      setSelectedProject(thread.cwd);
      historyRef.current = [];
      setThreadHistory([]);
      setComposerText("");
      setRoute({ view: "thread", threadId: thread.id, cwd: thread.cwd });
      await refreshSlashCommands(thread.cwd, thread.model);
    } catch (error) {
      setBootstrapError(String(error));
    }
  }

  async function sendTurn(): Promise<void> {
    const meta = threadMeta(currentThread);
    const text = composerText.trim();
    if (!meta || !text) return;
    const optimistic: ThreadHistoryItem = {
      id: crypto.randomUUID(),
      kind: "user",
      text,
      turnId: `local-${Date.now()}`,
      runtime: meta.runtime,
      provider: meta.provider,
      model: meta.model,
      accountId: meta.accountId,
    };
    const next = [...historyRef.current, optimistic];
    historyRef.current = next;
    setThreadHistory(next);
    setComposerText("");
    setBusy(true);
    try {
      await bridge.call<void>("turn:send", {
        threadId: currentThread?.id,
        cwd: meta.cwd,
        text,
        model: meta.model,
        runtime: meta.runtime,
        provider: meta.provider,
        accountId: meta.accountId,
        approvalPolicy: codexSettings?.approvalPolicy,
        sandboxMode: codexSettings?.sandboxMode,
        reasoningEffort: codexSettings?.reasoningEffort,
        responseSpeed: codexSettings?.responseSpeed,
      });
    } catch (error) {
      setBusy(false);
      setBootstrapError(String(error));
    }
  }

  async function interruptTurn(): Promise<void> {
    const meta = threadMeta(currentThread);
    if (!meta || !currentThread) return;
    try {
      await bridge.call<void>("turn:interrupt", { threadId: currentThread.id, runtime: meta.runtime });
      setBusy(false);
    } catch (error) {
      setBootstrapError(String(error));
    }
  }

  async function respondApproval(decision: ApprovalDecision): Promise<void> {
    const prompt = approvalQueue[0];
    if (!prompt) return;
    setRespondingApproval(true);
    try {
      await bridge.call<void>("approval:respond", { requestId: prompt.requestId, decision, threadId: prompt.threadId || undefined });
      setApprovalQueue((current) => current.slice(1));
    } catch (error) {
      setBootstrapError(String(error));
    } finally {
      setRespondingApproval(false);
    }
  }

  async function submitAsk(answers: AskAnswer[] | null): Promise<void> {
    if (!askRequest) return;
    try {
      await bridge.respondAsk(askRequest.id, answers);
      setAskRequest(null);
    } catch (error) {
      setBootstrapError(String(error));
    }
  }

  const routeTab = route.view === "thread" ? "thread" : route.view;
  const availableModels = modelOptions(providerSettings, codexModels);
  const currentUsageText = usageHeadline(threadHistory);
  const projectGroups = new Map<string, ThreadSummary[]>();
  for (const item of projectSummaries) {
    const bucket = projectGroups.get(item.cwd) ?? [];
    bucket.push(item);
    projectGroups.set(item.cwd, bucket);
  }

  return (
    <div className="mobile-app">
      <div className="shell">
        <header className="topbar">
          <div className="topbar-row">
            <div className="title-block">
              <h1>Devil Codex Remote</h1>
              <p>{currentThread ? threadLabel(currentThread) : runtimeStatus?.cwd || "원격 세션 대기"}</p>
            </div>
            <div className="status-pill">
              <span className={`status-dot ${bridgeState.state}`} />
              <span>{bridgeState.state === "ready" ? "연결됨" : bridgeState.reason ?? bridgeState.state}</span>
            </div>
          </div>
          <div className="toolbar">
            <button type="button" className="primary" onClick={() => void connectRuntime()} disabled={bridgeState.state !== "ready"}>런타임 연결</button>
            <button type="button" onClick={() => void refreshProjects("")} disabled={bridgeState.state !== "ready"}>목록 새로고침</button>
            <button type="button" onClick={() => void refreshUsage(true)} disabled={bridgeState.state !== "ready"}>사용량 새로고침</button>
            <button type="button" onClick={() => { clearStoredToken(); window.location.reload(); }}>토큰 제거</button>
          </div>
        </header>

        <main className="content">
          {!storedToken() && (
            <div className="empty-card">
              <strong>세션 토큰이 없습니다.</strong>
              <div className="muted">PC에서 생성한 원격 접속 URL을 열거나 `#t=...` fragment가 포함된 QR 링크를 다시 스캔해야 합니다.</div>
            </div>
          )}

          {bootstrapError && (
            <div className="empty-card">
              <strong>오류</strong>
              <div className="muted">{bootstrapError}</div>
            </div>
          )}

          {route.view === "projects" && (
            <section className="section">
              <input
                className="search-box"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void refreshProjects(event.currentTarget.value);
                }}
                placeholder="프로젝트 또는 스레드 검색"
              />

              <div className="card project-card">
                <div className="project-head">
                  <strong>새 스레드</strong>
                  <span className="tiny">허용 채널만 사용</span>
                </div>
                <div className="create-thread-form">
                  <input
                    value={createDraft.cwd}
                    onChange={(event) => setCreateDraft((current) => ({ ...current, cwd: event.target.value }))}
                    placeholder="프로젝트 경로"
                  />
                  <select
                    value={`${createDraft.provider ?? ""}:${createDraft.accountId ?? ""}:${createDraft.model}`}
                    onChange={(event) => {
                      const picked = availableModels.find((item) => `${item.provider}:${item.accountId ?? ""}:${item.model}` === event.target.value);
                      if (!picked) return;
                      setCreateDraft((current) => ({ ...current, provider: picked.provider, accountId: picked.accountId, model: picked.model }));
                    }}
                  >
                    {availableModels.map((item) => (
                      <option key={`${item.provider}:${item.accountId ?? ""}:${item.model}`} value={`${item.provider}:${item.accountId ?? ""}:${item.model}`}>
                        {item.provider} · {item.model}{item.accountId ? ` · ${item.accountId}` : ""}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="primary" onClick={() => void createThread()} disabled={bridgeState.state !== "ready"}>
                    새 스레드 열기
                  </button>
                </div>
              </div>

              <div className="list-stack">
                {[...projectGroups.entries()].map(([cwd, items]) => (
                  <button
                    type="button"
                    key={cwd}
                    className="card project-card"
                    onClick={() => {
                      setSelectedProject(cwd);
                      void refreshThreads(cwd);
                    }}
                  >
                    <div className="project-head">
                      <span className="project-title">{basename(cwd)}</span>
                      <span className="tiny">{items.length} threads</span>
                    </div>
                    <div className="muted">{cwd}</div>
                    <div className="badge-row">
                      <span className="badge">{items[0]?.runtime ?? "runtime?"}</span>
                      <span className="badge">{formatRelative(items[0]?.updatedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>

              {selectedProject && (
                <div className="section">
                  <div className="split-line">
                    <strong>{basename(selectedProject)}</strong>
                    <span className="tiny">{selectedProject}</span>
                  </div>
                  <div className="list-stack">
                    {threadSummaries.map((thread) => (
                      <button
                        type="button"
                        key={thread.id}
                        className="thread-row"
                        onClick={() => {
                          setCurrentThread(thread);
                          setRoute({ view: "thread", threadId: thread.id, cwd: thread.cwd });
                        }}
                      >
                        <div className="thread-head">
                          <span className="thread-title">{thread.title || thread.id}</span>
                          <span className="tiny">{formatRelative(thread.updatedAt)}</span>
                        </div>
                        <div className="muted">{thread.preview || "미리보기 없음"}</div>
                        <div className="badge-row">
                          <span className="badge">{thread.model}</span>
                          {thread.provider && <span className="badge">{thread.provider}</span>}
                          {thread.runtime && <span className="badge">{thread.runtime}</span>}
                        </div>
                      </button>
                    ))}
                    {!threadSummaries.length && <div className="empty-card"><strong>스레드 없음</strong><div className="muted">선택한 프로젝트에 표시할 스레드가 없습니다.</div></div>}
                  </div>
                </div>
              )}
            </section>
          )}

          {route.view === "thread" && (
            <section className="section">
              {currentThread && (
                <div className="card project-card">
                  <div className="thread-head">
                    <span className="thread-title">{threadLabel(currentThread) || basename(currentThread.cwd)}</span>
                    <span className="tiny">{currentThread.runtime ?? runtimeStatus?.state ?? "-"}</span>
                  </div>
                  <div className="muted">{currentThread.cwd}</div>
                  <div className="badge-row">
                    <span className="badge">{currentThread.model}</span>
                    {"provider" in currentThread && currentThread.provider && <span className="badge">{currentThread.provider}</span>}
                    {currentUsageText && <span className="badge">{currentUsageText}</span>}
                  </div>
                </div>
              )}

              <div className="chip-row">
                {slashCommands.map((command) => (
                  <button
                    type="button"
                    key={command.name}
                    className="chip"
                    onClick={() => setComposerText((current) => `${current}${current.trim() ? "\n" : ""}/${command.name} `)}
                  >
                    /{command.name}
                  </button>
                ))}
              </div>

              <div className="timeline">
                {loadingThread && <div className="empty-card"><strong>불러오는 중</strong><div className="muted">스레드 기록을 읽고 있습니다.</div></div>}
                {!loadingThread && threadHistory.map((item) => (
                  item.kind === "activity"
                    ? <ActivityBlock key={item.id} item={item} />
                    : <MessageBlock key={item.id} item={item} />
                ))}
                {!loadingThread && !threadHistory.length && <div className="empty-card"><strong>대화 없음</strong><div className="muted">첫 메시지를 보내면 이 스레드의 타임라인이 시작됩니다.</div></div>}
              </div>
            </section>
          )}

          {route.view === "usage" && (
            <section className="section">
              <div className="usage-grid">
                {(usageReport?.entries ?? []).map((entry) => (
                  <div key={`${entry.provider}:${entry.accountId ?? ""}`} className="usage-card">
                    <div className="usage-head">
                      <strong>{entry.label}</strong>
                      <span className="tiny">{entry.connected ? "connected" : "disconnected"}</span>
                    </div>
                    <div className="muted">{entry.accountLabel || entry.accountEmail || entry.provider}</div>
                    <div className="tiny">{formatUsageWindow(entry)}</div>
                    {entry.windows.map((window) => (
                      <div key={window.label}>
                        <div className="split-line">
                          <span>{window.label}</span>
                          <span className="tiny">{Math.round(window.usedPercent)}%</span>
                        </div>
                        <div className="usage-bar"><span style={{ width: `${Math.max(4, Math.min(100, window.usedPercent))}%` }} /></div>
                        <div className="tiny">리셋 {window.resetsAt ? formatTime(window.resetsAt) : "-"}</div>
                      </div>
                    ))}
                    {(entry.error || entry.unavailable) && <div className="tiny">{entry.error || entry.unavailable}</div>}
                  </div>
                ))}
                {!usageReport?.entries?.length && <div className="empty-card"><strong>사용량 데이터 없음</strong><div className="muted">providers:usage 결과가 아직 없습니다.</div></div>}
              </div>
            </section>
          )}
        </main>

        {route.view === "thread" && currentThread && (
          <div className="composer-wrap">
            <div className="composer card">
              <textarea
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                placeholder="메시지를 입력하세요"
              />
              <div className="composer-actions">
                <button type="button" onClick={() => void interruptTurn()} disabled={!busy}>중단</button>
                <button type="button" className="primary" onClick={() => void sendTurn()} disabled={!composerText.trim() || busy}>
                  {busy ? "응답 대기 중" : "보내기"}
                </button>
              </div>
            </div>
          </div>
        )}

        <nav className="nav">
          <button type="button" className={routeTab === "projects" ? "active" : ""} onClick={() => setRoute({ view: "projects" })}>목록</button>
          <button
            type="button"
            className={routeTab === "thread" ? "active" : ""}
            onClick={() => currentThread && setRoute({ view: "thread", threadId: currentThread.id, cwd: currentThread.cwd })}
            disabled={!currentThread}
          >
            대화
          </button>
          <button type="button" className={routeTab === "usage" ? "active" : ""} onClick={() => setRoute({ view: "usage" })}>사용량</button>
        </nav>

        {approvalQueue[0] && (
          <ApprovalOverlay prompt={approvalQueue[0]} busy={respondingApproval} onDecision={(decision) => void respondApproval(decision)} />
        )}

        {askRequest && (
          <AskOverlay request={askRequest} onClose={() => void submitAsk(null)} onSubmit={(answers) => void submitAsk(answers)} />
        )}
      </div>
    </div>
  );
}

function MessageBlock({ item }: { item: ThreadHistoryItem }): React.JSX.Element {
  const label = item.kind === "user" ? "나" : item.kind === "agent" ? "에이전트" : item.title || "시스템";
  return (
    <article className={`message ${item.kind}`}>
      <div className="message-head">
        <strong>{label}</strong>
        <span className="tiny">{item.model || item.runtime || ""}</span>
      </div>
      <div className="message-body">{messageText(item) || "(비어 있음)"}</div>
    </article>
  );
}

function ActivityBlock({ item }: { item: ThreadHistoryItem }): React.JSX.Element {
  const totalTokens = item.cumulativeTokenUsage?.totalTokens ?? item.tokenUsage?.totalTokens;
  return (
    <article className="activity-card">
      <div className="split-line">
        <strong>작업 흐름</strong>
        <span className="tiny">{item.status ?? "completed"}</span>
      </div>
      {(item.activities ?? []).map((entry) => (
        <div key={entry.id} className={`activity-entry ${entry.status ?? "completed"}`}>
          <div className="message-head">
            <strong>{entry.title}</strong>
            <span className="tiny">{entry.kind}</span>
          </div>
          {entry.detail && <div className="message-body">{entry.detail}</div>}
          {entry.output && <div className="message-body">{entry.output}</div>}
          {entry.files?.length ? (
            <div className="file-list">
              {entry.files.map((file) => (
                <div key={`${entry.id}:${file.path}`} className="tiny">{file.path} (+{file.additions}/-{file.deletions})</div>
              ))}
            </div>
          ) : null}
          {entry.images?.length ? (
            <div className="image-strip">
              {entry.images.map((src, index) => <img key={`${entry.id}:${index}`} src={src} alt={entry.title} />)}
            </div>
          ) : null}
        </div>
      ))}
      {(item.contextUsage || totalTokens) && (
        <div className="badge-row">
          {item.contextUsage && <span className="badge">컨텍스트 {item.contextUsage.usedTokens.toLocaleString()} / {item.contextUsage.maxTokens.toLocaleString()}</span>}
          {totalTokens && <span className="badge">토큰 {totalTokens.toLocaleString()}</span>}
        </div>
      )}
    </article>
  );
}

function ApprovalOverlay(
  { prompt, busy, onDecision }: { prompt: ApprovalPrompt; busy: boolean; onDecision: (decision: ApprovalDecision) => void },
): React.JSX.Element {
  const decisions: ApprovalDecision[] = prompt.availableDecisions.length ? prompt.availableDecisions : ["accept", "acceptForSession", "decline", "cancel"];
  return (
    <div className="overlay" role="presentation">
      <div className="modal-sheet">
        <div className="modal-head">
          <strong>{prompt.kind === "command" ? "명령 승인" : "파일 변경 승인"}</strong>
          <span className="tiny">{prompt.threadId || "-"}</span>
        </div>
        {prompt.command && <div className="message-body">{prompt.command}</div>}
        {prompt.reason && <div className="message-body">{prompt.reason}</div>}
        {prompt.cwd && <div className="tiny">{prompt.cwd}</div>}
        {prompt.grantRoot && <div className="tiny">grant root: {prompt.grantRoot}</div>}
        <div className="decision-grid">
          {decisions.map((decision) => (
            <button key={decision} type="button" onClick={() => onDecision(decision)} disabled={busy}>
              {decision}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AskOverlay(
  { request, onClose, onSubmit }: { request: AskRequest; onClose: () => void; onSubmit: (answers: AskAnswer[]) => void },
): React.JSX.Element {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  function answersFor(index: number): string[] {
    const free = (custom[index] ?? "").trim();
    return free ? [free] : (selected[index] ?? []);
  }

  const complete = request.questions.every((_, index) => answersFor(index).length > 0);

  return (
    <div className="overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-sheet">
        <div className="modal-head">
          <strong>질문 응답</strong>
          <span className="tiny">{request.id}</span>
        </div>
        {request.questions.map((question, index) => {
          const picks = selected[index] ?? [];
          return (
            <div key={`${request.id}:${index}`} className="section">
              {question.header && <span className="tag">{question.header}</span>}
              <strong>{question.question}</strong>
              <div className="decision-grid">
                {question.options.map((option) => {
                  const active = picks.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={active ? "active" : ""}
                      onClick={() => {
                        setCustom((current) => ({ ...current, [index]: "" }));
                        setSelected((current) => {
                          const currentValues = current[index] ?? [];
                          if (question.multiSelect) {
                            return {
                              ...current,
                              [index]: currentValues.includes(option.label)
                                ? currentValues.filter((value) => value !== option.label)
                                : [...currentValues, option.label],
                            };
                          }
                          return { ...current, [index]: currentValues[0] === option.label ? [] : [option.label] };
                        });
                      }}
                    >
                      <div>{option.label}</div>
                      {option.description && <div className="tiny">{option.description}</div>}
                    </button>
                  );
                })}
              </div>
              <textarea
                className="ask-textarea"
                value={custom[index] ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setCustom((current) => ({ ...current, [index]: value }));
                  if (value.trim()) setSelected((current) => ({ ...current, [index]: [] }));
                }}
                placeholder="직접 입력"
              />
            </div>
          );
        })}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>취소</button>
          <button
            type="button"
            className="primary"
            disabled={!complete}
            onClick={() => onSubmit(request.questions.map((question, index) => ({ question: question.question, header: question.header, answers: answersFor(index) })))}
          >
            보내기
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
