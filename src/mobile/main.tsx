/// <reference types="vite/client" />

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleUserRound,
  FolderKanban,
  Gauge,
  Info,
  Loader2,
  MessageSquare,
  Paperclip,
  PlusCircle,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
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
  RemoteScope,
  RuntimeStatus,
  ThreadHistoryItem,
  ThreadAttachment,
  ThreadRef,
  ThreadSummary,
} from "../shared/contracts";
import { RemoteBridge, consumeHashToken, isAppServerEvent, isAskRequest, storedToken } from "./ws-bridge";
import { GlowRing } from "./GlowRing";
import { MobileMarkdown } from "./Markdown";
import "./styles.css";

consumeHashToken();

type Route =
  | { view: "projects" }
  | { view: "thread"; threadId: string; cwd?: string }
  | { view: "usage" };

// How many of the newest timeline items render by default; "이전 대화
// 더보기" reveals another page of older items already held in threadHistory
// (thread:read has no server-side pagination, so this windows client-side).
const HISTORY_PAGE_SIZE = 20;
const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BATCH_BYTES = 18 * 1024 * 1024;

type CreateThreadDraft = {
  cwd: string;
  model: string;
  provider?: ProviderId;
  runtime?: AgentRuntimeId;
  accountId?: string;
};

type ModelChoice = {
  provider?: ProviderId;
  model: string;
  accountId?: string;
};

type ComposerImageAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  content: string;
};

function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return { view: "projects" };
  if (raw === "/usage") return { view: "usage" };
  if (raw.startsWith("/thread/")) {
    const [path, query] = raw.split("?");
    const [, , threadId] = path.split("/");
    const params = new URLSearchParams(query ?? "");
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

function modelChoiceKey(choice: Pick<ModelChoice, "provider" | "accountId" | "model">): string {
  return `${choice.provider ?? ""}:${choice.accountId ?? ""}:${choice.model}`;
}

function matchModelChoice(options: ModelChoice[], candidate: ModelChoice | null): ModelChoice | null {
  if (!candidate?.model) return null;
  return options.find((option) => modelChoiceKey(option) === modelChoiceKey(candidate))
    ?? options.find((option) => option.provider === candidate.provider && option.model === candidate.model)
    ?? options.find((option) => option.model === candidate.model)
    ?? null;
}

function uniqueModelChoices(options: Array<ModelChoice | null | undefined>): ModelChoice[] {
  const unique = new Map<string, ModelChoice>();
  for (const option of options) {
    if (!option?.model) continue;
    unique.set(modelChoiceKey(option), option);
  }
  return [...unique.values()];
}

function latestHistoryChoice(history: ThreadHistoryItem[]): ModelChoice | null {
  let model: string | undefined;
  let provider: ProviderId | undefined;
  let accountId: string | undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!model && item.model) model = item.model;
    if (!provider && item.provider) provider = item.provider;
    if (!accountId && item.accountId) accountId = item.accountId;
    if (model && (provider !== undefined || accountId !== undefined)) break;
  }
  return model ? { model, provider, accountId } : null;
}

