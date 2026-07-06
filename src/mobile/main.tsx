/// <reference types="vite/client" />

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  FolderKanban,
  Gauge,
  Loader2,
  MessageSquare,
  Plug,
  PlusCircle,
  RefreshCw,
  Search,
  Send,
  Square,
  Terminal,
  WifiOff,
  XCircle,
} from "lucide-react";
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
            <div className="brand">
              <div className="brand-mark"><Bot size={18} /></div>
              <div className="title-block">
                <h1>Devil Codex Remote</h1>
                <p>{currentThread ? threadLabel(currentThread) : runtimeStatus?.cwd || "원격 세션 대기"}</p>
              </div>
            </div>
            <div className="status-pill">
              <span className={`status-dot ${bridgeState.state}`} />
              <span>{bridgeState.state === "ready" ? "연결됨" : bridgeState.reason ?? bridgeState.state}</span>
            </div>
          </div>
          <div className="toolbar">
            <button type="button" className="icon-btn primary" onClick={() => void connectRuntime()} disabled={bridgeState.state !== "ready"}>
              <Plug size={14} />런타임 연결
            </button>
            <button type="button" className="icon-btn" onClick={() => void refreshProjects("")} disabled={bridgeState.state !== "ready"}>
              <RefreshCw size={14} />목록
            </button>
            <button type="button" className="icon-btn" onClick={() => void refreshUsage(true)} disabled={bridgeState.state !== "ready"}>
              <Gauge size={14} />사용량
            </button>
            <button type="button" className="icon-btn" onClick={() => { clearStoredToken(); window.location.reload(); }}>
              <XCircle size={14} />토큰 제거
            </button>
          </div>
        </header>

        <main className="content">
          {!storedToken() && (
            <div className="empty-card card">
              <WifiOff size={24} />
              <strong>세션 토큰이 없습니다</strong>
              <div className="muted" style={{ whiteSpace: "normal" }}>PC에서 생성한 원격 접속 URL을 열거나 `#t=...` fragment가 포함된 QR 링크를 다시 스캔해야 합니다.</div>
            </div>
          )}

          {bootstrapError && (
            <div className="empty-card card">
              <XCircle size={24} />
              <strong>오류</strong>
              <div className="muted" style={{ whiteSpace: "normal" }}>{bootstrapError}</div>
            </div>
          )}

          <AnimatePresence mode="wait">
            {route.view === "projects" && (
              <motion.section
                key="projects"
                className="section"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <div className="search-wrap">
                  <Search size={16} />
                  <input
                    className="search-box"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void refreshProjects(event.currentTarget.value);
                    }}
                    placeholder="프로젝트 또는 스레드 검색"
                  />
                </div>

                <div className="card row-card glow-card">
                  <div className="row-head">
                    <div className="row-title-group">
                      <div className="row-icon"><PlusCircle size={16} /></div>
                      <span className="row-title">새 스레드</span>
                    </div>
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
                    <motion.button whileTap={{ scale: 0.97 }} type="button" className="icon-btn primary" onClick={() => void createThread()} disabled={bridgeState.state !== "ready"}>
                      <PlusCircle size={16} />새 스레드 열기
                    </motion.button>
                  </div>
                </div>

                <div className="section-label">
                  프로젝트<span className="count">{projectGroups.size}</span>
                </div>
                <div className="list-stack">
                  {[...projectGroups.entries()].map(([cwd, items], index) => (
                    <motion.button
                      type="button"
                      key={cwd}
                      className="card row-card"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(index, 8) * 0.03, duration: 0.18 }}
                      whileTap={{ scale: 0.985 }}
                      onClick={() => {
                        setSelectedProject(cwd);
                        void refreshThreads(cwd);
                      }}
                    >
                      <div className="row-head">
                        <div className="row-title-group">
                          <div className="row-icon"><FolderKanban size={16} /></div>
                          <span className="row-title">{basename(cwd)}</span>
                        </div>
                        <ChevronRight size={16} className="tiny" />
                      </div>
                      <div className="muted">{cwd}</div>
                      <div className="badge-row">
                        <span className="badge">{items.length}개 스레드</span>
                        <span className="badge">{items[0]?.runtime ?? "runtime?"}</span>
                        <span className="badge">{formatRelative(items[0]?.updatedAt)}</span>
                      </div>
                    </motion.button>
                  ))}
                </div>

                {selectedProject && (
                  <div className="section">
                    <div className="split-line">
                      <span className="section-label" style={{ padding: 0 }}>{basename(selectedProject)}</span>
                      <span className="tiny">{selectedProject}</span>
                    </div>
                    <div className="list-stack">
                      {threadSummaries.map((thread, index) => (
                        <motion.button
                          type="button"
                          key={thread.id}
                          className="card row-card"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: Math.min(index, 8) * 0.03, duration: 0.18 }}
                          whileTap={{ scale: 0.985 }}
                          onClick={() => {
                            setCurrentThread(thread);
                            setRoute({ view: "thread", threadId: thread.id, cwd: thread.cwd });
                          }}
                        >
                          <div className="row-head">
                            <div className="row-title-group">
                              <div className="row-icon"><MessageSquare size={16} /></div>
                              <span className="row-title">{thread.title || thread.id}</span>
                            </div>
                            <span className="tiny">{formatRelative(thread.updatedAt)}</span>
                          </div>
                          <div className="muted">{thread.preview || "미리보기 없음"}</div>
                          <div className="badge-row">
                            <span className="badge accent">{thread.model}</span>
                            {thread.provider && <span className="badge">{thread.provider}</span>}
                            {thread.runtime && <span className="badge">{thread.runtime}</span>}
                          </div>
                        </motion.button>
                      ))}
                      {!threadSummaries.length && (
                        <div className="empty-card card">
                          <MessageSquare size={22} />
                          <strong>스레드 없음</strong>
                          <div className="muted" style={{ whiteSpace: "normal" }}>선택한 프로젝트에 표시할 스레드가 없습니다.</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.section>
            )}

            {route.view === "thread" && (
              <motion.section
                key="thread"
                className="section"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {currentThread && (
                  <div className="card row-card glow-card">
                    <div className="row-head">
                      <div className="row-title-group">
                        <div className="row-icon"><MessageSquare size={16} /></div>
                        <span className="row-title">{threadLabel(currentThread) || basename(currentThread.cwd)}</span>
                      </div>
                      <span className="tiny">{currentThread.runtime ?? runtimeStatus?.state ?? "-"}</span>
                    </div>
                    <div className="muted">{currentThread.cwd}</div>
                    <div className="badge-row">
                      <span className="badge accent">{currentThread.model}</span>
                      {"provider" in currentThread && currentThread.provider && <span className="badge">{currentThread.provider}</span>}
                      {currentUsageText && <span className="badge">{currentUsageText}</span>}
                    </div>
                  </div>
                )}

                {slashCommands.length > 0 && (
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
                )}

                <div className="timeline">
                  {loadingThread && (
                    <div className="empty-card card">
                      <Loader2 size={22} className="spin" />
                      <strong>불러오는 중</strong>
                      <div className="muted" style={{ whiteSpace: "normal" }}>스레드 기록을 읽고 있습니다.</div>
                    </div>
                  )}
                  {!loadingThread && threadHistory.map((item) => (
                    item.kind === "activity"
                      ? <ActivityBlock key={item.id} item={item} />
                      : <MessageBlock key={item.id} item={item} />
                  ))}
                  {!loadingThread && !threadHistory.length && (
                    <div className="empty-card card">
                      <MessageSquare size={22} />
                      <strong>대화 없음</strong>
                      <div className="muted" style={{ whiteSpace: "normal" }}>첫 메시지를 보내면 이 스레드의 타임라인이 시작됩니다.</div>
                    </div>
                  )}
                </div>
              </motion.section>
            )}

            {route.view === "usage" && (
              <motion.section
                key="usage"
                className="section"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <div className="usage-grid">
                  {(usageReport?.entries ?? []).map((entry) => (
                    <div key={`${entry.provider}:${entry.accountId ?? ""}`} className="card usage-card">
                      <div className="usage-head">
                        <div className="row-title-group">
                          <div className="row-icon"><Gauge size={16} /></div>
                          <strong>{entry.label}</strong>
                        </div>
                        <span className={`badge ${entry.connected ? "accent" : ""}`}>{entry.connected ? "연결됨" : "연결 안 됨"}</span>
                      </div>
                      <div className="muted">{entry.accountLabel || entry.accountEmail || entry.provider}</div>
                      <div className="tiny">{formatUsageWindow(entry)}</div>
                      {entry.windows.map((window) => (
                        <div key={window.label} className="usage-row">
                          <div className="split-line">
                            <span className="tiny">{window.label}</span>
                            <span className="tiny">{Math.round(window.usedPercent)}%</span>
                          </div>
                          <div className="usage-bar"><span style={{ width: `${Math.max(4, Math.min(100, window.usedPercent))}%` }} /></div>
                          <div className="tiny">리셋 {window.resetsAt ? formatTime(window.resetsAt) : "-"}</div>
                        </div>
                      ))}
                      {(entry.error || entry.unavailable) && <div className="tiny">{entry.error || entry.unavailable}</div>}
                    </div>
                  ))}
                  {!usageReport?.entries?.length && (
                    <div className="empty-card card">
                      <Gauge size={22} />
                      <strong>사용량 데이터 없음</strong>
                      <div className="muted" style={{ whiteSpace: "normal" }}>providers:usage 결과가 아직 없습니다.</div>
                    </div>
                  )}
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </main>

        {route.view === "thread" && currentThread && (
          <div className="composer-wrap">
            <div className="composer card">
              <textarea
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                placeholder="메시지를 입력하세요"
                rows={1}
              />
              {busy ? (
                <motion.button whileTap={{ scale: 0.9 }} type="button" className="composer-stop" onClick={() => void interruptTurn()} title="중단">
                  <Square size={16} />
                </motion.button>
              ) : (
                <motion.button whileTap={{ scale: 0.9 }} type="button" className="composer-send" onClick={() => void sendTurn()} disabled={!composerText.trim()} title="보내기">
                  <Send size={17} />
                </motion.button>
              )}
            </div>
          </div>
        )}

        <nav className="nav">
          <button type="button" className={`nav-btn ${routeTab === "projects" ? "active" : ""}`} onClick={() => setRoute({ view: "projects" })}>
            {routeTab === "projects" && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
            <FolderKanban size={18} />
            <span>목록</span>
          </button>
          <button
            type="button"
            className={`nav-btn ${routeTab === "thread" ? "active" : ""}`}
            onClick={() => currentThread && setRoute({ view: "thread", threadId: currentThread.id, cwd: currentThread.cwd })}
            disabled={!currentThread}
          >
            {routeTab === "thread" && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
            <MessageSquare size={18} />
            <span>대화</span>
          </button>
          <button type="button" className={`nav-btn ${routeTab === "usage" ? "active" : ""}`} onClick={() => setRoute({ view: "usage" })}>
            {routeTab === "usage" && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
            <Gauge size={18} />
            <span>사용량</span>
          </button>
        </nav>

        <AnimatePresence>
          {approvalQueue[0] && (
            <ApprovalOverlay key="approval" prompt={approvalQueue[0]} busy={respondingApproval} onDecision={(decision) => void respondApproval(decision)} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {askRequest && (
            <AskOverlay key="ask" request={askRequest} onClose={() => void submitAsk(null)} onSubmit={(answers) => void submitAsk(answers)} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function MessageBlock({ item }: { item: ThreadHistoryItem }): React.JSX.Element {
  const kind = item.kind === "user" ? "user" : item.kind === "agent" ? "agent" : "system";
  const label = kind === "user" ? "나" : kind === "agent" ? "에이전트" : item.title || "시스템";
  const Icon = kind === "user" ? CircleUserRound : kind === "agent" ? Bot : Terminal;
  return (
    <motion.div className={`msg-row ${kind}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
      <div className="msg-avatar"><Icon size={15} /></div>
      <div className="bubble">
        <div className="msg-meta">
          <strong>{label}</strong>
          {(item.model || item.runtime) && <span>· {item.model || item.runtime}</span>}
        </div>
        <div className="msg-body">{messageText(item) || "(비어 있음)"}</div>
      </div>
    </motion.div>
  );
}

function ActivityBlock({ item }: { item: ThreadHistoryItem }): React.JSX.Element {
  const totalTokens = item.cumulativeTokenUsage?.totalTokens ?? item.tokenUsage?.totalTokens;
  return (
    <motion.article className="card activity-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
      <div className="split-line">
        <span className="section-label" style={{ padding: 0 }}>작업 흐름</span>
        <span className="tiny">{item.status ?? "completed"}</span>
      </div>
      {(item.activities ?? []).map((entry) => (
        <div key={entry.id} className={`activity-entry ${entry.status ?? "completed"}`}>
          <div className="entry-head">
            <span className="entry-title">
              {entry.status === "failed" ? <XCircle size={14} /> : entry.status === "inProgress" ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              {entry.title}
            </span>
            <span className="tiny">{entry.kind}</span>
          </div>
          {entry.detail && <div className="entry-detail">{entry.detail}</div>}
          {entry.output && <div className="entry-detail">{entry.output}</div>}
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
    </motion.article>
  );
}

const DECISION_META: Record<string, { label: string; hint: string; tone: string }> = {
  accept: { label: "허용", hint: "이번 한 번만 승인", tone: "accept" },
  acceptForSession: { label: "세션 동안 허용", hint: "같은 요청은 세션 내내 자동 승인", tone: "accept" },
  decline: { label: "거부", hint: "이번 요청을 거부", tone: "decline" },
  cancel: { label: "취소", hint: "현재 턴을 취소", tone: "cancel" },
};

function ApprovalOverlay(
  { prompt, busy, onDecision }: { prompt: ApprovalPrompt; busy: boolean; onDecision: (decision: ApprovalDecision) => void },
): React.JSX.Element {
  const decisions: ApprovalDecision[] = prompt.availableDecisions.length ? prompt.availableDecisions : ["accept", "acceptForSession", "decline", "cancel"];
  return (
    <motion.div className="overlay" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <motion.div
        className="modal-sheet"
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
      >
        <div className="modal-grip" />
        <div className="modal-head">
          <strong>{prompt.kind === "command" ? "명령 승인" : "파일 변경 승인"}</strong>
          <span className="tiny">{prompt.threadId || "-"}</span>
        </div>
        {prompt.command && <div className="entry-detail" style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{prompt.command}</div>}
        {prompt.reason && <div className="muted" style={{ whiteSpace: "normal" }}>{prompt.reason}</div>}
        {prompt.cwd && <div className="tiny">{prompt.cwd}</div>}
        {prompt.grantRoot && <div className="tiny">grant root: {prompt.grantRoot}</div>}
        <div className="decision-grid">
          {decisions.map((decision) => {
            const meta = DECISION_META[decision] ?? { label: decision, hint: "", tone: "" };
            return (
              <motion.button
                whileTap={{ scale: 0.97 }}
                key={decision}
                type="button"
                className={`decision-btn ${meta.tone}`}
                onClick={() => onDecision(decision)}
                disabled={busy}
              >
                <span className="decision-label">
                  <strong>{meta.label}</strong>
                  {meta.hint && <span className="tiny">{meta.hint}</span>}
                </span>
                {meta.tone === "accept" ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
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
    <motion.div
      className="overlay"
      role="presentation"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <motion.div
        className="modal-sheet"
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
      >
        <div className="modal-grip" />
        <div className="modal-head">
          <strong>질문 응답</strong>
          <span className="tiny">{request.id}</span>
        </div>
        {request.questions.map((question, index) => {
          const picks = selected[index] ?? [];
          return (
            <div key={`${request.id}:${index}`} className="question-block">
              {question.header && <span className="tag">{question.header}</span>}
              <strong>{question.question}</strong>
              <div className="decision-grid">
                {question.options.map((option) => {
                  const active = picks.includes(option.label);
                  return (
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      key={option.label}
                      type="button"
                      className={`decision-btn ${active ? "active" : ""}`}
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
                      <span className="decision-label">
                        <strong>{option.label}</strong>
                        {option.description && <span className="tiny">{option.description}</span>}
                      </span>
                      {active && <CheckCircle2 size={18} />}
                    </motion.button>
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
          <button type="button" className="btn" onClick={onClose}>취소</button>
          <motion.button
            whileTap={{ scale: 0.97 }}
            type="button"
            className="btn primary"
            disabled={!complete}
            onClick={() => onSubmit(request.questions.map((question, index) => ({ question: question.question, header: question.header, answers: answersFor(index) })))}
          >
            보내기
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
