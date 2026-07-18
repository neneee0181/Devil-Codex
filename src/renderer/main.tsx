import { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  Archive, ArrowDown, ArrowLeft, ArrowRight, Bell, Blocks, Bot, Check, ChevronDown, ChevronRight, CirclePlus, CircleUser, CloudOff, ExternalLink,
  Clock, CloudCog, Code2, Copy, Download, FileText, Folder, FolderOpen, GitBranch, GitFork, Globe2, Laptop, Loader2, MessageSquarePlus,
  Maximize2, Minimize2, Minus, MoreHorizontal, NotebookText, PanelBottom, PanelLeftClose, PanelLeftOpen, PanelRight, Pencil, Pin, PinOff, Plus, Search, SearchCode,
  Settings, Share2, SlidersHorizontal, Square, SquarePen, SquareTerminal, Target, Trash2, UploadCloud, X,
} from "lucide-react";
import type { AgentRuntimeId, AppInfo, ApprovalDecision, ApprovalPrompt, AppServerEvent, ApprovalResolvedEvent, ClaudeSlashCommandInfo, CodexSettings, CodexSkillInfo, ContextUsage, ExternalTarget, GitBranchInfo, McpServerInfo, OpenWorkspaceTarget, ProviderId, ProviderInfo, ProviderRequestLogEntry, ProviderTokenUsage, ProviderUsageEntry, QueuedTurnView, ReasoningEffort, ResponseSpeed, RuntimeStatus, SidecarSettings, ThreadActivityEntry, ThreadAttachment, ThreadHistoryItem, ThreadMetaUpdate, ThreadQueueCommand, ThreadQueueState, ThreadRef, ThreadSummary, UpdateState, WindowControlAction, WorkspaceChange, WorkspaceChanges, WorkspaceDiff } from "../shared/contracts";
import { SettingsView } from "./SettingsView";
import { useProviderUsage } from "./hooks/useProviderUsage";
import { Composer, type ComposerInput } from "./components/Composer";
import type { ApprovalMode } from "./components/ApprovalPicker";
import { UtilityPanel } from "./components/UtilityPanel";
import { BottomDock } from "./components/BottomDock";
import type { ToolKind } from "./components/ToolLauncherMenu";
import { TimelineCard } from "./components/TimelineCard";
import { ArchivedThreadsView } from "./components/ArchivedThreadsView";
import type { SlashCommandId } from "./components/ComposerSuggestions";
import { ApprovalRequestDialog } from "./components/ApprovalRequestDialog";
import { AskUserModal } from "./components/AskUserModal";
import { GitWorkflowDialog } from "./components/GitWorkflowDialog";
import { WorktreeDialog } from "./components/WorktreeDialog";
import codexRuntimeIcon from "./assets/codex-runtime.png";
import claudeRuntimeIcon from "./assets/claude-runtime.png";
import { IntegrationsView } from "./components/IntegrationsView";
import { CommandPalette, type CommandId } from "./components/CommandPalette";
import { ThreadFind } from "./components/ThreadFind";
import { useDismissShellPopovers } from "./hooks/useOutsideDismiss";
import { useProviders } from "./hooks/useProviders";
import { useCodexSettings } from "./hooks/useCodexSettings";
import { approvalPromptFromEvent } from "./approvalRequests";
import { applyTimelineEvent } from "./threadTimeline";
import { estimateProviderUsageCost } from "./providerPricing";
import { isPrimaryModifier, shortcut } from "./shortcuts";
import "./styles.css";

type AppView = "thread" | "search" | "archive" | "sites" | "plugins" | "automations" | "settings";
type SiteCard = { id: string; name: string; url: string; access: string; updated: string };
type NavigationEntry = { view: AppView; runtime: AgentRuntimeId; thread: ThreadRef | null; workspace: string; items: ThreadHistoryItem[]; projectDraft: boolean; environmentOpen: boolean; settingsSection: string; search: string };
type TextPromptState = { title: string; label: string; initialValue: string; placeholder?: string; confirmLabel: string; resolve: (value: string | null) => void };
type ProjectSortMode = "manual" | "created" | "updated";
type SidebarLayoutMode = "project" | "recent" | "timeline" | "projectsDown";
type EnvironmentSource = { url: string; label: string };
type ShellMenuKey = "file" | "edit" | "view" | "help";
type SentModelState = { provider: ProviderId; accountId?: string; model: string };
type NotificationSettings = { notificationsEnabled: boolean; notifyOnTurnComplete: boolean; notifyOnApproval: boolean; notifyOnAsk: boolean };

const THREAD_STATE_RUNTIMES: AgentRuntimeId[] = ["codex", "claude-code"];
const NOTIFICATION_DEFAULTS: NotificationSettings = {
  notificationsEnabled: true,
  notifyOnTurnComplete: true,
  notifyOnApproval: true,
  notifyOnAsk: true,
};

function emptyThreadStateId(workspace: string, projectDraft: boolean): string {
  return `${projectDraft ? "project-draft" : "new-chat"}:${cwdKey(workspace) || "__none__"}`;
}

// Mirror of the composer's persisted approval mode (Composer APPROVAL_MODE_KEY).
// Read here so side chats can reuse the same mode the user picked in the main
// composer instead of silently falling back to the runtime defaults.
function storedComposerApprovalMode(): "ask" | "agent" | "full" {
  const value = typeof localStorage === "undefined" ? null : localStorage.getItem("devil-codex:approval-mode");
  return value === "ask" || value === "agent" || value === "full" ? value : "agent";
}

function sideChatPermissionsForMode(mode: "ask" | "agent" | "full"): { approvalPolicy: import("../shared/contracts").ThreadApprovalPolicy; sandboxMode: import("../shared/contracts").ThreadSandboxMode } {
  if (mode === "full") return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
  if (mode === "ask") return { approvalPolicy: "on-request", sandboxMode: "read-only" };
  return { approvalPolicy: "on-request", sandboxMode: "workspace-write" };
}

function threadStateKey(runtime: AgentRuntimeId, threadId?: string | null, emptyStateId = "__none__"): string {
  return `${runtime}:${threadId ?? emptyStateId}`;
}

function threadStateKeys(threadId: string): string[] {
  return [...THREAD_STATE_RUNTIMES.map((runtime) => threadStateKey(runtime, threadId)), threadId];
}

function retargetThreadStateKey(key: string, fromThreadId: string, toThreadId: string): string {
  for (const runtime of THREAD_STATE_RUNTIMES) {
    const prefix = `${runtime}:`;
    if (key === `${prefix}${fromThreadId}`) return `${prefix}${toThreadId}`;
  }
  return key === fromThreadId ? toThreadId : key;
}

function runWhenIdle(callback: () => void): void {
  const requestIdle = (window as Window & {
    requestIdleCallback?: (handler: IdleRequestCallback, options?: IdleRequestOptions) => number;
  }).requestIdleCallback;
  if (requestIdle) {
    requestIdle(() => callback(), { timeout: 1800 });
    return;
  }
  window.setTimeout(callback, 700);
}

function useStableEvent<T extends (...args: any[]) => unknown>(handler: T): T {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => { handlerRef.current = handler; });
  return useMemo(() => ((...args: Parameters<T>) => handlerRef.current(...args)) as T, []);
}

function readNotificationSettings(): NotificationSettings {
  try {
    const saved = JSON.parse(localStorage.getItem("devil-codex:settings") ?? "{}") as Partial<NotificationSettings>;
    return { ...NOTIFICATION_DEFAULTS, ...saved };
  } catch {
    return NOTIFICATION_DEFAULTS;
  }
}

const CLAUDE_RUNTIME_SKILLS: CodexSkillInfo[] = [
  {
    name: "browser-use",
    description: "Devil 내장 브라우저 MCP를 사용해 페이지 이동, 읽기, 클릭, 입력을 수행합니다.",
    path: "devil://claude-runtime/browser-use",
    scope: "devil",
    enabled: true,
  },
  {
    name: "computer-use",
    description: "Devil Computer Use MCP를 사용해 화면 확인, 마우스, 키보드 조작을 수행합니다.",
    path: "devil://claude-runtime/computer-use",
    scope: "devil",
    enabled: true,
  },
];

function claudeRuntimeSkillPrompt(skillNames: string[], skillOptions: CodexSkillInfo[] = []): string {
  const names = new Set(skillNames);
  const lines: string[] = [];
  if (names.has("browser-use")) {
    lines.push("사용자가 /browser-use를 선택했습니다. WebFetch 대신 Devil MCP 서버 `devil_browser`의 브라우저 도구를 사용하세요. 사용 가능한 도구는 `browser_navigate`, `browser_read`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`이며, SDK에서 `mcp__devil_browser__browser_navigate` 같은 이름으로 보일 수 있습니다.");
  }
  if (names.has("computer-use")) {
    lines.push("사용자가 /computer-use를 선택했습니다. OS 화면 확인이나 마우스/키보드 조작이 필요하면 Devil MCP 서버 `devil_computer`의 도구를 사용하세요. 사용 가능한 도구는 `computer_screenshot`, `computer_click`, `computer_move`, `computer_type`, `computer_key`, `computer_scroll`, `computer_list_windows`이며, 사용자의 명시 요청 범위 안에서만 조작하세요.");
  }
  for (const skillName of skillNames) {
    if (skillName === "browser-use" || skillName === "computer-use" || skillName.startsWith("mcp:")) continue;
    const skill = skillOptions.find((item) => item.name === skillName);
    if (skill?.path) lines.push(`사용자가 $${skill.name} 스킬을 선택했습니다. 필요하면 이 스킬 지침 파일을 먼저 읽고 따르세요: ${skill.path}`);
  }
  return lines.length ? `[Devil Claude Code runtime tool instructions]\n${lines.join("\n")}\n\n` : "";
}

function pluginNameForSkill(skill: CodexSkillInfo): string | null {
  if (skill.scope !== "plugin") return null;
  return skill.name.split(":", 1)[0] || skill.name;
}

function requestsDevilEmbeddedBrowser(text: string): boolean {
  return /(?:devil|데빌)\s*(?:codex)?\s*(?:의|내|안의)?\s*(?:내장|우측)?\s*(?:브라우저|browser)|(?:내장|우측)\s*(?:브라우저|browser)/i.test(text);
}
type ThreadScrollPosition = { top: number; atBottom: boolean; updatedAt: number };

const defaultStatus: RuntimeStatus = {
  state: "ready",
  detail: "Codex runtime 확인 중",
  cwd: "",
};

const defaultChanges: WorkspaceChanges = {
  available: true,
  files: [],
  branch: "",
  additions: 0,
  deletions: 0,
};

type ProjectThreadGroup = { cwd: string; name: string; threads: ThreadSummary[] };

function sameThreadSummary(a: ThreadSummary, b: ThreadSummary): boolean {
  return a.id === b.id
    && a.cwd === b.cwd
    && a.model === b.model
    && a.runtime === b.runtime
    && a.provider === b.provider
    && a.accountId === b.accountId
    && a.accountLabel === b.accountLabel
    && a.claudeSessionId === b.claudeSessionId
    && a.title === b.title
    && a.preview === b.preview
    && a.updatedAt === b.updatedAt
    && a.archived === b.archived;
}

function sameThreadSummaryList(a: ThreadSummary[], b: ThreadSummary[]): boolean {
  return a.length === b.length && a.every((item, index) => sameThreadSummary(item, b[index]));
}

function sameProjectThreadGroups(a: ProjectThreadGroup[], b: ProjectThreadGroup[]): boolean {
  return a.length === b.length
    && a.every((group, index) => group.cwd === b[index].cwd
      && group.name === b[index].name
      && sameThreadSummaryList(group.threads, b[index].threads));
}

const SIDE_CHAT_NAMES = ["Laplace", "Curie", "Euler", "Gauss", "Turing", "Lovelace", "Hopper", "Tesla", "Newton", "Fermi", "Bohr", "Pascal", "Fourier", "Riemann", "Noether", "Maxwell", "Planck", "Feynman", "Ada", "Hilbert"];
const LAST_SENT_MODELS_KEY = "devil-codex:last-sent-models";
const THREAD_SCROLL_POSITIONS_KEY = "devil-codex:thread-scroll-positions";
const PET_VISIBLE_KEY = "devil-codex:pet-visible";
const AGENT_RUNTIME_KEY = "devil-codex:agent-runtime";
const STEERING_PREFIX = [
  "[스티어링 지시]",
  "이 메시지는 진행 중이던 작업을 중간에 끊고 사용자가 새로 준 방향입니다.",
  "단순 질의응답으로 끝내지 말고, 바로 이전에 진행 중이던 작업의 목표를 계속 수행하면서 아래 지시를 반영하세요.",
  "필요한 파일 수정, 도구 실행, 검증까지 이어서 진행하세요.",
  "",
  "[사용자 스티어링]",
].join("\n");
const CLAUDE_PROVIDER_KEY = "devil-codex:claude-provider";
const CLAUDE_ACCOUNT_KEY = "devil-codex:claude-account";
const CLAUDE_MODEL_KEY = "devil-codex:claude-model";
const COMPOSER_CONFIGS_KEY = "devil-codex:composer-configs";
const RUNNING_TURNS_KEY = "devil-codex:running-turns";
const ENVIRONMENT_SOURCE_TURN_LIMIT = 8;
const ENVIRONMENT_SOURCE_LIMIT = 8;
const ENVIRONMENT_USAGE_MODEL_PREVIEW_LIMIT = 4;

function readThreadScrollPositions(): Record<string, ThreadScrollPosition> {
  try {
    const raw = JSON.parse(localStorage.getItem(THREAD_SCROLL_POSITIONS_KEY) ?? "{}") as Record<string, ThreadScrollPosition>;
    return Object.fromEntries(Object.entries(raw).filter(([threadId, value]) => threadId && Number.isFinite(value?.top)));
  } catch {
    return {};
  }
}

function writeThreadScrollPositions(input: Record<string, ThreadScrollPosition>): void {
  try {
    const compact = Object.fromEntries(Object.entries(input).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, 120));
    localStorage.setItem(THREAD_SCROLL_POSITIONS_KEY, JSON.stringify(compact));
  } catch {
    // Losing scroll persistence is better than breaking chat navigation.
  }
}

function readPersistedRunningTurns(): Record<string, { turnId?: string; startedAt: number }> {
  try {
    // Main-process turns only survive a renderer reload (Ctrl+R). After a full
    // app restart the persisted entries are dead turns, so drop them.
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigation?.type !== "reload") {
      localStorage.removeItem(RUNNING_TURNS_KEY);
      return {};
    }
    const raw = JSON.parse(localStorage.getItem(RUNNING_TURNS_KEY) ?? "{}") as Record<string, { turnId?: string; startedAt: number }>;
    const cutoff = Date.now() - 1000 * 60 * 60 * 6;
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => Number(value?.startedAt) > cutoff));
  } catch {
    return {};
  }
}

function writePersistedRunningTurns(input: Record<string, { turnId?: string; startedAt: number }>): void {
  try { localStorage.setItem(RUNNING_TURNS_KEY, JSON.stringify(input)); }
  catch { /* Losing running-state restore is acceptable. */ }
}

function readSidecarSettings(): SidecarSettings {
  try {
    const raw = JSON.parse(localStorage.getItem("devil-codex:settings") ?? "{}") as Record<string, unknown>;
    const nvidiaRateLimitRpm = raw.nvidiaRateLimitRpm === undefined ? 40 : Math.max(0, Math.floor(Number(raw.nvidiaRateLimitRpm) || 0));
    return {
      webSearch: raw.sidecarWebSearch === true,
      vision: raw.sidecarVision === true,
      webSearchLimit: Number(raw.sidecarWebSearchLimit ?? 3) || 3,
      visionLimit: Number(raw.sidecarVisionLimit ?? 3) || 3,
      nvidiaRateLimitRpm,
    };
  } catch {
    return { webSearch: false, vision: false, webSearchLimit: 3, visionLimit: 3, nvidiaRateLimitRpm: 40 };
  }
}

function attachmentContextForModel(attachments: ThreadAttachment[]): string {
  if (!attachments.length) return "";
  const lines: string[] = ["", "", "첨부 파일:"];
  for (const item of attachments) {
    const label = item.path || item.name;
    lines.push(`- ${label}`);
    if (item.kind === "file" && item.content) {
      lines.push("", `첨부 텍스트 파일 ${item.name} 내용:`, "```text", item.content, "```");
    }
  }
  return lines.join("\n");
}

function displayAttachments(attachments: ThreadAttachment[]): ThreadAttachment[] {
  return attachments.map((item) => ({
    kind: item.kind,
    name: item.name,
    path: item.path,
    url: item.url,
    mime: item.mime,
    size: item.size,
    content: item.content,
  }));
}

function basenamePath(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized || "프로젝트 선택";
}

function isProjectlessThread(summary: Pick<ThreadSummary, "cwd" | "projectless">): boolean {
  return summary.projectless === true || !cwdKey(summary.cwd) || basenamePath(summary.cwd) === "new-chat";
}

function cwdKey(value: string | undefined): string {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function modelContextWindow(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes("gpt-5") || lower.includes("5.5") || lower.includes("5.4")) return 258_400;
  if (lower.includes("claude") || /\b(sonnet|opus|haiku|fable)\b/.test(lower)) return 200_000;
  if (lower.includes("gemini")) return 1_000_000;
  return 128_000;
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const ascii = (text.match(/[\x00-\x7F]/g) ?? []).length;
  const nonAscii = text.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 1.6);
}

function hasCompactionEntry(item: ThreadHistoryItem): boolean {
  return item.activities?.some((activity) => activity.kind === "compaction") ?? false;
}

function estimatedContextItemsAfterCompaction(items: ThreadHistoryItem[], compactionIndex: number): ThreadHistoryItem[] {
  if (compactionIndex < 0) return items;
  const afterCompaction = items.slice(compactionIndex + 1);
  for (let index = compactionIndex - 1; index >= 0; index -= 1) {
    if (items[index].kind === "user") return [items[index], ...afterCompaction];
  }
  return afterCompaction;
}

function estimateContextUsage(items: ThreadHistoryItem[], model: string): ContextUsage | undefined {
  let lastCompactionIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (hasCompactionEntry(items[index])) {
      lastCompactionIndex = index;
      break;
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (index <= lastCompactionIndex) break;
    const usage = items[index].contextUsage;
    if (usage?.usedTokens && usage.maxTokens) return usage;
  }
  const contextItems = estimatedContextItemsAfterCompaction(items, lastCompactionIndex);
  const used = contextItems.reduce((sum, item) => {
    const activityText = (item.activities ?? []).map((activity) => `${activity.title}\n${activity.detail ?? ""}\n${activity.output ?? ""}`).join("\n");
    const attachmentText = (item.attachments ?? []).map((attachment) => `${attachment.name}\n${attachment.content ?? ""}`).join("\n");
    return sum + estimateTextTokens(`${item.title ?? ""}\n${item.text}\n${activityText}\n${attachmentText}`);
  }, 0);
  return used > 0 ? { usedTokens: used, maxTokens: modelContextWindow(model), source: "renderer-estimate", scope: "visible-thread-estimate", includesCache: false } : undefined;
}

function storedReasoningEffort(): ReasoningEffort {
  const value = localStorage.getItem("devil-codex:reasoning-effort");
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : "medium";
}

function storedResponseSpeed(): ResponseSpeed {
  return localStorage.getItem("devil-codex:response-speed") === "fast" ? "fast" : "standard";
}

function storedAgentRuntime(): AgentRuntimeId {
  return localStorage.getItem(AGENT_RUNTIME_KEY) === "claude-code" ? "claude-code" : "codex";
}

function storedClaudeModel(): string {
  return localStorage.getItem(CLAUDE_MODEL_KEY) || "claude-sonnet-5";
}

function storedClaudeProvider(): ProviderId {
  return (localStorage.getItem(CLAUDE_PROVIDER_KEY) as ProviderId | null) || "claude-code";
}

function storedClaudeAccount(): string | undefined {
  return localStorage.getItem(CLAUDE_ACCOUNT_KEY) || undefined;
}

type ComposerConfigSnapshot = {
  runtime?: AgentRuntimeId;
  provider?: ProviderId;
  accountId?: string;
  model?: string;
  approvalPolicy?: import("../shared/contracts").ThreadApprovalPolicy;
  sandboxMode?: import("../shared/contracts").ThreadSandboxMode;
  reasoningEffort?: ReasoningEffort;
  responseSpeed?: ResponseSpeed;
  planMode?: boolean;
  updatedAt: number;
};

function readComposerConfigs(): Record<string, ComposerConfigSnapshot> {
  try {
    const raw = JSON.parse(localStorage.getItem(COMPOSER_CONFIGS_KEY) ?? "{}") as Record<string, ComposerConfigSnapshot>;
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key && (typeof value?.model === "string" || value?.planMode === true)));
  } catch {
    return {};
  }
}

function writeComposerConfigs(input: Record<string, ComposerConfigSnapshot>): void {
  try {
    const compact = Object.fromEntries(Object.entries(input).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, 160));
    localStorage.setItem(COMPOSER_CONFIGS_KEY, JSON.stringify(compact));
  } catch {
    // Composer config persistence is best-effort. Losing it should not block chat.
  }
}

function transferContextFromHistory(items: ThreadHistoryItem[]): string {
  const rows = items
    .filter((item) => item.kind === "user" || item.kind === "agent" || item.kind === "system")
    .slice(-24)
    .map((item) => {
      const role = item.kind === "user" ? "User" : item.kind === "agent" ? "Assistant" : `System${item.title ? `: ${item.title}` : ""}`;
      return `### ${role}\n${(item.text ?? "").trim()}`;
    })
    .filter((row) => row.trim().length > 0);
  const text = rows.join("\n\n").trim();
  return text.length > 24000 ? `${text.slice(-24000).trimStart()}\n\n[앞부분은 길이 제한으로 생략됨]` : text;
}

function storedPetVisible(): boolean {
  return localStorage.getItem(PET_VISIBLE_KEY) === "true";
}

function formatTokenShort(value: number | undefined): string {
  if (!Number.isFinite(value ?? NaN)) return "-";
  const numeric = Number(value);
  if (numeric >= 1_000_000) return `${Math.round(numeric / 100_000) / 10}M`;
  if (numeric >= 1_000) return `${Math.round(numeric / 100) / 10}k`;
  return String(Math.round(numeric));
}

function reasoningEffortLabel(value: ReasoningEffort): string {
  if (value === "low") return "낮음";
  if (value === "high") return "높음";
  if (value === "xhigh") return "매우 높음";
  return "중간";
}

function responseSpeedLabel(value: ResponseSpeed): string {
  return value === "fast" ? "고속" : "표준";
}

function providerReady(provider: ProviderInfo | null, runtimeState: RuntimeStatus["state"]): boolean {
  if (!provider) return false;
  if (provider.id === "codex") return runtimeState === "connected";
  return provider.accounts.some((account) => account.credentialSource !== "none") && provider.modelsLoaded;
}

function readLastSentModels(): Record<string, SentModelState> {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_SENT_MODELS_KEY) ?? "{}") as Record<string, SentModelState>;
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => value?.provider && value?.model));
  } catch {
    return {};
  }
}

function modelKey(value: SentModelState): string {
  return `${value.provider}:${value.accountId ?? "default"}:${value.model}`;
}

function agentMessageKey(item: ThreadHistoryItem): string {
  return `agent:${item.turnId ?? ""}:${item.text.trim()}`;
}

function hasAgentMessageForTurn(items: ThreadHistoryItem[], turnId: string): boolean {
  return items.some((item) => item.kind === "agent" && item.turnId === turnId && item.text.trim());
}

function removeMissingFinalNoticeForTurn(items: ThreadHistoryItem[], turnId: string): ThreadHistoryItem[] {
  if (!turnId || !hasAgentMessageForTurn(items, turnId)) return items;
  const next = items.filter((item) => item.id !== `missing-final-${turnId}`);
  return next.length === items.length ? items : next;
}

function removeStaleMissingFinalNotices(items: ThreadHistoryItem[]): ThreadHistoryItem[] {
  const turnsWithAgent = new Set(items.filter((item) => item.kind === "agent" && item.turnId && item.text.trim()).map((item) => item.turnId!));
  if (!turnsWithAgent.size) return items;
  const next = items.filter((item) => !item.id.startsWith("missing-final-") || !item.turnId || !turnsWithAgent.has(item.turnId));
  return next.length === items.length ? items : next;
}

function appendMissingAgentMessagesForTurn(local: ThreadHistoryItem[], synced: ThreadHistoryItem[], turnId: string): ThreadHistoryItem[] {
  if (!turnId) return local;
  const seen = new Set(local.filter((item) => item.kind === "agent").map(agentMessageKey));
  const missing = synced.filter((item) => item.kind === "agent" && item.turnId === turnId && item.text.trim() && !seen.has(agentMessageKey(item)));
  return missing.length ? [...local, ...missing] : local;
}

function removeAgentMessagesForTurn(items: ThreadHistoryItem[], turnId: string): ThreadHistoryItem[] {
  if (!turnId) return items;
  const next = items.filter((item) => !(item.kind === "agent" && item.turnId === turnId));
  return next.length === items.length ? items : next;
}

function removeInterruptedTurnItems(items: ThreadHistoryItem[], turnId: string): ThreadHistoryItem[] {
  if (!turnId) return items;
  const next = items.filter((item) => !((item.kind === "activity" || item.kind === "agent") && item.turnId === turnId));
  return next.length === items.length ? items : next;
}

function latestInterruptibleTurnId(items: ThreadHistoryItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "activity" && item.status === "inProgress" && item.turnId) return item.turnId;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "activity" && item.activities?.some((entry) => entry.status === "inProgress") && item.turnId) return item.turnId;
  }
  return "";
}

function timelineItemKey(item: ThreadHistoryItem): string {
  if (item.kind === "user") return userTimelineKey(item);
  if (item.kind === "activity" && item.turnId) return `activity:${item.turnId}`;
  if (item.kind === "agent") return agentMessageKey(item);
  if (item.id) return item.id;
  return `${item.kind}:${item.turnId ?? ""}:${item.text ?? ""}`;
}

function normalizedUserText(text: string): string {
  let value = text.trim();
  const marker = "[수정된 사용자 메시지]";
  if (value.includes(marker)) value = value.slice(value.lastIndexOf(marker) + marker.length).trim();
  const newRequest = "[새 요청]";
  if (value.includes(newRequest)) value = value.slice(value.lastIndexOf(newRequest) + newRequest.length).trim();
  value = value.replace(/^\[Devil Claude Code runtime tool instructions\][\s\S]*?\n\n/, "");
  value = value.replace(/^\[플러그인 스킬\][\s\S]*?\n\n/, "");
  value = value.replace(/^\[연결된 플러그인\/MCP 언급\][\s\S]*?\n\n/, "");
  value = value.replace(/^\[이전 런타임에서 전달된 대화\][\s\S]*?\[새 요청\]\s*/, "");
  value = value.replace(/\n+\[첨부 파일 컨텍스트\][\s\S]*$/m, "");
  value = value.replace(/\n+첨부 파일:\s*(?:\n- [^\n]+)+\s*$/m, "");
  value = value.replace(/^(?:\$[^\s]+|\/[^\s]+)(?:[ \t]+(?:\$[^\s]+|\/[^\s]+))*\s*\n+/, "");
  return value.replace(/\s+/g, " ").trim();
}

function userTimelineKey(item: ThreadHistoryItem): string {
  return `user:${normalizedUserText(item.text)}`;
}

function attachmentMergeKey(attachment: NonNullable<ThreadHistoryItem["attachments"]>[number]): string {
  const locator = attachment.path ?? attachment.url ?? "";
  if (locator) return `${attachment.kind}:loc:${locator}`;
  const stem = attachment.name.trim().toLowerCase().replace(/\.[a-z0-9]+$/i, "");
  return `${attachment.kind}:name:${stem}:${attachment.size ?? ""}`;
}

function mergeAttachments(
  base: ThreadHistoryItem["attachments"],
  overlay: ThreadHistoryItem["attachments"],
): ThreadHistoryItem["attachments"] {
  if (!base?.length) return overlay;
  if (!overlay?.length) return base;
  const result = [...base];
  const seen = new Set(result.map(attachmentMergeKey));
  for (const attachment of overlay) {
    const key = attachmentMergeKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(attachment);
  }
  return result;
}

function userDisplayTextScore(text: string): number {
  let score = text.trim().length ? 10 : 0;
  if (/^\[(?:Devil Claude Code runtime tool instructions|플러그인 스킬|연결된 플러그인\/MCP 언급|이전 런타임에서 전달된 대화|첨부 파일 컨텍스트)\]/.test(text.trim())) score -= 20;
  if (normalizedUserText(text) === text.replace(/\s+/g, " ").trim()) score += 5;
  return score;
}

function mergeUserText(current: string, incoming: string): string {
  const currentScore = userDisplayTextScore(current);
  const incomingScore = userDisplayTextScore(incoming);
  if (incomingScore > currentScore) return incoming;
  if (currentScore > incomingScore) return current;
  return current.length >= incoming.length ? current : incoming;
}

function isAttachmentModelContext(text: string, attachments: ThreadAttachment[] | undefined): boolean {
  if (!text || !attachments?.length || !text.includes("첨부 파일:")) return false;
  return attachments.some((attachment) => {
    const label = attachment.path || attachment.name;
    return Boolean(label && text.includes(`- ${label}`))
      || (attachment.kind === "file" && text.includes(`첨부 텍스트 파일 ${attachment.name} 내용:`));
  });
}

function mergeTimelineItem(current: ThreadHistoryItem, item: ThreadHistoryItem): ThreadHistoryItem {
  if (current.kind === "activity" && item.kind === "activity") {
    return {
      ...current,
      ...item,
      text: item.text || current.text,
      activities: mergeActivityEntries(current.activities, item.activities),
      status: item.status ?? current.status,
      contextUsage: item.contextUsage ?? current.contextUsage,
      tokenUsage: item.tokenUsage ?? current.tokenUsage,
      cumulativeTokenUsage: item.cumulativeTokenUsage ?? current.cumulativeTokenUsage,
    };
  }
  if (current.kind === "user" && item.kind === "user") {
    const incomingIsAttachmentContext = isAttachmentModelContext(item.text, current.attachments);
    return {
      ...current,
      ...item,
      // The app-server echoes the model-bound attachment context after a turn.
      // Keep the compact attachment-card presentation instead of replacing the
      // user's visible message with the entire pasted file body.
      text: incomingIsAttachmentContext ? current.text : mergeUserText(current.text, item.text),
      attachments: mergeAttachments(current.attachments, item.attachments),
      runtime: item.runtime ?? current.runtime,
      provider: item.provider ?? current.provider,
      accountId: item.accountId ?? current.accountId,
      model: item.model ?? current.model,
    };
  }
  if (current.kind === "agent" && item.kind === "agent") {
    return {
      ...current,
      ...item,
      text: item.text || current.text,
      turnId: item.turnId ?? current.turnId,
      runtime: item.runtime ?? current.runtime,
      provider: item.provider ?? current.provider,
      accountId: item.accountId ?? current.accountId,
      model: item.model ?? current.model,
    };
  }
  return item;
}

function dedupePreAnswerUserItems(items: ThreadHistoryItem[]): ThreadHistoryItem[] {
  const seen = new Map<string, number>();
  const remove = new Set<number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind !== "user") continue;
    const key = userTimelineKey(item);
    const previous = seen.get(key);
    if (previous == null) {
      seen.set(key, index);
      continue;
    }
    const answeredBetween = items.slice(previous + 1, index).some((candidate) => candidate.kind === "agent");
    if (!answeredBetween) remove.add(index);
    else seen.set(key, index);
  }
  return remove.size ? items.filter((_, index) => !remove.has(index)) : items;
}

function dedupeAgentItems(items: ThreadHistoryItem[]): ThreadHistoryItem[] {
  const seen = new Set<string>();
  const next: ThreadHistoryItem[] = [];
  let changed = false;
  for (const item of items) {
    if (item.kind !== "agent") {
      next.push(item);
      continue;
    }
    const key = agentMessageKey(item);
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    next.push(item);
  }
  return changed ? next : items;
}

function dedupeTimelineItems(items: ThreadHistoryItem[]): ThreadHistoryItem[] {
  return removeStaleMissingFinalNotices(dedupeAgentItems(dedupePreAnswerUserItems(items)));
}

function mergeActivityEntries(base: ThreadActivityEntry[] = [], overlay: ThreadActivityEntry[] = []): ThreadActivityEntry[] {
  if (!base.length) return overlay;
  if (!overlay.length) return base;
  const result = [...base];
  const indexes = new Map(result.map((entry, index) => [entry.id, index]));
  for (const entry of overlay) {
    const index = indexes.get(entry.id);
    if (index == null) {
      indexes.set(entry.id, result.length);
      result.push(entry);
      continue;
    }
    const current = result[index]!;
    result[index] = {
      ...current,
      ...entry,
      detail: entry.detail ?? current.detail,
      files: entry.files ?? current.files,
      images: entry.images ?? current.images,
      status: current.status === "failed" || entry.status === "failed" ? "failed" : entry.status ?? current.status,
    };
  }
  return result;
}

function mergeTimelineItems(base: ThreadHistoryItem[], overlay: ThreadHistoryItem[]): ThreadHistoryItem[] {
  if (!base.length) return overlay;
  if (!overlay.length) return base;
  const result = dedupeTimelineItems(base);
  const indexes = new Map(result.map((item, index) => [timelineItemKey(item), index]));
  for (const item of overlay) {
    const key = timelineItemKey(item);
    const attachmentContextIndex = item.kind === "user"
      ? result.findIndex((current) => current.kind === "user" && isAttachmentModelContext(item.text, current.attachments))
      : -1;
    const index = indexes.get(key) ?? (attachmentContextIndex >= 0 ? attachmentContextIndex : undefined);
    if (index == null) { indexes.set(key, result.length); result.push(item); continue; }
    result[index] = mergeTimelineItem(result[index]!, item);
  }
  return dedupeTimelineItems(result);
}

function hasConversationItems(items: ThreadHistoryItem[] | undefined): boolean {
  return Boolean(items?.some((item) => item.kind === "user" || item.kind === "agent" || item.kind === "system"));
}

function annotateAgentMessages(items: ThreadHistoryItem[], turnId: string, pending?: PendingTurnState): ThreadHistoryItem[] {
  if (!turnId || !pending) return items;
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== "agent" || item.turnId !== turnId) return item;
    if (item.runtime === pending.runtime && item.provider === pending.provider && item.model === pending.model && item.accountId === pending.accountId) return item;
    changed = true;
    return { ...item, runtime: pending.runtime, provider: pending.provider, model: pending.model, accountId: pending.accountId };
  });
  return changed ? next : items;
}

function finalAnswerMissingNotice(turnId: string, runtimeLabel = "모델 런타임"): ThreadHistoryItem {
  return {
    id: `missing-final-${turnId || crypto.randomUUID()}`,
    kind: "system",
    title: "최종 응답 본문 누락",
    text: `${runtimeLabel}가 작업 완료 이벤트를 보냈지만 최종 답변 본문 이벤트가 도착하지 않았습니다. 작업 결과는 위의 활동 로그를 기준으로 확인해 주세요.`,
    turnId,
  };
}

type PendingTurnState = {
  threadId: string;
  cwd: string;
  text: string;
  model: string;
  runtime?: AgentRuntimeId;
  provider?: ProviderId;
  accountId?: string;
  skills?: Array<{ name: string; path: string }>;
  attachments?: string[];
  attachmentDetails?: ThreadAttachment[];
  sidecars?: SidecarSettings;
  contextUsage?: ContextUsage;
  approvalPolicy?: import("../shared/contracts").ThreadApprovalPolicy;
  sandboxMode?: import("../shared/contracts").ThreadSandboxMode;
  reasoningEffort?: ReasoningEffort;
  responseSpeed?: ResponseSpeed;
  planMode?: boolean;
  acceptEdits?: boolean;
  retriedAfterCompaction: boolean;
};