function attachmentPreview(item: ThreadAttachment): string | null {
  if (item.kind !== "image") return null;
  return item.url || item.content || null;
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

function modelChoiceLabel(choice: ModelChoice): string {
  const parts = [choice.provider, choice.model, choice.accountId].filter(Boolean);
  return parts.length ? parts.join(" · ") : choice.model;
}

async function readImageAsDataUrl(file: File): Promise<ComposerImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result) {
        reject(new Error(`${file.name} 이미지를 읽지 못했습니다.`));
        return;
      }
      resolve({
        id: crypto.randomUUID(),
        name: file.name || `image-${Date.now()}`,
        mime: file.type || "image/*",
        size: file.size,
        content: reader.result,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} 이미지를 읽지 못했습니다.`));
    reader.readAsDataURL(file);
  });
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
  const [remoteScope, setRemoteScope] = useState<RemoteScope | null>(null);
  const [projectSummaries, setProjectSummaries] = useState<ThreadSummary[]>([]);
  const [threadSummaries, setThreadSummaries] = useState<ThreadSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [threadHistory, setThreadHistory] = useState<ThreadHistoryItem[]>([]);
  const [currentThread, setCurrentThread] = useState<ThreadSummary | ThreadRef | null>(null);
  const [composerText, setComposerText] = useState("");
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalPrompt[]>([]);
  const [askRequest, setAskRequest] = useState<AskRequest | null>(null);
  const [respondingApproval, setRespondingApproval] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateThreadDraft>({ cwd: "", model: "" });
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);
  const [threadPanel, setThreadPanel] = useState<"info" | "slash" | "model" | "permissions" | null>(null);
  const [threadModelKeyState, setThreadModelKeyState] = useState<{ key: string; dirty: boolean }>({ key: "", dirty: false });
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const historyRef = useRef<ThreadHistoryItem[]>([]);
  const appRef = useRef<HTMLDivElement | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const nearBottomRef = useRef(true);
  const pendingScrollAdjustRef = useRef<number | null>(null);
  const forceScrollToBottomRef = useRef(false);

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
      const [runtime, settings, providers, usage, models, scope] = await Promise.all([
        bridge.call<RuntimeStatus>("runtime:status"),
        bridge.call<CodexSettings>("settings:load"),
        bridge.call<ProviderSettings>("providers:load"),
        bridge.call<ProviderUsageReport>("providers:usage", { force: true }),
        bridge.call<ProviderModel[]>("codex:models"),
        bridge.call<RemoteScope>("remote:scope").catch(() => ({ restricted: false })),
      ]);
      setRuntimeStatus(runtime);
      setCodexSettings(settings);
      setProviderSettings(providers);
      setUsageReport(usage);
      setCodexModels(models);
      setRemoteScope(scope);
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
    if (route.view !== "thread") return;
    setVisibleHistoryCount(HISTORY_PAGE_SIZE);
    nearBottomRef.current = true;
    forceScrollToBottomRef.current = true;
    setThreadPanel(null);
    setThreadModelKeyState({ key: "", dirty: false });
    setComposerImages([]);
  }, [route.view, route.view === "thread" ? route.threadId : ""]);

  useEffect(() => {
    const container = threadScrollRef.current;
    if (!container || route.view !== "thread") return;
    const onScroll = (): void => {
      nearBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 140;
      setShowScrollToBottom(!nearBottomRef.current);
    };
    onScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [route.view, route.view === "thread" ? route.threadId : "", loadingThread]);

  useLayoutEffect(() => {
    const host = appRef.current;
    if (!host) return;
    const applyBottomMetrics = (): void => {
      host.style.setProperty("--nav-height", `${navRef.current?.offsetHeight ?? 0}px`);
      host.style.setProperty("--composer-height", `${composerWrapRef.current?.offsetHeight ?? 0}px`);
    };
    applyBottomMetrics();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => applyBottomMetrics());
    if (navRef.current) resizeObserver?.observe(navRef.current);
    if (composerWrapRef.current) resizeObserver?.observe(composerWrapRef.current);
    window.addEventListener("resize", applyBottomMetrics);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", applyBottomMetrics);
    };
  }, [route.view, currentThread?.id, busy]);

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 140)}px`;
  }, [composerText]);

  const visibleHistory = useMemo(
    () => threadHistory.slice(Math.max(0, threadHistory.length - visibleHistoryCount)),
    [threadHistory, visibleHistoryCount],
  );
  const hiddenHistoryCount = threadHistory.length - visibleHistory.length;

  function loadMoreHistory(): void {
    pendingScrollAdjustRef.current = threadScrollRef.current?.scrollHeight ?? null;
    setVisibleHistoryCount((count) => count + HISTORY_PAGE_SIZE);
  }

  useLayoutEffect(() => {
    const container = threadScrollRef.current;
    if (!container || pendingScrollAdjustRef.current == null) return;
    const previousHeight = pendingScrollAdjustRef.current;
    pendingScrollAdjustRef.current = null;
    const delta = container.scrollHeight - previousHeight;
    if (delta > 0) container.scrollTop += delta;
  }, [visibleHistory]);

  function scrollThreadToBottom(): void {
    const container = threadScrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    nearBottomRef.current = true;
    setShowScrollToBottom(false);
  }

  useLayoutEffect(() => {
    if (route.view !== "thread" || loadingThread) return;
    if (forceScrollToBottomRef.current) {
      forceScrollToBottomRef.current = false;
      scrollThreadToBottom();
      return;
    }
    if (!nearBottomRef.current) return;
    scrollThreadToBottom();
  }, [route.view, loadingThread, visibleHistory]);

  useEffect(() => {
    historyRef.current = threadHistory;
  }, [threadHistory]);

  const availableModels = useMemo<ModelChoice[]>(() => modelOptions(providerSettings, codexModels), [providerSettings, codexModels]);
  const currentThreadChoice = useMemo<ModelChoice | null>(() => {
    if (!currentThread) return null;
    return {
      model: currentThread.model,
      provider: "provider" in currentThread ? currentThread.provider : undefined,
      accountId: "accountId" in currentThread ? currentThread.accountId : undefined,
    };
  }, [currentThread]);
  const historyChoice = useMemo<ModelChoice | null>(() => latestHistoryChoice(threadHistory), [threadHistory]);
  const settingsChoice = useMemo<ModelChoice | null>(() => {
    if (providerSettings?.model) {
      return {
        provider: providerSettings.provider,
        accountId: providerSettings.accountId,
        model: providerSettings.model,
      };
    }
    if (codexSettings?.model) return { provider: "codex", model: codexSettings.model };
    if (codexModels[0]?.id) return { provider: "codex", model: codexModels[0].id };
    return null;
  }, [providerSettings, codexSettings, codexModels]);
  const threadModelChoices = useMemo<ModelChoice[]>(
    () => uniqueModelChoices([...availableModels, historyChoice, currentThreadChoice, settingsChoice]),
    [availableModels, historyChoice, currentThreadChoice, settingsChoice],
  );
  const preferredThreadModel = useMemo<{ choice: ModelChoice | null; source: "history" | "thread" | "settings" | "fallback" | null }>(() => {
    const candidates = [
      { choice: historyChoice, source: "history" as const },
      { choice: currentThreadChoice, source: "thread" as const },
      { choice: settingsChoice, source: "settings" as const },
    ];
    for (const candidate of candidates) {
      if (!candidate.choice?.model) continue;
      return { choice: matchModelChoice(threadModelChoices, candidate.choice) ?? candidate.choice, source: candidate.source };
    }
    return { choice: threadModelChoices[0] ?? null, source: threadModelChoices[0] ? "fallback" : null };
  }, [threadModelChoices, historyChoice, currentThreadChoice, settingsChoice]);
  const selectedThreadModel = useMemo<ModelChoice | null>(() => {
    if (threadModelKeyState.key) {
      const exact = threadModelChoices.find((option) => modelChoiceKey(option) === threadModelKeyState.key);
      if (exact) return exact;
    }
    return preferredThreadModel.choice;
  }, [threadModelChoices, threadModelKeyState.key, preferredThreadModel.choice]);

  useEffect(() => {
    if (route.view !== "thread") return;
    setThreadModelKeyState((current) => {
      const currentValid = current.key && threadModelChoices.some((option) => modelChoiceKey(option) === current.key);
      if (current.dirty && currentValid) return current;
      const fallbackKey = preferredThreadModel.choice ? modelChoiceKey(preferredThreadModel.choice) : "";
      if (current.key === fallbackKey && current.dirty === false) return current;
      return { key: fallbackKey, dirty: false };
    });
  }, [route.view, threadModelChoices, preferredThreadModel.choice]);

  useEffect(() => {
    if (route.view !== "thread" || !currentThread?.cwd) return;
    void refreshSlashCommands(currentThread.cwd, selectedThreadModel?.model || currentThread.model);
  }, [route.view, currentThread?.cwd, currentThread?.model, selectedThreadModel?.model]);

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
    // PC-side changes (Settings page model/allowlist/approval toggles, provider
    // key or model selection) push here instead of the phone having to poll or
    // wait for its next manual refresh - keeps two open sessions (desktop +
    // phone) in sync without a reconnect.
    const unsubSettings = bridge.subscribe<CodexSettings>("settings:changed", (settings) => {
      setCodexSettings(settings);
      void bridge.call<RemoteScope>("remote:scope").then(setRemoteScope).catch(() => undefined);
      void refreshProjects("");
    });
    const unsubProviders = bridge.subscribe<ProviderSettings>("providers:changed", (settings) => {
      setProviderSettings(settings);
    });
    return () => {
      unsubApp();
      unsubAsk();
      unsubUsage();
      unsubStatus();
      unsubSettings();
      unsubProviders();
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
    if ((event.method === "turn/started" || event.method === "turn/updated") && eventThreadId) {
      if (selectedProject) void refreshThreads(selectedProject);
      void refreshProjects("");
    }
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
    forceScrollToBottomRef.current = true;
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
      forceScrollToBottomRef.current = true;
      setRoute({ view: "thread", threadId: thread.id, cwd: thread.cwd });
      await refreshSlashCommands(thread.cwd, thread.model);
    } catch (error) {
      setBootstrapError(String(error));
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

  async function handleAttachImages(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    event.target.value = "";
    if (!files.length) return;
    const oversized = files.find((file) => file.size > MAX_IMAGE_FILE_BYTES);
    if (oversized) {
      setBootstrapError(`${oversized.name} 파일이 너무 큽니다. 모바일 원격 첨부는 이미지당 최대 8MB까지 지원합니다.`);
      return;
    }
    const nextSize = composerImages.reduce((total, image) => total + image.size, 0) + files.reduce((total, file) => total + file.size, 0);
    if (nextSize > MAX_IMAGE_BATCH_BYTES) {
      setBootstrapError("첨부 이미지 합계가 너무 큽니다. 한 번에 최대 18MB까지 선택할 수 있습니다.");
      return;
    }
    try {
      const images = await Promise.all(files.map((file) => readImageAsDataUrl(file)));
      setComposerImages((current) => [...current, ...images]);
      if (nearBottomRef.current) forceScrollToBottomRef.current = true;
    } catch (error) {
      setBootstrapError(String(error));
    }
  }

  async function sendTurn(): Promise<void> {
    const meta = threadMeta(currentThread);
    const text = composerText.trim();
    const attachments: ThreadAttachment[] = composerImages.map((image) => ({
      name: image.name,
      kind: "image",
      mime: image.mime,
      size: image.size,
      content: image.content,
      url: image.content,
    }));
    const targetModel = selectedThreadModel ?? { provider: meta?.provider, model: meta?.model ?? "", accountId: meta?.accountId };
    if (!meta || (!text && !attachments.length) || !targetModel.model) return;
    const optimistic: ThreadHistoryItem = {
      id: crypto.randomUUID(),
      kind: "user",
      text,
      attachments,
      turnId: `local-${Date.now()}`,
      runtime: meta.runtime,
      provider: targetModel.provider ?? meta.provider,
      model: targetModel.model,
      accountId: targetModel.accountId ?? meta.accountId,
    };
    const next = [...historyRef.current, optimistic];
    historyRef.current = next;
    setThreadHistory(next);
    setComposerText("");
    setComposerImages([]);
    setBusy(true);
    if (nearBottomRef.current) forceScrollToBottomRef.current = true;
    try {
      await bridge.call<void>("turn:send", {
        threadId: currentThread?.id,
        cwd: meta.cwd,
        text,
        model: targetModel.model,
        runtime: meta.runtime,
        provider: targetModel.provider ?? meta.provider,
        accountId: targetModel.accountId ?? meta.accountId,
        attachments: attachments.map((item) => item.content ?? item.url ?? "").filter(Boolean),
        attachmentDetails: attachments,
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

  async function updateRemotePermissions(patch: Partial<Pick<CodexSettings, "approvalPolicy" | "sandboxMode" | "reasoningEffort" | "responseSpeed">>): Promise<void> {
    try {
      const next = await bridge.call<CodexSettings>("settings:update-permissions", patch);
      setCodexSettings(next);
    } catch (error) {
      setBootstrapError(String(error));
    }
  }

  const routeTab = route.view === "thread" ? "thread" : route.view;
  const currentUsageText = usageHeadline(threadHistory);
  const projectGroups = new Map<string, ThreadSummary[]>();
  for (const item of projectSummaries) {
    const bucket = projectGroups.get(item.cwd) ?? [];
    bucket.push(item);
    projectGroups.set(item.cwd, bucket);
  }
  const hasComposerContent = composerText.trim().length > 0 || composerImages.length > 0;
  const modelSourceLabel = preferredThreadModel.source === "history"
    ? "최신 히스토리 기준"
    : preferredThreadModel.source === "thread"
      ? "스레드 메타 기준"
      : preferredThreadModel.source === "settings"
        ? "현재 설정 기준"
        : "사용 가능 모델 기준";

  return (
    <div ref={appRef} className={`mobile-app ${route.view === "thread" ? "thread-app" : ""}`}>
      <div className={`shell ${route.view === "thread" ? "thread-shell" : ""}`}>
        <header className="topbar">
          <div className="topbar-row">
            <div className="brand">
              <div className="brand-mark"><Bot size={18} /></div>
              <div className="title-block">
                <h1>Devil Codex Remote</h1>
                <p>{currentThread ? threadLabel(currentThread) : runtimeStatus?.cwd || "원격 세션 대기"}</p>
              </div>
            </div>
            <button type="button" className="status-pill" onClick={() => void connectRuntime()} disabled={bridgeState.state !== "ready"}>
              <span className={`status-dot ${bridgeState.state}`} />
              <span>{bridgeState.state === "ready" ? "연결됨" : bridgeState.reason ?? bridgeState.state}</span>
            </button>
          </div>
        </header>

        <main className={`content ${route.view === "thread" ? "thread-content" : ""}`}>
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
                {remoteScope?.restricted ? (
                  <>
                    <p className="section-help" style={{ margin: 0 }}>이 기기는 PC의 설정 → 원격 제어 → 허용 스레드에서 지정한 스레드만 볼 수 있습니다.</p>
                    <div className="section-label">
                      허용된 스레드<span className="count">{projectSummaries.length}</span>
                    </div>
                    <div className="list-stack">
                      {projectSummaries.map((thread, index) => (
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
                            setSelectedProject(thread.cwd);
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
                          <div className="muted">{basename(thread.cwd)}</div>
                          <div className="badge-row">
                            <span className="badge accent">{thread.model}</span>
                            {thread.runtime && <span className="badge">{thread.runtime}</span>}
                          </div>
                        </motion.button>
                      ))}
                      {!projectSummaries.length && (
                        <div className="empty-card card">
                          <MessageSquare size={22} />
                          <strong>허용된 스레드 없음</strong>
                          <div className="muted" style={{ whiteSpace: "normal" }}>PC의 설정 → 원격 제어 → 허용 스레드에서 이 기기가 볼 스레드를 먼저 추가하세요.</div>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
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

                    <div className="card row-card glow-card glow-host">
                      <GlowRing />
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
                    <div className="list-stack grid-2">
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
                  </>
                )}
              </motion.section>
            )}

            {route.view === "thread" && (
              <section key="thread" className="section thread-section">
                <div className="thread-layout">
                  {currentThread && (
                    <div className="card thread-toolbar glow-card glow-host">
                      <GlowRing />
                      <div className="thread-summary">
                        <div className="thread-summary-copy">
                          <div className="row-title-group">
                            <div className="row-icon"><MessageSquare size={16} /></div>
                            <span className="row-title">{threadLabel(currentThread) || basename(currentThread.cwd)}</span>
                          </div>
                          <div className="thread-summary-subtitle">{selectedThreadModel ? modelChoiceLabel(selectedThreadModel) : currentThread.model}</div>
                        </div>
                        <div className="thread-summary-side">
                          <span className="tiny">{currentThread.runtime ?? runtimeStatus?.state ?? "-"}</span>
                          <ChevronDown size={16} className={`thread-chevron ${threadPanel ? "open" : ""}`} />
                        </div>
                      </div>

                      <div className="thread-toggle-row">
                        <button
                          type="button"
                          className={`chip thread-toggle ${threadPanel === "info" ? "active" : ""}`}
                          onClick={() => setThreadPanel((current) => current === "info" ? null : "info")}
                        >
                          <Info size={14} />정보
                        </button>
                        <button
                          type="button"
                          className={`chip thread-toggle ${threadPanel === "slash" ? "active" : ""}`}
                          onClick={() => setThreadPanel((current) => current === "slash" ? null : "slash")}
                        >
                          <Sparkles size={14} />스킬
                        </button>
                        <button
                          type="button"
                          className={`chip thread-toggle ${threadPanel === "model" ? "active" : ""}`}
                          onClick={() => setThreadPanel((current) => current === "model" ? null : "model")}
                        >
                          <SlidersHorizontal size={14} />모델
                        </button>
                        <button
                          type="button"
                          className={`chip thread-toggle ${threadPanel === "permissions" ? "active" : ""}`}
                          onClick={() => setThreadPanel((current) => current === "permissions" ? null : "permissions")}
                        >
                          <ShieldCheck size={14} />권한
                        </button>
                      </div>

                      {threadPanel === "info" && (
                        <div className="thread-panel">
                          <div className="thread-panel-info">
                            <div className="muted wrap-anywhere">{currentThread.cwd}</div>
                            <div className="badge-row">
                              <span className="badge accent">{selectedThreadModel?.model ?? currentThread.model}</span>
                              {(selectedThreadModel?.provider || ("provider" in currentThread ? currentThread.provider : undefined)) && (
                                <span className="badge">{selectedThreadModel?.provider ?? ("provider" in currentThread ? currentThread.provider : undefined)}</span>
                              )}
                              {(selectedThreadModel?.accountId || ("accountId" in currentThread ? currentThread.accountId : undefined)) && (
                                <span className="badge">{selectedThreadModel?.accountId ?? ("accountId" in currentThread ? currentThread.accountId : undefined)}</span>
                              )}
                              {currentUsageText && <span className="badge">{currentUsageText}</span>}
                            </div>
                          </div>
                        </div>
                      )}

                      {threadPanel === "slash" && slashCommands.length > 0 && (
                        <div className="thread-panel">
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
                        </div>
                      )}

                      {threadPanel === "model" && (
                        <div className="thread-panel">
                          <select
                            value={selectedThreadModel ? modelChoiceKey(selectedThreadModel) : ""}
                            onChange={(event) => {
                              setThreadModelKeyState({ key: event.target.value, dirty: true });
                            }}
                          >
                            {threadModelChoices.map((item) => (
                              <option key={modelChoiceKey(item)} value={modelChoiceKey(item)}>
                                {modelChoiceLabel(item)}
                              </option>
                            ))}
                          </select>
                          <div className="tiny wrap-anywhere">기본 선택: {modelSourceLabel}</div>
                        </div>
                      )}

                      {threadPanel === "permissions" && (
                        <div className="thread-panel permission-panel">
                          <label>
                            <span>승인</span>
                            <select
                              value={codexSettings?.approvalPolicy ?? "on-request"}
                              onChange={(event) => void updateRemotePermissions({ approvalPolicy: event.target.value })}
                            >
                              <option value="on-request">필요 시 요청</option>
                              <option value="never">항상 허용</option>
                            </select>
                          </label>
                          <label>
                            <span>샌드박스</span>
                            <select
                              value={codexSettings?.sandboxMode ?? "workspace-write"}
                              onChange={(event) => void updateRemotePermissions({ sandboxMode: event.target.value })}
                            >
                              <option value="read-only">읽기 전용</option>
                              <option value="workspace-write">작업공간 쓰기</option>
                              <option value="danger-full-access">전체 권한</option>
                            </select>
                          </label>
                          <label>
                            <span>추론</span>
                            <select
                              value={codexSettings?.reasoningEffort ?? "medium"}
                              onChange={(event) => void updateRemotePermissions({ reasoningEffort: event.target.value as CodexSettings["reasoningEffort"] })}
                            >
                              <option value="low">낮음</option>
                              <option value="medium">보통</option>
                              <option value="high">높음</option>
                              <option value="xhigh">매우 높음</option>
                            </select>
                          </label>
                          <label>
                            <span>응답 속도</span>
                            <select
                              value={codexSettings?.responseSpeed ?? "standard"}
                              onChange={(event) => void updateRemotePermissions({ responseSpeed: event.target.value as CodexSettings["responseSpeed"] })}
                            >
                              <option value="standard">표준</option>
                              <option value="fast">빠름</option>
                            </select>
                          </label>
                          <div className="tiny wrap-anywhere">변경한 권한은 PC 앱과 원격 웹에 WebSocket으로 동기화되고 다음 요청부터 적용됩니다.</div>
                        </div>
                      )}

                      {threadPanel === "slash" && slashCommands.length === 0 && (
                        <div className="thread-panel">
                          <div className="tiny wrap-anywhere">이 스레드에서 사용할 slash command가 아직 없습니다.</div>
                        </div>
                      )}
                    </div>
                  )}

                  <div ref={threadScrollRef} className="thread-scroll">
                    <div className="timeline">
                      {loadingThread && (
                        <div className="empty-card card">
                          <Loader2 size={22} className="spin" />
                          <strong>불러오는 중</strong>
                          <div className="muted" style={{ whiteSpace: "normal" }}>스레드 기록을 읽고 있습니다.</div>
                        </div>
                      )}
                      {!loadingThread && hiddenHistoryCount > 0 && (
                        <button type="button" className="load-more-button" onClick={loadMoreHistory}>
                          <ChevronUp size={14} />이전 대화 더보기 ({hiddenHistoryCount})
                        </button>
                      )}
                      {!loadingThread && visibleHistory.map((item) => (
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
                  </div>
                  <AnimatePresence>
                    {showScrollToBottom && !loadingThread && (
                      <motion.button
                        type="button"
                        className="scroll-to-bottom-button"
                        initial={{ opacity: 0, y: 10, scale: 0.92 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.94 }}
                        transition={{ duration: 0.16 }}
                        onClick={scrollThreadToBottom}
                        aria-label="맨 아래로 이동"
                        title="맨 아래로 이동"
                      >
                        <ArrowDown size={18} />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </section>
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
          <div ref={composerWrapRef} className="composer-wrap">
            <div className="composer card">
              <input
                ref={attachmentInputRef}
                className="composer-file-input"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => void handleAttachImages(event)}
              />
              {composerImages.length > 0 && (
                <div className="composer-attachments">
                  {composerImages.map((image) => (
                    <div key={image.id} className="composer-attachment">
                      <img src={image.content} alt={image.name} className="composer-thumb" />
                      <button
                        type="button"
                        className="composer-remove"
                        onClick={() => setComposerImages((current) => current.filter((item) => item.id !== image.id))}
                        aria-label={`${image.name} 제거`}
                      >
                        <XCircle size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="composer-main">
                <motion.button
                  whileTap={{ scale: 0.94 }}
                  type="button"
                  className="composer-attach"
                  onClick={() => attachmentInputRef.current?.click()}
                  title="이미지 첨부"
                >
                  <Paperclip size={16} />
                  <span>{composerImages.length ? `${composerImages.length}` : ""}</span>
                </motion.button>
                <textarea
                  ref={composerInputRef}
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
                  <motion.button whileTap={{ scale: 0.9 }} type="button" className="composer-send" onClick={() => void sendTurn()} disabled={!hasComposerContent} title="보내기">
                    <Send size={17} />
                  </motion.button>
                )}
              </div>
            </div>
          </div>
        )}

        <nav ref={navRef} className="nav">
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

const MessageBlock = memo(function MessageBlock({ item }: { item: ThreadHistoryItem }): React.JSX.Element {
  const kind = item.kind === "user" ? "user" : item.kind === "agent" ? "agent" : "system";
  const label = kind === "user" ? "나" : kind === "agent" ? "에이전트" : item.title || "시스템";
  const Icon = kind === "user" ? CircleUserRound : kind === "agent" ? Bot : Terminal;
  const imageAttachments = (item.attachments ?? []).map((attachment) => ({
    name: attachment.name,
    src: attachmentPreview(attachment),
  })).filter((attachment): attachment is { name: string; src: string } => Boolean(attachment.src));
  return (
    <div className={`msg-row ${kind}`}>
      <div className="msg-avatar"><Icon size={15} /></div>
      <div className="bubble">
        <div className="msg-meta">
          <strong>{label}</strong>
          {(item.model || item.runtime) && <span>· {item.model || item.runtime}</span>}
        </div>
        {messageText(item) ? <MobileMarkdown text={messageText(item)} /> : (!imageAttachments.length && <div className="msg-body">(비어 있음)</div>)}
        {imageAttachments.length > 0 && (
          <div className="message-attachments">
            {imageAttachments.map((attachment, index) => (
              <img key={`${item.id}:${index}`} src={attachment.src} alt={attachment.name} className="message-thumb" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

const ActivityBlock = memo(function ActivityBlock({ item }: { item: ThreadHistoryItem }): React.JSX.Element {
  const totalTokens = item.cumulativeTokenUsage?.totalTokens ?? item.tokenUsage?.totalTokens;
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const entry of item.activities ?? []) initial[entry.id] = entry.status === "failed" || entry.status === "inProgress";
    return initial;
  });
  return (
    <article className="card activity-card">
      <div className="split-line">
        <span className="section-label" style={{ padding: 0 }}>작업 흐름</span>
        <span className="tiny">{item.status ?? "completed"}</span>
      </div>
      {(item.activities ?? []).map((entry) => {
        const hasDetails = Boolean(entry.detail || entry.output || entry.files?.length || entry.images?.length);
        const expanded = hasDetails ? Boolean(expandedIds[entry.id]) : false;
        return (
          <div key={entry.id} className={`activity-entry ${entry.status ?? "completed"}${expanded ? " expanded" : ""}`}>
            <button
              type="button"
              className={`entry-head ${hasDetails ? "entry-toggle" : ""}`}
              onClick={() => {
                if (!hasDetails) return;
                setExpandedIds((current) => ({ ...current, [entry.id]: !current[entry.id] }));
              }}
              disabled={!hasDetails}
              aria-expanded={hasDetails ? expanded : undefined}
            >
              <span className="entry-title">
                {entry.status === "failed" ? <XCircle size={14} /> : entry.status === "inProgress" ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                {entry.title}
              </span>
              <span className="entry-meta">
                <span className="tiny">{entry.kind}</span>
                {hasDetails && <ChevronDown size={14} className={`entry-chevron ${expanded ? "open" : ""}`} />}
              </span>
            </button>
            {expanded && entry.detail && <div className="entry-detail">{entry.detail}</div>}
            {expanded && entry.output && <div className="entry-detail">{entry.output}</div>}
            {expanded && entry.files?.length ? (
              <div className="file-list">
                {entry.files.map((file) => (
                  <div key={`${entry.id}:${file.path}`} className="tiny">{file.path} (+{file.additions}/-{file.deletions})</div>
                ))}
              </div>
            ) : null}
            {expanded && entry.images?.length ? (
              <div className="image-strip">
                {entry.images.map((src, index) => <img key={`${entry.id}:${index}`} src={src} alt={entry.title} />)}
              </div>
            ) : null}
          </div>
        );
      })}
      {(item.contextUsage || totalTokens) && (
        <div className="badge-row">
          {item.contextUsage && <span className="badge">컨텍스트 {item.contextUsage.usedTokens.toLocaleString()} / {item.contextUsage.maxTokens.toLocaleString()}</span>}
          {totalTokens && <span className="badge">토큰 {totalTokens.toLocaleString()}</span>}
        </div>
      )}
    </article>
  );
});

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