type RuntimeThreadSnapshot = {
  thread: ThreadRef | null;
  workspace: string;
  items: ThreadHistoryItem[];
  projectDraft: boolean;
  view: AppView;
};

type UtilityPanelState = { tabs: string[]; active: string | null; open: boolean; expanded: boolean };
type BottomDockState = { tabs: string[]; active: string | null; open: boolean; height: number };

type QueuedTurn = { id: string; pending: PendingTurnState; userItem: ThreadHistoryItem; steering?: boolean; steerAfterTurnId?: string };
type CompactionRetryState = { pending: PendingTurnState; retrying: boolean; retryTurnId?: string };
type ThreadUsageModel = {
  key: string;
  label: string;
  provider: ProviderId | "unknown";
  model: string;
  requests: number;
  completed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  freshTokens: number;
  cacheMisses: number;
  latestCacheMissReason?: string;
  latestCacheMissedInputTokens?: number;
  durationMs: number;
  estimatedCost: number;
  pricedTokens: number;
};
type ThreadUsageSummary = {
  requests: number;
  completed: number;
  failed: number;
  totalTokens: number;
  freshTokens: number;
  cacheReadTokens: number;
  cacheMisses: number;
  estimatedCost: number;
  pricedTokens: number;
  contextUsage?: ContextUsage;
  contextTokens?: number;
  maxTokens?: number;
  contextLimitTokens?: number;
  contextOverflow: boolean;
  models: ThreadUsageModel[];
};

function compactTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return `${Math.round(value).toLocaleString()}`;
}

function contextUsageLimit(contextUsage: ContextUsage | undefined): number | undefined {
  if (!contextUsage?.maxTokens) return undefined;
  if (contextUsage.scope !== "last-request" && contextUsage.autoCompactEnabled && contextUsage.autoCompactThreshold && contextUsage.autoCompactThreshold > 0) {
    return contextUsage.autoCompactThreshold;
  }
  return contextUsage.maxTokens;
}

function contextUsagePercent(contextUsage: ContextUsage | undefined): number | null {
  const limit = contextUsageLimit(contextUsage);
  if (!contextUsage?.usedTokens || !limit) return null;
  return Math.round((contextUsage.usedTokens / limit) * 100);
}

function contextUsageOverflow(contextUsage: ContextUsage | undefined): boolean {
  const limit = contextUsageLimit(contextUsage);
  return Boolean(contextUsage?.usedTokens && limit && contextUsage.scope !== "last-request" && contextUsage.usedTokens >= limit);
}

function contextUsageTitle(contextUsage: ContextUsage | undefined): string {
  if (contextUsage?.scope === "last-request") return "마지막 요청 컨텍스트";
  if (contextUsage?.source === "renderer-estimate") return "현재 대화 추정치";
  if (contextUsage?.autoCompactEnabled && contextUsage.autoCompactThreshold) return "현재 컨텍스트 / 자동압축";
  return "현재 컨텍스트";
}

function contextUsageDisplay(contextUsage: ContextUsage | undefined): string {
  if (!contextUsage?.usedTokens || !contextUsage.maxTokens) return "알 수 없음";
  const percent = contextUsagePercent(contextUsage);
  const used = formatTokenShort(contextUsage.usedTokens);
  if (contextUsage.scope !== "last-request" && contextUsage.autoCompactEnabled && contextUsage.autoCompactThreshold) {
    return `${used} / ${formatTokenShort(contextUsage.autoCompactThreshold)} (${percent ?? 0}%, 최대 ${formatTokenShort(contextUsage.maxTokens)})`;
  }
  return `${used} / ${formatTokenShort(contextUsage.maxTokens)} (${percent ?? 0}%)`;
}

function contextUsageStatus(contextUsage: ContextUsage | undefined, overflow: boolean, usageHasClaudeCode: boolean): string {
  if (!contextUsage?.usedTokens || !contextUsage.maxTokens) return "알 수 없음";
  const percent = contextUsagePercent(contextUsage) ?? Math.round((contextUsage.usedTokens / contextUsage.maxTokens) * 100);
  if (contextUsage.scope === "last-request") return contextUsage.includesCache ? `캐시 포함 · ${percent}% 상당` : `${percent}% 상당`;
  if (contextUsage.source === "renderer-estimate") return overflow
    ? usageHasClaudeCode ? "추정 임계값 초과 · Claude Code 자동 압축 켜짐" : "추정 임계값 초과"
    : `추정 ${percent}% 사용`;
  if (contextUsage.autoCompactEnabled && contextUsage.autoCompactThreshold) {
    return overflow ? `자동압축 임계값 도달 · ${percent}%` : `자동압축 기준 ${percent}%`;
  }
  if (contextUsage.autoCompactEnabled === false) return `${percent}% 사용 · 자동압축 꺼짐`;
  if (overflow) return usageHasClaudeCode ? "임계값 초과 · Claude Code 자동 압축 켜짐" : "다음 요청에서 압축 필요";
  return usageHasClaudeCode ? `${percent}% 사용 · Claude Code 자동 압축 켜짐` : `${percent}% 사용`;
}

function compactUsageReset(value: string | number | null | undefined): string {
  if (value == null) return "";
  const normalized = typeof value === "number" && value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString("ko-KR", sameYear ? { month: "short", day: "numeric" } : { year: "2-digit", month: "short", day: "numeric" });
  const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: true }).replace(/^(오전|오후)\s+/, "$1\u00a0");
  return `${day} ${time}`;
}

function providerDisplayName(provider: ProviderId | "unknown", providers: ProviderInfo[]): string {
  if (provider === "unknown") return "알 수 없음";
  return providers.find((item) => item.id === provider)?.label ?? (provider === "claude-code" ? "Claude Code" : provider === "copilot" ? "GitHub Copilot" : provider === "antigravity" ? "Antigravity" : provider);
}

function runtimeAgentLabel(runtime: AgentRuntimeId, provider: ProviderId | undefined, providers: ProviderInfo[]): string {
  const base = runtime === "claude-code" ? "Claude" : "Codex";
  const defaultProvider = runtime === "claude-code" ? "claude-code" : "codex";
  if (!provider || provider === defaultProvider) return base;
  return `${base}(${providerDisplayName(provider, providers)})`;
}

function providerUsageInputBreakdown(usage: ProviderTokenUsage): { uncachedInput: number; cached: number; cacheRead: number; cacheCreation: number; total: number } {
  const cached = usage.cachedInputTokens ?? 0;
  const inputExcludesCache = cached > 0 && (usage.totalTokens ?? 0) >= usage.inputTokens + cached + usage.outputTokens;
  const inputIncludesCache = cached > 0 && !inputExcludesCache && usage.inputTokens >= cached;
  const uncachedInput = inputIncludesCache ? Math.max(0, usage.inputTokens - cached) : usage.inputTokens;
  // Entries logged before the read/write split count all cached tokens as reads.
  const cacheRead = usage.cacheReadInputTokens
    ?? (usage.cacheCreationInputTokens != null ? Math.max(0, cached - usage.cacheCreationInputTokens) : cached);
  const cacheCreation = usage.cacheCreationInputTokens ?? Math.max(0, cached - cacheRead);
  return { uncachedInput, cached, cacheRead, cacheCreation, total: Math.max(usage.totalTokens ?? 0, uncachedInput + cached + usage.outputTokens) };
}

function providerUsageFreshTokens(usage: ProviderTokenUsage): number {
  const breakdown = providerUsageInputBreakdown(usage);
  return breakdown.uncachedInput + breakdown.cacheCreation + usage.outputTokens;
}

function providerTokenTotal(usage: ProviderTokenUsage): number {
  return providerUsageInputBreakdown(usage).total;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatDurationShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function threadUsageCostLabel(cost: number, pricedTokens: number, totalTokens: number): string {
  if (cost > 0 || pricedTokens > 0) return formatUsd(cost);
  return totalTokens > 0 ? "단가 미정" : "$0";
}

function threadUsageRowDetail(row: ThreadUsageModel): string {
  const parts = [`요청 ${row.requests}회`];
  if (row.completed > 0) parts.push(`완료 ${row.completed}회`);
  if (row.failed > 0) parts.push(`실패 ${row.failed}회`);
  if (row.completed > 0 && row.durationMs > 0) parts.push(`평균 ${formatDurationShort(row.durationMs / row.completed)}`);
  if (row.freshTokens > 0) parts.push(`실사용 ${compactTokenCount(row.freshTokens)}`);
  if (row.inputTokens > 0 || row.outputTokens > 0) parts.push(`입력 ${compactTokenCount(row.inputTokens)} / 출력 ${compactTokenCount(row.outputTokens)}`);
  if (row.cacheCreationTokens > 0) parts.push(`캐시 생성 ${compactTokenCount(row.cacheCreationTokens)}`);
  if (row.cacheReadTokens > 0) parts.push(`캐시 재사용 ${compactTokenCount(row.cacheReadTokens)}`);
  if (row.cacheMisses > 0) parts.push(`캐시 미스 ${row.cacheMisses}회${row.latestCacheMissReason ? ` · ${row.latestCacheMissReason}` : ""}`);
  else if (row.cachedInputTokens > 0 && row.cacheCreationTokens === 0) parts.push(`캐시 ${compactTokenCount(row.cachedInputTokens)}`);
  return parts.join(" · ");
}

function emptyThreadUsageRow(input: { key: string; label: string; provider: ProviderId | "unknown"; model: string }): ThreadUsageModel {
  return {
    key: input.key,
    label: input.label,
    provider: input.provider,
    model: input.model,
    requests: 0,
    completed: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    freshTokens: 0,
    cacheMisses: 0,
    durationMs: 0,
    estimatedCost: 0,
    pricedTokens: 0,
  };
}

function addUsageToThreadRow(row: ThreadUsageModel, usage: ProviderTokenUsage): void {
  const usageBreakdown = providerUsageInputBreakdown(usage);
  row.inputTokens += usageBreakdown.uncachedInput;
  row.outputTokens += usage.outputTokens;
  row.cachedInputTokens += usageBreakdown.cached;
  row.cacheReadTokens += usageBreakdown.cacheRead;
  row.cacheCreationTokens += usageBreakdown.cacheCreation;
  row.reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
  row.totalTokens += providerTokenTotal(usage);
  row.freshTokens += providerUsageFreshTokens(usage);
  if (usage.cacheMissReason) {
    row.cacheMisses += 1;
    row.latestCacheMissReason = usage.cacheMissReason;
    row.latestCacheMissedInputTokens = usage.cacheMissedInputTokens;
  }
}

function summarizeThreadUsage(input: { threadId?: string; contextUsage?: ContextUsage; providers: ProviderInfo[]; requestLog: ProviderRequestLogEntry[]; items: ThreadHistoryItem[]; defaultRuntime: AgentRuntimeId; defaultProvider: ProviderId; defaultModel: string }): ThreadUsageSummary {
  const rows = new Map<string, ThreadUsageModel>();
  for (const entry of input.requestLog) {
    if (!input.threadId || !entry.threadId || entry.threadId !== input.threadId) continue;
    const key = `${entry.provider}:${entry.accountId ?? "default"}:${entry.model}`;
    const row = rows.get(key) ?? emptyThreadUsageRow({
      key,
      label: `${providerDisplayName(entry.provider, input.providers)}${entry.accountLabel ? ` · ${entry.accountLabel}` : ""} · ${entry.model || "unknown"}`,
      provider: entry.provider,
      model: entry.model || "unknown",
    });
    row.requests += 1;
    if (entry.status === "completed") row.completed += 1;
    if (entry.status === "failed") row.failed += 1;
    row.durationMs += entry.durationMs ?? 0;
    if (entry.usage) {
      addUsageToThreadRow(row, entry.usage);
      const cost = estimateProviderUsageCost(entry.provider, entry.model, entry.usage);
      row.estimatedCost += cost.cost;
      row.pricedTokens += cost.pricedTokens;
    }
    rows.set(key, row);
  }

  if (rows.size === 0) {
    const timelineUsageByTurn = new Map<string, ThreadHistoryItem>();
    input.items.forEach((item, index) => {
      if (!item.turnId || !item.tokenUsage) return;
      timelineUsageByTurn.set(item.turnId, { ...item, id: `${item.id}:${index}` });
    });
    for (const item of timelineUsageByTurn.values()) {
      const tokenUsage = item.tokenUsage;
      if (!tokenUsage) continue;
      const provider = item.provider ?? (item.runtime === "claude-code" ? "claude-code" : input.defaultProvider);
      const runtime = item.runtime ?? input.defaultRuntime;
      const model = item.model ?? input.defaultModel;
      const key = `${provider}:${item.accountId ?? "thread"}:${model}`;
      const row = rows.get(key) ?? emptyThreadUsageRow({
        key,
        label: `${runtimeAgentLabel(runtime, provider, input.providers)} · ${model || "unknown"}`,
        provider,
        model: model || "unknown",
      });
      row.requests += 1;
      if (item.status === "failed") row.failed += 1;
      else row.completed += 1;
      row.durationMs += item.durationMs ?? 0;
      addUsageToThreadRow(row, tokenUsage);
      const cost = estimateProviderUsageCost(provider, model, tokenUsage);
      row.estimatedCost += cost.cost;
      row.pricedTokens += cost.pricedTokens;
      rows.set(key, row);
    }
  }

  const models = [...rows.values()].sort((a, b) => b.estimatedCost - a.estimatedCost || b.totalTokens - a.totalTokens || b.requests - a.requests);
  const contextLimit = contextUsageLimit(input.contextUsage);
  return {
    requests: models.reduce((sum, row) => sum + row.requests, 0),
    completed: models.reduce((sum, row) => sum + row.completed, 0),
    failed: models.reduce((sum, row) => sum + row.failed, 0),
    totalTokens: models.reduce((sum, row) => sum + row.totalTokens, 0),
    freshTokens: models.reduce((sum, row) => sum + row.freshTokens, 0),
    cacheReadTokens: models.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    cacheMisses: models.reduce((sum, row) => sum + row.cacheMisses, 0),
    estimatedCost: models.reduce((sum, row) => sum + row.estimatedCost, 0),
    pricedTokens: models.reduce((sum, row) => sum + row.pricedTokens, 0),
    contextUsage: input.contextUsage,
    contextTokens: input.contextUsage?.usedTokens,
    maxTokens: input.contextUsage?.maxTokens,
    contextLimitTokens: contextLimit,
    contextOverflow: contextUsageOverflow(input.contextUsage),
    models,
  };
}

function App(): React.JSX.Element {
  const [runtime, setRuntime] = useState<RuntimeStatus>(defaultStatus);
  const [agentRuntime, setAgentRuntimeState] = useState<AgentRuntimeId>(() => storedAgentRuntime());
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ status: "none" });
  const [workspace, setWorkspace] = useState("");
  const [thread, setThread] = useState<ThreadRef | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [projects, setProjects] = useState<Array<{ cwd: string; name: string; threads: ThreadSummary[] }>>([]);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [archivedBusy, setArchivedBusy] = useState(false);
  const [changes, setChanges] = useState<WorkspaceChanges>(defaultChanges);
  const [selectedDiff, setSelectedDiff] = useState<WorkspaceDiff | null>(null);
  const [fileTarget, setFileTarget] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const selectedDiffRef = useRef<WorkspaceDiff | null>(null);
  const providers = useProviders();
  const codexSettings = useCodexSettings();
  const englishOutput = Boolean(codexSettings.settings?.englishOutput);
  const bridgeChatLocked = codexSettings.settings?.stockBridgeEnabled === true;
  const devilBrowserOwnsRouting = codexSettings.settings?.stockBridgeEnabled === false && codexSettings.settings?.devilMcpEnabled === true;
  const model = providers.settings?.model ?? "gpt-5.5";
  const accountId = providers.settings?.accountId;
  const [claudeModel, setClaudeModelState] = useState(() => storedClaudeModel());
  const [claudeProviderId, setClaudeProviderIdState] = useState<ProviderId>(() => storedClaudeProvider());
  const [claudeAccountId, setClaudeAccountIdState] = useState<string | undefined>(() => storedClaudeAccount());
  const [composerConfigs, setComposerConfigs] = useState<Record<string, ComposerConfigSnapshot>>(readComposerConfigs);
  const claudeModeProviders = providers.settings?.providers.filter((provider) => provider.id !== "codex") ?? [];
  const claudeModeProvider = claudeModeProviders.find((provider) => provider.id === claudeProviderId) ?? claudeModeProviders.find((provider) => provider.id === "claude-code") ?? null;
  const resolvedClaudeProviderId: ProviderId = claudeModeProvider?.id ?? "claude-code";
  const resolvedClaudeAccountId = claudeAccountId && claudeModeProvider?.accounts.some((account) => account.id === claudeAccountId)
    ? claudeAccountId
    : claudeModeProvider?.accounts[0]?.id;
  const composerRuntime = thread?.runtime ?? agentRuntime;
  const composerConfigKey = thread?.id ? `${composerRuntime}:thread:${thread.id}` : null;
  const composerConfig = composerConfigKey ? composerConfigs[composerConfigKey] : undefined;
  const composerProviders = composerRuntime === "claude-code" ? claudeModeProviders : providers.settings?.providers ?? [];
  const defaultComposerProviderId: ProviderId = composerRuntime === "claude-code" ? resolvedClaudeProviderId : providers.settings?.provider ?? "codex";
  const composerProviderId: ProviderId = composerConfig?.provider ?? thread?.provider ?? defaultComposerProviderId;
  const composerProvider = composerProviders.find((provider) => provider.id === composerProviderId) ?? null;
  const defaultComposerModel = composerRuntime === "claude-code" ? claudeModel : model;
  const composerModel = composerConfig?.model ?? thread?.model ?? defaultComposerModel;
  const composerAccountId = composerConfig?.accountId
    ?? thread?.accountId
    ?? (composerRuntime === "claude-code" ? resolvedClaudeAccountId : accountId);
  const activeProvider = composerProvider;
  const rememberComposerConfig = (key: string | null, patch: Omit<Partial<ComposerConfigSnapshot>, "updatedAt">): void => {
    if (!key) return;
    setComposerConfigs((current) => {
      const next = { ...current, [key]: { ...(current[key] ?? {}), ...patch, updatedAt: Date.now() } };
      writeComposerConfigs(next);
      return next;
    });
  };
  const setAgentRuntime = (next: AgentRuntimeId): void => {
    if (next !== agentRuntime) {
      runtimeSnapshots.current[agentRuntime] = runtimeSnapshotFor(agentRuntime);
      const key = threadStateKey(thread?.runtime ?? agentRuntime, thread?.id, emptyThreadStateId(workspace, projectDraft));
      panelByThread.current[key] = { tabs: utilityTabs, active: utilityActive, open: utilityPanelOpen, expanded: utilityPanelExpanded };
      bottomByThread.current[key] = { tabs: bottomTabs, active: bottomActive, open: terminalOpen, height: terminalHeight };
      skipNextPanelSave.current = true;
      skipNextBottomSave.current = true;
      setUtilityTabs([]);
      setUtilityActive(null);
      setUtilityPanelOpen(false);
      setUtilityPanelExpanded(false);
      setBottomTabs(["terminal:default"]);
      setBottomActive("terminal:default");
      setTerminalOpen(false);
      setEnvironmentOpen(false);
    }
    setAgentRuntimeState(next);
    localStorage.setItem(AGENT_RUNTIME_KEY, next);
  };
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort>(() => storedReasoningEffort());
  const [responseSpeed, setResponseSpeedState] = useState<ResponseSpeed>(() => storedResponseSpeed());
  // config.toml (shared with stock Codex) is the source of truth for effort and
  // speed; localStorage is only a fast-boot cache. Adopt the config values once
  // they load so a change made in stock Codex shows up here after a relaunch.
  const adoptedCodexDefaults = useRef(false);
  useEffect(() => {
    const loaded = codexSettings.settings;
    if (!loaded || adoptedCodexDefaults.current) return;
    adoptedCodexDefaults.current = true;
    setReasoningEffortState(loaded.reasoningEffort);
    localStorage.setItem("devil-codex:reasoning-effort", loaded.reasoningEffort);
    setResponseSpeedState(loaded.responseSpeed);
    localStorage.setItem("devil-codex:response-speed", loaded.responseSpeed);
  }, [codexSettings.settings]);
  const syncStockCodexDefaults = (patch: Partial<Pick<CodexSettings, "model" | "reasoningEffort" | "responseSpeed">>): void => {
    const current = codexSettings.settings;
    if (!current) return;
    const next = { ...current, ...patch };
    if (next.model === current.model && next.reasoningEffort === current.reasoningEffort && next.responseSpeed === current.responseSpeed) return;
    codexSettings.save(next);
  };
  const setModel = (next: { provider: ProviderId; accountId?: string; model: string }): void => {
    if (composerConfigKey) {
      rememberComposerConfig(composerConfigKey, { runtime: composerRuntime, provider: next.provider, accountId: next.accountId, model: next.model });
      setThread((current) => current ? { ...current, runtime: composerRuntime, provider: next.provider, accountId: next.accountId, model: next.model } : current);
      if (thread?.id) {
        void window.devilCodex.updateThreadMeta({
          id: thread.id,
          cwd: thread.cwd,
          runtime: composerRuntime,
          provider: next.provider,
          accountId: next.accountId,
          model: next.model,
        }).catch((error) => console.warn("[devil-codex] thread model sync failed", error));
      }
      return;
    }
    if (composerRuntime === "claude-code") {
      setClaudeProviderIdState(next.provider);
      localStorage.setItem(CLAUDE_PROVIDER_KEY, next.provider);
      setClaudeAccountIdState(next.accountId);
      if (next.accountId) localStorage.setItem(CLAUDE_ACCOUNT_KEY, next.accountId);
      else localStorage.removeItem(CLAUDE_ACCOUNT_KEY);
      setClaudeModelState(next.model);
      localStorage.setItem(CLAUDE_MODEL_KEY, next.model);
      return;
    }
    void providers.select(next);
    if (next.provider === "codex") syncStockCodexDefaults({ model: next.model });
  };
  const setReasoningEffort = (value: ReasoningEffort): void => {
    if (composerConfigKey) {
      rememberComposerConfig(composerConfigKey, { runtime: composerRuntime, reasoningEffort: value });
      return;
    }
    setReasoningEffortState(value);
    localStorage.setItem("devil-codex:reasoning-effort", value);
    syncStockCodexDefaults({ reasoningEffort: value });
  };
  const setResponseSpeed = (value: ResponseSpeed): void => {
    if (composerConfigKey) {
      rememberComposerConfig(composerConfigKey, { runtime: composerRuntime, responseSpeed: value });
      return;
    }
    setResponseSpeedState(value);
    localStorage.setItem("devil-codex:response-speed", value);
    syncStockCodexDefaults({ responseSpeed: value });
  };
  const [busy, setBusy] = useState(false);
  const [runningTurns, setRunningTurns] = useState<Record<string, { turnId?: string; startedAt: number }>>(() => readPersistedRunningTurns());
  const [queuedView, setQueuedView] = useState<Record<string, Array<{ id: string; text: string; attachments?: ThreadAttachment[]; steering?: boolean }>>>({});
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [bottomTabs, setBottomTabs] = useState<string[]>(["terminal:default"]);
  const [bottomActive, setBottomActive] = useState<string | null>("terminal:default");
  const [terminalHeight, setTerminalHeight] = useState(286);
  const [resizing, setResizing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem("devil-codex:sidebar-width")) || 310);
  const [utilityWidth, setUtilityWidth] = useState(() => Number(localStorage.getItem("devil-codex:utility-width")) || 440);
  const appShellRef = useRef<HTMLElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState(false);
  const [subagentNames, setSubagentNames] = useState<Record<string, string>>({});
  // Side-chat / subagent thread ids: kept out of the main timeline AND the
  // sidebar, persisted so they stay hidden across reloads. The ref mirror is
  // for synchronous reads inside receiveEvent.
  // Side conversations ("곁가지 대화") are ephemeral like stock Codex: created by
  // the user, shown in the environment, and gone when closed (not persisted).
  // Subagents ("하위 에이전트") are separate — spawned by the main thread's model.
  // Side conversations are per main thread (each thread has its own 곁가지 대화).
  const [sideChatsByThread, setSideChatsByThread] = useState<Record<string, Array<{ id: string; label: string }>>>({});
  const [sideChatCreatingDock, setSideChatCreatingDock] = useState<"right" | "bottom" | null>(null);
  const subagentIdsRef = useRef<Set<string>>(new Set());
  const autoSubagentSeedKey = useRef<string>("");
  const autoSubagentSeen = useRef<Set<string>>(new Set());
  useEffect(() => { for (const list of Object.values(sideChatsByThread)) for (const c of list) subagentIdsRef.current.add(c.id); }, [sideChatsByThread]);
  // Hide all side conversations from the main sidebar (spawned subagents are
  // already excluded from thread/list by the app-server's subAgent source).
  const sideThreadSet = useMemo(() => new Set(Object.values(sideChatsByThread).flat().map((c) => c.id)), [sideChatsByThread]);
  const sideChatKey = threadStateKey(thread?.runtime ?? agentRuntime, thread?.id, emptyThreadStateId(workspace, projectDraft));
  const sideChats = sideChatsByThread[sideChatKey] ?? [];
  const setSideChats = (updater: (prev: Array<{ id: string; label: string }>) => Array<{ id: string; label: string }>): void =>
    setSideChatsByThread((prev) => ({ ...prev, [sideChatKey]: updater(prev[sideChatKey] ?? []) }));
  // Persisted side-chat conversation per subagent thread (survives tab switches).
  const [subagentHistory, setSubagentHistory] = useState<Record<string, ThreadHistoryItem[]>>({});
  const [subagentBusy, setSubagentBusy] = useState<Record<string, boolean>>({});
  // Per-subagent picked model so it doesn't reset when switching tabs.
  const [subagentPick, setSubagentPick] = useState<Record<string, { provider: ProviderId; accountId?: string; model: string; auto?: boolean }>>({});
  const [utilityPanelExpanded, setUtilityPanelExpanded] = useState(false);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectPinned, setProjectPinned] = useState(() => localStorage.getItem("devil-codex:project-pinned") === "true");
  const [projectAlias, setProjectAlias] = useState("");
  const [hiddenProjects, setHiddenProjects] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("devil-codex:hidden-projects") || "[]"); } catch { return []; } });
  const [hiddenThreadIds, setHiddenThreadIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("devil-codex:hidden-threads") || "[]"); } catch { return []; } });
  const [localProjectCwds, setLocalProjectCwds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("devil-codex:local-project-cwds") || "[]"); } catch { return []; } });
  const [pinnedProjects, setPinnedProjects] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("devil-codex:pinned-projects") || "[]"); } catch { return []; } });
  const [pinnedThreads, setPinnedThreads] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("devil-codex:pinned-threads") || "[]"); } catch { return []; } });
  const [projectAliases, setProjectAliases] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem("devil-codex:project-aliases") || "{}"); } catch { return {}; } });
  const [openProjectMenu, setOpenProjectMenu] = useState<string | null>(null);
  const [projectHeaderMenuOpen, setProjectHeaderMenuOpen] = useState(false);
  const [projectHeaderSubmenu, setProjectHeaderSubmenu] = useState<"sort" | "cleanup" | null>(null);
  const [projectSortMode, setProjectSortMode] = useState<ProjectSortMode>(() => (localStorage.getItem("devil-codex:project-sort-mode") as ProjectSortMode | null) ?? "manual");
  const [sidebarLayoutMode, setSidebarLayoutMode] = useState<SidebarLayoutMode>(() => (localStorage.getItem("devil-codex:sidebar-layout-mode") as SidebarLayoutMode | null) ?? "project");
  const [threadContextMenu, setThreadContextMenu] = useState<{ summary: ThreadSummary; left: number; top: number } | null>(null);
  const [renameThreadTarget, setRenameThreadTarget] = useState<ThreadSummary | null>(null);
  const [renameThreadDraft, setRenameThreadDraft] = useState("");
  const [renameThreadBusy, setRenameThreadBusy] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [generalChatsAll, setGeneralChatsAll] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [openTargets, setOpenTargets] = useState<OpenWorkspaceTarget[]>([]);
  const [shellMenuOpen, setShellMenuOpen] = useState<ShellMenuKey | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountUsageOpen, setAccountUsageOpen] = useState(false);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [utilityPanelOpen, setUtilityPanelOpen] = useState(false);
  // Tabs are tool kinds or "subagent:<threadId>" entries (multiple allowed).
  const [utilityTabs, setUtilityTabs] = useState<string[]>([]);
  const [utilityActive, setUtilityActive] = useState<string | null>(null);
  // Per-main-thread right-panel tab state so returning restores open subagents.
  const panelByThread = useRef<Record<string, UtilityPanelState>>({});
  const bottomByThread = useRef<Record<string, BottomDockState>>({});
  const skipNextPanelSave = useRef(false);
  const skipNextBottomSave = useRef(false);
  const [externalError, setExternalError] = useState("");
  const [runtimeShareBusy, setRuntimeShareBusy] = useState<string | null>(null);
  const [petVisible, setPetVisible] = useState(storedPetVisible);
  const [permissionHint, setPermissionHint] = useState<"computer-use" | null>(null);
  // Screenshot / annotate from the embedded browser injects an image (+ optional
  // text) into the main composer so the user can ask about the page.
  const [composerInject, setComposerInject] = useState<{ attachments?: ThreadAttachment[]; text?: string; nonce: number } | null>(null);
  const askAboutPage = (att: ThreadAttachment, text?: string): void => setComposerInject({ attachments: [att], text, nonce: Date.now() });
  const askAboutTerminal = (text: string): void => { setView("thread"); setComposerInject({ text, nonce: Date.now() }); };
  const keepThreadOnRuntimeSwitch = useRef(false);
  const [view, setView] = useState<AppView>("thread");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<ThreadSummary[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<CodexSkillInfo[]>([]);
  const [availableClaudeSkills, setAvailableClaudeSkills] = useState<CodexSkillInfo[]>([]);
  const [availableClaudeSlashCommands, setAvailableClaudeSlashCommands] = useState<ClaudeSlashCommandInfo[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<McpServerInfo[]>([]);
  const [settingsSection, setSettingsSection] = useState("구성");
  const [items, setItems] = useState<ThreadHistoryItem[]>([]);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalPrompt[]>([]);
  const [approvalResponding, setApprovalResponding] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [gitDialogOpen, setGitDialogOpen] = useState(false);
  const [worktreeDialogCwd, setWorktreeDialogCwd] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [initializingThreadId, setInitializingThreadId] = useState<string | null>(null);
  const [threadFindOpen, setThreadFindOpen] = useState(false);
  const [threadFindQuery, setThreadFindQuery] = useState("");
  const [textPrompt, setTextPrompt] = useState<TextPromptState | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const showScrollToBottomRef = useRef(false);
  const lastScrollPositionWrite = useRef<{ threadId: string; top: number; atBottom: boolean; at: number } | null>(null);
  const threadViewRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLFormElement>(null);
  const [composerClearance, setComposerClearance] = useState(240);
  const stickToThreadBottom = useRef(true);
  const scrolledThreadId = useRef<string | null>(null);
  const pendingScrollRestoreThread = useRef<string | null>(null);
  const utilityScrollRestore = useRef<{ threadId: string; top: number; atBottom: boolean } | null>(null);
  const utilityScrollLockUntil = useRef(0);
  const threadScrollPositions = useRef<Record<string, ThreadScrollPosition>>(readThreadScrollPositions());
  const scrollPersistFrame = useRef<number | null>(null);
  const projectHeaderMenuRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<ThreadHistoryItem[]>([]);
  const itemsOwnerRef = useRef<string | null>(null);
  const threadRef = useRef<ThreadRef | null>(null);
  const threadHistoryCache = useRef(new Map<string, ThreadHistoryItem[]>());
  const prefetchingThreadHistory = useRef(new Set<string>());
  const activeResume = useRef<string | null>(null);
  const loadingThreadTimer = useRef<number | null>(null);
  const threadsLoadingCount = useRef(0);
  const projectsLoadingCount = useRef(0);
  const pendingThreads = useRef(new Map<string, ThreadSummary>());
  const pendingTurn = useRef<PendingTurnState | null>(null);
  const pendingTurns = useRef(new Map<string, PendingTurnState>());
  const lastSentModels = useRef<Record<string, SentModelState>>(readLastSentModels());
  // Per-thread follow-up queue. When the user sends another message while the
  // same chat is still running, it lands here and auto-sends the moment the
  // current turn finishes — instead of being dropped.
  const queuedTurns = useRef(new Map<string, QueuedTurn[]>());
  const compactionRetries = useRef(new Map<string, CompactionRetryState>());
  const compactedTurns = useRef(new Set<string>());
  const activeTurn = useRef<{ threadId: string; turnId: string } | null>(null);
  const activeTurnsByThread = useRef(new Map<string, string>());
  const steeringInterruptedTurns = useRef(new Set<string>());
  const visibleTimelineQueue = useRef<Array<{ threadId: string; event: AppServerEvent; turnId: string; pending?: PendingTurnState }>>([]);
  const visibleTimelineFrame = useRef<number | null>(null);
  const runningTurnsRef = useRef<Record<string, { turnId?: string; startedAt: number }>>({});
  const runtimeSnapshots = useRef<Partial<Record<AgentRuntimeId, RuntimeThreadSnapshot>>>({});
  const navigationBack = useRef<NavigationEntry[]>([]);
  const navigationForward = useRef<NavigationEntry[]>([]);
  const [navigationState, setNavigationState] = useState({ canGoBack: false, canGoForward: false });
  useDismissShellPopovers(closePopovers);
  const quickUsage = useProviderUsage(accountUsageOpen || environmentOpen);

  useEffect(() => { selectedDiffRef.current = selectedDiff; }, [selectedDiff]);

  function notifyInBackground(kind: keyof Omit<NotificationSettings, "notificationsEnabled">, title: string, body?: string, urgency?: "normal" | "critical", force = false): void {
    const settings = readNotificationSettings();
    if (!settings.notificationsEnabled || !settings[kind]) return;
    void window.devilCodex.showNotification({ title, body, urgency, force }).catch(() => undefined);
  }

  useEffect(() => { itemsRef.current = items; }, [items]);

  function visibleItemsForThread(threadId: string): ThreadHistoryItem[] | null {
    return itemsOwnerRef.current === threadId ? itemsRef.current : null;
  }
  useEffect(() => window.devilCodex.onAsk((request) => {
    const first = request.questions[0];
    notifyInBackground("notifyOnAsk", "Devil Codex 질문", first?.question ?? "AI가 사용자 입력을 기다리고 있습니다.", "critical", true);
  }), []);
  function runtimeSnapshotFor(runtimeId: AgentRuntimeId): RuntimeThreadSnapshot {
    return {
      thread: threadRef.current,
      workspace,
      items: itemsRef.current,
      projectDraft,
      view,
    };
  }

  function restoreRuntimeSnapshot(snapshot: RuntimeThreadSnapshot | undefined): boolean {
    if (!snapshot?.thread) return false;
    setLoadingThreadId(null);
    setInitializingThreadId(snapshot.thread.id);
    setView(snapshot.view === "settings" ? "thread" : snapshot.view);
    setWorkspace(snapshot.workspace || workspace);
    setThread(snapshot.thread);
    threadRef.current = snapshot.thread;
    const cached = threadHistoryCache.current.get(snapshot.thread.id);
    const nextItems = cached ? mergeTimelineItems(snapshot.items, cached) : snapshot.items;
    setItems(nextItems);
    itemsRef.current = nextItems;
    itemsOwnerRef.current = snapshot.thread.id;
    threadHistoryCache.current.set(snapshot.thread.id, nextItems);
    setProjectDraft(snapshot.projectDraft);
    activeResume.current = snapshot.thread.id;
    const panelKey = threadStateKey(snapshot.thread.runtime ?? agentRuntime, snapshot.thread.id);
    const panel = panelByThread.current[panelKey] ?? { tabs: [], active: null, open: false, expanded: false };
    setUtilityTabs(panel.tabs);
    setUtilityActive(panel.active);
    setUtilityPanelOpen(panel.open && panel.tabs.length > 0);
    setUtilityPanelExpanded(panel.open && panel.expanded);
    const bottom = bottomByThread.current[panelKey] ?? { tabs: ["terminal:default"], active: "terminal:default", open: false, height: terminalHeight };
    setBottomTabs(bottom.tabs);
    setBottomActive(bottom.active);
    setTerminalOpen(bottom.open && bottom.tabs.length > 0);
    setTerminalHeight(bottom.height);
    return true;
  }

  useEffect(() => {
    if (keepThreadOnRuntimeSwitch.current) {
      keepThreadOnRuntimeSwitch.current = false;
      if (workspace) void Promise.all([refreshThreads(workspace, { quiet: true, showLoading: true }), refreshProjects({ quiet: true, showLoading: true })]);
      return;
    }
    const restored = restoreRuntimeSnapshot(runtimeSnapshots.current[agentRuntime]);
    if (!restored) {
      activeResume.current = null;
      setLoadingThreadId(null);
      setInitializingThreadId(null);
      setThread(null);
      threadRef.current = null;
      setItems([]);
      itemsRef.current = [];
      itemsOwnerRef.current = null;
      setProjectDraft(false);
    }
    pendingThreads.current.clear();
    if (workspace) void Promise.all([refreshThreads(workspace, { quiet: true, showLoading: true }), refreshProjects({ quiet: true, showLoading: true })]);
  }, [agentRuntime]);
  useEffect(() => { threadRef.current = thread; }, [thread]);
  useEffect(() => {
    runningTurnsRef.current = runningTurns;
    writePersistedRunningTurns(runningTurns);
  }, [runningTurns]);
  useEffect(() => {
    if (!codexSettings.settings || !providers.settings) return;
    syncStockCodexDefaults({
      ...(providers.settings.provider === "codex" ? { model } : {}),
      reasoningEffort,
      responseSpeed,
    });
  }, [codexSettings.settings, providers.settings, model, reasoningEffort, responseSpeed]);
  useEffect(() => () => {
    saveCurrentThreadScrollPosition();
    if (scrollPersistFrame.current != null) cancelAnimationFrame(scrollPersistFrame.current);
    if (loadingThreadTimer.current != null) window.clearTimeout(loadingThreadTimer.current);
    if (visibleTimelineFrame.current != null) cancelAnimationFrame(visibleTimelineFrame.current);
    writeThreadScrollPositions(threadScrollPositions.current);
  }, []);

  useEffect(() => {
    const dispose = window.devilCodex.onAppServerEvent((event) => receiveEvent(event));
    void (async () => {
      const status = await window.devilCodex.runtime();
      setRuntime(status);
      if (status.state === "connected") {
        const cwd = await generalChatCwd(status.cwd);
        setWorkspace(cwd);
        setProjectDraft(false);
        setThread(null);
        setItems([]);
        itemsRef.current = [];
        itemsOwnerRef.current = null;
        await Promise.all([refreshThreads(cwd), refreshChanges(cwd), refreshProjects()]);
      } else {
        await connect();
      }
    })().catch((error) => {
      setRuntime((current) => ({ ...current, state: "error", detail: `Codex app-server 연결 실패: ${String(error)}` }));
    });
    return dispose;
  }, []);

  useEffect(() => {
    const disposeChanged = window.devilCodex.onThreadQueueChanged((state: ThreadQueueState) => {
      applyQueuedView(state.threadId, (state.queue ?? []).map((entry) => ({ id: entry.id, text: entry.text ?? "", attachments: entry.attachments, ...(entry.steering ? { steering: true } : {}) })));
    });
    const disposeCommand = window.devilCodex.onThreadQueueCommand((command: ThreadQueueCommand) => {
      if (command.type === "enqueue") {
        enqueueTurn(command.threadId, command.entry as QueuedTurn, Boolean(command.front));
        return;
      }
      if (command.type === "update") { editQueuedTurn(command.threadId, command.id, command.text); return; }
      if (command.type === "remove") { removeQueuedTurn(command.threadId, command.id); return; }
      if (command.type === "steer") { steerQueuedTurn(command.threadId, command.id); return; }
      if (command.type === "clear") clearQueuedTurns(command.threadId);
    });
    return () => {
      disposeChanged();
      disposeCommand();
    };
  }, []);

  useEffect(() => {
    const dispose = window.devilCodex.onThreadMetaChanged((meta: ThreadMetaUpdate) => {
      if (!meta.id) return;
      const apply = <T extends ThreadRef | ThreadSummary>(item: T): T => item.id === meta.id ? { ...item, ...meta } : item;
      setThread((current) => current?.id === meta.id ? apply(current) : current);
      setThreads((current) => current.map(apply));
      setProjects((current) => current.map((group) => ({ ...group, threads: group.threads.map(apply) })));
    });
    return dispose;
  }, []);

  useEffect(() => {
    const threadId = thread?.id;
    if (!threadId) return;
    void window.devilCodex.getThreadQueue({ threadId }).then((queue) => {
      applyQueuedView(threadId, (queue ?? []).map((entry) => ({ id: entry.id, text: entry.text ?? "", attachments: entry.attachments, ...(entry.steering ? { steering: true } : {}) })));
    }).catch(() => undefined);
  }, [thread?.id]);

  useEffect(() => {
    const dispose = window.devilCodex.onUpdateState((state) => setUpdate(state));
    void window.devilCodex.checkForUpdates();
    return dispose;
  }, []);
  // When the AI drives the browser (devil_browser MCP), open/focus the browser
  // tab so the user watches it act.
  useEffect(() => window.devilCodex.onBrowserActivate(() => { openBrowserTab("right"); }), []);
  useEffect(() => window.devilCodex.onBrowserNewTab(({ sourceKey, url }) => {
    openBrowserTab(utilityTabs.includes(sourceKey) ? "right" : "bottom", url);
  }), [utilityTabs]);
  useEffect(() => { void window.devilCodex.appInfo().then(setAppInfo).catch(() => undefined); }, []);
  useEffect(() => { void window.devilCodex.listOpenWorkspaceTargets().then(setOpenTargets).catch(() => undefined); }, []);

  useEffect(() => {
    if ((agentRuntime === "codex" && runtime.state !== "connected") || !workspace) return;
    const timer = window.setInterval(() => {
      void refreshThreads(workspace, { quiet: true });
      void refreshProjects({ quiet: true });
      const activeThreadId = threadRef.current?.id;
      if (!activeThreadId) return;
      if (runningTurnsRef.current[activeThreadId] || pendingTurns.current.has(activeThreadId) || activeTurnsByThread.current.has(activeThreadId)) return;
      const activeRuntime = threadRef.current?.runtime ?? agentRuntime;
      if (activeRuntime === "claude-code") return;
      void window.devilCodex.syncThreadHistory({ id: activeThreadId, runtime: activeRuntime, accountId: threadRef.current?.accountId }).then((history) => {
        const localHistory = threadHistoryCache.current.get(activeThreadId) ?? visibleItemsForThread(activeThreadId) ?? [];
        const merged = mergeTimelineItems(localHistory, history);
        threadHistoryCache.current.set(activeThreadId, merged);
        if (threadRef.current?.id === activeThreadId) {
          itemsRef.current = merged;
          itemsOwnerRef.current = activeThreadId;
          setItems(merged);
        }
      }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [runtime.state, workspace, agentRuntime]);

  useEffect(() => window.devilCodex.onCommand((command) => {
    if (command === "new-thread") void newThread();
    if (command === "search") setCommandPaletteOpen(true);
    if (command === "settings") openView("settings");
    if (command === "open-project") void chooseWorkspace();
    if (command === "terminal") { closePopovers(); if (terminalOpen && bottomActive === "terminal:default") setTerminalOpen(false); else openBottomTool("terminal:default"); }
    if (command === "environment") { closePopovers(); setEnvironmentOpen((open) => !open); }
  }), [workspace, runtime.state, model, busy, bottomActive, terminalOpen, bridgeChatLocked]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPrimaryModifier(event)) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setCommandPaletteOpen((open) => !open); return; }
      if (event.key.toLowerCase() === "f" && view === "thread") { event.preventDefault(); setThreadFindOpen(true); return; }
      if (event.key === "[") { event.preventDefault(); goBack(); return; }
      if (event.key === "]") { event.preventDefault(); goForward(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [view, workspace, thread, items, projectDraft, environmentOpen, settingsSection, search]);

  // Guarantee Ctrl/Cmd+C copies a plain page selection (file viewer, chat
  // transcript, etc.). The native app-menu copy role was not reliably copying
  // read-only DOM selections, so intercept the copy path and write the current
  // selection ourselves. Editable fields keep their native behavior — an input
  // or textarea selection is not reflected by window.getSelection().
  useEffect(() => {
    const onCopy = (event: ClipboardEvent): void => {
      const selection = window.getSelection()?.toString() ?? "";
      if (!selection) return;
      event.clipboardData?.setData("text/plain", selection);
      event.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  useEffect(() => { localStorage.setItem("devil-codex:sidebar-width", String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { localStorage.setItem("devil-codex:utility-width", String(utilityWidth)); }, [utilityWidth]);
  useEffect(() => {
    if (view !== "thread") scrolledThreadId.current = null;
  }, [view]);

  useEffect(() => {
    let active = true;
    // Marketplace plugins are local cache data and must be available even in a
    // fresh chat before a project/runtime connection exists. Otherwise typing
    // `@` produces an empty suggestion panel until after the first connection.
    const runtimeSkills = workspace && runtime.state === "connected"
      ? window.devilCodex.listSkills({ cwd: workspace }).catch((error) => { setExternalError(`스킬 목록 실패: ${String(error)}`); return [] as CodexSkillInfo[]; })
      : Promise.resolve([] as CodexSkillInfo[]);
    void Promise.all([
      runtimeSkills,
      window.devilCodex.listCodexPluginSkills().catch(() => [] as CodexSkillInfo[]),
    ]).then(([skills, pluginSkills]) => {
      if (!active) return;
      const enabled = skills.filter((skill) => skill.enabled);
      const seen = new Set(enabled.map((skill) => skill.name.toLowerCase()));
      const extras = pluginSkills.filter((skill) => skill.enabled && !seen.has(skill.name.toLowerCase()));
      setAvailableSkills([...enabled, ...extras]);
    });
    return () => { active = false; };
  }, [workspace, runtime.state]);

  useEffect(() => {
    let active = true;
    void window.devilCodex.listClaudeSkills()
      .then((skills) => { if (active) setAvailableClaudeSkills(skills.filter((skill) => skill.enabled)); })
      .catch((error) => { if (active) setExternalError(`Claude 스킬 목록 실패: ${String(error)}`); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (composerRuntime !== "claude-code" || !workspace) {
      setAvailableClaudeSlashCommands([]);
      return;
    }
    let active = true;
    void window.devilCodex.listClaudeSlashCommands({ cwd: workspace, model: composerModel })
      .then((commands) => { if (active) setAvailableClaudeSlashCommands(commands.filter((command) => command.name)); })
      .catch((error) => {
        if (!active) return;
        setAvailableClaudeSlashCommands([]);
        setExternalError(`Claude 명령 목록 실패: ${String(error)}`);
      });
    return () => { active = false; };
  }, [composerRuntime, workspace, composerModel]);

  useEffect(() => {
    let active = true;
    // Claude Code loads its own MCP config (~/.claude.json, .mcp.json, plugin
    // .mcp.json), so the "/" menu must list those instead of Codex servers.
    if (composerRuntime === "claude-code") {
      void window.devilCodex.listClaudeMcpServers({ ...(workspace ? { cwd: workspace } : {}) })
        .then((servers) => { if (active) setAvailableMcpServers(servers.filter((server) => server.name)); })
        .catch(() => { if (active) setAvailableMcpServers([]); });
      return () => { active = false; };
    }
    if (runtime.state !== "connected") { setAvailableMcpServers([]); return; }
    void window.devilCodex.listMcpServers({ ...(thread?.id ? { threadId: thread.id } : {}) })
      .then((servers) => {
        if (!active) return;
        setAvailableMcpServers(servers.filter((server) => server.name && server.authStatus !== "disabled"));
      })
      .catch(() => { if (active) setAvailableMcpServers([]); });
    return () => { active = false; };
  }, [thread?.id, runtime.state, composerRuntime, workspace]);

  const composerSkillOptions = composerRuntime === "claude-code"
    ? [...CLAUDE_RUNTIME_SKILLS, ...availableClaudeSkills.filter((skill) => !CLAUDE_RUNTIME_SKILLS.some((builtIn) => builtIn.name === skill.name))]
    : devilBrowserOwnsRouting ? availableSkills.filter((skill) => skill.name !== "browser:control-in-app-browser") : availableSkills;
  const queuedHere = thread?.id ? (queuedView[thread.id]?.length ?? 0) : 0;
  function scheduleThreadScrollPersist(): void {
    if (scrollPersistFrame.current != null) return;
    scrollPersistFrame.current = requestAnimationFrame(() => {
      scrollPersistFrame.current = null;
      writeThreadScrollPositions(threadScrollPositions.current);
    });
  }

  function setScrollToBottomVisible(visible: boolean): void {
    if (showScrollToBottomRef.current === visible) return;
    showScrollToBottomRef.current = visible;
    setShowScrollToBottom(visible);
  }

  function rememberThreadScrollPosition(threadId: string, top: number, atBottom: boolean): void {
    if (!threadId || !Number.isFinite(top)) return;
    const normalizedTop = Math.max(0, top);
    const now = Date.now();
    const last = lastScrollPositionWrite.current;
    if (last?.threadId === threadId && last.atBottom === atBottom && Math.abs(last.top - normalizedTop) < 24 && now - last.at < 400) return;
    lastScrollPositionWrite.current = { threadId, top: normalizedTop, atBottom, at: now };
    threadScrollPositions.current[threadId] = { top: normalizedTop, atBottom, updatedAt: now };
    scheduleThreadScrollPersist();
  }

  function saveCurrentThreadScrollPosition(): void {
    const node = threadViewRef.current;
    const threadId = threadRef.current?.id;
    if (!node || !threadId) return;
    const hiddenBelow = node.scrollHeight - node.scrollTop - node.clientHeight;
    rememberThreadScrollPosition(threadId, node.scrollTop, hiddenBelow <= 140);
  }

  function syncThreadScrollState(node = threadViewRef.current): void {
    if (!node) {
      stickToThreadBottom.current = true;
      setScrollToBottomVisible(false);
      return;
    }
    const hiddenBelow = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = hiddenBelow <= 140;
    stickToThreadBottom.current = atBottom;
    setScrollToBottomVisible(!atBottom && itemsRef.current.length > 0);
    if (threadRef.current?.id) rememberThreadScrollPosition(threadRef.current.id, node.scrollTop, atBottom);
  }

  function setThreadNodeToBottom(node = threadViewRef.current, force = false): void {
    if (!node) return;
    if (!force && Date.now() < utilityScrollLockUntil.current) return;
    const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = maxTop;
    stickToThreadBottom.current = true;
    setScrollToBottomVisible(false);
    if (threadRef.current?.id) rememberThreadScrollPosition(threadRef.current.id, maxTop, true);
  }

  function stabilizeThreadBottom(threadId: string, attempts = 5): void {
    if (!threadId || !stickToThreadBottom.current) return;
    if (Date.now() < utilityScrollLockUntil.current) return;
    let remaining = attempts;
    const tick = (): void => {
      if (threadRef.current?.id !== threadId || !stickToThreadBottom.current) return;
      setThreadNodeToBottom();
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.setTimeout(() => {
      if (threadRef.current?.id === threadId && stickToThreadBottom.current) setThreadNodeToBottom();
    }, 80);
    window.setTimeout(() => {
      if (threadRef.current?.id === threadId && stickToThreadBottom.current) setThreadNodeToBottom();
    }, 220);
  }

  function captureUtilityScrollPosition(): void {
    const node = threadViewRef.current;
    const threadId = threadRef.current?.id;
    if (!node || !threadId) return;
    const hiddenBelow = node.scrollHeight - node.scrollTop - node.clientHeight;
    utilityScrollRestore.current = { threadId, top: node.scrollTop, atBottom: hiddenBelow <= 140 };
    utilityScrollLockUntil.current = Date.now() + 560;
  }

  function restoreUtilityScrollPosition(): void {
    const restore = utilityScrollRestore.current;
    if (!restore) return;
    const apply = (): void => {
      const node = threadViewRef.current;
      if (!node || threadRef.current?.id !== restore.threadId) return;
      const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.min(restore.top, maxTop);
      setScrollToBottomVisible(!restore.atBottom && itemsRef.current.length > 0);
      rememberThreadScrollPosition(restore.threadId, node.scrollTop, restore.atBottom);
    };
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
    window.setTimeout(apply, 120);
    window.setTimeout(apply, 280);
    window.setTimeout(() => {
      apply();
      stickToThreadBottom.current = restore.atBottom;
      utilityScrollRestore.current = null;
    }, 520);
  }

  function scrollThreadToBottom(): void {
    const threadId = threadRef.current?.id;
    setThreadNodeToBottom(undefined, true);
    if (threadId) stabilizeThreadBottom(threadId);
  }

  useLayoutEffect(() => {
    if (view !== "thread") return;
    const composerNode = composerWrapRef.current;
    if (!composerNode) return;
    let frame: number | null = null;
    const applyComposerClearance = (): void => {
      if (frame != null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        const next = Math.max(180, Math.ceil(composerNode.getBoundingClientRect().height) + 20);
        setComposerClearance((current) => Math.abs(current - next) > 1 ? next : current);
        const threadNode = threadViewRef.current;
        if (threadNode && stickToThreadBottom.current) {
          setThreadNodeToBottom(threadNode);
          if (threadRef.current?.id) stabilizeThreadBottom(threadRef.current.id, 3);
        }
      });
    };
    applyComposerClearance();
    const observer = new ResizeObserver(applyComposerClearance);
    observer.observe(composerNode);
    return () => { observer.disconnect(); if (frame != null) cancelAnimationFrame(frame); };
  }, [view, thread?.id, composerRuntime, queuedHere, runningTurns, terminalOpen, terminalHeight]);

  useLayoutEffect(() => {
    if (view !== "thread" || !thread?.id || !terminalOpen) return;
    if (!stickToThreadBottom.current) return;
    const node = threadViewRef.current;
    if (!node) return;
    setThreadNodeToBottom(node);
    stabilizeThreadBottom(thread.id, 4);
  }, [view, thread?.id, terminalOpen, terminalHeight]);

  useLayoutEffect(() => {
    if (view !== "thread" || !thread?.id) return;
    const firstRenderForThread = scrolledThreadId.current !== thread.id;
    if (firstRenderForThread) {
      scrolledThreadId.current = thread.id;
      const saved = threadScrollPositions.current[thread.id];
      stickToThreadBottom.current = saved ? saved.atBottom : true;
      pendingScrollRestoreThread.current = saved && !saved.atBottom ? thread.id : null;
    }
    const applyInitialScroll = (): void => {
      const node = threadViewRef.current;
      if (!node) return;
      const saved = threadScrollPositions.current[thread.id];
      if (pendingScrollRestoreThread.current === thread.id && saved && !saved.atBottom) {
        const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
        node.scrollTop = Math.min(saved.top, maxTop);
        if (itemsRef.current.length === 0 && maxTop <= 0) return;
        stickToThreadBottom.current = false;
        setScrollToBottomVisible(itemsRef.current.length > 0);
        if (maxTop >= saved.top || itemsRef.current.length > 0) {
          pendingScrollRestoreThread.current = null;
          syncThreadScrollState(node);
        }
        return;
      }
      if (stickToThreadBottom.current) {
        setThreadNodeToBottom(node);
        stabilizeThreadBottom(thread.id);
      } else {
        syncThreadScrollState(node);
      }
      if (initializingThreadId === thread.id) setInitializingThreadId(null);
    };
    applyInitialScroll();
    const frame = requestAnimationFrame(applyInitialScroll);
    return () => cancelAnimationFrame(frame);
    // items: agent responses stream by updating text/activity on existing
    // timeline items, so length alone misses the most common growth path.
    // queuedHere: when the waiting-message panel grows/shrinks the composer gets
    // taller, so re-pin to bottom to keep the latest message above it.
  }, [thread?.id, items, view, queuedHere, initializingThreadId]);

  // Re-read codex settings whenever the user leaves the Settings view (via back
  // button, palette, anywhere). SettingsView owns a separate settings hook, so
  // App's copy is otherwise stale — leaving the translate toggle visible after
  // "English output" was turned off.
  const prevViewRef = useRef(view);
  useEffect(() => {
    if (prevViewRef.current === "settings" && view !== "settings") codexSettings.reload();
    prevViewRef.current = view;
  }, [view, codexSettings.reload]);

  const folderName = basenamePath(workspace);
  const projectName = projectAliases[workspace] || projectAlias || folderName;
  const activeSummary = threads.find((item) => item.id === thread?.id);
  const threadTitle = activeSummary?.title || (thread ? "새 채팅" : "새 채팅");
  const isGeneralChatWorkspace = basenamePath(workspace) === "new-chat";
  const hasStartedThread = Boolean(activeSummary && items.length > 0);
  const canUseThreadMenu = view === "thread" && hasStartedThread;
  const composerDraftKey = thread?.id ? `${composerRuntime}:thread:${thread.id}` : `${agentRuntime}:${projectDraft ? "project-draft" : "new-chat"}:${cwdKey(workspace) || "__none__"}`;
  const composerReasoningEffort = composerConfig?.reasoningEffort ?? reasoningEffort;
  const composerResponseSpeed = composerConfig?.responseSpeed ?? responseSpeed;
  const runtimeLabel = composerRuntime === "claude-code" ? "Claude Code" : "Codex";
  const runtimeBrandLabel = agentRuntime === "claude-code" ? "Claude" : "Codex";
  const runtimeBrandIcon = agentRuntime === "claude-code" ? claudeRuntimeIcon : codexRuntimeIcon;
  const canOpenWorkspace = Boolean(workspace && !isGeneralChatWorkspace && openTargets.length > 0);
  const activeThreadBusy = Boolean(thread?.id && runningTurns[thread.id]);
  // Lock manual file editing while the model is running a turn in this
  // workspace (main chat or any side chat) so a human save never races an
  // AI-driven file write. Live fs updates keep the panel current meanwhile.
  const filesLocked = activeThreadBusy || Object.values(subagentBusy).some(Boolean);
  const runningThreadIds = useMemo(() => new Set(Object.keys(runningTurns)), [runningTurns]);
  // Codex sometimes emits the same answer as several agentMessages, so the final
  // text echoes inside the work tab as "작업 메모" and as extra standalone copies.
  // Per turn, keep only the last agent message (the final, shown outside) and
  // drop work-note / duplicate copies whose text equals it.
  const dedupedItems = useMemo(() => {
    // The final answer is the last standalone agent message of a turn (shown
    // outside the work tab). Codex sometimes also echoes it as a "작업 메모"
    // inside the work tab and/or as duplicate standalone copies — drop those.
    // Intermediate narration (different text) stays inside the work tab in place.
    const finalText = new Map<string, string>();
    const lastAgentIndex = new Map<string, number>();
    items.forEach((item, index) => {
      if (item.kind === "agent" && item.turnId) { finalText.set(item.turnId, (item.text ?? "").trim()); lastAgentIndex.set(item.turnId, index); }
    });
    return items.flatMap((item, index) => {
      if (item.kind === "agent" && item.turnId) {
        // Drop earlier standalone copies whose text equals the final.
        if (index !== lastAgentIndex.get(item.turnId) && (item.text ?? "").trim() === finalText.get(item.turnId)) return [];
        return [item];
      }
      if (item.kind === "activity" && item.turnId) {
        const ft = finalText.get(item.turnId);
        if (!ft) return [item];
        const activities = (item.activities ?? []).filter((entry) => !(entry.kind === "message" && entry.title === "작업 메모" && (entry.detail ?? "").trim() === ft));
        return [{ ...item, activities }];
      }
      return [item];
    });
  }, [items]);
  const contextUsage = useMemo(() => estimateContextUsage(items, composerModel), [items, composerModel]);
  const threadUsage = useMemo(() => summarizeThreadUsage({
    threadId: thread?.id,
    contextUsage,
    providers: providers.settings?.providers ?? [],
    requestLog: quickUsage.requestLog,
    items,
    defaultRuntime: composerRuntime,
    defaultProvider: composerProviderId,
    defaultModel: composerModel,
  }), [thread?.id, contextUsage, providers.settings?.providers, quickUsage.requestLog, items, composerRuntime, composerProviderId, composerModel]);
  const sideConversationRuntime = thread?.runtime ?? composerRuntime;
  const sideConversationProvider: ProviderId = sideConversationRuntime === "claude-code" ? composerProviderId : "codex";
  const sideConversationAccountId = sideConversationProvider === "codex" ? undefined : composerAccountId;
  const sideConversationModel = sideConversationRuntime === "claude-code"
    ? composerModel
    : providers.settings?.provider === "codex" ? model : "gpt-5.5";
  const sideConversationProviders = sideConversationRuntime === "claude-code" ? composerProviders : providers.settings?.providers ?? [];
  // Side chats must inherit the composer's approval mode. Without it the child
  // thread falls back to the app-server/SDK defaults (Codex on-request, Claude
  // "default" per-tool approval on a hidden thread), which diverges from the
  // main chat and can leave the side chat unable to read the repository.
  const sideConversationPermissions = sideChatPermissionsForMode(storedComposerApprovalMode());
  const visibleItems = useMemo(() => {
    const needle = threadFindQuery.trim().toLowerCase();
    return needle ? dedupedItems.filter((item) => `${item.title ?? ""}\n${item.text}\n${JSON.stringify(item.activities ?? [])}`.toLowerCase().includes(needle)) : dedupedItems;
  }, [dedupedItems, threadFindQuery]);
  const queuedTimelineItems = useMemo<ThreadHistoryItem[]>(() => {
    if (!thread?.id || threadFindQuery.trim()) return [];
    return (queuedView[thread.id] ?? []).map((item) => ({
      id: `queued-${item.id}`,
      kind: "user",
      title: "대기 중",
      text: item.text,
      status: "inProgress",
      attachments: item.attachments,
    }));
  }, [thread?.id, queuedView, threadFindQuery]);
  const timelineItems = useMemo(() => [...visibleItems, ...queuedTimelineItems], [visibleItems, queuedTimelineItems]);
  const runningTurnIds = useMemo(() => new Set(Object.values(runningTurns).map((turn) => turn.turnId).filter((turnId): turnId is string => Boolean(turnId))), [runningTurns]);
  const turnChangeMeta = useMemo(() => {
    const byTurn = new Map<string, Map<string, WorkspaceChange>>();
    const rollbackTurns = new Set<string>();
    for (const activity of items) {
      if (activity.kind !== "activity" || !activity.turnId) continue;
      for (const entry of activity.activities ?? []) {
        if (entry.kind !== "fileChange") continue;
        for (const file of entry.files ?? []) {
          const files = byTurn.get(activity.turnId) ?? new Map<string, WorkspaceChange>();
          byTurn.set(activity.turnId, files);
          const previous = files.get(file.path);
          files.set(file.path, {
            path: file.path,
            status: previous?.status ?? "modified",
            additions: (previous?.additions ?? 0) + file.additions,
            deletions: (previous?.deletions ?? 0) + file.deletions,
          });
          if (file.diff) rollbackTurns.add(activity.turnId);
        }
      }
    }
    const result = new Map<string, { changes: WorkspaceChanges; canRollback: boolean }>();
    for (const [turnId, fileMap] of byTurn) {
      const files = [...fileMap.values()];
      result.set(turnId, {
        changes: {
          available: true,
          branch: changes.branch,
          files,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        },
        canRollback: rollbackTurns.has(turnId),
      });
    }
    return result;
  }, [items, changes.branch]);
  const timelineDefaultChanges = useMemo<WorkspaceChanges>(() => ({ ...defaultChanges, branch: changes.branch }), [changes.branch]);
  const onTimelineRollback = useStableEvent((turnId: string) => { void rollbackTurn(turnId); });
  const onTimelineReview = useStableEvent(() => openUtility("review"));
  const onTimelineOpenFile = useStableEvent((path: string) => openWorkspaceFile(path));
  const visibleSearchResults = useMemo(() => searchResults.filter((summary) => !hiddenThreadIds.includes(summary.id) && !sideThreadSet.has(summary.id)), [searchResults, hiddenThreadIds, sideThreadSet]);
  // Subagents spawned in this thread, for the environment "하위 에이전트" list.
  const subagents = useMemo(() => {
    const byThread = new Map<string, { id: string; label: string; provider?: ProviderId; model?: string }>();
    for (const item of items) {
      if (item.kind !== "activity") continue;
      for (const entry of item.activities ?? []) {
        const sub = entry.kind === "subagent" ? entry.subagent : undefined;
        if (sub?.agentThreadId && !byThread.has(sub.agentThreadId)) {
          byThread.set(sub.agentThreadId, {
            id: sub.agentThreadId,
            label: sub.nickname || sub.role || "서브에이전트",
            provider: sub.role as ProviderId | undefined,
            model: sub.model,
          });
        }
      }
    }
    return [...byThread.values()];
  }, [items]);
  useEffect(() => {
    setSubagentPick((current) => {
      let changed = false;
      const next = { ...current };
      for (const agent of subagents) {
        if (!agent.provider || !agent.model) continue;
        const existing = next[agent.id];
        if (existing?.provider === agent.provider && existing.model === agent.model && existing.auto === false) continue;
        next[agent.id] = { provider: agent.provider, model: agent.model, auto: false };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [subagents]);
  useEffect(() => {
    // Native Codex multi-agent spawns (`collabAgentToolCall` in threadTimeline)
    // carry no model/provider on the timeline entry itself — only devil's own
    // delegate_subagent tool reports that inline. For native spawns, look up
    // the real per-thread model Codex recorded at spawn time (state DB, via
    // getSubagentInfo) so the side-chat model badge doesn't fall back to
    // whatever model happens to be selected in the main composer right now.
    for (const agent of subagents) {
      const haveName = Boolean(subagentNames[agent.id]);
      const haveModel = Boolean(agent.model) || subagentPick[agent.id]?.auto === false;
      if (haveName && haveModel) continue;
      void window.devilCodex.getSubagentInfo({ id: agent.id }).then((info) => {
        if (info.nickname) setSubagentNames((prev) => prev[agent.id] ? prev : { ...prev, [agent.id]: info.nickname! });
        if (info.model && !agent.model) {
          setSubagentPick((prev) => prev[agent.id]?.auto === false ? prev : { ...prev, [agent.id]: { provider: "codex", model: info.model!, auto: false } });
        }
      }).catch(() => undefined);
    }
  }, [subagents, subagentNames, subagentPick]);
  const namedSubagents = useMemo(() => subagents.map((agent) => ({ ...agent, label: subagentNames[agent.id] || agent.label })), [subagents, subagentNames]);
  useEffect(() => {
    const key = threadStateKey(thread?.runtime ?? agentRuntime, thread?.id, emptyThreadStateId(workspace, projectDraft));
    const ids = new Set(namedSubagents.map((agent) => agent.id));
    if (autoSubagentSeedKey.current !== key) {
      autoSubagentSeedKey.current = key;
      autoSubagentSeen.current = ids;
      return;
    }
    for (const agent of namedSubagents) {
      if (autoSubagentSeen.current.has(agent.id)) continue;
      autoSubagentSeen.current.add(agent.id);
      openSubagentTab(agent.id, agent.label);
    }
  }, [namedSubagents, thread, agentRuntime, workspace, projectDraft]);
  const sideChatList = namedSubagents;
  const environmentSources = useMemo(() => collectEnvironmentSources(items), [items]);
  // Persist right-panel tabs per main thread so returning restores open tabs.
  useEffect(() => {
    if (skipNextPanelSave.current) {
      skipNextPanelSave.current = false;
      return;
    }
    const key = threadStateKey(thread?.runtime ?? agentRuntime, thread?.id, emptyThreadStateId(workspace, projectDraft));
    panelByThread.current[key] = { tabs: utilityTabs, active: utilityActive, open: utilityPanelOpen, expanded: utilityPanelExpanded };
  }, [utilityTabs, utilityActive, utilityPanelOpen, utilityPanelExpanded, thread, agentRuntime, workspace, projectDraft]);
  useEffect(() => {
    if (skipNextBottomSave.current) {
      skipNextBottomSave.current = false;
      return;
    }
    const key = threadStateKey(thread?.runtime ?? agentRuntime, thread?.id, emptyThreadStateId(workspace, projectDraft));
    bottomByThread.current[key] = { tabs: bottomTabs, active: bottomActive, open: terminalOpen, height: terminalHeight };
  }, [bottomTabs, bottomActive, terminalOpen, terminalHeight, thread, agentRuntime, workspace, projectDraft]);
  useEffect(() => {
    if (view !== "search" || !search.trim()) { setSearchResults([]); setSearchBusy(false); return; }
    const timer = window.setTimeout(() => {
      setSearchBusy(true);
      void window.devilCodex.searchThreads({ query: search, runtime: agentRuntime }).then(setSearchResults).catch((error) => setExternalError(`검색 실패: ${String(error)}`)).finally(() => setSearchBusy(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [search, view, agentRuntime]);

  const sidebarLoading = threadsLoading || projectsLoading;
  const projectGroups = useMemo(() => {
    const sortThreadList = (list: ThreadSummary[]): ThreadSummary[] => [...list]
      .filter((summary) => !hiddenThreadIds.includes(summary.id))
      .sort((a, b) => {
        const markerDelta = Number(pinnedThreads.includes(b.id)) - Number(pinnedThreads.includes(a.id));
        if (markerDelta !== 0) return markerDelta;
        if (projectSortMode === "created") return a.updatedAt - b.updatedAt;
        if (projectSortMode === "updated") return b.updatedAt - a.updatedAt;
        return 0;
      });
    const map = new Map<string, { cwd: string; threads: ThreadSummary[] }>();
    const addProjectThreads = (cwd: string, list: ThreadSummary[]): void => {
      const key = cwdKey(cwd);
      if (!key) return;
      const existing = map.get(key);
      if (existing) existing.threads.push(...list);
      else map.set(key, { cwd, threads: [...list] });
    };
    for (const group of projects) addProjectThreads(group.cwd, group.threads);
    // `threads` is only the currently selected workspace's fast-refresh list.
    // Merge it into the project cache instead of replacing that cache; replacing
    // it made sibling threads disappear whenever another project was opened.
    if (workspace) {
      const key = cwdKey(workspace);
      const existing = map.get(key);
      const merged = new Map((existing?.threads ?? []).map((summary) => [summary.id, summary]));
      // `workspace` changes synchronously when the user opens a thread, but
      // its fast-refresh `threads` list arrives asynchronously. During that
      // gap it can still hold the previous project's rows. Only merge rows
      // that explicitly belong to the active cwd; otherwise Devil-Codex rows
      // briefly (and after a failed refresh, permanently) appeared in memoc.
      for (const summary of threads) {
        if (cwdKey(summary.cwd) === key) merged.set(summary.id, summary);
      }
      map.set(key, { cwd: existing?.cwd ?? workspace, threads: [...merged.values()] });
    }
    for (const cwd of localProjectCwds) {
      const key = cwdKey(cwd);
      if (key && !map.has(key)) map.set(key, { cwd, threads: [] });
    }
    const hiddenProjectKeys = new Set(hiddenProjects.map(cwdKey));
    return [...map.values()]
      .filter(({ cwd }) => cwd && !hiddenProjectKeys.has(cwdKey(cwd)) && basenamePath(cwd) !== "new-chat")
      // Side-chat / subagent threads are not standalone conversations.
      .map(({ cwd, threads: all }) => ({ cwd, list: sortThreadList([...new Map(all.map((thread) => [thread.id, thread])).values()].filter((t) => !sideThreadSet.has(t.id) && !isProjectlessThread(t))) }))
      .filter(({ cwd, list }) => list.length > 0 || localProjectCwds.some((projectCwd) => cwdKey(projectCwd) === cwdKey(cwd)))
      .map(({ cwd, list }) => ({ cwd, name: projectAliases[cwd] || basenamePath(cwd), threads: list, recency: list.reduce((max, t) => Math.max(max, t.updatedAt), 0) }))
      .sort((a, b) => {
        const pinDelta = (pinnedProjects.includes(b.cwd) ? 1 : 0) - (pinnedProjects.includes(a.cwd) ? 1 : 0);
        if (projectSortMode === "created") return pinDelta !== 0 ? pinDelta : a.recency - b.recency;
        if (projectSortMode === "updated" || sidebarLayoutMode === "recent") return pinDelta !== 0 ? pinDelta : b.recency - a.recency;
        return pinDelta;
      });
  }, [workspace, threads, projects, localProjectCwds, hiddenProjects, hiddenThreadIds, pinnedProjects, pinnedThreads, projectAliases, sideThreadSet, projectSortMode, sidebarLayoutMode]);

  const generalChats = useMemo(() => {
    const fromProjects = projects.flatMap((group) => group.threads.filter(isProjectlessThread));
    const fromActive = threads.filter(isProjectlessThread);
    const byId = new Map<string, ThreadSummary>();
    for (const summary of [...fromActive, ...fromProjects]) if (!sideThreadSet.has(summary.id) && !hiddenThreadIds.includes(summary.id)) byId.set(summary.id, summary);
    return [...byId.values()].sort((a, b) => Number(pinnedThreads.includes(b.id)) - Number(pinnedThreads.includes(a.id)) || b.updatedAt - a.updatedAt);
  }, [projects, threads, workspace, sideThreadSet, hiddenThreadIds, pinnedThreads]);
  const timelineProjectThreads = useMemo(() => projectGroups.flatMap((group) => group.threads.map((summary) => ({ ...summary, title: `${group.name} · ${summary.title}` }))).sort((a, b) => b.updatedAt - a.updatedAt), [projectGroups]);
  const commandPaletteThreads = useMemo(() => {
    const byId = new Map<string, ThreadSummary>();
    for (const summary of [...generalChats, ...timelineProjectThreads]) byId.set(summary.id, summary);
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [generalChats, timelineProjectThreads]);
  const allProjectsExpanded = projectGroups.length > 0 && projectGroups.every((group) => expandedProjects[group.cwd] ?? false);

  function toggleAllProjects(): void {
    if (allProjectsExpanded) {
      setExpandedProjects({});
      return;
    }
    setExpandedProjects(Object.fromEntries(projectGroups.map((group) => [group.cwd, true])));
    setProjectExpanded(true);
  }

  function markThreadRunning(threadId: string, turnId?: string): void {
    if (!threadId) return;
    setRunningTurns((current) => ({ ...current, [threadId]: { turnId, startedAt: Date.now() } }));
  }

  function clearThreadRunning(threadId: string): void {
    if (!threadId) return;
    setRunningTurns((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }

  // Append an item to a thread's timeline whether it's the visible chat or a
  // backgrounded one (cache-only). Mirrors the live-event append path.
  function appendItemToThread(threadId: string, item: ThreadHistoryItem): void {
    if (!threadId) return;
    const runtimeForThread = threadRef.current?.id === threadId ? threadRef.current.runtime ?? agentRuntime : agentRuntime;
    const save = (next: ThreadHistoryItem[]): void => { void window.devilCodex.cacheThreadHistory({ id: threadId, items: next, runtime: runtimeForThread }).catch(() => undefined); };
    if (threadRef.current?.id === threadId) {
      setItems((current) => {
        const next = [...current, item];
        itemsRef.current = next;
        itemsOwnerRef.current = threadId;
        threadHistoryCache.current.set(threadId, next);
        save(next);
        return next;
      });
    } else {
      const next = [...(threadHistoryCache.current.get(threadId) ?? []), item];
      threadHistoryCache.current.set(threadId, next);
      save(next);
    }
  }

  function insertItemsAfterTurn(threadId: string, turnId: string | undefined, insertItems: ThreadHistoryItem[]): void {
    const uniqueItems = insertItems.filter((item, index, source) => source.findIndex((candidate) => candidate.id === item.id) === index);
    if (!threadId || uniqueItems.length === 0) return;
    const runtimeForThread = threadRef.current?.id === threadId ? threadRef.current.runtime ?? agentRuntime : agentRuntime;
    const save = (next: ThreadHistoryItem[]): void => { void window.devilCodex.cacheThreadHistory({ id: threadId, items: next, runtime: runtimeForThread }).catch(() => undefined); };
    const insert = (current: ThreadHistoryItem[]): ThreadHistoryItem[] => {
      const existing = new Set(current.map((item) => item.id));
      const missing = uniqueItems.filter((item) => !existing.has(item.id));
      if (missing.length === 0) return current;
      const anchorIndex = turnId
        ? current.reduce((last, item, index) => item.turnId === turnId ? index : last, -1)
        : -1;
      const insertIndex = anchorIndex >= 0 ? anchorIndex + 1 : current.length;
      return [...current.slice(0, insertIndex), ...missing, ...current.slice(insertIndex)];
    };
    if (threadRef.current?.id === threadId) {
      setItems((current) => {
        const next = insert(current);
        if (next === current) return current;
        itemsRef.current = next;
        itemsOwnerRef.current = threadId;
        threadHistoryCache.current.set(threadId, next);
        save(next);
        return next;
      });
      return;
    }
    const current = threadHistoryCache.current.get(threadId) ?? [];
    const next = insert(current);
    if (next !== current) {
      threadHistoryCache.current.set(threadId, next);
      save(next);
    }
  }

  function persistThreadHistory(threadId: string, items: ThreadHistoryItem[]): void {
    if (!threadId) return;
    threadHistoryCache.current.set(threadId, items);
    const runtimeForThread = threadRef.current?.id === threadId ? threadRef.current.runtime ?? agentRuntime : agentRuntime;
    void window.devilCodex.cacheThreadHistory({ id: threadId, items, runtime: runtimeForThread }).catch(() => undefined);
  }

  function removeItemFromThread(threadId: string, itemId: string): void {
    if (!threadId || !itemId) return;
    const remove = (current: ThreadHistoryItem[]): ThreadHistoryItem[] => current.filter((item) => item.id !== itemId);
    if (threadRef.current?.id === threadId) {
      setItems((current) => {
        const next = remove(current);
        itemsRef.current = next;
        persistThreadHistory(threadId, next);
        return next;
      });
      return;
    }
    persistThreadHistory(threadId, remove(threadHistoryCache.current.get(threadId) ?? []));
  }

  function ensureCompactionMarker(threadId: string, turnId?: string): void {
    if (!threadId) return;
    const entry = { id: `compaction-${turnId || threadId}`, kind: "compaction" as const, title: "컨텍스트가 자동으로 압축됨", status: "completed" as const };
    const markerItem: ThreadHistoryItem = { id: `activity-compaction-${turnId || threadId}`, kind: "activity", text: "", ...(turnId ? { turnId } : {}), activities: [entry] };
    const upsert = (current: ThreadHistoryItem[]): ThreadHistoryItem[] => {
      if (current.some((item) => item.activities?.some((activity) => activity.kind === "compaction" && activity.id === entry.id))) return current;
      if (turnId) {
        const index = current.findIndex((item) => item.kind === "activity" && item.turnId === turnId);
        if (index >= 0) {
          return current.map((item, itemIndex) => itemIndex === index ? { ...item, activities: [...(item.activities ?? []), entry] } : item);
        }
      }
      return [...current, markerItem];
    };
    if (threadRef.current?.id === threadId) {
      setItems((current) => {
        const next = upsert(current);
        itemsRef.current = next;
        persistThreadHistory(threadId, next);
        return next;
      });
    } else {
      persistThreadHistory(threadId, upsert(threadHistoryCache.current.get(threadId) ?? []));
    }
  }

  function pendingForThread(threadId: string): PendingTurnState | null {
    return pendingTurns.current.get(threadId) ?? (pendingTurn.current?.threadId === threadId ? pendingTurn.current : null);
  }

  function rememberCompactionRetry(threadId: string): boolean {
    if (!threadId || compactionRetries.current.has(threadId)) return compactionRetries.current.has(threadId);
    const pending = pendingForThread(threadId);
    if (!pending || pending.retriedAfterCompaction) return false;
    compactionRetries.current.set(threadId, { pending: { ...pending }, retrying: false });
    markThreadRunning(threadId);
    if (threadRef.current?.id === threadId) setBusy(true);
    return true;
  }

  function failCompactionRetry(threadId: string, error: unknown): void {
    const errorItem: ThreadHistoryItem = { id: crypto.randomUUID(), kind: "system", title: "압축 후 요청 재개 실패", text: String(error) };
    appendItemToThread(threadId, errorItem);
    if (pendingTurn.current?.threadId === threadId) pendingTurn.current = null;
    pendingTurns.current.delete(threadId);
    compactionRetries.current.delete(threadId);
    if (activeTurn.current?.threadId === threadId) activeTurn.current = null;
    activeTurnsByThread.current.delete(threadId);
    clearThreadRunning(threadId);
    if (threadRef.current?.id === threadId) setBusy(false);
  }

  function retryPendingAfterCompaction(threadId: string, turnId?: string): void {
    if (!rememberCompactionRetry(threadId)) return;
    const state = compactionRetries.current.get(threadId);
    if (!state || state.retrying) return;
    state.retrying = true;
    if (turnId) compactedTurns.current.add(turnId);
    const retry: PendingTurnState = { ...state.pending, contextUsage: undefined, retriedAfterCompaction: true };
    state.pending = retry;
    pendingTurn.current = retry;
    pendingTurns.current.set(threadId, retry);
    markThreadRunning(threadId);
    if (threadRef.current?.id === threadId) setBusy(true);
    window.setTimeout(() => {
      void window.devilCodex.sendTurn(retry).catch((error) => failCompactionRetry(threadId, error));
    }, 80);
  }

  function modelDisplayName(input: SentModelState): string {
    const provider = providers.settings?.providers.find((item) => item.id === input.provider);
    const account = provider?.accounts.find((item) => item.id === input.accountId);
    const modelInfo = (account?.models?.length ? account.models : provider?.models)?.find((item) => item.id === input.model);
    const label = modelInfo?.label || input.model;
    const accountLabel = account ? `${account.email || account.label || account.id} · ` : "";
    return input.provider === "codex" ? label : `${provider?.label ?? input.provider} ${accountLabel}${label}`;
  }

  function rememberThreadModel(threadId: string, provider: ProviderId, nextModel: string, nextAccountId?: string): void {
    if (!threadId || !nextModel) return;
    lastSentModels.current = { ...lastSentModels.current, [threadId]: { provider, accountId: nextAccountId, model: nextModel } };
    localStorage.setItem(LAST_SENT_MODELS_KEY, JSON.stringify(lastSentModels.current));
  }

  function updateVisibleThreadProvider(threadId: string, provider: ProviderId, nextModel: string, nextAccountId?: string): void {
    const apply = (current: ThreadRef | null): ThreadRef | null => current?.id === threadId
      ? { ...current, runtime: agentRuntime, provider, model: nextModel, accountId: nextAccountId }
      : current;
    threadRef.current = apply(threadRef.current);
    setThread((current) => apply(current));
  }

  function modelChangeItemForThread(threadId: string, provider: ProviderId, nextModel: string, nextAccountId?: string): ThreadHistoryItem | null {
    const next = { provider, accountId: nextAccountId, model: nextModel };
    const previous = lastSentModels.current[threadId];
    rememberThreadModel(threadId, provider, nextModel, nextAccountId);
    if (!previous || modelKey(previous) === modelKey(next)) return null;
    return {
      id: `model-change-${threadId}-${Date.now()}`,
      kind: "system",
      title: "모델 변경",
      text: `${modelDisplayName(previous)}에서 ${modelDisplayName(next)}(으)로 모델이 변경되었습니다.`,
    };
  }

  function applyQueuedView(threadId: string, queue: Array<{ id: string; text: string; attachments?: ThreadAttachment[]; steering?: boolean }>): void {
    setQueuedView((current) => {
      if (queue.length === 0) {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      }
      return { ...current, [threadId]: queue };
    });
  }

  // Mirror the queue ref into reactive state so the queued-message panel can
  // render (and edit) what's waiting. The ref stays the send-path source of
  // truth; this is the view projection.
  function syncQueuedView(threadId: string): void {
    const queue = queuedTurns.current.get(threadId) ?? [];
    const nextQueue = queue.map((entry) => ({ id: entry.id, text: entry.userItem.text ?? "", attachments: entry.userItem.attachments, ...(entry.steering ? { steering: true } : {}) }));
    applyQueuedView(threadId, nextQueue);
    void window.devilCodex.syncThreadQueue({ threadId, queue: nextQueue.map((entry) => ({ ...entry, threadId })) }).catch((error) => {
      console.warn("[devil-codex] queue sync failed", error);
    });
  }

  function enqueueTurn(threadId: string, entry: QueuedTurn, front = false): void {
    const queue = queuedTurns.current.get(threadId) ?? [];
    if (front) queue.unshift(entry); else queue.push(entry);
    queuedTurns.current.set(threadId, queue);
    syncQueuedView(threadId);
  }

  function clearQueuedTurns(threadId: string): void {
    if (queuedTurns.current.delete(threadId)) syncQueuedView(threadId);
  }

  function editQueuedTurn(threadId: string, id: string, text: string): void {
    const queue = queuedTurns.current.get(threadId);
    const entry = queue?.find((item) => item.id === id);
    if (!entry) return;
    entry.userItem = { ...entry.userItem, text };
    entry.pending = { ...entry.pending, text };
    syncQueuedView(threadId);
  }

  function removeQueuedTurn(threadId: string, id: string): void {
    const queue = queuedTurns.current.get(threadId);
    if (!queue) return;
    const next = queue.filter((item) => item.id !== id);
    if (next.length === 0) queuedTurns.current.delete(threadId);
    else queuedTurns.current.set(threadId, next);
    syncQueuedView(threadId);
  }

  function steeringPending(pending: PendingTurnState): PendingTurnState {
    if (pending.text.startsWith(STEERING_PREFIX)) return pending;
    return { ...pending, text: `${STEERING_PREFIX}\n${pending.text}` };
  }

  // Steer a specific queued message: move it to the front, then interrupt the
  // running turn so it sends next (model keeps history → redirects to this).
  function steerQueuedTurn(threadId: string, id: string): void {
    const queue = queuedTurns.current.get(threadId);
    if (!queue) return;
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) queuedTurns.current.delete(threadId);
    else queuedTurns.current.set(threadId, queue);
    syncQueuedView(threadId);

    const activeTurnId = runningTurnsRef.current[threadId]?.turnId ?? activeTurnsByThread.current.get(threadId);
    const canNativeSteer = entry.pending.runtime === "codex"
      && (entry.pending.provider ?? "codex") === "codex"
      && Boolean(activeTurnId)
      && (entry.pending.skills ?? []).length === 0
      && (entry.pending.attachments ?? []).length === 0
      && (entry.pending.attachmentDetails ?? []).length === 0;
    if (canNativeSteer && activeTurnId) {
      const modelNotice = modelChangeItemForThread(threadId, entry.pending.provider ?? "codex", entry.pending.model, entry.pending.accountId);
      // Native `turn/steer` completes the current turn asynchronously, just
      // like the interrupt-and-queue fallback. Mark that turn immediately so
      // late events from the old response cannot overwrite the optimistic user
      // message before the steered turn starts.
      steeringInterruptedTurns.current.add(activeTurnId);
      insertItemsAfterTurn(threadId, activeTurnId, [modelNotice, entry.userItem].filter((item): item is ThreadHistoryItem => Boolean(item)));
      void window.devilCodex.steerTurn({ threadId, text: entry.pending.text, expectedTurnId: activeTurnId, runtime: "codex" }).catch((error) => {
        steeringInterruptedTurns.current.delete(activeTurnId);
        if (modelNotice) removeItemFromThread(threadId, modelNotice.id);
        removeItemFromThread(threadId, entry.userItem.id);
        appendItemToThread(threadId, { id: crypto.randomUUID(), kind: "system", title: "스티어링 실패", text: `${String(error)}\n대기열 중단 방식으로 다시 시도합니다.` });
        entry.pending = steeringPending(entry.pending);
        entry.steering = true;
        entry.steerAfterTurnId = activeTurnId;
        enqueueTurn(threadId, entry, true);
        if (runningTurnsRef.current[threadId]) interruptForSteer(threadId);
        else startQueuedTurn(threadId);
      });
      return;
    }

    entry.pending = steeringPending(entry.pending);
    entry.steering = true;
    entry.steerAfterTurnId = activeTurnId;
    enqueueTurn(threadId, entry, true);
    if (runningTurnsRef.current[threadId]) interruptForSteer(threadId);
    else startQueuedTurn(threadId);
  }

  // Fire the next queued message for a thread once its prior turn completed. The
  // user bubble is added here (not at enqueue time) so the timeline stays in
  // order: response → next user message → next response.
  function startQueuedTurn(threadId: string): void {
    const queue = queuedTurns.current.get(threadId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (!next) return;
    if (queue.length === 0) queuedTurns.current.delete(threadId);
    syncQueuedView(threadId);
    const modelNotice = modelChangeItemForThread(threadId, next.pending.provider ?? "codex", next.pending.model, next.pending.accountId);
    const timelineItems = [modelNotice, next.userItem].filter((item): item is ThreadHistoryItem => Boolean(item));
    if (next.steering) insertItemsAfterTurn(threadId, next.steerAfterTurnId, timelineItems);
    else timelineItems.forEach((item) => appendItemToThread(threadId, item));
    updateVisibleThreadProvider(threadId, next.pending.provider ?? "codex", next.pending.model, next.pending.accountId);
    pendingTurn.current = next.pending;
    pendingTurns.current.set(threadId, next.pending);
    markThreadRunning(threadId);
    if (threadRef.current?.id === threadId) setBusy(true);
    void window.devilCodex.sendTurn(next.pending).catch((error) => {
      appendItemToThread(threadId, { id: crypto.randomUUID(), kind: "system", title: "대기 요청 전송 실패", text: String(error) });
      pendingTurn.current = null;
      pendingTurns.current.delete(threadId);
      clearThreadRunning(threadId);
      startQueuedTurn(threadId);
    });
  }

  // Steering: cut the running turn short and jump this message to the front of
  // the queue. The interrupt's turn/completed triggers startQueuedTurn, which
  // sends it first — same thread, so the model keeps full history and redirects.
  function interruptForSteer(threadId: string): void {
    const history = threadRef.current?.id === threadId ? itemsRef.current : threadHistoryCache.current.get(threadId) ?? [];
    const turnId = activeTurnsByThread.current.get(threadId) ?? latestInterruptibleTurnId(history);
    if (turnId) steeringInterruptedTurns.current.add(turnId);
    void window.devilCodex.interruptTurn({ threadId, runtime: pendingForThread(threadId)?.runtime ?? threadRef.current?.runtime ?? agentRuntime, turnId }).catch((error) => {
      if (/no active turn to interrupt/i.test(String(error))) {
        if (turnId) steeringInterruptedTurns.current.delete(turnId);
        activeTurnsByThread.current.delete(threadId);
        if (activeTurn.current?.threadId === threadId) activeTurn.current = null;
        clearThreadRunning(threadId);
        startQueuedTurn(threadId);
        return;
      }
      if (turnId) steeringInterruptedTurns.current.delete(turnId);
      setExternalError(`스티어링 실패: ${String(error)}`);
    });
  }

  // When a computer-use / browser tool call fails (typically a missing macOS
  // permission or an unconnected browser extension), surface a hint banner so
  // the user can open the right settings — like stock Codex.
  function detectPermissionHint(params: Record<string, unknown>): void {
    const item = params.item as Record<string, unknown> | undefined;
    if (!item || item.status !== "failed") return;
    const tool = String(item.tool ?? "").toLowerCase();
    const blob = `${tool} ${JSON.stringify(item.result ?? item.error ?? "")}`.toLowerCase();
    // Only Computer Use (native screen control) still needs a macOS permission.
    // Browser control runs through our own embedded webview (no Chrome extension),
    // so codex's own browser/iab/chrome tool failures are irrelevant here.
    const computerUse = /computer_use|get_app_state|type_text|select_text|set_value/.test(tool) || /eraetimeout|accessibility|screen recording/.test(blob);
    if (computerUse) setPermissionHint("computer-use");
  }

  function queueVisibleTimelineEvent(threadId: string, event: AppServerEvent, turnId: string, pending: PendingTurnState | undefined): void {
    visibleTimelineQueue.current.push({ threadId, event, turnId, pending });
    if (visibleTimelineFrame.current != null) return;
    visibleTimelineFrame.current = requestAnimationFrame(() => {
      visibleTimelineFrame.current = null;
      const queued = visibleTimelineQueue.current;
      visibleTimelineQueue.current = [];
      if (!queued.length) return;
      setItems((current) => {
        let next = current;
        const visibleThreadId = threadRef.current?.id ?? "";
        for (const entry of queued) {
          if (entry.threadId && entry.threadId !== visibleThreadId) {
            const cached = annotateAgentMessages(applyTimelineEvent(threadHistoryCache.current.get(entry.threadId) ?? [], entry.event), entry.turnId, entry.pending);
            threadHistoryCache.current.set(entry.threadId, cached);
            continue;
          }
          next = annotateAgentMessages(applyTimelineEvent(next, entry.event), entry.turnId, entry.pending);
        }
        itemsRef.current = next;
        if (visibleThreadId) threadHistoryCache.current.set(visibleThreadId, next);
        if (visibleThreadId) itemsOwnerRef.current = visibleThreadId;
        return next;
      });
    });
  }

  useEffect(() => {
    const dispose = window.devilCodex.onApprovalResolved((event: ApprovalResolvedEvent) => {
      setApprovalQueue((current) => current.filter((prompt) => String(prompt.requestId) !== String(event.requestId)));
      setApprovalResponding(false);
    });
    return dispose;
  }, []);
  function receiveEvent(event: AppServerEvent): void {
    const approval = approvalPromptFromEvent(event);
    if (approval) {
      notifyInBackground("notifyOnApproval", approval.kind === "command" ? "명령 실행 승인 필요" : "파일 변경 승인 필요", approval.command || approval.reason || "AI 작업을 계속하려면 승인이 필요합니다.", "critical", true);
      setApprovalQueue((current) => current.some((prompt) => prompt.requestId === approval.requestId) ? current : [...current, approval]);
      return;
    }
    const eventParams = (event.params ?? {}) as Record<string, unknown>;
    if (event.method === "thread/compaction_started") {
      rememberCompactionRetry(String(eventParams.threadId ?? ""));
      return;
    }
    const inferredThreadId = String(eventParams.threadId ?? activeTurn.current?.threadId ?? pendingTurn.current?.threadId ?? "");
    const requiresThreadScope = event.method.startsWith("turn/")
      || event.method.startsWith("item/")
      || event.method === "response.failed"
      || event.method === "thread/compacted";
    if (requiresThreadScope && !inferredThreadId) return;
    detectPermissionHint(eventParams);
    if (event.method === "turn/started") {
      const turnId = String(eventParams.turnId ?? (eventParams.turn as { id?: unknown } | undefined)?.id ?? "");
      const threadId = inferredThreadId;
      if (turnId && threadId) {
        activeTurn.current = { threadId, turnId };
        activeTurnsByThread.current.set(threadId, turnId);
        const retryState = compactionRetries.current.get(threadId);
        if (retryState?.retrying && retryState.pending.retriedAfterCompaction) retryState.retryTurnId = turnId;
        markThreadRunning(threadId, turnId);
      }
    }
    // Subagent side-chat turns stream under their own threadId. Keep every such
    // event out of the main timeline (the side-chat owns its own conversation),
    // regardless of which main thread is currently open. Persistent set so it
    // holds even after the user navigates away mid-turn.
    const explicitThreadId = String(eventParams.threadId ?? "");
    const inSubagentTurn = !explicitThreadId && activeTurn.current != null && subagentIdsRef.current.has(activeTurn.current.threadId);
    const subTid = explicitThreadId && subagentIdsRef.current.has(explicitThreadId) ? explicitThreadId
      : inSubagentTurn && activeTurn.current ? activeTurn.current.threadId : "";
    if (subTid) {
      // Build the subagent's conversation live (like the main chat) instead of
      // relying on a post-turn readThread, which can lag the finished turn.
      setSubagentHistory((prev) => ({ ...prev, [subTid]: applyTimelineEvent(prev[subTid] ?? [], event) }));
      if (event.method === "turn/started") setSubagentBusy((prev) => ({ ...prev, [subTid]: true }));
      if (event.method === "turn/completed") {
        setSubagentBusy((prev) => ({ ...prev, [subTid]: false }));
        clearThreadRunning(subTid);
        activeTurnsByThread.current.delete(subTid);
        if (activeTurn.current && subagentIdsRef.current.has(activeTurn.current.threadId)) activeTurn.current = null;
      }
      return;
    }
    const eventThreadId = inferredThreadId;
    const visibleThreadId = threadRef.current?.id ?? "";
    const eventTurnId = String(eventParams.turnId ?? (eventParams.turn as { id?: unknown } | undefined)?.id ?? activeTurnsByThread.current.get(eventThreadId) ?? "");
    const timelineEvent = eventTurnId && !eventParams.turnId
      ? { ...event, params: { ...eventParams, turnId: eventTurnId } }
      : event;
    const suppressInterruptedTurnEvent = Boolean(
      eventTurnId
      && steeringInterruptedTurns.current.has(eventTurnId)
      && (event.method.startsWith("item/") || event.method === "response.failed")
    );
    if (suppressInterruptedTurnEvent) return;
    const suppressInterruptedTurnTimeline = Boolean(
      eventTurnId
      && steeringInterruptedTurns.current.has(eventTurnId)
      && event.method === "turn/completed"
    );
    const pendingForEvent = pendingForThread(eventThreadId);
    if (eventThreadId && eventThreadId !== visibleThreadId) {
      if (!suppressInterruptedTurnTimeline) {
        const next = annotateAgentMessages(applyTimelineEvent(threadHistoryCache.current.get(eventThreadId) ?? [], timelineEvent), eventTurnId, pendingForEvent ?? undefined);
        threadHistoryCache.current.set(eventThreadId, next);
      }
    } else {
      if (!suppressInterruptedTurnTimeline) queueVisibleTimelineEvent(eventThreadId, timelineEvent, eventTurnId, pendingForEvent ?? undefined);
    }
    if (event.method === "response.failed" && eventThreadId) {
      if (!eventTurnId || activeTurn.current?.turnId === eventTurnId || activeTurn.current?.threadId === eventThreadId) activeTurn.current = null;
      if (!eventTurnId || activeTurnsByThread.current.get(eventThreadId) === eventTurnId) activeTurnsByThread.current.delete(eventThreadId);
      pendingTurns.current.delete(eventThreadId);
      if (pendingTurn.current?.threadId === eventThreadId) pendingTurn.current = null;
      clearThreadRunning(eventThreadId);
      if (visibleThreadId === eventThreadId) setBusy(false);
    }
    if (event.method === "thread/compacted") {
      const params = (event.params ?? {}) as Record<string, unknown>;
      const turnId = String(params.turnId ?? "");
      const threadId = String(params.threadId ?? activeTurn.current?.threadId ?? pendingTurn.current?.threadId ?? "");
      ensureCompactionMarker(threadId, turnId || undefined);
      retryPendingAfterCompaction(threadId, turnId);
    }
    if (event.method === "turn/completed") {
      window.dispatchEvent(new Event("devil-codex:provider-usage-refresh"));
      const params = (event.params ?? {}) as Record<string, unknown>;
      const turnId = String(params.turnId ?? (params.turn as { id?: unknown } | undefined)?.id ?? "");
      const turnStatus = String((params.turn as { status?: unknown } | undefined)?.status ?? "completed");
      const threadId = String(params.threadId ?? activeTurn.current?.threadId ?? pendingTurn.current?.threadId ?? "");
      const waitingForCompactionRetry = threadId ? compactionRetries.current.get(threadId) : undefined;
      if (waitingForCompactionRetry && !waitingForCompactionRetry.pending.retriedAfterCompaction) {
        ensureCompactionMarker(threadId, turnId || undefined);
        if (activeTurn.current?.turnId === turnId) activeTurn.current = null;
        if (threadId && activeTurnsByThread.current.get(threadId) === turnId) activeTurnsByThread.current.delete(threadId);
        retryPendingAfterCompaction(threadId);
        return;
      }
      if (waitingForCompactionRetry?.retrying && waitingForCompactionRetry.retryTurnId !== turnId) {
        if (activeTurn.current?.turnId === turnId) activeTurn.current = null;
        if (threadId && activeTurnsByThread.current.get(threadId) === turnId) activeTurnsByThread.current.delete(threadId);
        return;
      }
      if (compactedTurns.current.delete(turnId)) {
        if (activeTurn.current?.turnId === turnId) activeTurn.current = null;
        if (threadId && activeTurnsByThread.current.get(threadId) === turnId) activeTurnsByThread.current.delete(threadId);
        return;
      }
      const steeringInterrupted = turnId ? steeringInterruptedTurns.current.delete(turnId) : false;
      const completedPending = pendingForThread(threadId);
      const activeTurnIdForThread = threadId ? activeTurnsByThread.current.get(threadId) : undefined;
      const finishingActiveTurn = !turnId || !activeTurnIdForThread || activeTurnIdForThread === turnId;
      if (activeTurn.current?.turnId === turnId) activeTurn.current = null;
      if (finishingActiveTurn && threadId) activeTurnsByThread.current.delete(threadId);
      if (finishingActiveTurn && threadId) pendingTurns.current.delete(threadId);
      if (finishingActiveTurn && pendingTurn.current?.threadId === threadId) pendingTurn.current = null;
      if (threadId) compactionRetries.current.delete(threadId);
      if (finishingActiveTurn) {
        clearThreadRunning(threadId);
        if (visibleThreadId === threadId) setBusy(false);
      }
      const hasQueuedFollowUp = Boolean(threadId && (queuedTurns.current.get(threadId)?.length ?? 0) > 0);
      if (!hasQueuedFollowUp) {
        const failed = turnStatus === "failed";
        notifyInBackground("notifyOnTurnComplete", failed ? "AI 작업 실패" : "AI 작업 완료", failed ? "작업이 실패했습니다. Devil Codex에서 진단을 확인하세요." : "요청한 작업이 끝났습니다.", failed ? "critical" : "normal", true);
      }
      if (steeringInterrupted && threadId && turnId) {
        const cached = threadHistoryCache.current.get(threadId);
        if (cached) threadHistoryCache.current.set(threadId, removeInterruptedTurnItems(cached, turnId));
        if (threadRef.current?.id === threadId) {
          setItems((current) => {
            const next = removeInterruptedTurnItems(current, turnId);
            itemsRef.current = next;
            threadHistoryCache.current.set(threadId, next);
            return next;
          });
        }
      }
      if (threadId) startQueuedTurn(threadId);
      if (steeringInterrupted) {
        void Promise.all([refreshThreads(), refreshChanges()]);
        return;
      }
      if (threadId) window.setTimeout(() => {
        void (async () => {
          const localHistory = threadHistoryCache.current.get(threadId) ?? visibleItemsForThread(threadId) ?? [];
          const cachedAccountId = threadRef.current?.id === threadId ? threadRef.current.accountId : undefined;
          const cachedRuntime = threadRef.current?.id === threadId ? threadRef.current.runtime ?? agentRuntime : pendingForThread(threadId)?.runtime ?? agentRuntime;
          if (cachedRuntime !== "claude-code") {
            await window.devilCodex.cacheThreadHistory({ id: threadId, items: localHistory, runtime: cachedRuntime, accountId: cachedAccountId });
          }
          const history = await window.devilCodex.syncThreadHistory({ id: threadId, runtime: cachedRuntime, accountId: cachedAccountId });
          let recoveredHistory = annotateAgentMessages(mergeTimelineItems(localHistory, history), turnId, completedPending ?? undefined);
          recoveredHistory = removeMissingFinalNoticeForTurn(recoveredHistory, turnId);
          if (turnStatus === "completed" && turnId && !hasAgentMessageForTurn(recoveredHistory, turnId)) {
            const alreadyWarned = recoveredHistory.some((item) => item.id === `missing-final-${turnId}`);
            if (!alreadyWarned) {
              const runtimeLabel = runtimeAgentLabel(cachedRuntime, completedPending?.provider, providers.settings?.providers ?? []);
              recoveredHistory = [...recoveredHistory, finalAnswerMissingNotice(turnId, runtimeLabel)];
            }
          }
          threadHistoryCache.current.set(threadId, recoveredHistory);
          if (threadRef.current?.id === threadId && recoveredHistory !== localHistory) {
            setItems(recoveredHistory);
            itemsRef.current = recoveredHistory;
            itemsOwnerRef.current = threadId;
          }
        })().catch(() => undefined);
      }, 120);
      void Promise.all([refreshThreads(), refreshChanges()]);
    }
  }

  async function respondToApproval(decision: ApprovalDecision): Promise<void> {
    const prompt = approvalQueue[0];
    if (!prompt || approvalResponding) return;
    setApprovalResponding(true);
    try {
      await window.devilCodex.respondApproval({ requestId: prompt.requestId, decision, threadId: prompt.threadId });
      setApprovalQueue((current) => current.filter((item) => item.requestId !== prompt.requestId));
    } catch (error) {
      setExternalError(`승인 응답 실패: ${String(error)}`);
    } finally {
      setApprovalResponding(false);
    }
  }

  function stopTurn(): void {
    const threadId = thread?.id ?? activeTurn.current?.threadId;
    const history = threadId && threadRef.current?.id === threadId ? itemsRef.current : threadId ? threadHistoryCache.current.get(threadId) ?? [] : [];
    const turnId = threadId ? activeTurnsByThread.current.get(threadId) ?? activeTurn.current?.turnId ?? latestInterruptibleTurnId(history) : activeTurn.current?.turnId;
    if (!threadId) return;
    clearQueuedTurns(threadId);
    compactionRetries.current.delete(threadId);
    void window.devilCodex.interruptTurn({ threadId, runtime: thread?.runtime ?? pendingForThread(threadId)?.runtime ?? agentRuntime, turnId }).catch((error) => {
      const message = String(error);
      if (/no active turn to interrupt/i.test(message)) {
        activeTurnsByThread.current.delete(threadId);
        if (activeTurn.current?.threadId === threadId) activeTurn.current = null;
        pendingTurns.current.delete(threadId);
        if (pendingTurn.current?.threadId === threadId) pendingTurn.current = null;
        clearThreadRunning(threadId);
        setBusy(false);
        return;
      }
      setExternalError(`작업 중지 실패: ${String(error)}`);
    });
  }

  async function connect(): Promise<void> {
    setRuntime((current) => ({ ...current, state: "connecting", detail: "Codex app-server 시작 중" }));
    try {
      const status = await window.devilCodex.connect();
      setRuntime(status);
      const cwd = status.state === "connected" ? await generalChatCwd(status.cwd) : status.cwd;
      setWorkspace(cwd);
      setProjectDraft(false);
      setThread(null);
      setItems([]);
      itemsRef.current = [];
      itemsOwnerRef.current = null;
      if (status.state === "connected") await Promise.all([refreshThreads(cwd), refreshChanges(cwd), refreshProjects()]);
    } catch (error) {
      setRuntime((current) => ({ ...current, state: "error", detail: `Codex app-server 연결 실패: ${String(error)}` }));
    }
  }

  async function generalChatCwd(fallback = workspace): Promise<string> {
    return window.devilCodex.newChatCwd().catch(() => fallback);
  }

  function navigationSnapshot(): NavigationEntry {
    saveCurrentThreadScrollPosition();
    const currentThread = threadRef.current ?? thread;
    const snapshotItems = currentThread?.id
      ? (itemsOwnerRef.current === currentThread.id ? itemsRef.current : threadHistoryCache.current.get(currentThread.id) ?? [])
      : itemsRef.current;
    if (currentThread?.id && itemsOwnerRef.current === currentThread.id) threadHistoryCache.current.set(currentThread.id, snapshotItems);
    const runtimeForEntry = currentThread?.runtime ?? agentRuntime;
    return { view, runtime: runtimeForEntry, thread: currentThread, workspace, items: snapshotItems, projectDraft, environmentOpen, settingsSection, search };
  }

  function restoreNavigation(entry: NavigationEntry): void {
    activeResume.current = entry.thread?.id ?? null;
    if (entry.thread?.id) setInitializingThreadId(entry.thread.id);
    const entryRuntime = entry.thread?.runtime ?? entry.runtime;
    if (entryRuntime !== agentRuntime) {
      runtimeSnapshots.current[agentRuntime] = runtimeSnapshotFor(agentRuntime);
      const currentPanelKey = threadStateKey(thread?.runtime ?? agentRuntime, thread?.id, emptyThreadStateId(workspace, projectDraft));
      panelByThread.current[currentPanelKey] = { tabs: utilityTabs, active: utilityActive, open: utilityPanelOpen, expanded: utilityPanelExpanded };
      bottomByThread.current[currentPanelKey] = { tabs: bottomTabs, active: bottomActive, open: terminalOpen, height: terminalHeight };
      keepThreadOnRuntimeSwitch.current = true;
      setAgentRuntimeState(entryRuntime);
      localStorage.setItem(AGENT_RUNTIME_KEY, entryRuntime);
    }
    threadRef.current = entry.thread;
    const restoredItems = entry.thread?.id ? threadHistoryCache.current.get(entry.thread.id) ?? entry.items : entry.items;
    setView(entry.view);
    setThread(entry.thread);
    setWorkspace(entry.workspace);
    setItems(restoredItems);
    itemsRef.current = restoredItems;
    itemsOwnerRef.current = entry.thread?.id ?? null;
    setProjectDraft(entry.projectDraft);
    setEnvironmentOpen(entry.environmentOpen);
    setSettingsSection(entry.settingsSection);
    setSearch(entry.search);
    setThreadFindOpen(false);
    setThreadFindQuery("");
    // Restore per-thread right-panel tabs only in app views. Settings is a
    // full-window route, so it must not resurrect the current thread's panel.
    if (entry.view === "settings") {
      setUtilityTabs([]);
      setUtilityActive(null);
      setUtilityPanelOpen(false);
      setUtilityPanelExpanded(false);
    } else {
      const panelKey = threadStateKey(entryRuntime, entry.thread?.id, emptyThreadStateId(entry.workspace, entry.projectDraft));
      const panel = panelByThread.current[panelKey] ?? { tabs: [], active: null, open: false, expanded: false };
      setUtilityTabs(panel.tabs);
      setUtilityActive(panel.active);
      setUtilityPanelOpen(panel.open && panel.tabs.length > 0);
      setUtilityPanelExpanded(panel.open && panel.expanded);
      const bottom = bottomByThread.current[panelKey] ?? { tabs: ["terminal:default"], active: "terminal:default", open: false, height: terminalHeight };
      setBottomTabs(bottom.tabs);
      setBottomActive(bottom.active);
      setTerminalOpen(bottom.open && bottom.tabs.length > 0);
      setTerminalHeight(bottom.height);
    }
    if (entry.workspace) void refreshChanges(entry.workspace);
  }

  function syncNavigationState(): void {
    setNavigationState({
      canGoBack: navigationBack.current.length > 0,
      canGoForward: navigationForward.current.length > 0,
    });
  }

  function navigate(next: Partial<NavigationEntry>): void {
    const current = navigationSnapshot();
    navigationBack.current.push(current);
    navigationForward.current = [];
    restoreNavigation({ ...current, ...next });
    syncNavigationState();
  }

  function goBack(): void {
    const previous = navigationBack.current.pop();
    if (!previous) return;
    navigationForward.current.push(navigationSnapshot());
    restoreNavigation(previous);
    syncNavigationState();
  }

  function goForward(): void {
    const next = navigationForward.current.pop();
    if (!next) return;
    navigationBack.current.push(navigationSnapshot());
    restoreNavigation(next);
    syncNavigationState();
  }

  function newThread(scopedToProject = false): void {
    if (bridgeChatLocked) {
      setExternalError("순정 Codex Bridge 사용 중에는 새 Devil Codex 채팅을 시작할 수 없습니다. Bridge를 끄면 즉시 사용할 수 있습니다.");
      return;
    }
    closePopovers();
    if (scopedToProject) { navigate({ view: "thread", thread: null, items: [], projectDraft: true, environmentOpen: false }); return; }
    // Top-level new chat is a standalone (general) chat, not a project thread.
    void (async () => {
      const cwd = await generalChatCwd();
      navigate({ view: "thread", workspace: cwd, thread: null, items: [], projectDraft: false, environmentOpen: false });
    })();
  }

  async function newThreadInProject(cwd: string): Promise<void> {
    if (bridgeChatLocked) {
      setExternalError("순정 Codex Bridge 사용 중에는 새 Devil Codex 채팅을 시작할 수 없습니다. Bridge를 끄면 즉시 사용할 수 있습니다.");
      return;
    }
    navigate({ view: "thread", workspace: cwd, thread: null, items: [], projectDraft: true, environmentOpen: false });
    setProjectAlias("");
    if (agentRuntime === "claude-code" || runtime.state === "connected") await Promise.all([refreshThreads(cwd), refreshChanges(cwd)]);
  }

  async function chooseWorkspace(): Promise<void> {
    const next = await window.devilCodex.chooseWorkspace();
    if (!next) return;
    navigate({ view: "thread", workspace: next, thread: null, items: [], projectDraft: true, environmentOpen: false });
    setProjectAlias("");
    if (agentRuntime === "claude-code" || runtime.state === "connected") await Promise.all([refreshThreads(next), refreshChanges(next)]);
  }

  async function refreshThreads(cwd = workspace, options?: { quiet?: boolean; showLoading?: boolean }): Promise<void> {
    if (!cwd) return;
    const showLoading = options?.showLoading ?? !options?.quiet;
    if (showLoading) {
      threadsLoadingCount.current += 1;
      setThreadsLoading(true);
    }
    try {
      const loaded = await window.devilCodex.listThreads({ cwd, runtime: agentRuntime });
      for (const summary of loaded) pendingThreads.current.delete(summary.id);
      const currentCwdKey = cwdKey(cwd);
      const pending = [...pendingThreads.current.values()].filter((summary) => cwdKey(summary.cwd) === currentCwdKey && !loaded.some((item) => item.id === summary.id));
      const nextThreads = [...pending, ...loaded].sort((a, b) => Number(pinnedThreads.includes(b.id)) - Number(pinnedThreads.includes(a.id)) || b.updatedAt - a.updatedAt);
      setThreads((current) => sameThreadSummaryList(current, nextThreads) ? current : nextThreads);
      const prefetchTargets = loaded.slice(0, 2).filter((summary) => !threadHistoryCache.current.has(summary.id) && !prefetchingThreadHistory.current.has(summary.id));
      if (prefetchTargets.length) {
        runWhenIdle(() => {
          for (const summary of prefetchTargets) void prefetchThreadHistory(summary.id, summary.accountId);
        });
      }
    } catch (error) {
      if (options?.quiet) return;
      setItems((current) => [...current, { id: crypto.randomUUID(), kind: "system", title: "스레드 목록 오류", text: String(error) }]);
    } finally {
      if (showLoading) {
        threadsLoadingCount.current = Math.max(0, threadsLoadingCount.current - 1);
        if (threadsLoadingCount.current === 0) setThreadsLoading(false);
      }
    }
  }

  async function prefetchThreadHistory(threadId: string, accountId?: string): Promise<void> {
    if (threadHistoryCache.current.has(threadId) || prefetchingThreadHistory.current.has(threadId)) return;
    prefetchingThreadHistory.current.add(threadId);
    try { threadHistoryCache.current.set(threadId, await window.devilCodex.readThread({ id: threadId, runtime: agentRuntime, accountId })); }
    catch { /* prefetch is opportunistic; opening the thread still reports real errors. */ }
    finally { prefetchingThreadHistory.current.delete(threadId); }
  }

  async function refreshProjects(options?: { quiet?: boolean; showLoading?: boolean }): Promise<void> {
    const showLoading = options?.showLoading ?? !options?.quiet;
    if (showLoading) {
      projectsLoadingCount.current += 1;
      setProjectsLoading(true);
    }
    try {
      const all = await window.devilCodex.listProjects({ runtime: agentRuntime });
      const map = new Map<string, { cwd: string; threads: ThreadSummary[] }>();
      for (const summary of all) {
        if (!summary.cwd) continue;
        const key = cwdKey(summary.cwd);
        const group = map.get(key) ?? { cwd: summary.cwd, threads: [] };
        group.threads.push(summary);
        map.set(key, group);
      }
      const groups = [...map.values()]
        .map(({ cwd, threads }) => ({ cwd, name: basenamePath(cwd), threads: [...new Map(threads.map((thread) => [thread.id, thread])).values()] }))
        .sort((a, b) => Math.max(...b.threads.map((t) => t.updatedAt)) - Math.max(...a.threads.map((t) => t.updatedAt)));
      setProjects((current) => sameProjectThreadGroups(current, groups) ? current : groups);
    } catch {
      // listing all projects is best-effort; ignore failures
    } finally {
      if (showLoading) {
        projectsLoadingCount.current = Math.max(0, projectsLoadingCount.current - 1);
        if (projectsLoadingCount.current === 0) setProjectsLoading(false);
      }
    }
  }

  async function showArchivedThreads(): Promise<void> {
    setProjectMenuOpen(false);
    navigate({ view: "archive" });
    setArchivedBusy(true);
    try { setArchivedThreads(await window.devilCodex.listThreads({ cwd: workspace, archived: true, runtime: agentRuntime })); }
    catch (error) { setItems((current) => [...current, { id: crypto.randomUUID(), kind: "system", title: "보관함 오류", text: String(error) }]); }
    finally { setArchivedBusy(false); }
  }

  async function showAllArchivedThreads(): Promise<void> {
    navigate({ view: "archive" });
    setArchivedBusy(true);
    try { setArchivedThreads(await window.devilCodex.listProjects({ archived: true, runtime: agentRuntime })); }
    catch (error) { setExternalError(`보관함 오류: ${String(error)}`); }
    finally { setArchivedBusy(false); }
  }

  function openTextPrompt(input: Omit<TextPromptState, "resolve">): Promise<string | null> {
    return new Promise((resolve) => setTextPrompt({ ...input, resolve }));
  }

  async function sendFeedback(): Promise<void> {
    const reason = (await openTextPrompt({
      title: "피드백 보내기",
      label: "Codex에 보낼 피드백",
      initialValue: "",
      placeholder: "피드백 내용을 입력하세요",
      confirmLabel: "보내기",
    }))?.trim();
    if (!reason) return;
    try {
      await window.devilCodex.uploadFeedback({ reason, ...(thread?.id ? { threadId: thread.id } : {}) });
      setItems((current) => [...current, { id: crypto.randomUUID(), kind: "system", title: "피드백 전송 완료", text: "로그를 포함하지 않고 피드백을 전송했습니다." }]);
    } catch (error) { setExternalError(`피드백 전송 실패: ${String(error)}`); }
  }

  async function refreshChanges(cwd = workspace): Promise<WorkspaceChanges> {
    if (!cwd) return defaultChanges;
    try {
      const next = await window.devilCodex.getWorkspaceChanges({ cwd });
      setChanges(next);
      return next;
    } catch (error) {
      const unavailable = { ...defaultChanges, available: false, detail: String(error) };
      setChanges(unavailable);
      return unavailable;
    }
  }

  async function selectDiff(file: WorkspaceChange, options: { quiet?: boolean } = {}): Promise<void> {
    if (!options.quiet) setDiffBusy(true);
    try {
      setSelectedDiff(await window.devilCodex.getWorkspaceDiff({ cwd: workspace, path: file.path }));
    } catch (error) {
      setSelectedDiff({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions, text: String(error), binary: false });
    } finally {
      if (!options.quiet) setDiffBusy(false);
    }
  }

  async function prepareReview(): Promise<void> {
    const next = await refreshChanges();
    if (next?.files[0]) await selectDiff(next.files[0]);
    else setSelectedDiff(null);
  }

  const reviewPanelVisible = view === "thread" && Boolean(workspace)
    && ((utilityPanelOpen && utilityActive === "review") || (terminalOpen && bottomActive === "review"));
  useEffect(() => {
    if (!reviewPanelVisible) return undefined;
    let live = true;
    let timer: number | null = null;
    let running = false;
    const schedule = (delay: number): void => {
      if (!live) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(tick, delay);
    };
    const tick = async (): Promise<void> => {
      if (running || !workspace) return;
      running = true;
      try {
        const next = await refreshChanges(workspace);
        const selected = selectedDiffRef.current;
        const file = selected ? next.files.find((item) => item.path === selected.path) : next.files[0];
        if (file) await selectDiff(file, { quiet: true });
        else setSelectedDiff(null);
      } finally {
        running = false;
        schedule(activeThreadBusy ? 900 : 1800);
      }
    };
    schedule(200);
    return () => {
      live = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [activeThreadBusy, reviewPanelVisible, workspace]);

  function sendInlineReviewComment(input: { path: string; line: number; side: "old" | "new"; text: string }): void {
    if (activeThreadBusy) {
      setExternalError("현재 turn이 끝난 뒤 인라인 의견을 보내세요.");
      return;
    }
    const side = input.side === "new" ? "변경 후" : "변경 전";
    void submit({ prompt: `인라인 리뷰 의견을 반영해줘.\n\n파일: ${input.path}\n줄: ${input.line} (${side})\n의견: ${input.text}`, approvalMode: "agent", goalMode: false, planMode: false, acceptEdits: false, attachments: [], skills: [], reasoningEffort, responseSpeed });
  }

  async function applyReviewHunk(input: { path: string; hunk: string; action: "stage" | "revert" }): Promise<void> {
    try {
      await window.devilCodex.applyWorkspaceHunk({ cwd: workspace, ...input });
      const next = await refreshChanges();
      const file = next.files.find((item) => item.path === input.path);
      if (file) await selectDiff(file); else setSelectedDiff(null);
    } catch (error) {
      setExternalError(`${input.action === "stage" ? "hunk 스테이징" : "hunk 되돌리기"} 실패: ${String(error)}`);
    }
  }

  async function rollbackTurn(turnId: string): Promise<void> {
    if (!workspace || rollbackBusy) return;
    const changesForTurn = items
      .filter((item) => item.kind === "activity" && item.turnId === turnId)
      .flatMap((item) => item.activities ?? [])
      .filter((entry) => entry.kind === "fileChange")
      .flatMap((entry) => entry.files ?? [])
      .map((file) => ({ path: file.path, diff: file.diff ?? "", additions: file.additions, deletions: file.deletions }));
    if (!changesForTurn.length) {
      setExternalError("실행 취소할 AI 파일 변경을 찾을 수 없습니다.");
      return;
    }
    setRollbackBusy(true);
    try {
      await window.devilCodex.undoFileChanges({ cwd: workspace, changes: changesForTurn });
      setSelectedDiff(null);
      setExternalError("");
      await refreshChanges();
    } catch (error) {
      setExternalError(`실행 취소 실패: 파일이 이후 변경됐거나 원본 패치를 적용할 수 없습니다. ${String(error)}`);
    } finally {
      setRollbackBusy(false);
    }
  }

  async function resumeThread(summary: ThreadSummary): Promise<void> {
    activeResume.current = summary.id;
    const projectless = isProjectlessThread(summary);
    const chatWorkspace = projectless ? await generalChatCwd() : summary.cwd || workspace;
    const cachedHistory = threadHistoryCache.current.get(summary.id);
    const needsHistoryLoad = !cachedHistory;
    setLoadingThreadId(needsHistoryLoad ? summary.id : null);
    navigate({ view: "thread", thread: { id: summary.id, cwd: chatWorkspace, model: summary.model || composerModel, runtime: summary.runtime ?? agentRuntime, provider: summary.provider, accountId: summary.accountId }, workspace: chatWorkspace, projectDraft: false, items: cachedHistory ?? [], environmentOpen: false });
    setInitializingThreadId(needsHistoryLoad ? null : summary.id);
    const running = Boolean(runningTurnsRef.current[summary.id]);
    const historyPromise = running && hasConversationItems(cachedHistory)
      ? Promise.resolve(cachedHistory ?? [])
      : window.devilCodex.readThread({ id: summary.id, runtime: summary.runtime ?? agentRuntime, accountId: summary.accountId });
    void historyPromise.catch(() => undefined);
    try {
      const next = await window.devilCodex.resumeThread({ id: summary.id, model: summary.model || composerModel, runtime: summary.runtime ?? agentRuntime, accountId: summary.accountId });
      if (activeResume.current !== summary.id) return;
      const nextWorkspace = projectless ? chatWorkspace : next.cwd;
      setThread(projectless ? { ...next, cwd: nextWorkspace } : next);
      setWorkspace(nextWorkspace);
      setProjectDraft(false);
      void historyPromise.then((history) => {
        const liveHistory = threadHistoryCache.current.get(summary.id) ?? [];
        const merged = running ? mergeTimelineItems(history, liveHistory) : history;
        threadHistoryCache.current.set(summary.id, merged);
        if (activeResume.current === summary.id) {
          setInitializingThreadId(summary.id);
          setItems((current) => {
            const nextItems = running ? mergeTimelineItems(merged, current) : merged;
            itemsRef.current = nextItems;
            itemsOwnerRef.current = summary.id;
            threadHistoryCache.current.set(summary.id, nextItems);
            return nextItems;
          });
        }
        if (activeResume.current === summary.id) setLoadingThreadId(null);
      }).catch((error) => {
        if (activeResume.current === summary.id) {
          setLoadingThreadId(null);
          setItems((current) => [...current, { id: crypto.randomUUID(), kind: "system", title: "대화 불러오기 실패", text: String(error) }]);
        }
      });
      if (!projectless && next.cwd && next.cwd !== workspace) void Promise.all([refreshThreads(next.cwd), refreshChanges(next.cwd)]);
    } catch (error) {
      if (activeResume.current === summary.id) {
        setLoadingThreadId(null);
        setItems((current) => [...current, { id: crypto.randomUUID(), kind: "system", title: "스레드 열기 실패", text: String(error) }]);
      }
    }
  }

  function openRenameThreadDialog(summary: ThreadSummary): void {
    setThreadMenuOpen(false);
    setThreadContextMenu(null);
    setRenameThreadTarget(summary);
    setRenameThreadDraft(summary.title);
  }

  async function submitRenameThread(): Promise<void> {
    if (!renameThreadTarget || renameThreadBusy) return;
    const summary = renameThreadTarget;
    const name = renameThreadDraft.trim();
    if (!name) return;
    setRenameThreadBusy(true);
    try {
      await window.devilCodex.renameThread({ id: summary.id, name, cwd: summary.cwd, model: summary.model, preview: summary.preview });
      setThreads((current) => current.map((item) => item.id === summary.id ? { ...item, title: name } : item));
      setProjects((current) => current.map((group) => ({ ...group, threads: group.threads.map((item) => item.id === summary.id ? { ...item, title: name } : item) })));
      setRenameThreadTarget(null);
      setRenameThreadDraft("");
      await refreshProjects();
    } catch (error) { setExternalError(`채팅 이름 변경 실패: ${String(error)}`); }
    finally { setRenameThreadBusy(false); }
  }

  async function copyThreadInfo(summary: ThreadSummary, kind: "cwd" | "id" | "markdown"): Promise<void> {
    setThreadMenuOpen(false);
    try {
      if (kind === "cwd") {
        await navigator.clipboard?.writeText(summary.cwd);
        return;
      }
      if (kind === "id") {
        await navigator.clipboard?.writeText(summary.id);
        return;
      }
      const history = threadHistoryCache.current.get(summary.id) ?? await window.devilCodex.readThread({ id: summary.id, runtime: summary.runtime ?? agentRuntime, accountId: summary.accountId });
      threadHistoryCache.current.set(summary.id, history);
      const markdown = [`# ${summary.title}`, "", `- Session ID: ${summary.id}`, `- Directory: ${summary.cwd}`, "", ...history.map((item) => `## ${item.kind}${item.title ? `: ${item.title}` : ""}\n\n${item.text || ""}`)].join("\n");
      await navigator.clipboard?.writeText(markdown);
    } catch (error) {
      setExternalError(`채팅 복사 실패: ${String(error)}`);
    }
  }

  async function renameActiveThread(): Promise<void> {
    if (!activeSummary) return;
    openRenameThreadDialog(activeSummary);
  }

  function toggleActiveThreadPin(): void {
    if (!activeSummary) return;
    setThreadMenuOpen(false);
    setPinnedThreads((current) => {
      const next = current.includes(activeSummary.id) ? current.filter((id) => id !== activeSummary.id) : [...current, activeSummary.id];
      localStorage.setItem("devil-codex:pinned-threads", JSON.stringify(next));
      setThreads((list) => [...list].sort((a, b) => Number(next.includes(b.id)) - Number(next.includes(a.id)) || b.updatedAt - a.updatedAt));
      return next;
    });
  }

  async function shareActiveThreadToOtherRuntime(): Promise<void> {
    if (!activeSummary || !workspace) return;
    setThreadMenuOpen(false);
    const sourceRuntime = activeSummary.runtime ?? agentRuntime;
    const targetRuntime: AgentRuntimeId = sourceRuntime === "claude-code" ? "codex" : "claude-code";
    const targetLabel = targetRuntime === "claude-code" ? "Devil Claude Code" : "Devil Codex";
    const sourceLabel = sourceRuntime === "claude-code" ? "Devil Claude Code" : "Devil Codex";
    const targetProvider: ProviderId = targetRuntime === "claude-code" ? "claude-code" : "codex";
    const targetModel = targetRuntime === "claude-code"
      ? claudeModel
      : providers.settings?.provider === "codex" ? model : "gpt-5.5";
    const now = Math.floor(Date.now() / 1000);
    const sharedTitle = `공유: ${activeSummary.title || "새 채팅"}`;
    const marker: ThreadHistoryItem = {
      id: crypto.randomUUID(),
      kind: "system",
      title: "런타임 공유",
      text: `${sourceLabel} thread에서 ${targetLabel} thread를 새로 열고 대화 컨텍스트를 첨부했습니다.\n공유 버튼 자체는 모델을 호출하지 않았습니다.\n추가 토큰은 이 새 thread에서 첫 메시지를 보낼 때만 사용됩니다.`,
    };
    const contextText = transferContextFromHistory(threadHistoryCache.current.get(activeSummary.id) ?? itemsRef.current);
    const contextItem: ThreadHistoryItem | null = contextText ? {
      id: crypto.randomUUID(),
      kind: "system",
      title: "런타임 공유 컨텍스트",
      text: contextText,
    } : null;
    const initialItems = contextItem ? [marker, contextItem] : [marker];

    try {
      setRuntimeShareBusy(`${targetLabel}로 대화 넘기는 중...`);
      const created = await window.devilCodex.createThread({
        cwd: workspace,
        model: targetModel,
        runtime: targetRuntime,
        provider: targetProvider,
      });
      const nextThread: ThreadRef = {
        ...created,
        runtime: targetRuntime,
        provider: targetProvider,
        model: targetModel,
      };
      const summary: ThreadSummary = {
        id: created.id,
        cwd: workspace,
        model: targetModel,
        runtime: targetRuntime,
        provider: targetProvider,
        title: sharedTitle,
        preview: marker.text,
        updatedAt: now,
        archived: false,
      };
      threadHistoryCache.current.set(created.id, initialItems);
      pendingThreads.current.set(created.id, summary);
      await window.devilCodex.cacheThreadHistory({ id: created.id, runtime: targetRuntime, items: initialItems }).catch(() => undefined);
      await window.devilCodex.renameThread({ id: created.id, name: sharedTitle, cwd: workspace, model: targetModel, preview: marker.text }).catch(() => undefined);
      keepThreadOnRuntimeSwitch.current = true;
      setAgentRuntime(targetRuntime);
      threadRef.current = nextThread;
      setThread(nextThread);
      setItems(initialItems);
      itemsRef.current = initialItems;
      itemsOwnerRef.current = created.id;
      setThreads([summary]);
      navigate({ view: "thread", thread: nextThread, workspace, projectDraft: false, items: initialItems, environmentOpen: false });
    } catch (error) {
      setExternalError(`런타임 공유 실패: ${String(error)}`);
    } finally {
      setRuntimeShareBusy(null);
    }
  }

  async function unarchiveThread(summary: ThreadSummary): Promise<void> {
    try {
      await window.devilCodex.unarchiveThread({ id: summary.id, accountId: summary.accountId });
      setArchivedThreads((current) => current.filter((item) => item.id !== summary.id));
      await Promise.all([refreshThreads(summary.cwd || workspace), refreshProjects()]);
    } catch (error) { setExternalError(`채팅 복원 실패: ${String(error)}`); }
  }

  async function openWorkspace(target: ExternalTarget): Promise<void> {
    setOpenMenuOpen(false);
    if (!canOpenWorkspace) return;
    const result = await window.devilCodex.openWorkspace({ cwd: workspace, target });
    setExternalError(result.ok ? "" : result.detail ?? "앱을 열 수 없습니다.");
  }

  async function toggleOpenWithMenu(): Promise<void> {
    if (!canOpenWorkspace) return;
    const next = !openMenuOpen;
    closePopovers();
    setOpenMenuOpen(next);
    if (next) {
      try { setOpenTargets(await window.devilCodex.listOpenWorkspaceTargets()); }
      catch { /* keep the last known list */ }
    }
  }

  function editedContinuationContext(history: ThreadHistoryItem[]): string {
    const lines = history.flatMap((item) => {
      if (item.kind === "user") return [`사용자: ${item.text.trim()}`];
      if (item.kind === "agent") return [`Codex: ${item.text.trim()}`];
      return [];
    }).filter(Boolean);
    return lines.length ? `아래는 편집 지점 이전 대화입니다. 이 맥락만 유지하고, 이어지는 사용자 메시지부터 새로 계속하세요.\n\n${lines.join("\n\n")}` : "";
  }

  function threadTitleFromPrompt(text: string): string {
    const title = text.replace(/\s+/g, " ").trim() || "새 채팅";
    return title.length > 64 ? `${title.slice(0, 61).trimEnd()}...` : title;
  }

  function updateThreadTitle(threadId: string, title: string): void {
    pendingThreads.current.set(threadId, { ...(pendingThreads.current.get(threadId) ?? { id: threadId, cwd: workspace, model, preview: "", updatedAt: Math.floor(Date.now() / 1000), archived: false }), title });
    setThreads((current) => current.map((summary) => summary.id === threadId ? { ...summary, title } : summary));
    setProjects((current) => current.map((group) => ({ ...group, threads: group.threads.map((summary) => summary.id === threadId ? { ...summary, title } : summary) })));
  }

  async function submit(input: ComposerInput, options: { forceNewThread?: boolean; provider?: ProviderId; accountId?: string; model?: string; replaceFromItemId?: string; contextPrefix?: string } = {}): Promise<void> {
    const attachmentContext = attachmentContextForModel(input.attachments);
    const imageAttachments = input.attachments.flatMap((item) => {
      if (item.kind !== "image") return [];
      const target = item.url ?? item.path;
      return target ? [target] : [];
    });
    const attachmentDetails = displayAttachments(input.attachments);
    const selectedSkillNames = [...new Set(input.skills.flatMap((name) => {
      if (!name.startsWith("plugin:")) return [name];
      const plugin = name.slice("plugin:".length);
      return composerSkillOptions.filter((skill) => pluginNameForSkill(skill) === plugin).map((skill) => skill.name);
    }))];
    const selectedMcpServers = selectedSkillNames
      .filter((name) => name.startsWith("mcp:"))
      .map((name) => name.slice("mcp:".length))
      .filter(Boolean);
    const devilBrowserRequested = composerRuntime === "codex" && devilBrowserOwnsRouting && requestsDevilEmbeddedBrowser(input.prompt);
    if (devilBrowserRequested && availableMcpServers.some((server) => server.name === "devil_browser") && !selectedMcpServers.includes("devil_browser")) selectedMcpServers.push("devil_browser");
    // Plugin-cache skills are unknown to the app-server registry, so send them
    // as prompt instructions instead of native skill input items.
    const codexPluginSkills = composerRuntime === "codex"
      ? selectedSkillNames.flatMap((name) => {
        const skill = composerSkillOptions.find((item) => item.name === name);
        return skill?.scope === "plugin" && skill.path ? [skill] : [];
      })
      : [];
    const selectedSkills = selectedSkillNames.flatMap((name) => {
      if (name.startsWith("mcp:")) return [];
      const skill = composerSkillOptions.find((item) => item.name === name);
      if (skill?.scope === "plugin" && composerRuntime === "codex") return [];
      return skill?.path ? [{ name: skill.name, path: skill.path }] : [];
    });
    const codexPluginSkillPrefix = codexPluginSkills.length
      ? `[플러그인 스킬]\n${codexPluginSkills.map((skill) => `사용자가 $${skill.name} 스킬을 선택했습니다. 이 스킬 지침 파일을 먼저 읽고 따르세요: ${skill.path}`).join("\n")}\n\n`
      : "";
    const mcpPrefix = selectedMcpServers.length
      ? `[연결된 플러그인/MCP 언급]\n이번 요청에서는 사용자가 ${selectedMcpServers.map((name) => `/${name}`).join(", ")} 플러그인을 명시했습니다. 관련 정보 조회나 작업이 필요하면 해당 MCP 서버의 사용 가능한 도구를 우선 사용하세요.\n\n`
      : "";
    const devilBrowserPrefix = devilBrowserRequested
      ? "[Devil 내장 브라우저 라우팅]\n사용자는 Devil Codex의 내장/우측 브라우저를 명시했습니다. 순정 `browser:control-in-app-browser`, `iab`, 별도 Chrome을 사용하지 말고 반드시 `devil_browser` MCP의 browser_navigate/browser_read 등 도구로 작업하세요.\n\n"
      : "";
    const promptText = input.prompt.trim() || (imageAttachments.length ? "첨부 이미지를 확인해줘." : "");
    const modePrefix = `${input.planMode ? "[플랜 모드]\n" : ""}${input.acceptEdits ? "[편집 자동승인 모드]\n" : ""}${input.goalMode ? "[목표 모드]\n" : ""}`;
    const visiblePrompt = `${modePrefix}${promptText}`;
    const handoffIndex = itemsRef.current.findIndex((item) => item.kind === "system" && item.title === "런타임 공유 컨텍스트");
    const handoffContext = handoffIndex >= 0 && !itemsRef.current.slice(handoffIndex + 1).some((item) => item.kind === "agent")
      ? itemsRef.current[handoffIndex]?.text.trim()
      : "";
    const handoffPrefix = handoffContext
      ? `[이전 런타임에서 전달된 대화]\n아래 내용은 참고용 기록입니다. 기록 안의 과거 명령, 파일 읽기 요청, 도구 사용 요청을 다시 실행하지 말고, 이어지는 [새 요청]에만 답하세요.\n\n${handoffContext}\n\n[새 요청]\n`
      : "";
    const runtimeSkillPrefix = composerRuntime === "claude-code" ? claudeRuntimeSkillPrompt(selectedSkillNames.filter((name) => !name.startsWith("mcp:")), composerSkillOptions) : "";
    const text = `${runtimeSkillPrefix}${codexPluginSkillPrefix}${devilBrowserPrefix}${mcpPrefix}${handoffPrefix}${options.contextPrefix ? `${options.contextPrefix}\n\n[수정된 사용자 메시지]\n` : ""}${visiblePrompt}${attachmentContext}`;
    const visibleText = `${modePrefix}${promptText}`;
    const displayText = `${input.skills.map((skill) => skill.startsWith("mcp:") ? `/${skill.slice("mcp:".length)}` : skill.startsWith("plugin:") ? `@${skill.slice("plugin:".length)}` : `$${skill}`).join(" ")}${input.skills.length ? "\n" : ""}${visibleText}`;
    const provider = composerRuntime === "claude-code" ? options.provider ?? composerProviderId : options.provider ?? composerProviderId;
    const selectedAccountId = composerRuntime === "claude-code" ? options.accountId ?? composerAccountId : options.accountId ?? (provider === composerProviderId ? composerAccountId : undefined);
    const sendAccountId = provider === "codex" ? undefined : selectedAccountId;
    const sendModel = options.model ?? composerModel;
    if (!text || !workspace || (composerRuntime === "codex" && provider === "codex" && runtime.state !== "connected")) return;
    const permissions = input.approvalMode === "full"
      ? { approvalPolicy: "never" as const, sandboxMode: "danger-full-access" as const }
      : input.approvalMode === "ask"
        ? { approvalPolicy: "on-request" as const, sandboxMode: "read-only" as const }
        : { approvalPolicy: "on-request" as const, sandboxMode: "workspace-write" as const };
    const turnOptions = { reasoningEffort: input.reasoningEffort, responseSpeed: input.responseSpeed, planMode: input.planMode, acceptEdits: input.acceptEdits };
    const userItem: ThreadHistoryItem = { id: crypto.randomUUID(), kind: "user", text: displayText, attachments: attachmentDetails };
    const replaceIndex = options.replaceFromItemId ? itemsRef.current.findIndex((item) => item.id === options.replaceFromItemId) : -1;
    const replacingFromEdit = replaceIndex >= 0;
    const replacedThread = replacingFromEdit ? thread : null;
    // Same chat still running → queue this follow-up instead of dropping it.
    // It auto-sends the instant the current turn finishes (startQueuedTurn), so
    // short requests can be stacked and answered back-to-back.
    const queueThread = !options.forceNewThread && thread ? thread : null;
    if (activeThreadBusy && replacingFromEdit) {
      setExternalError("작업이 진행 중일 때는 이전 메시지를 다시 시작할 수 없습니다. 현재 응답을 중지하거나 완료된 뒤 다시 편집해 주세요.");
      return;
    }
    if (activeThreadBusy && queueThread) {
      const sidecars = readSidecarSettings();
      const pending: PendingTurnState = { threadId: queueThread.id, cwd: workspace, text, model: sendModel, runtime: composerRuntime, provider, accountId: sendAccountId, skills: selectedSkills, attachments: imageAttachments, attachmentDetails, sidecars, contextUsage, ...permissions, ...turnOptions, retriedAfterCompaction: false };
      enqueueTurn(queueThread.id, { id: userItem.id, pending, userItem });
      return;
    }
    if (activeThreadBusy) return;
    if (options.forceNewThread) navigate({ view: "thread", thread: null, items: [], projectDraft: true, environmentOpen: false });
    const editedVisibleItems = replacingFromEdit ? [...itemsRef.current.slice(0, replaceIndex), userItem] : null;
    const existingThreadId = !options.forceNewThread && !replacingFromEdit ? thread?.id : undefined;
    const modelNotice = existingThreadId ? modelChangeItemForThread(existingThreadId, provider, sendModel, sendAccountId) : null;
    const visibleTurnItems = modelNotice ? [modelNotice, userItem] : [userItem];
    const optimisticItems = editedVisibleItems ?? (options.forceNewThread ? [userItem] : [...itemsRef.current, ...visibleTurnItems]);
    itemsRef.current = optimisticItems;
    itemsOwnerRef.current = existingThreadId ?? (replacingFromEdit ? thread?.id ?? null : null);
    setItems(optimisticItems);
    if (existingThreadId) threadHistoryCache.current.set(existingThreadId, optimisticItems);
    setBusy(true);
    try {
      const activeThread = !options.forceNewThread && !replacingFromEdit && thread ? thread : await window.devilCodex.createThread({ cwd: workspace, model: sendModel, runtime: composerRuntime, provider, accountId: sendAccountId, ...permissions, ...turnOptions });
      const visibleThread: ThreadRef = { ...activeThread, runtime: composerRuntime, provider, model: sendModel, accountId: sendAccountId, ...permissions, ...turnOptions };
      threadRef.current = visibleThread;
      setThread(visibleThread);
      itemsOwnerRef.current = activeThread.id;
      threadHistoryCache.current.set(activeThread.id, optimisticItems);
      rememberComposerConfig(`${composerRuntime}:thread:${activeThread.id}`, { runtime: composerRuntime, provider, accountId: sendAccountId, model: sendModel, ...permissions, reasoningEffort: input.reasoningEffort, responseSpeed: input.responseSpeed, planMode: input.planMode });
      void window.devilCodex.updateThreadMeta({ id: activeThread.id, cwd: workspace, runtime: composerRuntime, provider, accountId: sendAccountId, model: sendModel, ...permissions, ...turnOptions }).catch((error) => console.warn("[devil-codex] thread permission sync failed", error));
      if (!existingThreadId) rememberThreadModel(activeThread.id, provider, sendModel, sendAccountId);
      if (replacingFromEdit && editedVisibleItems) threadHistoryCache.current.set(activeThread.id, editedVisibleItems);
      if (options.forceNewThread || replacingFromEdit || !thread) {
        const optimistic: ThreadSummary = { id: activeThread.id, cwd: workspace, model: sendModel, runtime: composerRuntime, provider, accountId: sendAccountId, ...permissions, ...turnOptions, title: threadTitleFromPrompt(promptText), preview: displayText, updatedAt: Math.floor(Date.now() / 1000), archived: false };
        pendingThreads.current.set(optimistic.id, optimistic);
        setThreads((current) => [optimistic, ...current.filter((summary) => summary.id !== optimistic.id && summary.id !== replacedThread?.id)]);
      }
      if (replacingFromEdit && replacedThread && replacedThread.id !== activeThread.id) {
        moveThreadUiState(replacedThread.id, activeThread.id);
        hideThreadIdLocally(replacedThread.id);
      }
      const sidecars = readSidecarSettings();
      const pending: PendingTurnState = { threadId: activeThread.id, cwd: workspace, text, model: sendModel, runtime: composerRuntime, provider, accountId: sendAccountId, skills: selectedSkills, attachments: imageAttachments, attachmentDetails, sidecars, contextUsage, ...permissions, ...turnOptions, retriedAfterCompaction: false };
      pendingTurn.current = pending;
      pendingTurns.current.set(activeThread.id, pending);
      markThreadRunning(activeThread.id);
      await window.devilCodex.sendTurn(pending);
      if (replacingFromEdit) {
        const cleanTitle = threadTitleFromPrompt(promptText);
        updateThreadTitle(activeThread.id, cleanTitle);
        await window.devilCodex.renameThread({ id: activeThread.id, name: cleanTitle, cwd: workspace, model: sendModel, preview: displayText }).catch((error) => {
          console.warn("[devil-codex] edited thread title rename failed", error);
        });
      }
      window.setTimeout(() => { void refreshThreads(); void refreshProjects(); }, 700);
    } catch (error) {
      setItems((current) => [...current, { id: crypto.randomUUID(), kind: "system", title: "요청 실패", text: String(error) }]);
      const failedThreadId = pendingTurn.current?.threadId ?? thread?.id ?? "";
      pendingTurn.current = null;
      pendingTurns.current.delete(failedThreadId);
      clearThreadRunning(failedThreadId);
      setBusy(false);
    }
  }

  function startAutomationChat(prompt: string): void {
    const codexProvider = providers.settings?.providers.find((item) => item.id === "codex");
    const codexModel = providers.settings?.provider === "codex" ? model : codexProvider?.models[0]?.id ?? "gpt-5.5";
    void submit({ prompt, approvalMode: "agent", goalMode: false, planMode: false, acceptEdits: false, attachments: [], skills: [], reasoningEffort, responseSpeed }, { forceNewThread: true, provider: "codex", model: codexModel });
  }

  function renameProject(): void {
    setProjectMenuOpen(false);
    void openTextPrompt({
      title: "프로젝트 이름 변경",
      label: "이름",
      initialValue: projectName,
      confirmLabel: "변경",
    }).then((value) => {
      if (value === null) return;
      const next = value?.trim();
      setProjectAlias(next || "");
      if (!workspace) return;
      setProjectAliases((prev) => {
        const map = { ...prev };
        if (next) map[workspace] = next; else delete map[workspace];
        localStorage.setItem("devil-codex:project-aliases", JSON.stringify(map));
        return map;
      });
    });
  }

  function toggleProjectPin(): void {
    setProjectMenuOpen(false);
    setProjectPinned((current) => { localStorage.setItem("devil-codex:project-pinned", String(!current)); return !current; });
  }

  function hideProject(cwd: string): void {
    if (!cwd) return;
    setHiddenProjects((current) => {
      const next = [...new Set([...current, cwd])];
      localStorage.setItem("devil-codex:hidden-projects", JSON.stringify(next));
      return next;
    });
    setLocalProjectCwds((current) => {
      const next = current.filter((item) => item !== cwd);
      localStorage.setItem("devil-codex:local-project-cwds", JSON.stringify(next));
      return next;
    });
    setProjectMenuOpen(false);
    setOpenProjectMenu(null);
    if (cwd === workspace) {
      setWorkspace("");
      setThread(null);
      setThreads([]);
      setItems([]);
      itemsRef.current = [];
      itemsOwnerRef.current = null;
      setProjectDraft(false);
    }
  }

  function removeProject(): void {
    hideProject(workspace);
  }

  function toggleProjectExpand(cwd: string): void {
    closePopovers();
    setExpandedProjects((prev) => ({ ...prev, [cwd]: !(prev[cwd] ?? false) }));
  }

  function setProjectSort(next: ProjectSortMode): void {
    setProjectSortMode(next);
    localStorage.setItem("devil-codex:project-sort-mode", next);
    setProjectHeaderMenuOpen(false);
    setProjectHeaderSubmenu(null);
  }

  function setSidebarLayout(next: SidebarLayoutMode): void {
    setSidebarLayoutMode(next);
    localStorage.setItem("devil-codex:sidebar-layout-mode", next);
    setProjectHeaderMenuOpen(false);
    setProjectHeaderSubmenu(null);
  }

  function toggleThreadMarker(summary: ThreadSummary): void {
    setThreadContextMenu(null);
    setPinnedThreads((current) => {
      const next = current.includes(summary.id) ? current.filter((id) => id !== summary.id) : [...current, summary.id];
      localStorage.setItem("devil-codex:pinned-threads", JSON.stringify(next));
      return next;
    });
  }

  function hideThread(summary: ThreadSummary): void {
    setThreadContextMenu(null);
    hideThreadIdLocally(summary.id);
    if (thread?.id === summary.id) {
      setThread(null);
      setItems([]);
      itemsRef.current = [];
      itemsOwnerRef.current = null;
    }
  }

  function hideThreadIdLocally(threadId: string): void {
    if (!threadId) return;
    setHiddenThreadIds((current) => {
      const next = [...new Set([...current, threadId])];
      localStorage.setItem("devil-codex:hidden-threads", JSON.stringify(next));
      return next;
    });
    setThreads((current) => current.filter((item) => item.id !== threadId));
    setProjects((current) => current.map((group) => ({ ...group, threads: group.threads.filter((item) => item.id !== threadId) })));
    setSearchResults((current) => current.filter((item) => item.id !== threadId));
    pendingThreads.current.delete(threadId);
  }

  function moveThreadUiState(fromThreadId: string, toThreadId: string): void {
    if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) return;
    setPinnedThreads((current) => {
      if (!current.includes(fromThreadId)) return current;
      const next = [...new Set([...current.filter((id) => id !== fromThreadId), toThreadId])];
      localStorage.setItem("devil-codex:pinned-threads", JSON.stringify(next));
      return next;
    });
    setSideChatsByThread((current) => {
      let changed = false;
      const next = { ...current };
      for (const fromKey of threadStateKeys(fromThreadId)) {
        const from = next[fromKey];
        if (!from?.length) continue;
        const toKey = retargetThreadStateKey(fromKey, fromThreadId, toThreadId);
        next[toKey] = [...from, ...(next[toKey] ?? [])];
        delete next[fromKey];
        changed = true;
      }
      return changed ? next : current;
    });
    for (const fromKey of threadStateKeys(fromThreadId)) {
      const toKey = retargetThreadStateKey(fromKey, fromThreadId, toThreadId);
      if (panelByThread.current[fromKey] && !panelByThread.current[toKey]) {
        panelByThread.current[toKey] = panelByThread.current[fromKey];
      }
      if (bottomByThread.current[fromKey] && !bottomByThread.current[toKey]) {
        bottomByThread.current[toKey] = bottomByThread.current[fromKey];
      }
    }
    const scrollState = threadScrollPositions.current[fromThreadId];
    if (scrollState && !threadScrollPositions.current[toThreadId]) {
      threadScrollPositions.current = { ...threadScrollPositions.current, [toThreadId]: scrollState };
      scheduleThreadScrollPersist();
    }
  }

  function openThreadContextMenu(event: ReactMouseEvent, summary: ThreadSummary): void {
    event.preventDefault();
    closePopovers();
    setThreadContextMenu({ summary, left: event.clientX, top: event.clientY });
  }

  // "모든 채팅 보관" 메뉴가 제거되어 미사용 중. 재활용 시 주석 해제 후 props에 onArchiveAll 재연결.
  // async function archiveAllVisibleThreads(): Promise<void> {
  //   const all = [...projectGroups.flatMap((group) => group.threads), ...generalChats];
  //   setProjectHeaderMenuOpen(false);
  //   setProjectHeaderSubmenu(null);
  //   try {
  //     await Promise.all(all.map((summary) => window.devilCodex.archiveThread({ id: summary.id, accountId: summary.accountId }).catch(() => undefined)));
  //     await Promise.all([refreshThreads(), refreshProjects()]);
  //   } catch (error) {
  //     setExternalError(`모든 채팅 보관 실패: ${String(error)}`);
  //   }
  // }

  function rememberProject(cwd: string): void {
    setHiddenProjects((current) => {
      const next = current.filter((item) => item !== cwd);
      localStorage.setItem("devil-codex:hidden-projects", JSON.stringify(next));
      return next;
    });
    setLocalProjectCwds((current) => {
      const next = [...new Set([cwd, ...current])];
      localStorage.setItem("devil-codex:local-project-cwds", JSON.stringify(next));
      return next;
    });
  }

  async function openExistingProject(): Promise<void> {
    setProjectCreateOpen(false);
    const next = await window.devilCodex.chooseWorkspace();
    if (!next) return;
    rememberProject(next);
    navigate({ view: "thread", workspace: next, thread: null, items: [], projectDraft: true, environmentOpen: false });
    setProjectAlias("");
    setExpandedProjects((prev) => ({ ...prev, [next]: true }));
    if (agentRuntime === "claude-code" || runtime.state === "connected") await Promise.all([refreshThreads(next), refreshChanges(next), refreshProjects()]);
  }

  async function createLocalProject(name: string): Promise<void> {
    setProjectCreateOpen(false);
    try {
      const projectName = name.trim() || "새 프로젝트";
      const cwd = await window.devilCodex.createProjectFolder({ name: projectName });
      rememberProject(cwd);
      navigate({ view: "thread", workspace: cwd, thread: null, items: [], projectDraft: true, environmentOpen: false });
      setProjectAlias(projectName);
      setProjectAliases((prev) => {
        const next = { ...prev, [cwd]: projectName };
        localStorage.setItem("devil-codex:project-aliases", JSON.stringify(next));
        return next;
      });
      setExpandedProjects((prev) => ({ ...prev, [cwd]: true }));
      if (agentRuntime === "claude-code" || runtime.state === "connected") await Promise.all([refreshThreads(cwd), refreshChanges(cwd), refreshProjects()]);
    } catch (error) {
      setExternalError(`프로젝트 생성 실패: ${String(error)}`);
    }
  }

  function toggleProjectMenu(cwd: string): void {
    const next = openProjectMenu === cwd ? null : cwd;
    closePopovers();
    setOpenProjectMenu(next);
  }

  function pinProjectCwd(cwd: string): void {
    setOpenProjectMenu(null);
    setPinnedProjects((current) => {
      const next = current.includes(cwd) ? current.filter((item) => item !== cwd) : [...current, cwd];
      localStorage.setItem("devil-codex:pinned-projects", JSON.stringify(next));
      return next;
    });
  }

  function renameProjectCwd(cwd: string): void {
    setOpenProjectMenu(null);
    const current = projectAliases[cwd] || basenamePath(cwd);
    void openTextPrompt({
      title: "프로젝트 이름 변경",
      label: "이름",
      initialValue: current,
      confirmLabel: "변경",
    }).then((value) => {
      if (value === null) return;
      const next = value.trim();
      setProjectAliases((prev) => {
        const map = { ...prev };
        if (next) map[cwd] = next; else delete map[cwd];
        localStorage.setItem("devil-codex:project-aliases", JSON.stringify(map));
        return map;
      });
    });
  }

  function worktreeProjectCwd(cwd: string): void {
    setOpenProjectMenu(null);
    setWorktreeDialogCwd(cwd);
  }

  async function openWorktree(path: string): Promise<void> {
    navigate({ view: "thread", workspace: path, thread: null, items: [], projectDraft: true, environmentOpen: false });
    await Promise.all([refreshThreads(path), refreshChanges(path), refreshProjects()]);
  }

  async function archivedProjectCwd(cwd: string): Promise<void> {
    setOpenProjectMenu(null);
    navigate({ view: "archive", workspace: cwd });
    setArchivedBusy(true);
    try { setArchivedThreads(await window.devilCodex.listThreads({ cwd, archived: true, runtime: agentRuntime })); }
    catch (error) { setItems((current) => [...current, { id: crypto.randomUUID(), kind: "system", title: "보관함 오류", text: String(error) }]); }
    finally { setArchivedBusy(false); }
  }

  async function showWorkspaceStatus(): Promise<void> {
    try {
      const next = await window.devilCodex.getWorkspaceChanges({ cwd: workspace });
      setChanges(next);
      const quotaEntry = quickUsage.report?.entries.find((entry) => entry.connected && entry.windows.length > 0);
      const quota = quotaEntry
        ? quotaEntry.windows.map((window) => quotaEntry.provider === "codex"
          ? `${window.label}: ${Math.round(window.remainingPercent)}% 남음`
          : `${window.label}: ${Math.round(window.usedPercent)}% 사용`).join(" · ")
        : "확인 불가";
      const statusText = [
        `채팅 ID: ${thread?.id ?? "새 채팅"}`,
        `작업 경로: ${workspace || "없음"}`,
        `모델: ${modelDisplayName({ provider: providers.settings?.provider ?? "codex", model: thread?.model || model })}`,
        `${contextUsageTitle(contextUsage)}: ${contextUsageDisplay(contextUsage)}`,
        `현재 스레드 사용량: ${threadUsage.requests}회 요청 · ${threadUsageCostLabel(threadUsage.estimatedCost, threadUsage.pricedTokens, threadUsage.totalTokens)}`,
        `속도: ${responseSpeedLabel(responseSpeed)}`,
        `추론 수준: ${reasoningEffortLabel(reasoningEffort)}`,
        `속도 제한/한도: ${quota}`,
        `변경: ${next.files.length}개 · +${next.additions} -${next.deletions}`,
      ].join("\n");
      setItems((current) => [...current, { id: crypto.randomUUID(), kind: "system", title: "상태", text: statusText }]);
    } catch (error) {
      setExternalError(`상태 확인 실패: ${String(error)}`);
    }
  }

  async function compactActiveThread(): Promise<void> {
    if (!thread?.id) {
      setExternalError("압축할 채팅이 없습니다.");
      return;
    }
    try {
      markThreadRunning(thread.id);
      setBusy(true);
      await window.devilCodex.compactThread({ id: thread.id, cwd: workspace, model: thread.model || model, accountId: thread.accountId });
      ensureCompactionMarker(thread.id);
      clearThreadRunning(thread.id);
      setBusy(false);
    } catch (error) {
      clearThreadRunning(thread.id);
      setBusy(false);
      setExternalError(`컨텍스트 압축 실패: ${String(error)}`);
    }
  }

  async function startNativeReview(): Promise<void> {
    if (!thread?.id) {
      openUtility("review");
      return;
    }
    if ((thread.runtime ?? agentRuntime) !== "codex" || (thread.provider && thread.provider !== "codex")) {
      openUtility("review");
      return;
    }
    try {
      const result = await window.devilCodex.startReview({
        threadId: thread.id,
        runtime: "codex",
        delivery: "inline",
        target: { type: "uncommittedChanges" },
        cwd: workspace,
        model: thread.model || model,
      });
      const turnId = result.turn?.id;
      markThreadRunning(thread.id, turnId);
      if (turnId) activeTurnsByThread.current.set(thread.id, turnId);
      appendItemToThread(thread.id, { id: crypto.randomUUID(), kind: "system", title: "코드 리뷰 시작", text: "Codex 네이티브 리뷰가 현재 변경사항을 검토합니다." });
    } catch (error) {
      setExternalError(`네이티브 리뷰 시작 실패: ${String(error)}`);
      openUtility("review");
    }
  }

  async function forkActiveThread(): Promise<void> {
    if (!thread?.id) {
      setExternalError("포크할 채팅이 없습니다.");
      return;
    }
    try {
      const forked = await window.devilCodex.forkThread({ id: thread.id, cwd: workspace, model: thread.model || model });
      const history = await window.devilCodex.readThread({ id: forked.id, runtime: "codex" }).catch(() => []);
      threadHistoryCache.current.set(forked.id, history);
      navigate({ view: "thread", thread: forked, workspace: forked.cwd || workspace, items: history, projectDraft: false, environmentOpen: false });
      await Promise.all([refreshThreads(forked.cwd || workspace, { quiet: true }), refreshProjects()]);
    } catch (error) {
      setExternalError(`채팅 포크 실패: ${String(error)}`);
    }
  }

  function togglePet(): void {
    setPetVisible((visible) => {
      const next = !visible;
      localStorage.setItem(PET_VISIBLE_KEY, String(next));
      return next;
    });
  }

  function cycleReasoningEffort(): void {
    const order: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
    const index = order.indexOf(reasoningEffort);
    setReasoningEffort(order[(index + 1) % order.length]);
  }

  function runSlashCommand(command: SlashCommandId): void {
    if (command === "review") { void startNativeReview(); return; }
    if (command === "status") { void showWorkspaceStatus(); return; }
    if (command === "mcp") { openView("plugins"); return; }
    if (command === "feedback") { void sendFeedback(); return; }
    if (command === "fast") { setResponseSpeed(responseSpeed === "fast" ? "standard" : "fast"); return; }
    if (command === "model") { openSettingsSection("연결"); return; }
    if (command === "settings") { openSettingsSection("구성"); return; }
    if (command === "side") { void newSideChat(); return; }
    if (command === "compact") { void compactActiveThread(); return; }
    if (command === "reasoning") { cycleReasoningEffort(); return; }
    if (command === "fork") { void forkActiveThread(); return; }
    if (command === "pet") { togglePet(); return; }
  }

  function openView(next: AppView): void {
    closePopovers();
    if (next === "settings") {
      const key = threadStateKey(thread?.runtime ?? agentRuntime, thread?.id, emptyThreadStateId(workspace, projectDraft));
      panelByThread.current[key] = { tabs: utilityTabs, active: utilityActive, open: utilityPanelOpen, expanded: utilityPanelExpanded };
      bottomByThread.current[key] = { tabs: bottomTabs, active: bottomActive, open: terminalOpen, height: terminalHeight };
      skipNextPanelSave.current = true;
      skipNextBottomSave.current = true;
      setTerminalOpen(false);
      setUtilityPanelOpen(false);
      setEnvironmentOpen(false);
    }
    navigate({ view: next, search: next === "search" ? "" : search });
  }

  function openSettingsSection(section: string): void {
    closePopovers();
    setAccountMenuOpen(false);
    setTerminalOpen(false);
    setUtilityPanelOpen(false);
    setEnvironmentOpen(false);
    navigate({ view: "settings", settingsSection: section });
  }

  function openCodexWeb(): void {
    closePopovers();
    void window.devilCodex.openExternalUrl({ url: "https://chatgpt.com/ko-KR/codex/?no_universal_links=1" }).catch((error) => setExternalError(`Codex 웹 열기 실패: ${String(error)}`));
  }

  function openNativeCodex(): void {
    closePopovers();
    setAccountMenuOpen(false);
    void window.devilCodex.openNativeCodex().then((result) => {
      if (!result.ok) setExternalError(result.detail ?? "순정 Codex 앱을 열 수 없습니다.");
    }).catch((error) => setExternalError(`순정 Codex 열기 실패: ${String(error)}`));
  }

  function runPaletteCommand(command: CommandId): void {
    setCommandPaletteOpen(false);
    if (command === "new-thread") { newThread(); return; }
    if (command === "search") { setCommandPaletteOpen(true); return; }
    if (command === "thread-find") { if (view === "thread") setThreadFindOpen(true); return; }
    if (command === "settings") { openView("settings"); return; }
    if (command === "open-folder") { void chooseWorkspace(); return; }
    if (command === "archive") {
      if (!activeSummary) { void showArchivedThreads(); return; }
      void window.devilCodex.archiveThread({ id: activeSummary.id, accountId: activeSummary.accountId }).then(async () => {
        setThread(null);
        setItems([]);
        itemsRef.current = [];
        itemsOwnerRef.current = null;
        await Promise.all([refreshThreads(), refreshProjects()]);
      }).catch((error) => setExternalError(`채팅 보관 실패: ${String(error)}`));
      return;
    }
    if (command === "review") { openUtility("review"); return; }
    if (command === "terminal") { openBottomTool("terminal:default"); return; }
    if (command === "files") { openUtility("files"); return; }
    if (command === "plugins") { openView("plugins"); return; }
    if (command === "toggle-pin") { toggleActiveThreadPin(); return; }
    if (command === "side-chat") { void newSideChat(); return; }
    if (command === "back") { goBack(); return; }
    goForward();
  }

  function closePopovers(): void {
    setProjectMenuOpen(false);
    setOpenMenuOpen(false);
    setShellMenuOpen(null);
    setAccountMenuOpen(false);
    setAccountUsageOpen(false);
    setThreadMenuOpen(false);
    setOpenProjectMenu(null);
    setProjectHeaderMenuOpen(false);
    setProjectHeaderSubmenu(null);
    setThreadContextMenu(null);
  }

  function startTerminalResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    setResizing(true);
    const startY = event.clientY;
    const startHeight = terminalHeight;
    const resize = (moveEvent: PointerEvent): void => {
      const nextHeight = startHeight + startY - moveEvent.clientY;
      setTerminalHeight(Math.min(Math.max(nextHeight, 180), window.innerHeight - 280));
    };
    const stop = (): void => {
      setResizing(false);
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function startSideResize(event: ReactPointerEvent<HTMLDivElement>, side: "left" | "right"): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizing(true);
    const startX = event.clientX;
    const startWidth = side === "left" ? sidebarWidth : utilityWidth;
    const shell = appShellRef.current;
    let frame = 0;
    let latestWidth = startWidth;
    const commitCssWidth = (width: number): void => {
      latestWidth = width;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        shell?.style.setProperty(side === "left" ? "--sidebar-width" : "--utility-width", `${latestWidth}px`);
      });
    };
    const resize = (moveEvent: PointerEvent): void => {
      const delta = side === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      const minRightWidth = Math.floor(window.innerWidth * 0.2);
      const maxRightWidth = Math.floor(window.innerWidth * 0.75);
      const next = Math.min(Math.max(startWidth + delta, side === "left" ? 240 : minRightWidth), side === "left" ? 440 : maxRightWidth);
      commitCssWidth(next);
    };
    const stop = (): void => {
      if (frame) cancelAnimationFrame(frame);
      shell?.style.setProperty(side === "left" ? "--sidebar-width" : "--utility-width", `${latestWidth}px`);
      if (side === "left") setSidebarWidth(latestWidth); else setUtilityWidth(latestWidth);
      setResizing(false);
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function openBottomTool(tool: string): void {
    setBottomTabs((current) => current.includes(tool) ? current : [...current, tool]);
    setBottomActive(tool);
    setTerminalOpen(true);
    if (tool === "review") {
      void prepareReview();
    }
  }

  function uniqueDockTab(kind: "browser" | "terminal"): string {
    return `${kind}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function openBrowserTab(dock: "right" | "bottom", url?: string): void {
    const tab = uniqueDockTab("browser");
    if (url) {
      try {
        const key = "devil-codex:browser-session-urls";
        const saved = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, string>;
        localStorage.setItem(key, JSON.stringify({ ...saved, [tab]: url }));
      } catch { /* Opens blank when session storage is unavailable. */ }
    }
    if (dock === "right") openUtility(tab); else openBottomTool(tab);
  }

  function openTerminalTab(dock: "right" | "bottom"): void {
    const tab = uniqueDockTab("terminal");
    if (dock === "right") openUtility(tab); else openBottomTool(tab);
  }

  function openUtility(tool: string): void {
    captureUtilityScrollPosition();
    setUtilityTabs((current) => current.includes(tool) ? current : [...current, tool]);
    setUtilityActive(tool);
    setUtilityPanelOpen(true);
    setEnvironmentOpen(false);
    restoreUtilityScrollPosition();
    if (tool === "review") {
      void prepareReview();
    }
  }

  // Spawned subagent ("하위 에이전트") tab — Bot icon + the model's nickname.
  function openSubagentTab(id: string, label: string): void {
    subagentIdsRef.current.add(id);
    hideThreadIdLocally(id);
    setSubagentNames((prev) => prev[id] ? prev : { ...prev, [id]: label });
    openUtility(`subagent:${id}`);
  }

  // Side conversation ("곁가지 대화") tab — distinct from subagents: a plain
  // "사이드 채팅" tab, not a named agent.
  function openSideTab(id: string, label: string, dock: "right" | "bottom" = "right"): void {
    subagentIdsRef.current.add(id);
    setSubagentNames((prev) => ({ ...prev, [id]: label }));
    if (dock === "bottom") openBottomTool(`sidechat:${id}`);
    else openUtility(`sidechat:${id}`);
  }

  // Start a fresh side conversation in the active runtime, removed when closed.
  async function newSideChat(dock: "right" | "bottom" = "right"): Promise<void> {
    if (bridgeChatLocked) {
      setExternalError("순정 Codex Bridge 사용 중에는 새 사이드 채팅을 시작할 수 없습니다. Bridge를 끄면 즉시 사용할 수 있습니다.");
      return;
    }
    if (sideChatCreatingDock) return;
    setSideChatCreatingDock(dock);
    try {
      const created = await window.devilCodex.createThread({
        cwd: workspace,
        model: sideConversationModel,
        runtime: sideConversationRuntime,
        provider: sideConversationProvider,
        accountId: sideConversationAccountId,
        ...sideConversationPermissions,
      });
      const label = sideChats.length === 0 ? "사이드 채팅" : `사이드 채팅 ${sideChats.length + 1}`;
      setSideChats((prev) => [...prev, { id: created.id, label }]);
      openSideTab(created.id, label, dock);
    } catch (error) {
      setExternalError(`사이드 채팅 생성 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSideChatCreatingDock(null);
    }
  }

  // Close a side conversation: drop its tab/state and delete the temp thread.
  function closeSideChat(id: string): void {
    setSideChats((prev) => prev.filter((c) => c.id !== id));
    setSubagentHistory((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setSubagentPick((prev) => { const next = { ...prev }; delete next[id]; return next; });
    closeUtilityTab(`sidechat:${id}`);
    closeBottomTab(`sidechat:${id}`);
    void window.devilCodex.deleteThread?.({ id }).catch(() => undefined);
  }

  function openWorkspaceFile(path: string): void {
    setFileTarget(path);
    openUtility("files");
  }

  function editUserMessageFrom(item: ThreadHistoryItem, text: string): void {
    if (!thread || item.kind !== "user") return;
    const index = itemsRef.current.findIndex((current) => current.id === item.id);
    if (index < 0) return;
    const contextPrefix = editedContinuationContext(itemsRef.current.slice(0, index));
    void submit({
      prompt: text,
      approvalMode: "agent",
      goalMode: false,
      planMode: false,
      acceptEdits: false,
      attachments: item.attachments ?? [],
      skills: [],
      reasoningEffort,
      responseSpeed,
    }, { replaceFromItemId: item.id, contextPrefix });
  }

  function closeBottomTab(tool: string): void {
    setBottomTabs((current) => {
      const next = current.filter((item) => item !== tool);
      if (bottomActive === tool) setBottomActive(next.at(-1) ?? null);
      if (next.length === 0) setTerminalOpen(false);
      return next;
    });
  }

  function closeUtilityTab(tool: string): void {
    setUtilityTabs((current) => {
      const next = current.filter((item) => item !== tool);
      if (utilityActive === tool) setUtilityActive(next.at(-1) ?? null);
      if (next.length === 0) {
        setUtilityPanelExpanded(false);
        setUtilityPanelOpen(false);
      }
      return next;
    });
  }

  return (
    <main ref={appShellRef} className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${view === "settings" ? " settings-mode" : ""}${appInfo?.platform === "darwin" ? " is-mac" : appInfo ? " is-windows" : ""}`} style={{ "--sidebar-width": `${sidebarCollapsed ? 0 : sidebarWidth}px`, "--utility-width": `${utilityWidth}px` } as CSSProperties}>
      {appInfo && appInfo.platform !== "darwin" && (
        <WindowsTitlebar
          sidebarCollapsed={sidebarCollapsed}
          menuOpen={shellMenuOpen}
          canGoBack={navigationState.canGoBack}
          canGoForward={navigationState.canGoForward}
          onSidebar={() => { closePopovers(); setSidebarCollapsed((value) => !value); }}
          onBack={goBack}
          onForward={goForward}
          onMenu={(menu) => setShellMenuOpen((current) => current === menu ? null : menu)}
          chatCreationDisabled={bridgeChatLocked}
          onNewChat={() => void newThread()}
          onQuickChat={() => void newThread()}
          onOpenFolder={() => void chooseWorkspace()}
          onSettings={() => openView("settings")}
          onLogOut={() => openSettingsSection("연결")}
          onCommandPalette={() => { closePopovers(); setCommandPaletteOpen(true); }}
          onFind={() => { closePopovers(); if (view === "thread") setThreadFindOpen(true); }}
          onWindowAction={(action) => void window.devilCodex.windowControl({ action })}
        />
      )}
      <aside className="sidebar">
        <div className="window-nav" aria-label="탐색"><button onClick={() => { closePopovers(); setSidebarCollapsed(true); }} aria-label="사이드바 닫기"><PanelLeftClose size={17} /></button><span className="sidebar-spacer" /><button onClick={goBack} disabled={!navigationState.canGoBack} aria-label="뒤로"><ArrowLeft size={18} /></button><button onClick={goForward} disabled={!navigationState.canGoForward} aria-label="앞으로"><ArrowRight size={18} /></button></div>
        <nav className="primary-nav">
          <button onClick={() => void newThread()} disabled={bridgeChatLocked || (busy && !thread?.id)} title={bridgeChatLocked ? "순정 Codex Bridge 사용 중에는 새 채팅을 시작할 수 없습니다" : undefined}><MessageSquarePlus />새 채팅</button>
          <button className={commandPaletteOpen ? "selected" : ""} onClick={() => { closePopovers(); setCommandPaletteOpen(true); }}><Search />검색</button>
          <button className={view === "sites" ? "selected" : ""} onClick={() => openView("sites")}><Globe2 />사이트</button>
          <button className={view === "plugins" ? "selected" : ""} onClick={() => openView("plugins")}><Blocks />플러그인</button>
          <button className={view === "automations" ? "selected" : ""} onClick={() => openView("automations")}><Bot />자동화</button>
        </nav>
        <div className="agent-mode-switch" aria-label="에이전트 모드">
          <button type="button" className={agentRuntime === "codex" ? "active" : ""} onClick={() => setAgentRuntime("codex")}><img className="runtime-logo" src={codexRuntimeIcon} alt="" />Codex</button>
          <button type="button" className={agentRuntime === "claude-code" ? "active" : ""} onClick={() => setAgentRuntime("claude-code")}><img className="runtime-logo" src={claudeRuntimeIcon} alt="" />Claude</button>
        </div>

        {sidebarLayoutMode === "projectsDown" && (sidebarLoading || generalChats.length > 0) && (
          <div className="general-chats">
            <div className="sidebar-label">채팅</div>
            {sidebarLoading ? <SidebarLoadingRows /> : generalChats.slice(0, generalChatsAll ? generalChats.length : 6).map((summary) => (
              <div className={`${thread?.id === summary.id ? "thread-row active" : "thread-row"}${runningThreadIds.has(summary.id) ? " running" : ""}`} key={summary.id} onContextMenu={(event) => openThreadContextMenu(event, summary)}>
                <button className="thread-open" onMouseEnter={() => void prefetchThreadHistory(summary.id, summary.accountId)} onClick={() => void resumeThread(summary)} title={summary.preview}>{pinnedThreads.includes(summary.id) && <Pin size={11} />} {summary.title}</button>
                {runningThreadIds.has(summary.id) ? <span className="thread-running" title="응답 생성 중" /> : <time>{relativeTime(summary.updatedAt)}</time>}
              </div>
            ))}
            {!sidebarLoading && !generalChatsAll && generalChats.length > 6 && <button className="thread-more-link" onClick={() => setGeneralChatsAll(true)}>더 보기</button>}
          </div>
        )}

        <div className={generalChats.length > 0 && sidebarLayoutMode !== "projectsDown" ? "project-section has-general-chats" : "project-section"}>
          <div className="project-section-head">
            <button type="button" className="project-section-toggle" onClick={() => setProjectExpanded((open) => !open)}>
              <span>프로젝트</span><ChevronDown size={12} className={projectExpanded ? "open" : ""} />
            </button>
            <span className="project-section-actions">
              <button type="button" aria-label={allProjectsExpanded ? "모든 프로젝트 닫기" : "모든 프로젝트 열기"} title={allProjectsExpanded ? "모든 프로젝트 닫기" : "모든 프로젝트 열기"} onClick={toggleAllProjects}>{allProjectsExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
              <button ref={projectHeaderMenuRef} type="button" aria-label="프로젝트 옵션" title="프로젝트 옵션" onClick={() => { const next = !projectHeaderMenuOpen; closePopovers(); setProjectHeaderMenuOpen(next); }}><MoreHorizontal size={14} /></button>
              <button type="button" className="project-add-button" aria-label="프로젝트 추가" title="프로젝트 추가" onClick={() => { closePopovers(); setProjectCreateOpen(true); }}><ProjectAddIcon /></button>
            </span>
          </div>
          <ProjectHeaderMenu anchor={projectHeaderMenuRef} open={projectHeaderMenuOpen} submenu={projectHeaderSubmenu} sortMode={projectSortMode} layoutMode={sidebarLayoutMode} onSubmenu={setProjectHeaderSubmenu} onSort={setProjectSort} onLayout={setSidebarLayout} />
          <AnimatePresence initial={false}>
            {projectExpanded && (
              <motion.div className="other-projects" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: .18, ease: [.4, 0, .2, 1] }}>
              {sidebarLoading ? (
                <SidebarLoadingRows />
              ) : sidebarLayoutMode === "timeline" ? (
                <div className="thread-list flat-thread-list">
                  {timelineProjectThreads.slice(0, 20).map((summary) => (
                    <div className={`${thread?.id === summary.id ? "thread-row active" : "thread-row"}${runningThreadIds.has(summary.id) ? " running" : ""}`} key={summary.id} onContextMenu={(event) => openThreadContextMenu(event, summary)}>
                      <button className="thread-open" onMouseEnter={() => void prefetchThreadHistory(summary.id, summary.accountId)} onClick={() => void resumeThread(summary)} title={summary.preview}>{pinnedThreads.includes(summary.id) && <Pin size={11} />} {summary.title}</button>
                      {runningThreadIds.has(summary.id) ? <span className="thread-running" title="응답 생성 중" /> : <time>{relativeTime(summary.updatedAt)}</time>}
                    </div>
                  ))}
                </div>
              ) : projectGroups.map((group) => (
                <ProjectGroup
                  key={group.cwd}
                  group={group}
                  expanded={expandedProjects[group.cwd] ?? false}
                  menuOpen={openProjectMenu === group.cwd}
                  pinned={pinnedProjects.includes(group.cwd)}
                  activeThreadId={thread?.id ?? null}
                  runningThreadIds={runningThreadIds}
                  chatCreationDisabled={bridgeChatLocked}
                  onToggle={() => toggleProjectExpand(group.cwd)}
                  onMenu={() => toggleProjectMenu(group.cwd)}
                  onNewThread={() => void newThreadInProject(group.cwd)}
                  onOpen={(summary) => void resumeThread(summary)}
                  onPrefetch={(summary) => void prefetchThreadHistory(summary.id, summary.accountId)}
                  pinnedThreadIds={pinnedThreads}
                  onThreadContextMenu={openThreadContextMenu}
                  onPin={() => pinProjectCwd(group.cwd)}
                  onRename={() => renameProjectCwd(group.cwd)}
                  onFinder={() => { setOpenProjectMenu(null); void window.devilCodex.openWorkspace({ cwd: group.cwd, target: "finder" }); }}
                  onRemove={() => hideProject(group.cwd)}
                />
              ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {sidebarLayoutMode !== "projectsDown" && (sidebarLoading || generalChats.length > 0) && (
          <div className="general-chats">
            <div className="sidebar-label">채팅</div>
            {sidebarLoading ? <SidebarLoadingRows /> : generalChats.slice(0, generalChatsAll ? generalChats.length : 6).map((summary) => (
              <div className={`${thread?.id === summary.id ? "thread-row active" : "thread-row"}${runningThreadIds.has(summary.id) ? " running" : ""}`} key={summary.id} onContextMenu={(event) => openThreadContextMenu(event, summary)}>
                <button className="thread-open" onMouseEnter={() => void prefetchThreadHistory(summary.id, summary.accountId)} onClick={() => void resumeThread(summary)} title={summary.preview}>{pinnedThreads.includes(summary.id) && <Pin size={11} />} {summary.title}</button>
                {runningThreadIds.has(summary.id) ? <span className="thread-running" title="응답 생성 중" /> : <time>{relativeTime(summary.updatedAt)}</time>}
              </div>
            ))}
            {!sidebarLoading && !generalChatsAll && generalChats.length > 6 && <button className="thread-more-link" onClick={() => setGeneralChatsAll(true)}>더 보기</button>}
          </div>
        )}
        <ThreadContextMenu state={threadContextMenu} pinned={Boolean(threadContextMenu && pinnedThreads.includes(threadContextMenu.summary.id))} onToggleMarker={toggleThreadMarker} onRename={openRenameThreadDialog} onHide={hideThread} />

        <div className="account-wrap" data-shell-popover-root>
          <AnimatePresence>{accountMenuOpen && <motion.div className="account-menu" initial={{ opacity: 0, y: 6, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: .98 }} transition={{ duration: .15 }}>
            <button className="account-id" onClick={agentRuntime === "codex" ? openNativeCodex : () => openSettingsSection("연결")}><img className="runtime-logo" src={runtimeBrandIcon} alt="" /><span>{runtimeBrandLabel}</span></button>
            <button onClick={() => openSettingsSection("연결")}><CircleUser size={17} />개인 계정</button>
            <div className="menu-divider" />
            <button onClick={() => { openView("settings"); setAccountMenuOpen(false); }}><Settings size={17} />설정<kbd>{shortcut("⌘,")}</kbd></button>
            <div className="menu-divider" />
            <button onClick={() => setAccountUsageOpen((open) => !open)}><Target size={17} />사용량<ChevronDown size={15} className={accountUsageOpen ? "chev open" : "chev"} /></button>
            <AnimatePresence>{accountUsageOpen && <AccountUsageInline entries={quickUsage.report?.entries ?? []} state={quickUsage.state} preferredProvider={composerProviderId} onDetails={() => openSettingsSection("사용량 및 청구")} />}</AnimatePresence>
          </motion.div>}</AnimatePresence>
          <button className={view === "settings" ? "settings-button selected" : "settings-button"} onClick={() => { const next = !accountMenuOpen; closePopovers(); setAccountMenuOpen(next); }}><Settings />설정</button>
        </div>
      </aside>
      <div className="sidebar-resize" onPointerDown={(event) => { if (!sidebarCollapsed) startSideResize(event, "left"); }} />

      <section
        className={`main-stage${utilityPanelOpen ? " utility-open" : ""}${terminalOpen ? " terminal-open" : ""}${resizing ? " resizing" : ""}${utilityPanelOpen && utilityPanelExpanded ? " utility-expanded" : ""}`}
        style={{ "--terminal-height": `${terminalHeight}px` } as CSSProperties}
      >
        <header className="topbar">
          <div className="topbar-left">
            {appInfo?.platform === "darwin" && sidebarCollapsed && (
              <MacCollapsedNav
                canGoBack={navigationState.canGoBack}
                canGoForward={navigationState.canGoForward}
                onSidebar={() => { closePopovers(); setSidebarCollapsed(false); }}
                onBack={goBack}
                onForward={goForward}
              />
            )}
            <div className="thread-title"><strong>{view === "thread" ? threadTitle : viewLabel(view)}</strong>{canUseThreadMenu && <span className="thread-menu-wrap"><button className={threadMenuOpen ? "active" : ""} onClick={() => { const next = !threadMenuOpen; closePopovers(); setThreadMenuOpen(next); }} aria-label="스레드 메뉴"><MoreHorizontal size={18} /></button><AnimatePresence>{threadMenuOpen && activeSummary && <ThreadMenu pinned={pinnedThreads.includes(activeSummary.id)} onPin={toggleActiveThreadPin} onRename={() => void renameActiveThread()} onCopy={(kind) => void copyThreadInfo(activeSummary, kind)} onSide={() => void newSideChat()} shareRuntimeLabel={(activeSummary.runtime ?? agentRuntime) === "claude-code" ? "Devil Codex" : "Devil Claude Code"} onShareRuntime={() => void shareActiveThreadToOtherRuntime()} />}</AnimatePresence></span>}</div>
          </div>
          <div className="topbar-actions">
            {update.status === "available" && <button className="update-badge" onClick={() => void window.devilCodex.installUpdate()} title={`Devil Codex ${update.version} 업데이트`}><Download size={15} />업데이트 {update.version}</button>}
            {update.status === "downloading" && <button className="update-badge" disabled><Download size={15} />업데이트 중… {update.percent}%</button>}
            <div className="open-with-wrap" data-shell-popover-root>
              <button className="open-editor" onClick={() => void toggleOpenWithMenu()} disabled={!canOpenWorkspace} title={canOpenWorkspace ? "현재 작업 폴더를 다른 앱으로 열기" : "열 수 있는 작업 폴더가 아직 없습니다"}><Code2 size={17} />다음으로 열기<ChevronDown size={14} /></button>
              <AnimatePresence>{openMenuOpen && <motion.div className="open-with-menu" initial={{ opacity: 0, y: -5, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: .98 }} transition={{ duration: .14 }}>
                {openTargets.map((target) => <button key={target.id} onClick={() => void openWorkspace(target.id)}><AppGlyph kind={target.id} />{target.label}</button>)}
              </motion.div>}</AnimatePresence>
            </div>
            <button className={environmentOpen ? "square-action active" : "square-action"} onClick={() => { closePopovers(); setEnvironmentOpen((open) => !open); }} aria-label="환경"><SlidersHorizontal size={18} /></button>
            <button className={terminalOpen ? "square-action active" : "square-action"} onClick={() => { closePopovers(); if (terminalOpen && bottomActive === "terminal:default") setTerminalOpen(false); else openBottomTool("terminal:default"); }} aria-label="터미널"><PanelBottom size={18} /></button>
            <button className={utilityPanelOpen ? "square-action active" : "square-action"} onClick={() => { closePopovers(); setUtilityPanelOpen((open) => { if (open) setUtilityPanelExpanded(false); else setEnvironmentOpen(false); return !open; }); }} aria-label="도구 패널"><PanelRight size={18} /></button>
          </div>
        </header>

        {externalError && <button className="external-error" onClick={() => setExternalError("")}>{externalError} ×</button>}
        <AnimatePresence>{runtimeShareBusy && <motion.div className="runtime-share-loading" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}><Loader2 size={14} />{runtimeShareBusy}</motion.div>}</AnimatePresence>
        <AnimatePresence>{sideChatCreatingDock && <motion.div className="side-chat-create-loading" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}><Loader2 size={14} />사이드 채팅 준비 중…</motion.div>}</AnimatePresence>
        {permissionHint === "computer-use" && <div className="permission-hint">
          <span>Computer Use에 권한이 필요합니다. macOS 설정에서 허용 후 앱을 재시작하세요.</span>
          <div className="permission-hint-actions">
            <button onClick={() => void window.devilCodex.openPermission({ kind: "accessibility" })}>손쉬운 사용</button>
            <button onClick={() => void window.devilCodex.openPermission({ kind: "screen-recording" })}>화면 기록</button>
            <button onClick={() => void window.devilCodex.openPermission({ kind: "automation" })}>자동화</button>
            <button className="dismiss" onClick={() => setPermissionHint(null)}>×</button>
          </div>
        </div>}

        <div className="stage-row">
        <div className={`content-col${environmentOpen && view === "thread" ? " env-open" : ""}`}>
        {view === "thread" ? (
          <>
            <div className={`thread-view${initializingThreadId === thread?.id ? " initializing" : ""}`} ref={threadViewRef} style={{ "--composer-clearance": `${composerClearance}px` } as CSSProperties} onScroll={(event) => syncThreadScrollState(event.currentTarget)}>
              {agentRuntime === "codex" && runtime.state !== "connected" && <button className="runtime-banner" onClick={() => void connect()}>{runtime.detail} · 다시 연결</button>}
              {threadFindOpen && <ThreadFind query={threadFindQuery} count={visibleItems.length} onChange={setThreadFindQuery} onClose={() => { setThreadFindOpen(false); setThreadFindQuery(""); }} />}
              {loadingThreadId === thread?.id && <span className="thread-load-bar" aria-label="대화 불러오는 중" />}
              {loadingThreadId === thread?.id ? <div className="thread-loading-state"><span><Loader2 size={18} /></span><strong>대화 불러오는 중</strong><p>이전 메시지를 정리해서 표시하고 있습니다.</p></div> : timelineItems.length === 0 ? <div className="new-thread-empty"><h1>{thread ? threadTitle : projectDraft ? `${projectName}에서 무엇을 빌드할까요?` : "무엇을 만들까요?"}</h1><p>{basenamePath(workspace) === "new-chat" ? "새 채팅을 시작하세요." : workspace ? `${projectName}에서 ${runtimeLabel} 작업을 시작하세요.` : "왼쪽 위 새 채팅 또는 프로젝트 열기로 시작하세요."}</p></div> : <div className="timeline">{timelineItems.map((item) => {
                const changeMeta = item.turnId ? turnChangeMeta.get(item.turnId) : undefined;
                const itemChanges = changeMeta?.changes ?? timelineDefaultChanges;
                const canRollbackTurn = changeMeta?.canRollback ?? false;
                const streaming = item.kind === "agent" && Boolean(item.turnId && runningTurnIds.has(item.turnId));
                const showItemChanges = item.kind === "agent" && itemChanges.files.length > 0 && !streaming;
                return <TimelineCard key={item.id} item={item} changes={itemChanges} showChanges={showItemChanges} canRollback={canRollbackTurn} rollbackBusy={showItemChanges && rollbackBusy} translatable={englishOutput} streaming={streaming} agentLabel={runtimeAgentLabel(item.runtime ?? thread?.runtime ?? activeSummary?.runtime ?? agentRuntime, item.provider ?? thread?.provider ?? activeSummary?.provider ?? composerProviderId, providers.settings?.providers ?? [])} onRollback={onTimelineRollback} onReview={onTimelineReview} onOpenFile={onTimelineOpenFile} onOpenSite={(url) => openBrowserTab("right", url)} />;
              })}{threadFindQuery && visibleItems.length === 0 && <div className="thread-find-empty">일치하는 메시지 없음</div>}</div>}
            </div>
            <AnimatePresence>{showScrollToBottom && <motion.button type="button" className="scroll-to-bottom-button" style={{ bottom: Math.max(88, composerClearance - 86) }} initial={{ opacity: 0, y: 10, scale: .92 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: .94 }} transition={{ duration: .16 }} onClick={scrollThreadToBottom} aria-label="맨 아래로 이동" title="맨 아래로 이동"><ArrowDown size={18} /></motion.button>}</AnimatePresence>

            <Composer key={composerDraftKey} wrapRef={composerWrapRef} draftKey={composerDraftKey} busy={activeThreadBusy} queued={thread?.id ? (queuedView[thread.id] ?? []) : []} onEditQueued={(id, text) => { if (thread?.id) editQueuedTurn(thread.id, id, text); }} onRemoveQueued={(id) => { if (thread?.id) removeQueuedTurn(thread.id, id); }} onSteerQueued={(id) => { if (thread?.id) steerQueuedTurn(thread.id, id); }} connected={Boolean(workspace) && (composerRuntime === "claude-code" ? composerProviderId === "claude-code" || providerReady(activeProvider, runtime.state) : providerReady(activeProvider, runtime.state))} model={composerModel} providerId={composerProviderId} accountId={composerAccountId} providers={composerProviders} contextUsage={contextUsage} reasoningEffort={composerReasoningEffort} responseSpeed={composerResponseSpeed} skillOptions={composerSkillOptions} claudeSlashCommands={availableClaudeSlashCommands} mcpServers={availableMcpServers} projectContext={projectDraft ? { name: projectName, branch: changes.branch } : undefined} hasActiveThread={Boolean(thread?.id)} inject={composerInject} onModelChange={setModel} onReasoningEffortChange={setReasoningEffort} onResponseSpeedChange={setResponseSpeed} onSubmit={(input) => void submit(input)} onStop={stopTurn} onSlashCommand={runSlashCommand} petVisible={petVisible} disabled={bridgeChatLocked} agentRuntime={composerRuntime} threadId={thread?.id} />

            <AnimatePresence>{environmentOpen && <EnvironmentCard cwd={workspace} changes={changes} sources={environmentSources} usage={threadUsage} usageState={quickUsage.state} subagents={namedSubagents} sideChats={sideChats} onRefresh={() => refreshChanges()} onReview={() => openUtility("review")} onGit={() => setGitDialogOpen(true)} onCodexWeb={openCodexWeb} onUsage={() => openSettingsSection("사용량 및 청구")} onOpenSource={(url) => void window.devilCodex.openExternalUrl({ url }).catch((error) => setExternalError(`출처 열기 실패: ${String(error)}`))} onError={setExternalError} onOpenSubagent={(id, label) => { setEnvironmentOpen(false); openSubagentTab(id, label); }} onOpenSide={(id, label) => { setEnvironmentOpen(false); openSideTab(id, label); }} />}</AnimatePresence>
          </>
        ) : view === "search" ? (
          <SearchView query={search} onQuery={setSearch} threads={visibleSearchResults} loading={searchBusy} onOpen={resumeThread} />
        ) : view === "archive" ? (
          <ArchivedThreadsView threads={archivedThreads} loading={archivedBusy} onBack={() => openView("thread")} onOpen={(summary) => void resumeThread(summary)} onRestore={(summary) => void unarchiveThread(summary)} relativeTime={relativeTime} />
        ) : view === "settings" ? (
          <SettingsView active={settingsSection} appInfo={appInfo} onSelect={(section) => { if (section === "보관된 채팅") void showAllArchivedThreads(); else setSettingsSection(section); }} onBack={goBack} providerSettings={providers.settings} providerState={providers.state} onProviderSelect={(input) => providers.select(input)} onProviderSaveKey={(input) => providers.saveKey(input)} onProviderClearKey={(provider, accountId) => providers.clearKey(provider, accountId)} onProviderRefreshModels={(provider, accountId) => providers.refreshModels(provider, accountId)} />
        ) : view === "sites" ? (
          <SitesView servers={availableMcpServers} threadId={thread?.id ?? null} knownSites={siteCardsFromResult(items.filter((item) => item.kind === "agent").map((item) => item.text))} onLoadKnown={window.devilCodex.listKnownSites} onCall={(input) => window.devilCodex.callMcpTool(input)} onOpen={(url) => openBrowserTab("right", url)} onCreate={() => { setView("thread"); setComposerInject({ text: "Sites를 사용해 새 웹사이트를 만들고 비공개로 배포해줘. 필요한 초기화, 빌드, 저장, 배포 상태 확인까지 진행해줘.", nonce: Date.now() }); }} />
        ) : view === "plugins" ? (
          <IntegrationsView skills={availableSkills} threadId={thread?.id ?? null} cwd={workspace} />
        ) : (
          <FeatureView view="automations" onAutomationPrompt={startAutomationChat} />
        )}
        </div>

        <UtilityPanel open={utilityPanelOpen} tabs={utilityTabs} active={utilityActive} workspace={workspace} fileTarget={fileTarget} filesLocked={filesLocked} projectName={projectName} changes={changes} selectedDiff={selectedDiff} diffBusy={diffBusy} subagentLabels={subagentNames} subagentList={sideChatList} browserSessionKey={sideChatKey} terminalSessionKey={`${sideChatKey}:right-terminal`} subagentCtx={{ runtime: sideConversationRuntime, model: sideConversationModel, provider: sideConversationProvider, accountId: sideConversationAccountId, cwd: workspace, providers: sideConversationProviders, ...sideConversationPermissions }} subagentHistory={subagentHistory} subagentBusy={subagentBusy} expanded={utilityPanelExpanded} onBrowserAsk={askAboutPage} onTerminalAsk={askAboutTerminal} onTerminalOpenPath={openWorkspaceFile} subagentPick={subagentPick} onToggleExpanded={() => setUtilityPanelExpanded((value) => !value)} onSubagentPick={(id, pick) => setSubagentPick((prev) => ({ ...prev, [id]: pick }))} onSubagentHistory={(id, items) => setSubagentHistory((prev) => ({ ...prev, [id]: items }))} onOpenSubagent={openSubagentTab} onNewSideChat={() => void newSideChat()} sideChatCreating={sideChatCreatingDock === "right"} onSelect={openUtility} onAdd={(tool) => { if (tool === "side-chat") void newSideChat(); else if (tool === "browser") openBrowserTab("right"); else if (tool === "terminal") openTerminalTab("right"); else openUtility(tool); }} onCloseTab={(tab) => { if (tab.startsWith("sidechat:")) closeSideChat(tab.slice("sidechat:".length)); else closeUtilityTab(tab); }} onSelectDiff={(file) => void selectDiff(file)} onSendReviewComment={sendInlineReviewComment} onApplyHunk={applyReviewHunk} onClose={() => { setUtilityPanelExpanded(false); setUtilityPanelOpen(false); }} onResize={(event) => startSideResize(event, "right")} />
        </div>

        <BottomDock open={terminalOpen} tabs={bottomTabs} active={bottomActive} workspace={workspace} fileTarget={fileTarget} filesLocked={filesLocked} projectName={projectName} changes={changes} selectedDiff={selectedDiff} diffBusy={diffBusy} subagentLabels={subagentNames} browserSessionKey={sideChatKey} terminalSessionKey={`${sideChatKey}:bottom-terminal`} subagentCtx={{ runtime: sideConversationRuntime, model: sideConversationModel, provider: sideConversationProvider, accountId: sideConversationAccountId, cwd: workspace, providers: sideConversationProviders, ...sideConversationPermissions }} subagentHistory={subagentHistory} subagentBusy={subagentBusy} subagentPick={subagentPick} onTerminalAsk={askAboutTerminal} onTerminalOpenPath={openWorkspaceFile} onSubagentPick={(id, pick) => setSubagentPick((prev) => ({ ...prev, [id]: pick }))} onSubagentHistory={(id, items) => setSubagentHistory((prev) => ({ ...prev, [id]: items }))} onNewSideChat={() => void newSideChat("bottom")} sideChatCreating={sideChatCreatingDock === "bottom"} onSelect={openBottomTool} onAdd={(tool) => { if (tool === "side-chat") void newSideChat("bottom"); else if (tool === "browser") openBrowserTab("bottom"); else if (tool === "terminal") openTerminalTab("bottom"); else openBottomTool(tool); }} onCloseTab={(tab) => { if (tab.startsWith("sidechat:")) closeSideChat(tab.slice("sidechat:".length)); else closeBottomTab(tab); }} onSelectDiff={(file) => void selectDiff(file)} onSendReviewComment={sendInlineReviewComment} onApplyHunk={applyReviewHunk} onClose={() => setTerminalOpen(false)} onResize={startTerminalResize} />
      </section>
      {gitDialogOpen && <GitWorkflowDialog cwd={workspace} changes={changes} onClose={() => setGitDialogOpen(false)} onRefresh={() => refreshChanges()} onError={setExternalError} />}
      {worktreeDialogCwd && <WorktreeDialog cwd={worktreeDialogCwd} onClose={() => setWorktreeDialogCwd(null)} onOpen={(path) => void openWorktree(path)} onError={setExternalError} />}
      {projectCreateOpen && <ProjectCreateDialog onClose={() => setProjectCreateOpen(false)} onExisting={() => void openExistingProject()} onCreate={(name) => void createLocalProject(name)} />}
      {renameThreadTarget && <RenameThreadDialog value={renameThreadDraft} busy={renameThreadBusy} onValue={setRenameThreadDraft} onSubmit={() => void submitRenameThread()} onClose={() => { if (!renameThreadBusy) setRenameThreadTarget(null); }} />}
      {textPrompt && <TextPromptDialog state={textPrompt} onClose={() => setTextPrompt(null)} />}
      {approvalQueue[0] && <ApprovalRequestDialog prompt={approvalQueue[0]} responding={approvalResponding} onDecision={(decision) => void respondToApproval(decision)} />}
      {commandPaletteOpen && <CommandPalette recentThreads={commandPaletteThreads} activeThreadId={thread?.id ?? null} hasActiveThread={Boolean(activeSummary)} chatCreationDisabled={bridgeChatLocked} onClose={() => setCommandPaletteOpen(false)} onOpenThread={(summary) => { setCommandPaletteOpen(false); void resumeThread(summary); }} onRun={runPaletteCommand} />}
      <AskUserModal />
      {petVisible && <button type="button" className="desktop-pet" onClick={togglePet} title="펫 숨기기"><Bot size={18} /><span>Devil</span><small>{activeThreadBusy ? "작업 중" : "대기 중"}</small></button>}
    </main>
  );
}

type ProjectGroupData = { cwd: string; name: string; threads: ThreadSummary[] };

function MacCollapsedNav({
  canGoBack,
  canGoForward,
  onSidebar,
  onBack,
  onForward,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
}): React.JSX.Element {
  return (
    <div className="mac-collapsed-nav" aria-label="macOS 접힌 사이드바 탐색">
      <button type="button" onClick={onSidebar} aria-label="사이드바 열기" title="사이드바 열기"><PanelLeftOpen size={16} /></button>
      <button type="button" onClick={onBack} disabled={!canGoBack} aria-label="뒤로" title="뒤로"><ArrowLeft size={16} /></button>
      <button type="button" onClick={onForward} disabled={!canGoForward} aria-label="앞으로" title="앞으로"><ArrowRight size={16} /></button>
    </div>
  );
}

function WindowsTitlebar({
  sidebarCollapsed,
  menuOpen,
  canGoBack,
  canGoForward,
  onSidebar,
  onBack,
  onForward,
  onMenu,
  chatCreationDisabled,
  onNewChat,
  onQuickChat,
  onOpenFolder,
  onSettings,
  onLogOut,
  onCommandPalette,
  onFind,
  onWindowAction,
}: {
  sidebarCollapsed: boolean;
  menuOpen: ShellMenuKey | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
  onMenu: (menu: ShellMenuKey) => void;
  chatCreationDisabled: boolean;
  onNewChat: () => void;
  onQuickChat: () => void;
  onOpenFolder: () => void;
  onSettings: () => void;
  onLogOut: () => void;
  onCommandPalette: () => void;
  onFind: () => void;
  onWindowAction: (action: WindowControlAction) => void;
}): React.JSX.Element {
  return (
    <div className="windows-titlebar">
      <div className="windows-titlebar-left">
        {/* The sidebar toggle must persist when collapsed — it's the only way back. */}
        <button className="windows-titlebar-icon" onClick={onSidebar} aria-label={sidebarCollapsed ? "사이드바 열기" : "사이드바 닫기"} title={sidebarCollapsed ? "사이드바 열기" : "사이드바 닫기"}>{sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</button>
        {!sidebarCollapsed && (
          <>
            <button className="windows-titlebar-icon" onClick={onBack} disabled={!canGoBack} aria-label="뒤로" title="뒤로"><ArrowLeft size={16} /></button>
            <button className="windows-titlebar-icon" onClick={onForward} disabled={!canGoForward} aria-label="앞으로" title="앞으로"><ArrowRight size={16} /></button>
          </>
        )}
        <div className="windows-menu-group">
          <button className={menuOpen === "file" ? "active" : ""} onClick={() => onMenu("file")}>파일</button>
          <button className={menuOpen === "edit" ? "active" : ""} onClick={() => onMenu("edit")}>편집</button>
          <button className={menuOpen === "view" ? "active" : ""} onClick={() => onMenu("view")}>보기</button>
          <button className={menuOpen === "help" ? "active" : ""} onClick={() => onMenu("help")}>도움말</button>
          <AnimatePresence>
            {menuOpen && (
              <motion.div className="windows-app-menu" initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={{ duration: .11 }}>
                {menuOpen === "file" && (
                  <>
                    <button type="button" onClick={onNewChat} disabled={chatCreationDisabled}><span>New Window</span><kbd>Ctrl+Shift+N</kbd></button>
                    <button type="button" onClick={onNewChat} disabled={chatCreationDisabled}><span>New Chat</span><kbd>Ctrl+N</kbd></button>
                    <button type="button" onClick={onQuickChat} disabled={chatCreationDisabled}><span>Quick Chat</span><kbd>Alt+Ctrl+N</kbd></button>
                    <button type="button" onClick={onOpenFolder}><span>Open Folder...</span><kbd>Ctrl+O</kbd></button>
                    <button type="button" onClick={() => onWindowAction("close")}><span>Close</span><kbd>Ctrl+W</kbd></button>
                    <div className="windows-app-menu-divider" />
                    <button type="button" onClick={onSettings}><span>Settings...</span><kbd>Ctrl+,</kbd></button>
                    <div className="windows-app-menu-divider" />
                    <button type="button" onClick={onLogOut}><span>Log Out</span></button>
                    <button type="button" onClick={() => onWindowAction("quit")}><span>Exit</span><kbd>Ctrl+Q</kbd></button>
                  </>
                )}
                {menuOpen === "edit" && (
                  <>
                    <button type="button" onClick={() => document.execCommand("undo")}><span>Undo</span><kbd>Ctrl+Z</kbd></button>
                    <button type="button" onClick={() => document.execCommand("redo")}><span>Redo</span><kbd>Ctrl+Y</kbd></button>
                    <div className="windows-app-menu-divider" />
                    <button type="button" onClick={() => document.execCommand("cut")}><span>Cut</span><kbd>Ctrl+X</kbd></button>
                    <button type="button" onClick={() => document.execCommand("copy")}><span>Copy</span><kbd>Ctrl+C</kbd></button>
                    <button type="button" onClick={() => document.execCommand("paste")}><span>Paste</span><kbd>Ctrl+V</kbd></button>
                    <button type="button" onClick={() => document.execCommand("selectAll")}><span>Select All</span><kbd>Ctrl+A</kbd></button>
                  </>
                )}
                {menuOpen === "view" && (
                  <>
                    <button type="button" onClick={onSidebar}><span>{sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar"}</span></button>
                    <div className="windows-app-menu-divider" />
                    <button type="button" onClick={onCommandPalette}><span>Command Palette</span><kbd>Ctrl+K</kbd></button>
                    <button type="button" onClick={onFind}><span>Find in Thread</span><kbd>Ctrl+F</kbd></button>
                    <div className="windows-app-menu-divider" />
                    <button type="button" onClick={() => location.reload()}><span>Reload</span><kbd>Ctrl+R</kbd></button>
                  </>
                )}
                {menuOpen === "help" && (
                  <>
                    <button type="button" onClick={() => window.open("https://help.openai.com/", "_blank", "noopener,noreferrer")}><span>OpenAI Help</span></button>
                    <button type="button" onClick={() => window.open("https://github.com/openai/codex", "_blank", "noopener,noreferrer")}><span>Codex GitHub</span></button>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <WindowControls onAction={onWindowAction} />
    </div>
  );
}

// Windows-style window controls: icon buttons at the top-right, like stock Codex
// on Windows (macOS keeps its native traffic lights, so this isn't rendered there).
function WindowControls({ onAction }: { onAction: (action: WindowControlAction) => void }): React.JSX.Element {
  return (
    <div className="win-controls" aria-label="창 제어">
      <button onClick={() => onAction("minimize")} aria-label="최소화" title="최소화"><Minus size={16} /></button>
      <button onClick={() => onAction("maximize")} aria-label="최대화" title="최대화"><Square size={13} /></button>
      <button className="win-close" onClick={() => onAction("close")} aria-label="닫기" title="닫기"><X size={17} /></button>
    </div>
  );
}

function ProjectCreateDialog({ onClose, onExisting, onCreate }: { onClose: () => void; onExisting: () => void; onCreate: (name: string) => void }): React.JSX.Element {
  const [name, setName] = useState("새 프로젝트");
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <motion.form className="project-create-dialog" initial={{ opacity: 0, scale: .97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: 6 }} transition={{ duration: .16, ease: [.4, 0, .2, 1] }} onSubmit={(event) => { event.preventDefault(); onCreate(name); }}>
        <header>
          <h2>프로젝트 만들기</h2>
          <button type="button" onClick={onClose} aria-label="닫기"><X size={24} /></button>
        </header>
        <label className="project-name-field">
          <span>이름</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <section>
          <h3>프로젝트 유형</h3>
          <button type="button" className="project-type-card active">
            <Laptop size={27} />
            <span>
              <strong>로컬</strong>
              <small>컴퓨터에서 파일을 편집, 실행, 테스트합니다</small>
            </span>
            <i aria-hidden="true" />
          </button>
        </section>
        <footer>
          <button type="button" className="secondary" onClick={onExisting}>기존 폴더 사용</button>
          <button type="submit" className="primary" disabled={!name.trim()}>생성</button>
        </footer>
      </motion.form>
    </div>,
    document.body,
  );
}

function RenameThreadDialog({ value, busy, onValue, onSubmit, onClose }: { value: string; busy: boolean; onValue: (value: string) => void; onSubmit: () => void; onClose: () => void }): React.JSX.Element {
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <motion.form className="rename-thread-dialog" initial={{ opacity: 0, scale: .97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: 6 }} transition={{ duration: .16, ease: [.4, 0, .2, 1] }} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <header>
          <h2>채팅 이름 바꾸기</h2>
          <button type="button" onClick={onClose} aria-label="닫기" disabled={busy}><X size={20} /></button>
        </header>
        <label>
          <span>이름</span>
          <input autoFocus value={value} onChange={(event) => onValue(event.target.value)} disabled={busy} />
        </label>
        <footer>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>취소</button>
          <button type="submit" className="primary" disabled={busy || !value.trim()}>변경</button>
        </footer>
      </motion.form>
    </div>,
    document.body,
  );
}

function TextPromptDialog({ state, onClose }: { state: TextPromptState; onClose: () => void }): React.JSX.Element {
  const [value, setValue] = useState(state.initialValue);
  const finish = (next: string | null): void => {
    state.resolve(next);
    onClose();
  };
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(null); }}>
      <motion.form className="text-prompt-dialog" initial={{ opacity: 0, scale: .97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: 6 }} transition={{ duration: .16, ease: [.4, 0, .2, 1] }} onSubmit={(event) => { event.preventDefault(); finish(value); }}>
        <header>
          <h2>{state.title}</h2>
          <button type="button" onClick={() => finish(null)} aria-label="닫기"><X size={20} /></button>
        </header>
        <label>
          <span>{state.label}</span>
          <input autoFocus value={value} placeholder={state.placeholder} onChange={(event) => setValue(event.target.value)} />
        </label>
        <footer>
          <button type="button" className="secondary" onClick={() => finish(null)}>취소</button>
          <button type="submit" className="primary">{state.confirmLabel}</button>
        </footer>
      </motion.form>
    </div>,
    document.body,
  );
}

function ProjectAddIcon(): React.JSX.Element {
  return <NotebookText size={17} className="project-add-glyph" aria-hidden="true" />;
}

function ProjectNotebookIcon({ open }: { open: boolean }): React.JSX.Element {
  return <NotebookText size={18} className={open ? "project-notebook open" : "project-notebook"} aria-hidden="true" />;
}

function ProjectHeaderMenu({ anchor, open, submenu, sortMode, layoutMode, onSubmenu, onSort, onLayout }: {
  anchor: { current: HTMLButtonElement | null };
  open: boolean;
  submenu: "sort" | "cleanup" | null;
  sortMode: ProjectSortMode;
  layoutMode: SidebarLayoutMode;
  onSubmenu: (next: "sort" | "cleanup" | null) => void;
  onSort: (next: ProjectSortMode) => void;
  onLayout: (next: SidebarLayoutMode) => void;
}): React.JSX.Element | null {
  const [pos, setPos] = useState({ mainLeft: 0, mainTop: 0, submenuLeft: 0, submenuTop: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const mainWidth = 228;
    const mainHeight = 142;
    const submenuWidth = 236;
    const submenuHeight = submenu === "cleanup" ? 204 : 154;
    const mainLeft = Math.min(Math.max(8, rect.right - mainWidth), window.innerWidth - mainWidth - 8);
    const mainTop = rect.bottom + 6 + mainHeight > window.innerHeight ? Math.max(8, rect.top - mainHeight - 6) : rect.bottom + 6;
    const rightSideLeft = mainLeft + mainWidth + 8;
    const submenuLeft = rightSideLeft + submenuWidth <= window.innerWidth - 8 ? rightSideLeft : Math.max(8, mainLeft - submenuWidth - 8);
    const submenuOffset = submenu === "cleanup" ? 42 : 78;
    const submenuTop = Math.min(Math.max(8, mainTop + submenuOffset), window.innerHeight - submenuHeight - 8);
    setPos({ mainLeft, mainTop, submenuLeft, submenuTop });
  }, [anchor, open, submenu]);

  if (!open) return null;
  const sortOptions: Array<{ value: ProjectSortMode; label: string; icon: React.JSX.Element }> = [
    { value: "manual", label: "수동 정렬", icon: <MoreHorizontal /> },
    { value: "created", label: "생성됨", icon: <CirclePlus /> },
    { value: "updated", label: "최근 업데이트순", icon: <Clock /> },
  ];
  const layoutOptions: Array<{ value: SidebarLayoutMode; label: string; icon: React.JSX.Element }> = [
    { value: "project", label: "프로젝트별", icon: <ProjectNotebookIcon open={false} /> },
    { value: "recent", label: "최근 프로젝트", icon: <ProjectNotebookIcon open={false} /> },
    { value: "timeline", label: "시간순 목록", icon: <Clock /> },
    { value: "projectsDown", label: "아래로 이동", icon: <ArrowDown /> },
  ];

  return createPortal(
    <>
      <motion.div className="project-menu project-header-menu" data-shell-popover-root style={{ position: "fixed", left: pos.mainLeft, top: pos.mainTop }} initial={{ opacity: 0, scale: .97, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: -3 }} transition={{ duration: .13 }}>
        <button type="button" className={submenu === "cleanup" ? "active" : ""} onClick={() => onSubmenu(submenu === "cleanup" ? null : "cleanup")}><ProjectNotebookIcon open={false} />사이드바 정리<ChevronRight className="chev" /></button>
        <button type="button" className={submenu === "sort" ? "active" : ""} onClick={() => onSubmenu(submenu === "sort" ? null : "sort")}><Clock />정렬 기준<ChevronRight className="chev" /></button>
      </motion.div>
      <AnimatePresence>
        {submenu && (
          <motion.div className="project-menu project-header-menu project-submenu" data-shell-popover-root style={{ position: "fixed", left: pos.submenuLeft, top: pos.submenuTop }} initial={{ opacity: 0, scale: .97, x: -4 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0, scale: .98, x: -3 }} transition={{ duration: .13 }}>
            {submenu === "sort" && sortOptions.map((option) => (
              <button type="button" key={option.value} onClick={() => onSort(option.value)}>{option.icon}{option.label}{sortMode === option.value && <Check className="check" />}</button>
            ))}
            {submenu === "cleanup" && layoutOptions.map((option) => (
              <button type="button" key={option.value} onClick={() => onLayout(option.value)}>{option.icon}{option.label}{layoutMode === option.value && <Check className="check" />}</button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body,
  );
}

function SidebarLoadingRows(): React.JSX.Element {
  return <div className="sidebar-loading-list" aria-label="목록 불러오는 중">
    {Array.from({ length: 4 }, (_, index) => <span key={index}><i /><b /></span>)}
  </div>;
}

function ThreadContextMenu({ state, pinned, onToggleMarker, onRename, onHide }: {
  state: { summary: ThreadSummary; left: number; top: number } | null;
  pinned: boolean;
  onToggleMarker: (summary: ThreadSummary) => void;
  onRename: (summary: ThreadSummary) => void;
  onHide: (summary: ThreadSummary) => void;
}): React.JSX.Element | null {
  if (!state) return null;
  const width = 206;
  const height = 132;
  const left = Math.min(Math.max(8, state.left), window.innerWidth - width - 8);
  const top = Math.min(Math.max(8, state.top), window.innerHeight - height - 8);
  return createPortal(
    <AnimatePresence>
      <motion.div className="project-menu thread-context-menu" data-shell-popover-root style={{ position: "fixed", left, top }} initial={{ opacity: 0, scale: .97, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: -3 }} transition={{ duration: .13 }}>
        <button type="button" onClick={() => onToggleMarker(state.summary)}>{pinned ? <PinOff /> : <Pin />}{pinned ? "마커 제거" : "마커 추가"}</button>
        <button type="button" onClick={() => onRename(state.summary)}><Pencil />채팅 이름 바꾸기</button>
        <button type="button" className="danger" onClick={() => onHide(state.summary)}><Trash2 />쓰레드 삭제</button>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

function ProjectGroup({ group, expanded, menuOpen, pinned, activeThreadId, runningThreadIds, pinnedThreadIds, chatCreationDisabled, onToggle, onMenu, onNewThread, onOpen, onPrefetch, onThreadContextMenu, onPin, onRename, onFinder, onRemove }: {
  group: ProjectGroupData;
  expanded: boolean;
  menuOpen: boolean;
  pinned: boolean;
  activeThreadId: string | null;
  runningThreadIds: Set<string>;
  pinnedThreadIds: string[];
  chatCreationDisabled: boolean;
  onToggle: () => void;
  onMenu: () => void;
  onNewThread: () => void;
  onOpen: (summary: ThreadSummary) => void;
  onPrefetch: (summary: ThreadSummary) => void;
  onThreadContextMenu: (event: ReactMouseEvent, summary: ThreadSummary) => void;
  onPin: () => void;
  onRename: () => void;
  onFinder: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const THREAD_PAGE_SIZE = 5;
  const [visibleCount, setVisibleCount] = useState(THREAD_PAGE_SIZE);
  const shownThreads = group.threads.slice(0, visibleCount);
  const remainingThreads = Math.max(0, group.threads.length - visibleCount);
  useEffect(() => {
    if (!expanded) setVisibleCount(THREAD_PAGE_SIZE);
  }, [expanded]);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 236;
    const height = 268;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const top = rect.bottom + 6 + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
    setPos({ left, top });
  }, [menuOpen]);

  return (
    <div className="project-group" data-shell-popover-root>
      <div className={menuOpen ? "project-row menu-open" : "project-row"}>
        <button className="project-toggle" onClick={onToggle} title={group.cwd}><ProjectNotebookIcon open={expanded} /><strong>{group.name}</strong><ChevronRight className="project-caret" size={14} style={{ transform: expanded ? "rotate(90deg)" : "none" }} /></button>
        <button ref={anchor} className="project-action" onClick={onMenu} aria-label="프로젝트 메뉴"><MoreHorizontal size={17} /></button>
        <button className="project-action" onClick={onNewThread} disabled={chatCreationDisabled} aria-label={`${group.name}에서 새 채팅`} title={chatCreationDisabled ? "순정 Codex Bridge 사용 중에는 새 채팅을 시작할 수 없습니다" : `${group.name}에서 새 채팅`}><SquarePen size={16} /></button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div className="thread-list-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .2, ease: [.4, 0, .2, 1] }} style={{ overflow: "hidden" }}>
            <div className="thread-list">
              {group.threads.length === 0 ? <div className="thread-empty">스레드 없음</div> : shownThreads.map((summary) => (
                <div className={`${activeThreadId === summary.id ? "thread-row active" : "thread-row"}${runningThreadIds.has(summary.id) ? " running" : ""}`} key={summary.id} onContextMenu={(event) => onThreadContextMenu(event, summary)}>
                  <button className="thread-open" onMouseEnter={() => onPrefetch(summary)} onFocus={() => onPrefetch(summary)} onClick={() => onOpen(summary)} title={summary.preview}>{pinnedThreadIds.includes(summary.id) && <Pin size={11} />} {summary.title}</button>
                  {runningThreadIds.has(summary.id) ? <span className="thread-running" title="응답 생성 중" /> : <time>{relativeTime(summary.updatedAt)}</time>}
                </div>
              ))}
              {remainingThreads > 0 && <button className="thread-more-link" onClick={() => setVisibleCount((count) => Math.min(group.threads.length, count + THREAD_PAGE_SIZE))}>더 보기 <small>{Math.min(THREAD_PAGE_SIZE, remainingThreads)}개 더 보기</small></button>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {createPortal(
        <AnimatePresence>
          {menuOpen && (
            <motion.div className="project-menu" data-shell-popover-root style={{ position: "fixed", left: pos.left, top: pos.top }} initial={{ opacity: 0, scale: .97, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: -3 }} transition={{ duration: .13 }}>
              <button onClick={onPin}>{pinned ? <PinOff /> : <Pin />}{pinned ? "프로젝트 고정 해제" : "프로젝트 고정"}</button>
              <button onClick={onRename}><Pencil />이름 변경</button>
              <button onClick={onFinder}><FolderOpen />Finder에서 보기</button>
              <div className="menu-divider" />
              <button className="danger" onClick={onRemove}><Trash2 />제거하기</button>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

function collectEnvironmentSources(items: ThreadHistoryItem[]): EnvironmentSource[] {
  const urls = new Map<string, EnvironmentSource>();
  const recentItems: ThreadHistoryItem[] = [];
  const seenTurns = new Set<string>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const turnKey = item.turnId || item.id;
    if (!seenTurns.has(turnKey)) {
      if (seenTurns.size >= ENVIRONMENT_SOURCE_TURN_LIMIT) break;
      seenTurns.add(turnKey);
    }
    recentItems.push(item);
  }
  const addUrl = (raw: string): void => {
    if (urls.size >= ENVIRONMENT_SOURCE_LIMIT) return;
    const cleaned = raw.replace(/[),.;\]]+$/g, "");
    if (!/^https?:\/\//i.test(cleaned) || cleaned.startsWith("data:")) return;
    try {
      const parsed = new URL(cleaned);
      const label = parsed.hostname.replace(/^www\./, "");
      if (!urls.has(parsed.href)) urls.set(parsed.href, { url: parsed.href, label });
    } catch {
      // Ignore malformed source candidates from model text.
    }
  };
  const scan = (text?: string): void => {
    if (!text) return;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) addUrl(match[0]);
  };
  for (const item of recentItems) {
    scan(item.text);
    scan(item.title);
    for (const attachment of item.attachments ?? []) if (attachment.url) addUrl(attachment.url);
    for (const activity of item.activities ?? []) {
      scan(activity.title);
      scan(activity.detail);
      scan(activity.output);
      for (const image of activity.images ?? []) addUrl(image);
    }
  }
  return [...urls.values()];
}

function AccountUsageInline({ entries, state, preferredProvider, onDetails }: { entries: ProviderUsageEntry[]; state: string; preferredProvider?: ProviderId; onDetails: () => void }): React.JSX.Element {
  const preferredEntry = preferredProvider ? entries.find((item) => item.provider === preferredProvider && item.windows.length > 0) ?? entries.find((item) => item.provider === preferredProvider) : undefined;
  const entry = preferredEntry ?? entries.find((item) => item.windows.length > 0) ?? entries[0];
  const message = state === "loading" || state === "idle"
    ? "사용량을 불러오는 중..."
    : !entry
      ? "표시할 사용량이 없습니다."
      : entry.error
        ? `오류: ${entry.error}`
        : entry.unavailable ?? "";
  return <motion.div className="account-usage-panel" initial={{ opacity: 0, height: 0, y: -4 }} animate={{ opacity: 1, height: "auto", y: 0 }} exit={{ opacity: 0, height: 0, y: -4 }} transition={{ duration: .16 }}>
    {entry?.windows.length ? <>
      {entry.label !== "Codex" && <small className="account-usage-provider">{[entry.label, entry.accountEmail || entry.accountLabel].filter(Boolean).join(" · ")}</small>}
      {entry.windows.slice(0, 3).map((window) => <div className="account-usage-row" key={`${entry.provider}-${window.label}`}>
        <strong>{window.label}</strong>
        <span>{Math.round(window.usedPercent)}% 사용</span>
        <time>{compactUsageReset(window.resetsAt)}</time>
      </div>)}
    </> : <p>{message}</p>}
    <button type="button" className="account-usage-details" onClick={onDetails}>자세히 보기</button>
  </motion.div>;
}

function EnvironmentCard({ cwd, changes, sources, usage, usageState, subagents, sideChats, onRefresh, onReview, onGit, onCodexWeb, onUsage, onOpenSource, onError, onOpenSubagent, onOpenSide }: {
  cwd: string;
  changes: WorkspaceChanges;
  sources: EnvironmentSource[];
  usage: ThreadUsageSummary;
  usageState: "idle" | "loading" | "ready" | "error";
  subagents: Array<{ id: string; label: string }>;
  sideChats: Array<{ id: string; label: string }>;
  onRefresh: () => Promise<WorkspaceChanges>;
  onReview: () => void;
  onGit: () => void;
  onCodexWeb: () => void;
  onUsage: () => void;
  onOpenSource: (url: string) => void;
  onError: (message: string) => void;
  onOpenSubagent: (id: string, label: string) => void;
  onOpenSide: (id: string, label: string) => void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<"local" | "branch" | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [branchBusy, setBranchBusy] = useState(false);
  const gitAvailable = Boolean(cwd && changes.available && basenamePath(cwd) !== "new-chat");
  const [usageExpanded, setUsageExpanded] = useState(false);
  const hiddenUsageModels = Math.max(0, usage.models.length - ENVIRONMENT_USAGE_MODEL_PREVIEW_LIMIT);
  const visibleUsageModels = usageExpanded ? usage.models : usage.models.slice(0, ENVIRONMENT_USAGE_MODEL_PREVIEW_LIMIT);
  const usageHasClaudeCode = usage.models.some((row) => row.provider === "claude-code");
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  useEffect(() => {
    if (menu !== "branch" || !gitAvailable) return;
    void window.devilCodex.listGitBranches({ cwd }).then(setBranches).catch((error) => onError(`브랜치 목록 실패: ${String(error)}`));
  }, [cwd, gitAvailable, menu, onError]);

  const switchBranch = async (branch: string, create = false): Promise<void> => {
    if (!gitAvailable || !branch.trim()) return;
    setBranchBusy(true);
    try {
      await window.devilCodex.switchGitBranch({ cwd, branch: branch.trim(), create });
      setNewBranch("");
      setBranches(await window.devilCodex.listGitBranches({ cwd }));
      await onRefresh();
    } catch (error) {
      onError(`브랜치 ${create ? "생성" : "체크아웃"} 실패: ${String(error)}`);
    } finally {
      setBranchBusy(false);
    }
  };

  return <motion.aside ref={rootRef} className="environment-card" initial={{ opacity: 0, scale: .97, y: -6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .98, y: -4 }} transition={{ duration: .17 }}>
    <header><span>환경</span><button onClick={onRefresh}><Plus size={18} /></button></header>
    {gitAvailable && <button className="environment-row" onClick={onReview}><span><FileText />변경 사항</span><strong><i>+{changes.additions.toLocaleString()}</i> <b>-{changes.deletions.toLocaleString()}</b></strong></button>}
    <div className="environment-popover-wrap">
      <button className="environment-row" onClick={() => setMenu((value) => value === "local" ? null : "local")}><span><Laptop />로컬</span><ChevronRight className={menu === "local" ? "open" : ""} /></button>
      {menu === "local" && <div className="environment-side-menu local" data-shell-popover-root>
        <p>다음으로 계속</p>
        <button className="selected"><Laptop />로컬로 작업<Check /></button>
        <button onClick={onCodexWeb}><CloudCog />Codex 웹 연결<ExternalLink /></button>
        <button className="disabled" disabled><CloudOff />클라우드에 보내기</button>
        <div className="menu-divider" />
        <button onClick={onUsage}><Target />사용량<ChevronRight /></button>
      </div>}
    </div>
    {gitAvailable && <div className="environment-popover-wrap">
      <button className="environment-row" onClick={() => setMenu((value) => value === "branch" ? null : "branch")}><span><GitBranch />{changes.branch || "branch"}</span><ChevronRight className={menu === "branch" ? "open" : ""} /></button>
      {menu === "branch" && <div className="environment-side-menu branch" data-shell-popover-root>
        <p>브랜치</p>
        <div className="environment-branch-create">
          <input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newBranch.trim()) void switchBranch(newBranch, true); }} placeholder="새 브랜치 이름" disabled={branchBusy} />
          <button type="button" onClick={() => void switchBranch(newBranch, true)} disabled={branchBusy || !newBranch.trim()}><Plus size={13} />생성</button>
        </div>
        <div className="environment-branch-list">
          {branches.map((branch) => <button type="button" key={branch.name} className={branch.current ? "selected" : ""} onClick={() => void switchBranch(branch.name)} disabled={branchBusy || branch.current}><GitBranch />{branch.name}{branch.remote && <small>원격</small>}{branch.current && <Check />}</button>)}
        </div>
      </div>}
    </div>}
    {gitAvailable && <button className="environment-row" onClick={onGit}><span><UploadCloud />커밋 또는 푸시</span></button>}
    {(usage.requests > 0 || usageState !== "idle") && <>
      <div className="environment-divider" />
      <div className="environment-caption">사용량</div>
      <div className="environment-usage-card">
        <div className="environment-usage-head">
          <span><Target />현재 스레드</span>
          <strong>{usage.requests > 0 ? `${usage.requests}회 요청` : usageState === "error" ? "불러오기 실패" : "불러오는 중"}</strong>
        </div>
        {usage.contextTokens && usage.maxTokens && usage.contextLimitTokens && <>
          <div className={usage.contextOverflow ? "environment-usage-context overflow" : "environment-usage-context"}>
            <span>{contextUsageTitle(usage.contextUsage)}</span>
            <b>{compactTokenCount(usage.contextTokens)} / {compactTokenCount(usage.contextLimitTokens)}</b>
          </div>
          {usage.contextUsage?.autoCompactEnabled && usage.contextUsage.autoCompactThreshold && usage.contextUsage.maxTokens !== usage.contextUsage.autoCompactThreshold && (
            <div className="environment-usage-context">
              <span>최대 컨텍스트 창</span>
              <b>{compactTokenCount(usage.contextUsage.maxTokens)}</b>
            </div>
          )}
          <div className={usage.contextOverflow ? "environment-usage-context overflow" : "environment-usage-context"}>
            <span>컨텍스트 상태</span>
            <b>{contextUsageStatus(usage.contextUsage, usage.contextOverflow, usageHasClaudeCode)}</b>
          </div>
          <progress className={usage.contextOverflow ? "overflow" : ""} value={Math.min(usage.contextTokens, usage.contextLimitTokens)} max={usage.contextLimitTokens} />
        </>}
        {usage.requests > 0 ? <>
          <div className="environment-usage-summary">
            <span><small>실사용 토큰</small><strong>{compactTokenCount(usage.freshTokens)}</strong></span>
            <span><small>전체 처리량</small><strong>{compactTokenCount(usage.totalTokens)}</strong></span>
            <span><small>예상 비용</small><strong>{threadUsageCostLabel(usage.estimatedCost, usage.pricedTokens, usage.totalTokens)}</strong></span>
            <span><small>완료 / 실패</small><strong>{usage.completed} / {usage.failed}</strong></span>
          </div>
          {usage.cacheReadTokens > 0 && <div className="environment-usage-context">
            <span>캐시 재사용</span>
            <b>{compactTokenCount(usage.cacheReadTokens)} 포함</b>
          </div>}
          {usage.cacheMisses > 0 && <div className="environment-usage-context overflow">
            <span>캐시 미스</span>
            <b>{usage.cacheMisses}회 감지</b>
          </div>}
          <div className="environment-usage-models">
            {visibleUsageModels.map((row) => <div key={row.key} title={row.label}>
              <span><strong>{row.label}</strong><small>{threadUsageRowDetail(row)}</small></span>
              <b>{threadUsageCostLabel(row.estimatedCost, row.pricedTokens, row.totalTokens)}</b>
            </div>)}
            {hiddenUsageModels > 0 && <button type="button" className="environment-usage-more" onClick={() => setUsageExpanded((value) => !value)} aria-expanded={usageExpanded}>
              <span>{usageExpanded ? "접기" : "더보기"}</span>
              <small>{usageExpanded ? `상위 ${ENVIRONMENT_USAGE_MODEL_PREVIEW_LIMIT}개만 보기` : `${hiddenUsageModels}개 모델 더 보기`}</small>
            </button>}
          </div>
        </> : <p className="environment-usage-empty">{usageState === "error" ? "사용량 기록을 불러오지 못했습니다." : usageState === "loading" ? "이 스레드의 모델 사용량 기록을 불러오는 중입니다." : "이 스레드에서 기록된 모델 요청이 아직 없습니다."}</p>}
      </div>
    </>}
    {sideChats.length > 0 && <>
      <div className="environment-divider" />
      <div className="environment-caption">곁가지 대화</div>
      {sideChats.map((chat) => <button key={chat.id} className="environment-row subagent" onClick={() => onOpenSide(chat.id, chat.label)}><span><MessageSquarePlus />{chat.label}</span></button>)}
    </>}
    {subagents.length > 0 && <>
      <div className="environment-divider" />
      <div className="environment-caption">하위 에이전트</div>
      {subagents.map((agent) => <button key={agent.id} className="environment-row subagent" onClick={() => onOpenSubagent(agent.id, agent.label)}><span><Bot />{agent.label}</span></button>)}
    </>}
    <div className="environment-divider" />
    <div className="environment-caption">출처</div>
    {sources.length > 0 ? <div className="environment-sources">{sources.map((source) => <button type="button" key={source.url} title={source.url} onClick={() => onOpenSource(source.url)}><Globe2 />{source.label}</button>)}</div> : <button className="environment-row muted"><span><Blocks />연결된 출처 없음</span></button>}
  </motion.aside>;
}

function SearchView({ query, onQuery, threads, loading, onOpen }: { query: string; onQuery: (value: string) => void; threads: ThreadSummary[]; loading: boolean; onOpen: (thread: ThreadSummary) => Promise<void> }): React.JSX.Element {
  return <div className="page-view"><h1>검색</h1><div className="search-box"><Search size={17} /><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="스레드, 대화 내용 또는 브랜치 검색" /></div>{loading ? <div className="feature-empty">검색 중…</div> : query.trim() && threads.length === 0 ? <div className="feature-empty"><Search /><strong>검색 결과 없음</strong></div> : <div className="search-results">{threads.map((thread) => <button key={thread.id} onClick={() => void onOpen(thread)}><strong>{thread.title}</strong><span>{thread.preview}</span><small>{thread.cwd}</small></button>)}</div>}</div>;
}

function siteCardsFromResult(value: unknown): SiteCard[] {
  const found: SiteCard[] = [];
  const seen = new Set<string>();
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      // Connector results are commonly returned as MCP `content[].text` rather
      // than structured objects. Parse JSON when present, otherwise retain the
      // human-readable name/URL pairs that Sites returns.
      try { visit(JSON.parse(entry)); return; } catch { /* Plain connector text. */ }
      const lines = entry.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      lines.forEach((line, index) => {
        const url = line.match(/https?:\/\/[^\s)]+\.chatgpt\.site[^\s)]*/i)?.[0];
        if (!url || seen.has(url)) return;
        seen.add(url);
        const name = lines.slice(0, index).reverse().find((candidate) => !/^[-•*#]|^(상태|버전|접근|status|version|access)\s*[:：]/i.test(candidate)) ?? new URL(url).hostname.split(".")[0];
        found.push({ id: url, name: name.replace(/^[-•*#]\s*/, ""), url, access: /(?:나만|private|비공개)/i.test(entry) ? "나만" : "공유", updated: "" });
      });
      return;
    }
    if (Array.isArray(entry)) { entry.forEach(visit); return; }
    if (!entry || typeof entry !== "object") return;
    const row = entry as Record<string, unknown>;
    const url = [row.url, row.site_url, row.deployment_url, row.preview_url].find((item): item is string => typeof item === "string" && /^https?:\/\//.test(item));
    const id = String(row.project_id ?? row.site_id ?? row.id ?? url ?? "");
    if (url && id && !seen.has(id)) {
      seen.add(id);
      found.push({
        id,
        name: String(row.name ?? row.title ?? row.slug ?? "이름 없는 사이트"),
        url,
        access: String(row.access ?? row.visibility ?? row.access_level ?? "나만"),
        updated: String(row.updated_at ?? row.created_at ?? ""),
      });
    }
    Object.values(row).forEach((child) => { if (child && typeof child === "object") visit(child); });
  };
  visit(value);
  return found;
}

function SitesView({ servers, threadId, knownSites, onLoadKnown, onCall, onOpen, onCreate }: {
  servers: McpServerInfo[];
  threadId: string | null;
  knownSites: SiteCard[];
  onLoadKnown: () => Promise<Array<{ name: string; url: string; access?: string }>>;
  onCall: (input: { threadId: string; server: string; tool: string; arguments?: unknown }) => Promise<unknown>;
  onOpen: (url: string) => void;
  onCreate: () => void;
}): React.JSX.Element {
  const [sites, setSites] = useState<SiteCard[]>([]);
  const [historySites, setHistorySites] = useState<SiteCard[]>([]);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const server = servers.find((item) => item.name.toLowerCase() === "sites" || item.name.toLowerCase().includes("sites"));
  const canList = Boolean(threadId && server?.tools.some((tool) => tool.name === "list_sites"));
  useEffect(() => { void onLoadKnown().then((rows) => setHistorySites(rows.map((site) => ({ id: site.url, name: site.name, url: site.url, access: site.access ?? "나만", updated: "" })))).catch(() => undefined); }, [onLoadKnown]);
  const load = async (): Promise<void> => {
    if (!threadId || !server) { setState("error"); setError(threadId ? "현재 Codex app-server에서 Sites 도구를 찾지 못했습니다." : "Sites 목록을 불러오려면 먼저 채팅을 하나 열어 주세요."); return; }
    setState("loading"); setError("");
    try {
      const result = await onCall({ threadId, server: server.name, tool: "list_sites" });
      setSites(siteCardsFromResult(result)); setState("ready");
    } catch (cause) { setState("error"); setError(`Sites 목록을 불러오지 못했습니다: ${String(cause)}`); }
  };
  useEffect(() => { if (canList) void load(); }, [threadId, server?.name]);
  const catalog = [...sites, ...knownSites, ...historySites].filter((site, index, all) => all.findIndex((candidate) => candidate.url === site.url) === index);
  const visible = catalog.filter((site) => `${site.name} ${site.url}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="sites-page">
    <div className="sites-head"><div><h1>사이트</h1><p>아이디어를 실제 웹사이트로 만들고 관리하세요.</p></div><div><button className="sites-refresh" type="button" onClick={() => void load()} disabled={state === "loading"}><Loader2 className={state === "loading" ? "spin" : ""} size={16} />새로고침</button><button className="sites-create" type="button" onClick={onCreate}><Plus size={16} />만들기</button></div></div>
    <label className="sites-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사이트 검색" /></label>
    {state === "loading" ? <div className="sites-empty"><Loader2 className="spin" /><strong>사이트를 불러오는 중</strong></div>
      : state === "error" && visible.length === 0 ? <div className="sites-empty error"><Globe2 /><strong>Sites 연결을 확인할 수 없습니다</strong><small>{error}</small><button type="button" onClick={() => void load()}>다시 시도</button></div>
      : visible.length === 0 ? <div className="sites-empty"><Globe2 /><strong>{catalog.length ? "검색 결과가 없습니다" : "아직 만든 사이트가 없습니다"}</strong><small>만들기를 누르면 Sites 생성과 비공개 배포 작업을 채팅에서 시작합니다.</small></div>
      : <section className="sites-list"><div className="sites-list-label"><span>사이트</span><span>공유 대상</span></div>{visible.map((site) => <article className="site-row" key={site.id}><div className="site-thumb"><Globe2 size={22} /></div><div className="site-info"><strong>{site.name}</strong><small>{site.url.replace(/^https?:\/\//, "")}</small></div><div className="site-access"><span>▣</span>{site.access === "private" ? "나만" : site.access}</div><div className="site-actions"><button type="button" onClick={() => onOpen(site.url)}><ExternalLink size={15} />Open</button><button type="button" onClick={() => void navigator.clipboard.writeText(site.url)}><Share2 size={15} />공유</button></div></article>)}</section>}
  </div>;
}

function FeatureView({ view, onAutomationPrompt }: { view: "plugins" | "automations"; onAutomationPrompt?: (prompt: string) => void }): React.JSX.Element {
  if (view === "automations") return <AutomationsView onPrompt={onAutomationPrompt ?? (() => undefined)} />;
  return <div className="page-view"><h1>플러그인</h1><p>Skills, MCP, Apps를 설치하고 관리합니다.</p><div className="feature-empty"><Blocks /><strong>설치된 플러그인</strong><small>app-server 관리 API 연결 예정</small></div></div>;
}

function AutomationsView({ onPrompt }: { onPrompt: (prompt: string) => void }): React.JSX.Element {
  const templates = [
    {
      icon: <Bell size={16} />,
      label: "일일 브리핑",
      prompt: "매일 아침 실행되는 일일 브리핑 자동화를 설정하고 싶어. 먼저 내가 어떤 내용을 브리핑받고 싶은지, 몇 시에 받을지, 결과를 어떻게 보고받을지 질문해줘.",
    },
    {
      icon: <FileText size={16} />,
      label: "주간 검토",
      prompt: "매주 실행되는 주간 검토 자동화를 설정하고 싶어. 먼저 어떤 프로젝트나 저장소를 검토할지, 무슨 요일 몇 시에 실행할지, 어떤 형식으로 요약할지 질문해줘.",
    },
    {
      icon: <SearchCode size={16} />,
      label: "프로젝트 모니터링",
      prompt: "프로젝트를 주기적으로 모니터링하는 자동화를 설정하고 싶어. 먼저 어떤 프로젝트를 확인할지, 어떤 상태를 감시할지, 얼마나 자주 실행할지, 문제가 있을 때만 알려줄지 질문해줘.",
    },
  ];
  const defaultPrompt = "자동화를 설정하고 싶어. Codex에서 자동화가 어떻게 작동하는지 간단히 설명해주고, 나한테 몇 가지 질문을 해서 내가 Codex에 뭘 시키고 싶은지, 언제 실행되어야 하는지 파악해.";
  return (
    <div className="automations-page">
      <div className="automations-top">
        <button type="button" className="automations-secondary">템플릿 보기</button>
        <button type="button" className="automations-primary" onClick={() => onPrompt(defaultPrompt)}>채팅으로 만들기<ChevronDown size={14} /></button>
      </div>
      <div className="automations-body">
        <h1>자동화</h1>
        <p className="automations-lead">일정에 따라 또는 필요할 때마다 채팅을 실행합니다. <a>자세히 알아보기</a></p>
        <div className="automations-empty">
          <span className="automations-glyph"><CloudCog size={64} strokeWidth={1.4} /></span>
          <strong>첫 자동화를 만들어 보세요</strong>
          <div className="automations-templates">{templates.map((t) => <button type="button" key={t.label} onClick={() => onPrompt(t.prompt)}>{t.icon}{t.label}</button>)}</div>
        </div>
      </div>
    </div>
  );
}

function ThreadMenu({ pinned, onPin, onRename, onCopy, onSide, shareRuntimeLabel, onShareRuntime }: { pinned: boolean; onPin: () => void; onRename: () => void; onCopy: (kind: "cwd" | "id" | "markdown") => void; onSide: () => void; shareRuntimeLabel: string; onShareRuntime: () => void }): React.JSX.Element {
  const [copyOpen, setCopyOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [copyPlacement, setCopyPlacement] = useState<"left" | "right">("right");
  useLayoutEffect(() => {
    if (!copyOpen) return;
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    const copyWidth = 292;
    setCopyPlacement(rect.right + 8 + copyWidth > window.innerWidth - 8 ? "left" : "right");
  }, [copyOpen]);
  return <motion.div ref={menuRef} className="thread-menu" initial={{ opacity: 0, y: -6, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: .98 }} transition={{ duration: .13, ease: [.4, 0, .2, 1] }}>
    <button onClick={onPin}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}{pinned ? "채팅 고정 해제" : "채팅 고정"}<kbd>{shortcut("⌥⌘P")}</kbd></button>
    <button onClick={onRename}><Pencil size={16} />채팅 이름 바꾸기<kbd>{shortcut("⌥⌘R")}</kbd></button>
    <div className="menu-divider" />
    <button onClick={onSide}><MessageSquarePlus size={16} />사이드 채팅 열기<kbd>{shortcut("⌥⌘S")}</kbd></button>
    <button onClick={onShareRuntime}><GitFork size={16} />{shareRuntimeLabel}로 대화 넘기기</button>
    <button className={copyOpen ? "active" : ""} onClick={() => setCopyOpen((open) => !open)}><Copy size={16} />복사<ChevronRight size={15} className="chev" /></button>
    <AnimatePresence>
      {copyOpen && (
        <motion.div className={`thread-copy-menu ${copyPlacement}`} initial={{ opacity: 0, scale: .97, x: copyPlacement === "left" ? 4 : -4 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0, scale: .98, x: copyPlacement === "left" ? 3 : -3 }} transition={{ duration: .13 }}>
          <button type="button" onClick={() => onCopy("cwd")}><Copy size={16} />작업 중인 디렉토리 복사<kbd>{shortcut("⇧⌘C")}</kbd></button>
          <button type="button" onClick={() => onCopy("id")}><Copy size={16} />세션 ID 복사<kbd>{shortcut("⌥⌘C")}</kbd></button>
          <button type="button" onClick={() => onCopy("markdown")}><FileText size={16} />Markdown으로 복사</button>
        </motion.div>
      )}
    </AnimatePresence>
  </motion.div>;
}

function AppGlyph({ kind }: { kind: ExternalTarget }): React.JSX.Element {
  if (kind === "finder") return <span className="app-glyph finder"><Folder size={16} /></span>;
  if (kind === "terminal") return <span className="app-glyph terminal-app"><SquareTerminal size={16} /></span>;
  if (kind === "visualstudio") return <span className="app-glyph visualstudio">VS</span>;
  if (kind === "antigravity") return <span className="app-glyph antigravity">A</span>;
  if (kind === "github-desktop") return <span className="app-glyph github">GH</span>;
  if (kind === "git-bash") return <span className="app-glyph gitbash">◆</span>;
  if (kind === "intellij") return <span className="app-glyph intellij">IJ</span>;
  if (kind === "rider") return <span className="app-glyph rider">RD</span>;
  return <span className="app-glyph vscode"><Code2 size={16} /></span>;
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const minutes = Math.max(1, Math.floor((Date.now() / 1000 - timestamp) / 60));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

function viewLabel(view: AppView): string {
  return { thread: "새 채팅", search: "검색", archive: "보관된 채팅", sites: "사이트", plugins: "플러그인", automations: "자동화", settings: "설정" }[view];
}

createRoot(document.getElementById("root")!).render(<App />);
