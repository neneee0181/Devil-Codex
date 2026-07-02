import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, nativeImage, shell, Tray } from "electron";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { access, mkdir as fsMkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { CodexAppServer, syncStockThreadPermissions } from "./app-server.cjs";
import { getWorkspaceChanges, getWorkspaceDiff } from "./git-status.cjs";
import { applyWorkspaceHunk, commitWorkspace, createPullRequest, listGitBranches, pushWorkspace, stageWorkspaceFiles, switchGitBranch, unstageWorkspaceFiles } from "./git-workflow.cjs";
import { undoFileChanges } from "./file-rollback.cjs";
import { findWorkspaceFile, listWorkspaceDirectory, previewLocalImage, readWorkspaceEntry } from "./file-service.cjs";
import { TerminalManager } from "./terminal-manager.cjs";
import { CodexSettingsStore } from "./codex-settings.cjs";
import { translateText } from "./translate.cjs";
import { capabilityFor, ProviderSettingsStore } from "./provider-settings.cjs";
import { ProviderRuntime } from "./provider-runtime.cjs";
import { ProviderModelCatalog } from "./provider-model-catalog.cjs";
import { ProviderTranscriptStore } from "./provider-transcript.cjs";
import { CodexProviderReconciler } from "./codex-provider-reconcile.cjs";
import { CodexProxyServer } from "./proxy/proxy-server.cjs";
import { ClaudeCodeRuntime } from "./claude-runtime.cjs";
import { enrichDocumentAttachments } from "./document-attachments.cjs";
import { initAutoUpdate, checkForUpdatesNow, installUpdate } from "./auto-update.cjs";
import { registerDevilProvider, registerDevilBrowserMcp, unregisterDevilBrowserMcp, registerDevilAskMcp, unregisterDevilAskMcp } from "./codex-config.cjs";
import { BrowserControlServer } from "./browser-control-server.cjs";
import { DesktopControlManager } from "./desktop-control.cjs";
import { DesktopControlServer } from "./desktop-control-server.cjs";
import { AskControlServer } from "./ask-control-server.cjs";
import { providerAuthStatus as codexCliStatus, providerLogin as codexCliLogin, providerLogout as codexCliLogout } from "./provider-auth.cjs";
import { oauthLogin, oauthLogout, oauthModels, oauthStatus } from "./provider-oauth.cjs";
import { antigravityLogin, antigravityLogout, antigravityModels, antigravityStatus } from "./provider-antigravity.cjs";
import { clearProviderUsageCache, providerUsageReport } from "./provider-usage.cjs";
import { appendMirroredRolloutEvents, repairMirroredRolloutJsonl } from "./codex-rollout-mirror.cjs";
import { attachCodexTokenSnapshot, attachRolloutFinalAnswers, readCodexTokenSnapshot } from "./codex-token-usage.cjs";
import { applySessionIndexTitles } from "./codex-session-index.cjs";
import type { AgentRuntimeId, AppServerEvent, ApprovalDecision, ContextUsage, ExternalTarget, OpenWorkspaceTarget, ProviderId, SidecarSettings, ThreadApprovalPolicy, ThreadAttachment, ThreadHistoryItem, ThreadSandboxMode, ThreadSummary, WorkspaceChange } from "./contracts.cjs";

async function combinedAuthStatus(): Promise<{ codex: boolean; claude: boolean; copilot: boolean; antigravity: boolean }> {
  const [cli, oauth, antigravity] = await Promise.all([codexCliStatus(), oauthStatus(), antigravityStatus()]);
  return { codex: cli.codex, claude: oauth.claude, copilot: oauth.copilot, antigravity };
}

async function refreshProviderModels(provider: Exclude<ProviderId, "codex">, accountId?: string) {
  if (provider === "antigravity") {
    const models = await antigravityModels(accountId);
    if (!models.length) throw new Error("Antigravity 로그인 또는 사용 가능한 모델을 확인하세요.");
    return providerSettingsStore.saveModels(provider, models, accountId);
  }
  if (provider === "copilot" || provider === "claude-code") {
    const models = await oauthModels(provider, accountId);
    if (!models.length) throw new Error(`${provider === "copilot" ? "GitHub Copilot" : "Claude Code"} 로그인 또는 사용 가능한 모델을 확인하세요.`);
    return providerSettingsStore.saveModels(provider, models, accountId);
  }
  return providerModels.refresh(provider, accountId);
}

type UsageCacheProvider = "codex" | "claude-code" | "copilot" | "antigravity";
const USAGE_CACHE_PROVIDERS: readonly UsageCacheProvider[] = ["codex", "claude-code", "copilot", "antigravity"];

function isUsageCacheProvider(provider: ProviderId | "unknown"): provider is UsageCacheProvider {
  return (USAGE_CACHE_PROVIDERS as readonly string[]).includes(provider);
}

function safeProjectName(value: unknown): string {
  const text = String(value ?? "").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ");
  return text || "새 프로젝트";
}

async function uniqueProjectDir(base: string, name: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const suffix = i === 0 ? "" : ` ${i + 1}`;
    const dir = join(base, `${name}${suffix}`);
    try { await access(dir); }
    catch { return dir; }
  }
  return join(base, `${name} ${Date.now()}`);
}
import { createGitWorktree, listGitWorktrees } from "./worktree-service.cjs";
import { BrowserViewManager } from "./browser-view.cjs";
import { ThreadHistoryCache, mergeCachedActivities } from "./history-cache.cjs";

loadEnv({ path: join(process.cwd(), ".env.local"), quiet: true });
app.setName("devil-codex");

const ENGLISH_OUTPUT_DIRECTIVE = "[Output language directive] Respond only in English, even when the user writes in another language. Do not translate code, identifiers, file paths, or shell commands.";

function stripInternalDirectives(text: string): string {
  return text.replace(new RegExp(`\\n*---\\n${escapeRegExp(ENGLISH_OUTPUT_DIRECTIVE)}\\s*$`), "").trimEnd();
}

function stripInternalDirectivesFromHistory(items: ThreadHistoryItem[]): ThreadHistoryItem[] {
  return items.map((item) => item.kind === "user" ? { ...item, text: stripInternalDirectives(item.text) } : item);
}

async function attachCodexTokenUsage(threadId: string, items: ThreadHistoryItem[]): Promise<ThreadHistoryItem[]> {
  await repairMirroredRolloutJsonl(threadId).catch(() => undefined);
  const withFinalAnswers = await attachRolloutFinalAnswers(threadId, items);
  return attachCodexTokenSnapshot(withFinalAnswers, await readCodexTokenSnapshot(threadId));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Only one Devil Codex instance may run. A second process collides on the ask/
// browser/computer named pipes ("EADDRINUSE \\.\pipe\devil-codex-ask"), fights
// over the userData GPU disk cache ("Unable to create cache" / access denied),
// and leaves the renderer talking to a different app-server than the one holding
// a thread's per-thread child → "thread not found". Hand focus to the running
// window and quit the duplicate before any of that state is touched.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

let windowRef: BrowserWindow | undefined;
let trayRef: Tray | undefined;
let isQuitting = false;
let ipcHandlersReady = false;
let showMainWindowWhenReady = false;
const FALLBACK_TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA1ElEQVQ4jcWTsQ2DMBBFXWUF/gCJFGELS5FSQsU4GYANQooMgESfCRAjQOnMQOLQM8BFtgJFoLBJkeJL9ln37mzfZ2EYbgBcAGgA5KgngNzkMrPwSPxWzsbKp92WrnzvC3ixcXOTgu7HAw3DMJPWmuq6piRJZhDmAhjVdR0JIdwBSilqmob6vp9iWZa5A9I0tWdRFE2Qoij8AQCobVsbK8vyDwAp5borKKVs5dWPOCx8I+fcH6C1pqqqKI7jxUEyxlg1ykEQPH4105l97GwgthNfO78BmdECbWW4kcMAAAAASUVORK5CYII=";
const historyCache = new ThreadHistoryCache();
const browserView = new BrowserViewManager((channel, payload) => sendToRenderer(channel, payload));
const browserControlSecret = randomBytes(24).toString("hex");
const desktopControlSecret = randomBytes(24).toString("hex");
const askControlSecret = randomBytes(24).toString("hex");
const browserControl = new BrowserControlServer(browserView, browserControlSecret);
const desktopControl = new DesktopControlServer(new DesktopControlManager(), desktopControlSecret);
const askControl = new AskControlServer((channel, payload) => sendToRenderer(channel, payload), askControlSecret);
let appServer: CodexAppServer | undefined;
const MAX_THREAD_APP_SERVERS = 8;
const threadServers = new Map<string, CodexAppServer>();
const threadServerLastUsed = new Map<string, number>();
const appServerThreadIds = new WeakMap<CodexAppServer, string>();
const activeThreadServerTurns = new Set<string>();
const approvalRequestServers = new Map<string, CodexAppServer>();
// Threads whose rollout is currently loaded on their (live) per-thread server.
// A fresh/replaced server doesn't know an existing thread until it's resumed —
// without this a restart or prune leaves "thread not found" on the next turn.
const loadedThreads = new Set<string>();

// Codex app-server reports auth/usage/model errors on stderr (emitted as
// "diagnostic"), not as structured turn events — so a failed turn otherwise
// surfaces only a generic "no detail" message. Keep a rolling buffer and attach
// the likely error line to the failed turn's Provider 진단 card.
const APP_SERVER_ERROR_CONTEXT_MS = 30_000;
const appServerStderr: Array<{ line: string; at: number }> = [];
const contextWindowFailures = new Map<string, string>();
function recordAppServerStderr(line: string): void {
  const at = Date.now();
  for (const part of String(line ?? "").split(/\r?\n/)) {
    const trimmed = part.trim();
    if (trimmed) appServerStderr.push({ line: trimmed, at });
  }
  if (appServerStderr.length > 120) appServerStderr.splice(0, appServerStderr.length - 120);
}
function recentAppServerError(): string | undefined {
  if (!appServerStderr.length) return undefined;
  const cutoff = Date.now() - APP_SERVER_ERROR_CONTEXT_MS;
  const recent = appServerStderr.filter((entry) => entry.at >= cutoff);
  if (!recent.length) return undefined;
  const errish = recent.filter((entry) => /error|fail|denied|unauthor|forbidden|401|403|429|quota|usage|rate.?limit|exceeded|invalid|not ?found|unsupported|expired|token|timeout/i.test(entry.line));
  const picked = (errish.length ? errish : recent).slice(-4).map((entry) => entry.line);
  return picked.join(" | ").slice(0, 600) || undefined;
}
function tokenCountInfo(event: { method: string; params?: unknown }): { context: number; total: number; max: number } | undefined {
  const params = (event.params ?? {}) as Record<string, unknown>;
  const payload = (params.payload ?? params) as Record<string, unknown>;
  const info = (payload.info ?? payload) as Record<string, unknown>;
  const totalUsage = (info.total_token_usage ?? info.totalTokenUsage ?? {}) as Record<string, unknown>;
  const lastUsage = (info.last_token_usage ?? info.lastTokenUsage ?? {}) as Record<string, unknown>;
  const total = Number(totalUsage.total_tokens ?? totalUsage.totalTokens ?? 0);
  const context = Number(lastUsage.total_tokens ?? lastUsage.totalTokens ?? lastUsage.input_tokens ?? lastUsage.inputTokens ?? 0);
  const max = Number(info.model_context_window ?? info.modelContextWindow ?? payload.model_context_window ?? payload.modelContextWindow ?? 0);
  return Number.isFinite(context) && Number.isFinite(total) && Number.isFinite(max) && max > 0 ? { context, total, max } : undefined;
}

function validContextUsage(value: unknown): ContextUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const usedTokens = Number(raw.usedTokens);
  const maxTokens = Number(raw.maxTokens);
  return Number.isFinite(usedTokens) && Number.isFinite(maxTokens) && usedTokens > 0 && maxTokens > 0 ? { usedTokens, maxTokens } : undefined;
}

// Codex reports the effective context window (95% of the raw model window),
// while its default auto-compaction limit is 90% of the raw model window.
const AUTO_COMPACT_CONTEXT_PERCENT = 90;
const EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

function autoCompactContextLimit(maxTokens: number): number {
  return Math.floor((maxTokens * AUTO_COMPACT_CONTEXT_PERCENT) / EFFECTIVE_CONTEXT_WINDOW_PERCENT);
}

function shouldStartContextCompaction(usage: ContextUsage): boolean {
  return usage.usedTokens >= autoCompactContextLimit(usage.maxTokens);
}

function contextWindowMessage(usage: ContextUsage): string {
  const limit = autoCompactContextLimit(usage.maxTokens);
  return `Codex 컨텍스트 자동 압축 임계값에 도달했습니다 (${Math.round(usage.usedTokens)}/${Math.round(usage.maxTokens)} tokens, limit ${limit}). 압축을 먼저 실행한 뒤 같은 요청을 다시 보냅니다.`;
}

async function maybeStartContextCompaction(instance: CodexAppServer, input: { threadId: string; provider?: ProviderId; contextUsage?: ContextUsage; retriedAfterCompaction?: boolean }): Promise<boolean> {
  if ((input.provider ?? "codex") !== "codex" || input.retriedAfterCompaction) return false;
  const snapshot = await readCodexTokenSnapshot(input.threadId).catch(() => undefined);
  const usage = snapshot?.contextUsage ?? validContextUsage(input.contextUsage);
  if (!usage || !shouldStartContextCompaction(usage)) return false;
  contextWindowFailures.set(input.threadId, contextWindowMessage(usage));
  sendToRenderer("app-server:event", {
    method: "thread/compaction_started",
    params: {
      threadId: input.threadId,
      contextUsage: usage,
      limit: autoCompactContextLimit(usage.maxTokens),
    },
  });
  await instance.compactThread({ threadId: input.threadId });
  return true;
}
let terminalManager: TerminalManager | undefined;
const execFileAsync = promisify(execFile);
const settingsStore = new CodexSettingsStore();
const providerSettingsStore = new ProviderSettingsStore();
const providerRuntime = new ProviderRuntime(providerSettingsStore, (event) => sendToRenderer("app-server:event", event));
const providerModels = new ProviderModelCatalog(providerSettingsStore);
const providerTranscripts = new ProviderTranscriptStore();
const providerReconciler = new CodexProviderReconciler();
const claudeRuntime = new ClaudeCodeRuntime(baseServerCwd());
claudeRuntime.on("event", (event) => sendToRenderer("app-server:event", event));
const codexProxy = new CodexProxyServer((message) => {
  sendToRenderer("app-server:event", {
    method: "item/completed",
    params: {
      item: {
        id: `proxy-error-${crypto.randomUUID()}`,
        type: "error",
        message,
        status: "failed",
      },
    },
  });
}, (event) => {
  if (event.completed && isUsageCacheProvider(event.provider)) clearProviderUsageCache(event.provider);
  sendToRenderer("provider:usage-changed", { provider: event.provider, completed: event.completed, at: Date.now() });
});

function usesCodexProxy(provider?: string): boolean {
  return Boolean(provider && provider !== "codex");
}

function routedProviderModel(provider: ProviderId, model: string, accountId?: string): string {
  return `${provider}${accountId ? `@${encodeURIComponent(accountId)}` : ""}:${model}`;
}

async function providerAccountLabel(provider: ProviderId | undefined, accountId: string | undefined): Promise<string | undefined> {
  if (!provider || !accountId) return undefined;
  const settings = await providerSettingsStore.load().catch(() => null);
  return settings?.providers.find((item) => item.id === provider)?.accounts.find((account) => account.id === accountId)?.label;
}

function annotateCodexSummaries<T extends ThreadSummary>(threads: T[]): T[] {
  return threads.map((thread) => ({ ...thread, provider: "codex" as const }));
}

interface SidecarDiagnosticsSnapshot {
  webSearchRequests: number;
  webSearchToolCalls?: number;
  webSearchLoops?: number;
  webSearchEvents?: Array<{ query: string; status: "completed" | "failed"; sources: Array<{ url: string; title?: string }>; error?: string }>;
  visionRequests: number;
  visionEvents?: Array<{ status: "completed" | "failed"; error?: string }>;
  failures: string[];
}

const pendingProviderDiagnostics = new Map<string, { provider: string; model: string; accountId?: string; accountLabel?: string; sidecars?: SidecarSettings; sandboxMode?: ThreadSandboxMode; approvalPolicy?: string; cwd?: string }>();
const turnFileSnapshots = new Map<string, { cwd: string; files: Map<string, string> }>();
const nativeFileChangeTurns = new Set<string>();

function sidecarDiagnostics(sidecars?: SidecarSettings, actual?: SidecarDiagnosticsSnapshot): string[] {
  const config = sidecars ?? { webSearch: false, vision: false, webSearchLimit: 3, visionLimit: 3 };
  const webSearchRequests = actual?.webSearchRequests ?? 0;
  const webSearchToolCalls = actual?.webSearchToolCalls ?? 0;
  const webSearchLoops = actual?.webSearchLoops ?? 0;
  const visionRequests = actual?.visionRequests ?? 0;
  const visionFailures = actual?.visionEvents?.filter((event) => event.status === "failed").length ?? 0;
  const failures = actual?.failures ?? [];
  return [
    `sidecar.webSearch: ${config.webSearch ? `enabled; mode tool-loop; toolCalls ${webSearchToolCalls}; requests ${webSearchRequests}/${config.webSearchLimit}; loops ${webSearchLoops}` : "disabled"}`,
    `sidecar.vision: ${config.vision ? `enabled; requests ${visionRequests}/${config.visionLimit}; failures ${visionFailures}` : "disabled"}`,
    `sidecar.failures: ${failures.length ? failures.join(" | ") : "none"}`,
  ];
}

function providerDiagnosticsDetail(input: { provider: string; model: string; accountLabel?: string; status: "completed" | "failed"; error?: string; sidecars?: SidecarSettings; sidecarActual?: SidecarDiagnosticsSnapshot; sandboxMode?: ThreadSandboxMode; approvalPolicy?: string }): string {
  const cap = capabilityFor(input.provider as ProviderId, input.model);
  return [
    `provider: ${input.provider}`,
    ...(input.accountLabel ? [`account: ${input.accountLabel}`] : []),
    `model: ${input.model}`,
    `route: ${input.provider === "codex" ? "app-server direct" : "devil proxy + reconcile"}`,
    `approvalPolicy: ${input.approvalPolicy ?? "on-request"}`,
    `sandbox: ${input.sandboxMode ?? "workspace-write"}`,
    `tools: ${cap.tools}`,
    `images: ${cap.images}`,
    `webSearch: ${cap.webSearch}`,
    `diagnostics: ${cap.diagnostics}`,
    `reconcile: ${input.provider === "codex" ? "native" : input.status === "completed" ? "attempted; pending queue should clear" : "failed turn; pending discarded or marked failed"}`,
    ...(input.provider === "codex" ? ["sidecar: ignored on Codex direct route"] : sidecarDiagnostics(input.sidecars, input.sidecarActual)),
    ...(input.status === "failed" ? ["note: Provider 최종 응답은 실패했지만 위에 표시된 명령어/파일 작업은 이미 실행됐을 수 있습니다. 실제 파일 상태는 작업 카드, 리뷰, git 상태로 확인하세요."] : []),
    ...(cap.notes ?? []).map((note) => `note: ${note}`),
    ...(input.error ? [`error: ${input.error}`] : []),
  ].join("\n");
}

function emitProviderDiagnostics(input: { threadId: string; turnId?: string; provider: string; model: string; accountLabel?: string; status: "completed" | "failed"; error?: string; sidecars?: SidecarSettings; sidecarActual?: SidecarDiagnosticsSnapshot; sandboxMode?: ThreadSandboxMode; approvalPolicy?: string }): void {
  const item = {
    id: `provider-diagnostics-${crypto.randomUUID()}`,
    type: "providerDiagnostics",
    title: "Provider 진단",
    detail: providerDiagnosticsDetail(input),
    status: input.status,
  };
  void providerTranscripts.isExternal(input.threadId).then((external) => external
    ? providerTranscripts.appendActivityEntry(input.threadId, input.turnId, {
      id: item.id,
      kind: "diagnostic",
      title: item.title,
      detail: item.detail,
      status: item.status,
    }, input.status)
    : undefined).catch(() => undefined);
  sendToRenderer("app-server:event", {
    method: "item/completed",
    params: {
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      item,
    },
  });
}

function webSearchDetail(event: { query: string; sources: Array<{ url: string; title?: string }>; error?: string }): string {
  const lines: string[] = [`검색어: ${event.query}`];
  if (event.error) lines.push(`실패 이유: ${event.error}`);
  if (event.sources.length) {
    lines.push("출처:");
    event.sources.forEach((source, index) => lines.push(`${index + 1}. ${source.title ? `${source.title} — ` : ""}${source.url}`));
  }
  return lines.join("\n");
}

function emitSidecarActivities(input: { threadId: string; turnId?: string; sidecarActual?: SidecarDiagnosticsSnapshot }): void {
  for (const [index, event] of input.sidecarActual?.webSearchEvents?.entries() ?? []) {
    sendToRenderer("app-server:event", {
      method: "item/completed",
      params: {
        threadId: input.threadId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        item: {
          id: `sidecar-web-search-${input.turnId || input.threadId}-${index}`,
          type: "webSearch",
          query: event.query,
          detail: webSearchDetail(event),
          sources: event.sources,
          status: event.status,
        },
      },
    });
  }
}

function sortThreadsByRecency(threads: Array<{ updatedAt: number }>): void {
  threads.sort((a, b) => b.updatedAt - a.updatedAt);
}

function cwdKey(cwd: string | undefined): string {
  return String(cwd ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function requestedRuntime(value: unknown): AgentRuntimeId {
  return value === "claude-code" ? "claude-code" : "codex";
}

function threadRuntime(summary: ThreadSummary): AgentRuntimeId {
  return summary.runtime === "claude-code" ? "claude-code" : "codex";
}

function filterRuntime<T extends ThreadSummary>(threads: T[], runtime: AgentRuntimeId): T[] {
  return threads.filter((thread) => threadRuntime(thread) === runtime);
}

function hasClaudeCodeConversation(items: ThreadHistoryItem[]): boolean {
  return items.some((item) => item.kind === "agent" && item.runtime === "claude-code" && (item.provider ?? "claude-code") === "claude-code");
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (!windowRef || windowRef.isDestroyed()) return;
  windowRef.webContents.send(channel, payload);
}

function sendCommand(command: string): void {
  sendToRenderer("app:command", command);
}

function turnKey(threadId: string, turnId?: string): string {
  return `${threadId}:${turnId || "pending"}`;
}

async function snapshotWorkspaceFiles(cwd?: string): Promise<{ cwd: string; files: Map<string, string> } | undefined> {
  if (!cwd) return undefined;
  const changes = await getWorkspaceChanges(cwd);
  if (!changes.available) return undefined;
  const entries = await Promise.all(changes.files.map(async (file) => {
    const diff = await getWorkspaceDiff(cwd, file.path).catch(() => undefined);
    return [file.path, `${file.status}\0${file.additions}\0${file.deletions}\0${diff?.text ?? ""}`] as const;
  }));
  return { cwd, files: new Map(entries) };
}

async function rememberTurnFileSnapshot(threadId: string, cwd?: string): Promise<void> {
  const snapshot = await snapshotWorkspaceFiles(cwd);
  if (snapshot) turnFileSnapshots.set(threadId, snapshot);
}

async function changedFilesSinceSnapshot(threadId: string): Promise<Array<WorkspaceChange & { diff?: string; absPath?: string }>> {
  const before = turnFileSnapshots.get(threadId);
  turnFileSnapshots.delete(threadId);
  if (!before) return [];
  const after = await getWorkspaceChanges(before.cwd);
  if (!after.available) return [];
  const withDiffs = await Promise.all(after.files.map(async (file) => ({
    ...file,
    diff: (await getWorkspaceDiff(before.cwd, file.path).catch(() => undefined))?.text ?? "",
  })));
  const changed = withDiffs.filter((file) => {
    const beforeSignature = before.files.get(file.path);
    if (beforeSignature == null) return true;
    return beforeSignature !== `${file.status}\0${file.additions}\0${file.deletions}\0${file.diff ?? ""}`;
  });
  return changed.filter((file) => file.diff || file.additions || file.deletions).map((file) => ({ ...file, absPath: resolve(before.cwd, file.path) }));
}

async function emitSyntheticFileChanges(input: { threadId: string; turnId?: string; status: "completed" | "failed"; mirrorRollout?: boolean }): Promise<void> {
  const seenNative = nativeFileChangeTurns.delete(turnKey(input.threadId, input.turnId)) || nativeFileChangeTurns.delete(turnKey(input.threadId));
  const changes = await changedFilesSinceSnapshot(input.threadId);
  if (seenNative || changes.length === 0) return;
  const mirrorId = `devil-file-change-${input.turnId || input.threadId}`;
  sendToRenderer("app-server:event", {
    method: "item/completed",
    params: {
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      item: {
        id: `synthetic-file-change-${input.turnId || input.threadId}`,
        type: "fileChange",
        status: input.status,
        changes: changes.map((file) => ({ path: file.path, diff: file.diff ?? "" })),
      },
    },
  });
  if (input.mirrorRollout === false) return;
  void appendMirroredRolloutEvents(input.threadId, mirrorId, [{
    type: "patch_apply_end",
    call_id: mirrorId,
    ...(input.turnId ? { turn_id: input.turnId } : {}),
    stdout: `Devil Codex detected ${changes.length} changed file(s).`,
    stderr: "",
    success: input.status !== "failed",
    changes: Object.fromEntries(changes.map((file) => [
      file.absPath ?? file.path,
      { type: "update", unified_diff: file.diff ?? "" },
    ])),
  }]).catch((error) => console.warn("[devil-codex rollout mirror] fileChange", error instanceof Error ? error.message : error));
}

function mirrorCommandExecution(input: { threadId: string; turnId?: string; item: Record<string, unknown> }): void {
  const id = String(input.item.id ?? crypto.randomUUID());
  const mirrorId = `devil-command-${id}`;
  const command = String(input.item.command ?? "명령 실행");
  const output = String(input.item.aggregatedOutput ?? input.item.output ?? "");
  const status = String(input.item.status ?? "completed");
  const cwd = String(input.item.cwd ?? "");
  void appendMirroredRolloutEvents(input.threadId, mirrorId, [
    {
      type: "exec_command_begin",
      call_id: mirrorId,
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      command,
      cwd,
    },
    {
      type: "exec_command_end",
      call_id: mirrorId,
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      stdout: output,
      stderr: "",
      exit_code: status === "failed" ? 1 : 0,
      duration: { secs: 0, nanos: 0 },
    },
  ]).catch((error) => console.warn("[devil-codex rollout mirror] commandExecution", error instanceof Error ? error.message : error));
}

function eventThreadId(event: { params?: unknown }): string {
  const params = (event.params ?? {}) as Record<string, unknown>;
  return String(params.threadId ?? "");
}

function handleAppServerEvent(event: { method: string; params?: unknown }): void {
  const explicitThreadId = eventThreadId(event);
  const usage = tokenCountInfo(event);
  const threadId = explicitThreadId || (usage && activeThreadServerTurns.size === 1 ? Array.from(activeThreadServerTurns)[0] ?? "" : "");
  if (!threadId) return;
  if (usage && shouldStartContextCompaction({ usedTokens: usage.context, maxTokens: usage.max })) {
    contextWindowFailures.set(threadId, contextWindowMessage({ usedTokens: usage.context, maxTokens: usage.max }));
  }
  const params = (event.params ?? {}) as Record<string, unknown>;
  const item = (params.item ?? {}) as Record<string, unknown>;
  const turn = (params.turn ?? {}) as Record<string, unknown>;
  const turnId = String(params.turnId ?? turn.id ?? "");
  const terminalTurn = event.method === "turn/completed" || event.method === "turn/aborted" || event.method === "turn/interrupted";
  touchThreadServer(threadId);
  if (event.method === "turn/started") {
    activeThreadServerTurns.add(threadId);
    return;
  }
  if (event.method === "item/completed" && String(item.type ?? "") === "commandExecution") {
    mirrorCommandExecution({ threadId, ...(turnId ? { turnId } : {}), item });
  }
  if ((event.method === "item/started" || event.method === "item/completed") && String(item.type ?? "") === "fileChange") {
    nativeFileChangeTurns.add(turnKey(threadId, turnId));
    return;
  }
  if (!terminalTurn) return;
  activeThreadServerTurns.delete(threadId);
  pruneThreadServers();
  const turnStatus = event.method === "turn/completed"
    ? String(turn.status ?? "completed")
    : String(params.reason ?? turn.status ?? "aborted");
  void emitSyntheticFileChanges({ threadId, ...(turnId ? { turnId } : {}), status: turnStatus === "failed" ? "failed" : "completed" });
  const pendingDiagnostics = pendingProviderDiagnostics.get(threadId);
  if (pendingDiagnostics) {
    if (pendingDiagnostics.cwd) {
      const approvalPolicy: ThreadApprovalPolicy = pendingDiagnostics.approvalPolicy === "never" ? "never" : "on-request";
      const sandboxMode: ThreadSandboxMode = pendingDiagnostics.sandboxMode === "danger-full-access" || pendingDiagnostics.sandboxMode === "read-only"
        ? pendingDiagnostics.sandboxMode
        : "workspace-write";
      void syncStockThreadPermissions(threadId, pendingDiagnostics.cwd, approvalPolicy, sandboxMode).catch((error) => {
        console.warn("[devil-codex] final thread permission sync failed", error instanceof Error ? error.message : error);
      });
    }
    pendingProviderDiagnostics.delete(threadId);
    const sidecarActual = codexProxy.consumeSidecarStats(threadId);
    emitSidecarActivities({ threadId, ...(turnId ? { turnId } : {}), sidecarActual });
    emitProviderDiagnostics({
      threadId,
      ...(turnId ? { turnId } : {}),
      provider: pendingDiagnostics.provider,
      model: pendingDiagnostics.model,
      accountLabel: pendingDiagnostics.accountLabel,
      status: turnStatus === "failed" ? "failed" : "completed",
      ...(turnStatus === "failed" ? { error: contextWindowFailures.get(threadId) ?? recentAppServerError() } : {}),
      sidecars: pendingDiagnostics.sidecars,
      sidecarActual,
      sandboxMode: pendingDiagnostics.sandboxMode,
      approvalPolicy: pendingDiagnostics.approvalPolicy,
    });
    contextWindowFailures.delete(threadId);
  }
  void providerReconciler.hasPending(threadId).then((pending) => pending ? providerReconciler.completeExternalTurn(threadId) : null).then((result) => {
    if (!result) return undefined;
    if (result.ok && turnStatus === "completed") return providerTranscripts.markLatestProviderTurnSync(threadId, "synced");
    if (result.ok) return providerTranscripts.markLatestProviderTurnSync(threadId, "failed", `turn ${turnStatus}`);
    return providerTranscripts.markLatestProviderTurnSync(threadId, "failed", result.error);
  }).catch((error) => {
    void providerTranscripts.markLatestProviderTurnSync(threadId, "failed", error instanceof Error ? error.message : String(error));
  });
}

function configureMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "devil-codex",
      submenu: [
        { label: "devil-codex 정보", role: "about" },
        { type: "separator" },
        { label: "설정…", accelerator: "CmdOrCtrl+,", click: () => sendCommand("settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "새 채팅", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new-thread") },
        { label: "프로젝트 열기…", accelerator: "CmdOrCtrl+O", click: () => sendCommand("open-project") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        { label: "스레드 검색", accelerator: "CmdOrCtrl+G", click: () => sendCommand("search") },
        { label: "터미널 토글", accelerator: "CmdOrCtrl+J", click: () => sendCommand("terminal") },
        { label: "환경 토글", accelerator: "CmdOrCtrl+Alt+B", click: () => sendCommand("environment") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
    { label: "Help", submenu: [] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function appIconPath(): string {
  const filename = process.platform === "win32" ? "icon.ico" : "icon.png";
  const fallback = process.platform === "win32" ? "icon.png" : "icon.ico";
  const candidates = [
    join(process.resourcesPath, "build", filename),
    join(app.getAppPath(), "build", filename),
    join(process.resourcesPath, "build", fallback),
    join(app.getAppPath(), "build", fallback),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function trayIconImage(): Electron.NativeImage {
  const resize = (image: Electron.NativeImage): Electron.NativeImage => process.platform === "win32" ? image.resize({ width: 16, height: 16 }) : image;
  for (const candidate of [appIconPath(), process.execPath]) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return resize(image);
  }
  return resize(nativeImage.createFromDataURL(FALLBACK_TRAY_ICON_DATA_URL));
}

function quitApp(): void {
  isQuitting = true;
  trayRef?.destroy();
  trayRef = undefined;
  app.quit();
}

function showMainWindow(): void {
  if (!ipcHandlersReady) {
    showMainWindowWhenReady = true;
    return;
  }
  if (!windowRef || windowRef.isDestroyed()) createWindow();
  if (!windowRef) return;
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.show();
  windowRef.focus();
}

function createBackgroundTray(): void {
  if (trayRef) return;
  trayRef = new Tray(trayIconImage());
  trayRef.setToolTip("Devil Codex - 백그라운드에서 실행 중");
  trayRef.setContextMenu(Menu.buildFromTemplate([
    { label: "Devil Codex 열기", click: () => showMainWindow() },
    { label: "새 채팅", click: () => { showMainWindow(); sendCommand("new-thread"); } },
    { label: "설정", click: () => { showMainWindow(); sendCommand("settings"); } },
    { type: "separator" },
    { label: "Devil Codex 종료", click: () => quitApp() },
  ]));
  trayRef.on("click", () => showMainWindow());
}

const openTargetLabels: Record<ExternalTarget, string> = {
  vscode: "VS Code",
  visualstudio: "Visual Studio",
  antigravity: "Antigravity",
  "github-desktop": "GitHub Desktop",
  finder: process.platform === "win32" ? "File Explorer" : "Finder",
  terminal: "Terminal",
  "git-bash": "Git Bash",
  intellij: "IntelliJ IDEA",
  rider: "Rider",
};

function envPath(name: string): string {
  return process.env[name] ?? "";
}

function candidatePaths(target: ExternalTarget): string[] {
  const local = envPath("LOCALAPPDATA");
  const programFiles = envPath("ProgramFiles");
  const programFilesX86 = envPath("ProgramFiles(x86)");
  const userProfile = envPath("USERPROFILE");
  const appData = envPath("APPDATA");
  const paths: Partial<Record<ExternalTarget, string[]>> = {
    vscode: [
      join(local, "Programs", "Microsoft VS Code", "Code.exe"),
      join(programFiles, "Microsoft VS Code", "Code.exe"),
      join(programFilesX86, "Microsoft VS Code", "Code.exe"),
    ],
    visualstudio: [
      join(programFiles, "Microsoft Visual Studio", "2022", "Community", "Common7", "IDE", "devenv.exe"),
      join(programFiles, "Microsoft Visual Studio", "2022", "Professional", "Common7", "IDE", "devenv.exe"),
      join(programFiles, "Microsoft Visual Studio", "2022", "Enterprise", "Common7", "IDE", "devenv.exe"),
      join(programFilesX86, "Microsoft Visual Studio", "2019", "Community", "Common7", "IDE", "devenv.exe"),
      join(programFilesX86, "Microsoft Visual Studio", "2019", "Professional", "Common7", "IDE", "devenv.exe"),
      join(programFilesX86, "Microsoft Visual Studio", "2019", "Enterprise", "Common7", "IDE", "devenv.exe"),
    ],
    antigravity: [
      join(local, "Programs", "Antigravity", "Antigravity.exe"),
      join(programFiles, "Antigravity", "Antigravity.exe"),
    ],
    "github-desktop": [
      join(local, "GitHubDesktop", "GitHubDesktop.exe"),
      join(local, "Programs", "GitHub Desktop", "GitHubDesktop.exe"),
    ],
    "git-bash": [
      join(programFiles, "Git", "git-bash.exe"),
      join(programFilesX86, "Git", "git-bash.exe"),
      join(userProfile, "scoop", "apps", "git", "current", "git-bash.exe"),
    ],
    intellij: [
      join(local, "Programs", "IntelliJ IDEA Ultimate", "bin", "idea64.exe"),
      join(local, "Programs", "IntelliJ IDEA Community Edition", "bin", "idea64.exe"),
      join(programFiles, "JetBrains", "IntelliJ IDEA 2025.3", "bin", "idea64.exe"),
      join(programFiles, "JetBrains", "IntelliJ IDEA 2025.2", "bin", "idea64.exe"),
      join(programFiles, "JetBrains", "IntelliJ IDEA 2025.1", "bin", "idea64.exe"),
      join(programFiles, "JetBrains", "IntelliJ IDEA 2024.3", "bin", "idea64.exe"),
      join(appData, "JetBrains", "Toolbox", "scripts", "idea.cmd"),
    ],
    rider: [
      join(local, "Programs", "Rider", "bin", "rider64.exe"),
      join(programFiles, "JetBrains", "JetBrains Rider 2025.3", "bin", "rider64.exe"),
      join(programFiles, "JetBrains", "JetBrains Rider 2025.2", "bin", "rider64.exe"),
      join(programFiles, "JetBrains", "JetBrains Rider 2025.1", "bin", "rider64.exe"),
      join(programFiles, "JetBrains", "JetBrains Rider 2024.3", "bin", "rider64.exe"),
      join(appData, "JetBrains", "Toolbox", "scripts", "rider.cmd"),
    ],
  };
  return (paths[target] ?? []).filter(Boolean);
}

async function firstAccessible(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

async function commandWorks(command: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [command], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function resolveOpenCommand(target: ExternalTarget): Promise<string | undefined> {
  if (target === "finder") return process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  if (target === "terminal") {
    if (process.platform === "win32") return await commandWorks("wt") ? "wt" : "cmd";
    return process.platform === "darwin" ? "open" : "x-terminal-emulator";
  }
  if (process.platform === "darwin") return target === "vscode" ? "Visual Studio Code" : target === "intellij" ? "IntelliJ IDEA" : undefined;
  if (process.platform !== "win32") {
    const command = { vscode: "code", visualstudio: "", antigravity: "antigravity", "github-desktop": "github-desktop", "git-bash": "", intellij: "idea", rider: "rider" }[target];
    return command && await commandWorks(command) ? command : undefined;
  }
  const cli: Partial<Record<ExternalTarget, string>> = { vscode: "code", antigravity: "antigravity", intellij: "idea64", rider: "rider64" };
  if (cli[target] && await commandWorks(cli[target]!)) return cli[target];
  return firstAccessible(candidatePaths(target));
}

async function listOpenWorkspaceTargets(): Promise<OpenWorkspaceTarget[]> {
  const order: ExternalTarget[] = process.platform === "win32"
    ? ["vscode", "visualstudio", "antigravity", "github-desktop", "finder", "terminal", "git-bash", "intellij", "rider"]
    : ["vscode", "finder", "terminal", "intellij"];
  const rows = await Promise.all(order.map(async (id) => ({ id, label: openTargetLabels[id], available: Boolean(await resolveOpenCommand(id)) })));
  return rows.filter((row) => row.available);
}

async function openWorkspaceExternal(input: { cwd: string; target: ExternalTarget }): Promise<{ ok: boolean; detail?: string }> {
  try {
    if (process.platform === "darwin") {
      if (input.target === "finder") await execFileAsync("open", [input.cwd]);
      else if (input.target === "terminal") await execFileAsync("open", ["-a", "Terminal", input.cwd]);
      else {
        const appName = await resolveOpenCommand(input.target);
        if (!appName) throw new Error(`${openTargetLabels[input.target]}을 찾을 수 없습니다.`);
        await execFileAsync("open", ["-a", appName, input.cwd]);
      }
    } else if (process.platform === "win32") {
      const command = await resolveOpenCommand(input.target);
      if (!command) throw new Error(`${openTargetLabels[input.target]}을 찾을 수 없습니다.`);
      if (input.target === "terminal" && command === "cmd") await execFileAsync("cmd", ["/c", "start", "", "cmd", "/K", `cd /d "${input.cwd}"`]);
      else if (input.target === "terminal" && command === "wt") await execFileAsync("wt", ["-d", input.cwd]);
      else if (input.target === "git-bash") await execFileAsync(command, ["--cd=" + input.cwd]);
      else await execFileAsync(command, [input.cwd]);
    } else {
      const command = await resolveOpenCommand(input.target);
      if (!command) throw new Error(`${openTargetLabels[input.target]}을 찾을 수 없습니다.`);
      await execFileAsync(command, [input.cwd]);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "앱을 열 수 없습니다." };
  }
}

async function openNativeCodex(): Promise<{ ok: boolean; detail?: string }> {
  const attempts: Array<[string, string[]]> = process.platform === "darwin"
    ? [["open", ["-a", "Codex"]], ["open", ["/Applications/Codex.app"]]]
    : process.platform === "win32"
      ? [["Codex", []], ["codex", []], ["cmd", ["/c", "start", "", "Codex"]]]
      : [["codex", []], ["xdg-open", ["codex:"]]];
  const errors: string[] = [];
  for (const [command, args] of attempts) {
    try {
      await execFileAsync(command, args, { timeout: 8_000 });
      return { ok: true };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { ok: false, detail: errors.at(-1) ?? "순정 Codex 앱을 열 수 없습니다." };
}

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 19, y: 19 },
    backgroundColor: "#181818",
    icon: appIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  // Capture the embedded browser's guest WebContents for one control path.
  windowRef.webContents.on("did-attach-webview", (_event, guest) => browserView.attach(guest));
  windowRef.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    windowRef?.hide();
  });
  windowRef.on("closed", () => {
    windowRef = undefined;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) windowRef.loadURL(devUrl);
  else windowRef.loadFile(join(__dirname, "../dist/index.html"));
}

// app-server thread/read returns pasted images as deleted temp paths; restore
// their pixels from the rollout base64 (in message order) so they still render.
async function enrichThreadImages(threadId: string, items: ThreadHistoryItem[]): Promise<ThreadHistoryItem[]> {
  const needsUrl = items.some((item) => item.attachments?.some((att: ThreadAttachment) => att.kind === "image" && !att.url));
  if (!needsUrl) return items;
  const urls = await providerReconciler.getRolloutImageUrls(threadId).catch(() => [] as string[]);
  if (!urls.length) return items;
  let index = 0;
  return items.map((item) => {
    if (!item.attachments?.length) return item;
    const attachments = item.attachments.map((att: ThreadAttachment) => {
      if (att.kind !== "image" || att.url) return att;
      const url = urls[index++];
      return url ? { ...att, url } : att;
    });
    return { ...item, attachments };
  });
}

function baseServerCwd(): string {
  // Packaged builds must not use the app.asar path as the default workspace;
  // fall back to the user's home directory (dev keeps the project dir).
  return app.isPackaged ? app.getPath("home") : app.getAppPath();
}

function scopedAppServerEvent(instance: CodexAppServer, event: AppServerEvent): AppServerEvent {
  const threadId = appServerThreadIds.get(instance);
  if (!threadId) return event;
  const params = event.params && typeof event.params === "object" ? event.params as Record<string, unknown> : {};
  if (params.threadId) return event;
  return { ...event, params: { ...params, threadId } };
}

function attachAppServerEvents(instance: CodexAppServer, reportStatus: boolean): CodexAppServer {
  if (reportStatus) instance.on("status", (status) => sendToRenderer("app-server:status", status));
  instance.on("diagnostic", (line: string) => recordAppServerStderr(line));
  instance.on("event", (event) => {
    const scoped = scopedAppServerEvent(instance, event);
    if (scoped.requestId !== undefined && (scoped.method === "item/commandExecution/requestApproval" || scoped.method === "item/fileChange/requestApproval")) {
      approvalRequestServers.set(String(scoped.requestId), instance);
    }
    sendToRenderer("app-server:event", scoped);
    handleAppServerEvent(scoped);
  });
  return instance;
}

function createAppServer(reportStatus = false): CodexAppServer {
  return attachAppServerEvents(new CodexAppServer(baseServerCwd()), reportStatus);
}

function server(): CodexAppServer {
  if (appServer) return appServer;
  appServer = createAppServer(true);
  return appServer;
}

function restartAppServer(): void {
  appServer?.dispose();
  appServer = undefined;
  // Turns run on per-thread servers; dropping only the global one would leave
  // them holding stale auth/config (e.g. after a re-login). Clear them too so
  // the next turn spawns a fresh child that reloads ~/.codex auth.
  for (const instance of threadServers.values()) instance.dispose();
  threadServers.clear();
  threadServerLastUsed.clear();
  activeThreadServerTurns.clear();
  approvalRequestServers.clear();
  loadedThreads.clear();
}

// Resume an existing thread on its server when that server is fresh (after a
// restart/prune), so a turn can be sent. No-op once the thread is loaded.
async function ensureThreadLoaded(input: { threadId: string; model: string; cwd?: string; modelProvider?: string }): Promise<void> {
  await repairMirroredRolloutJsonl(input.threadId).catch(() => undefined);
  if (loadedThreads.has(input.threadId)) return;
  await (await threadServerFor(input.threadId)).resumeThread({
    id: input.threadId,
    model: input.model,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
  });
  loadedThreads.add(input.threadId);
}

function touchThreadServer(threadId: string): void {
  if (threadId) threadServerLastUsed.set(threadId, Date.now());
}

function pruneThreadServers(): void {
  if (threadServers.size <= MAX_THREAD_APP_SERVERS) return;
  const idle = [...threadServers.keys()]
    .filter((threadId) => !activeThreadServerTurns.has(threadId))
    .sort((a, b) => (threadServerLastUsed.get(a) ?? 0) - (threadServerLastUsed.get(b) ?? 0));
  for (const threadId of idle) {
    if (threadServers.size <= MAX_THREAD_APP_SERVERS) break;
    threadServers.get(threadId)?.dispose();
    threadServers.delete(threadId);
    threadServerLastUsed.delete(threadId);
    loadedThreads.delete(threadId);
  }
}

function bindThreadServer(threadId: string, instance: CodexAppServer): CodexAppServer {
  const previous = threadServers.get(threadId);
  if (previous && previous !== instance) previous.dispose();
  threadServers.set(threadId, instance);
  appServerThreadIds.set(instance, threadId);
  touchThreadServer(threadId);
  pruneThreadServers();
  return instance;
}

function threadServer(threadId: string): CodexAppServer {
  const existing = threadServers.get(threadId);
  if (existing) {
    touchThreadServer(threadId);
    return existing;
  }
  return bindThreadServer(threadId, createAppServer(false));
}

async function threadServerFor(threadId: string): Promise<CodexAppServer> {
  const existing = threadServers.get(threadId);
  if (existing) {
    touchThreadServer(threadId);
    return existing;
  }
  return bindThreadServer(threadId, createAppServer(false));
}

async function restartThreadServer(threadId: string): Promise<CodexAppServer> {
  threadServers.get(threadId)?.dispose();
  threadServerLastUsed.delete(threadId);
  loadedThreads.delete(threadId);
  return bindThreadServer(threadId, createAppServer(false));
}

// A newer stock-Codex rollout can't be deserialized by an older bundled codex
// binary (app-server throws "rollout does not start with session metadata" /
// "thread-store internal error"). Detect that so we surface an actionable
// "update Devil Codex" notice instead of a silently empty/desynced thread.
function isRolloutVersionSkew(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not start with session metadata|thread-store internal error/i.test(message);
}
function rolloutSkewNotice(): ThreadHistoryItem {
  return { id: "rollout-version-skew", kind: "system", text: "이 대화는 더 최신 버전의 Codex로 작성되어, 현재 Devil Codex에 번들된 codex 버전으로는 열 수 없습니다. Devil Codex를 최신 버전으로 업데이트하면 동기화됩니다." };
}

const EDITED_USER_MESSAGE_MARKER = "[수정된 사용자 메시지]";
const EDITED_CONTINUATION_PREFIX = "아래는 편집 지점 이전 대화입니다.";

function stripEditedContinuationText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const markerIndex = clean.lastIndexOf(EDITED_USER_MESSAGE_MARKER);
  if (markerIndex >= 0) return clean.slice(markerIndex + EDITED_USER_MESSAGE_MARKER.length).trim();
  if (!clean.startsWith(EDITED_CONTINUATION_PREFIX)) return clean;
  const lastUserIndex = clean.lastIndexOf("사용자:");
  if (lastUserIndex > EDITED_CONTINUATION_PREFIX.length) return clean.slice(lastUserIndex + "사용자:".length).trim();
  return "수정된 대화";
}

function compactThreadText(text: string, fallback: string, maxLength: number): string {
  const clean = stripEditedContinuationText(text) || fallback;
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function titleFromText(text: string): string {
  return compactThreadText(text, "새 채팅", 60);
}

function previewFromText(text: string): string {
  return compactThreadText(text, "", 80);
}

async function externalThreadTitle(threadId: string, fallbackText: string): Promise<string | undefined> {
  const local = await providerTranscripts.read(threadId).catch(() => []);
  if (local.some((item) => item.kind === "user")) return undefined;
  const native = await server().readThread({ id: threadId }).catch(() => []);
  return titleFromText(native.find((item) => item.kind === "user")?.text ?? fallbackText);
}

function terminals(): TerminalManager {
  if (!terminalManager) terminalManager = new TerminalManager((payload) => sendToRenderer("terminal:data", payload));
  return terminalManager;
}

// Start the local Codex Responses proxy and register it as a non-default Codex
// model provider so external-model turns can run through the app-server.
function mcpScripts(): { script: string; computerScript: string; askScript: string } {
  const scriptDir = app.isPackaged
    ? join(process.resourcesPath, "scripts")
    : join(__dirname, "..", "scripts");
  return {
    script: join(scriptDir, "devil-browser-mcp.cjs"),
    computerScript: join(scriptDir, "devil-computer-mcp.cjs"),
    askScript: join(scriptDir, "devil-ask-mcp.cjs"),
  };
}

// Always-on "ask the user" MCP (independent of the Devil browser/computer
// toggle) so any model can pause and ask. Registered before the app-server
// (re)starts so it picks the tool up.
async function setupDevilAskMcp(): Promise<void> {
  try {
    const sock = await askControl.start();
    const { askScript } = mcpScripts();
    await registerDevilAskMcp({ execPath: process.execPath, script: askScript, sock, secret: askControlSecret });
    console.log(`[devil-codex ask] control server on ${sock}, MCP script ${askScript}`);
  } catch (error) {
    console.error("[devil-codex ask] FAILED to configure:", error instanceof Error ? error.message : error);
  }
}

async function setDevilMcpEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    browserControl.stop();
    desktopControl.stop();
    await unregisterDevilBrowserMcp();
    restartAppServer();
    console.log("[devil-codex mcp] disabled");
    return;
  }
  const sock = await browserControl.start();
  const computerSock = await desktopControl.start();
  const { script, computerScript } = mcpScripts();
  await registerDevilBrowserMcp({ execPath: process.execPath, script, sock, secret: browserControlSecret, computerScript, computerSock, computerSecret: desktopControlSecret });
  restartAppServer();
  console.log(`[devil-codex browser] control server on ${sock}, MCP script ${script}`);
  console.log(`[devil-codex computer] control server on ${computerSock}, MCP script ${computerScript}`);
}

async function claudeMcpConfig(options?: { browser?: boolean; computer?: boolean }): Promise<string | undefined> {
  const settings = await settingsStore.load().catch(() => null);
  const { script, computerScript, askScript } = mcpScripts();
  const mcpServers: Record<string, unknown> = {};

  try {
    const askSock = await askControl.start();
    mcpServers.devil_ask = {
      command: process.execPath,
      args: [askScript],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        DEVIL_ASK_SOCK: askSock,
        DEVIL_ASK_SECRET: askControlSecret,
      },
    };
  } catch (error) {
    console.warn("[devil-codex ask] Claude MCP disabled:", error instanceof Error ? error.message : error);
  }

  if (settings?.devilMcpEnabled || options?.browser || options?.computer) {
    try {
      const sock = await browserControl.start();
      const computerSock = await desktopControl.start();
      if (settings?.devilMcpEnabled || options?.browser) {
        mcpServers.devil_browser = {
          command: process.execPath,
          args: [script],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            DEVIL_BROWSER_SOCK: sock,
            DEVIL_BROWSER_SECRET: browserControlSecret,
          },
        };
      }
      if (settings?.devilMcpEnabled || options?.computer) {
        mcpServers.devil_computer = {
          command: process.execPath,
          args: [computerScript],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            DEVIL_COMPUTER_SOCK: computerSock,
            DEVIL_COMPUTER_SECRET: desktopControlSecret,
          },
        };
      }
    } catch (error) {
      console.warn("[devil-codex mcp] Claude browser/computer MCP disabled:", error instanceof Error ? error.message : error);
    }
  }

  return Object.keys(mcpServers).length ? JSON.stringify({ mcpServers }) : undefined;
}

async function startCodexProxy(): Promise<void> {
  try {
    const port = await codexProxy.start();
    await registerDevilProvider(port, codexProxy.secretToken());
  } catch (error) {
    console.error("[devil-codex proxy]", error instanceof Error ? error.message : error);
  }
  await setupDevilAskMcp();
  try {
    const settings = await settingsStore.load();
    await setDevilMcpEnabled(settings.devilMcpEnabled);
  } catch (error) {
    console.error("[devil-codex mcp] FAILED to configure:", error instanceof Error ? error.message : error);
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  configureMenu();
  // Provider/MCP registration can touch config, sockets, and named pipes. Keep
  // it off the critical startup path so a slow helper never blocks the window
  // or the primary Codex app-server connection.
  void startCodexProxy().catch((error) => console.error("[devil-codex startup]", error instanceof Error ? error.message : error));
  void (async () => {
    const pending = await providerReconciler.reconcilePending();
    if (pending.attempted && pending.failed) console.warn("[devil-codex reconcile] pending recovery incomplete", pending);
    // A forced stop can leave a thread permanently tagged with the temporary
    // "devil" provider even after the pending journal is gone. Sweep those on
    // startup so stock Codex keeps listing the thread.
    const lingering = await providerReconciler.recoverLingeringDevilThreads();
    if (lingering.attempted && lingering.failed) console.warn("[devil-codex reconcile] lingering recovery incomplete", lingering);
  })().catch((error) => console.warn("[devil-codex reconcile]", error instanceof Error ? error.message : error));

  ipcMain.handle("app:info", () => ({ version: app.getVersion(), platform: process.platform }));
  // Open the relevant macOS privacy pane (or browser-extension help) so the user
  // can grant Computer Use / browser control permissions, like stock Codex does.
  ipcMain.handle("app:open-permission", (_event, input: { kind: "accessibility" | "screen-recording" | "automation" | "browser-extension" }) => {
    const panes: Record<string, string> = {
      accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    };
    if (input.kind === "browser-extension") return shell.openExternal("https://chromewebstore.google.com/");
    if (process.platform === "darwin" && panes[input.kind]) return shell.openExternal(panes[input.kind]);
    return undefined;
  });
  ipcMain.handle("app:window-control", (_event, input: { action: "close" | "minimize" | "maximize" | "quit" }) => {
    const target = BrowserWindow.getFocusedWindow() ?? windowRef;
    if (input.action === "quit") {
      quitApp();
      return;
    }
    if (!target) return;
    if (input.action === "close") target.close();
    if (input.action === "minimize") target.minimize();
    if (input.action === "maximize") {
      if (target.isMaximized()) target.unmaximize();
      else target.maximize();
    }
  });
  ipcMain.handle("browser:navigate", (_event, input: { url: string }) => browserView.navigate(input.url));
  ipcMain.handle("browser:back", () => browserView.goBack());
  ipcMain.handle("browser:forward", () => browserView.goForward());
  ipcMain.handle("browser:reload", () => browserView.reload());
  ipcMain.handle("browser:hard-reload", () => browserView.hardReload());
  ipcMain.handle("browser:stop", () => browserView.stop());
  ipcMain.handle("browser:state", () => browserView.state());
  ipcMain.handle("browser:screenshot", () => browserView.screenshot());
  ipcMain.handle("browser:find", (_event, input: { text: string; forward?: boolean; findNext?: boolean }) => browserView.find(input.text, { forward: input.forward, findNext: input.findNext }));
  ipcMain.handle("browser:stop-find", () => browserView.stopFind());
  ipcMain.handle("browser:zoom", (_event, input: { factor?: number; delta?: number; reset?: boolean }) => {
    if (input.reset) return browserView.setZoom(1);
    if (typeof input.factor === "number") return browserView.setZoom(input.factor);
    if (typeof input.delta === "number") return browserView.setZoom(browserView.getZoom() + input.delta);
    return browserView.getZoom();
  });
  ipcMain.handle("browser:clear-cookies", () => browserView.clearCookies());
  ipcMain.handle("browser:clear-cache", () => browserView.clearCache());
  ipcMain.handle("browser:capture-rect", (_event, input: { x: number; y: number; width: number; height: number }) => browserView.captureRect(input));
  ipcMain.handle("browser:ai-click", (_event, input: { x?: number; y?: number; selector?: string }) => browserView.aiClick(input));
  ipcMain.handle("browser:ai-type", (_event, input: { text: string }) => browserView.aiType(input.text));
  ipcMain.handle("browser:upload-files", (_event, input: { paths: string[] }) => browserView.uploadFiles(input.paths));
  ipcMain.handle("browser:ai-key", (_event, input: { key: string }) => browserView.aiKey(input.key));
  ipcMain.handle("browser:ai-scroll", (_event, input: { dy: number }) => browserView.aiScroll(input.dy));
  ipcMain.handle("browser:ai-read", () => browserView.aiReadText());
  ipcMain.handle("ask:respond", (_event, input: { id: string; answers: import("./ask-control-server.cjs").AskAnswerPayload[] | null }) => { askControl.resolve(input.id, input.answers); });
  ipcMain.handle("runtime:status", () => server().getStatus());
  ipcMain.handle("runtime:connect", () => {
    // Treat an explicit (re)connect as "reload everything": drop stale children
    // so fresh auth/config (e.g. after a Codex re-login) takes effect.
    restartAppServer();
    return server().connect();
  });
  ipcMain.handle("update:check", () => checkForUpdatesNow(() => windowRef));
  ipcMain.handle("update:install", () => installUpdate(() => windowRef));
  ipcMain.handle("subagent:info", (_event, input) => providerReconciler.getSubagentInfo(input.id));
  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("workspace:create-project-folder", async (_event, input?: { name?: string }) => {
    const base = join(app.getPath("home"), "Documents", "Codex", "Projects");
    await fsMkdir(base, { recursive: true });
    const dir = await uniqueProjectDir(base, safeProjectName(input?.name));
    await fsMkdir(dir, { recursive: true });
    return dir;
  });
  ipcMain.handle("workspace:changes", (_event, input) => getWorkspaceChanges(input.cwd));
  ipcMain.handle("workspace:diff", (_event, input) => getWorkspaceDiff(input.cwd, input.path));
  ipcMain.handle("workspace:list-directory", (_event, input) => listWorkspaceDirectory(input.cwd, input.path));
  ipcMain.handle("workspace:read-file", (_event, input) => readWorkspaceEntry(input.cwd, input.path));
  ipcMain.handle("workspace:find-file", (_event, input) => findWorkspaceFile(input.cwd, input.query));
  ipcMain.handle("workspace:list-open-targets", () => listOpenWorkspaceTargets());
  ipcMain.handle("file:preview-image", (_event, input) => previewLocalImage(input.path));
  ipcMain.handle("app:open-native-codex", () => openNativeCodex());
  ipcMain.handle("app:open-external-url", async (_event, input) => {
    const url = String(input?.url ?? "");
    if (!/^https?:\/\//i.test(url)) throw new Error("지원하지 않는 URL입니다.");
    await shell.openExternal(url);
  });
  ipcMain.handle("terminal:create", (_event, input) => terminals().create(input.cwd, input.cols, input.rows));
  ipcMain.handle("terminal:write", (_event, input) => terminals().write(input.id, input.data));
  ipcMain.handle("terminal:resize", (_event, input) => terminals().resize(input.id, input.cols, input.rows));
  ipcMain.handle("terminal:close", (_event, input) => terminals().close(input.id));
  ipcMain.handle("translate:text", (_event, input: { text: string; to?: string; from?: string }) => translateText(input));
  ipcMain.handle("settings:load", () => settingsStore.load());
  ipcMain.handle("settings:save", async (_event, input) => {
    const previous = await settingsStore.load();
    const next = await settingsStore.save(input);
    if (previous.devilMcpEnabled !== next.devilMcpEnabled) await setDevilMcpEnabled(next.devilMcpEnabled);
    return next;
  });
  ipcMain.handle("providers:load", () => providerSettingsStore.load());
  ipcMain.handle("providers:select", (_event, input) => providerSettingsStore.select(input));
  ipcMain.handle("providers:save-key", async (_event, input) => {
    const saved = await providerSettingsStore.saveKey(input);
    try {
      return await providerModels.refresh(input.provider, saved.accountId ?? input.accountId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[devil-codex providers] model refresh after key save failed:", message);
      return saved;
    }
  });
  ipcMain.handle("providers:clear-key", (_event, input) => providerSettingsStore.clearKey(input.provider, input.accountId));
  ipcMain.handle("providers:refresh-models", (_event, input) => refreshProviderModels(input.provider, input.accountId));
  ipcMain.handle("providers:auth-status", () => combinedAuthStatus());
  ipcMain.handle("providers:login", async (_event, input) => {
    if (input.provider === "codex") { clearProviderUsageCache("codex"); codexCliLogin("codex"); return null; }
    if (input.provider === "antigravity") {
      return antigravityLogin(() => {
        clearProviderUsageCache("antigravity");
        void combinedAuthStatus().then((status) => sendToRenderer("provider:auth", status));
      });
    }
    const oauthProvider = input.provider === "claude" ? "claude-code" : "copilot";
    return oauthLogin(oauthProvider, () => {
      clearProviderUsageCache(input.provider === "claude" ? "claude-code" : "copilot");
      void combinedAuthStatus().then((status) => sendToRenderer("provider:auth", status));
    });
  });
  ipcMain.handle("providers:logout", async (_event, input) => {
    if (input.provider === "codex") { await codexCliLogout("codex"); clearProviderUsageCache("codex"); restartAppServer(); }
    else if (input.provider === "antigravity") {
      await antigravityLogout(input.accountId);
      clearProviderUsageCache("antigravity");
    }
    else {
      const provider = input.provider === "claude" ? "claude-code" : "copilot";
      await oauthLogout(provider, input.accountId);
      clearProviderUsageCache(provider);
    }
    const status = await combinedAuthStatus();
    sendToRenderer("provider:auth", status);
    return status;
  });
  ipcMain.handle("providers:oauth-models", (_event, input) => input.provider === "antigravity" ? antigravityModels(input.accountId) : oauthModels(input.provider, input.accountId));
  ipcMain.handle("providers:usage", async () => providerUsageReport(await combinedAuthStatus(), await providerSettingsStore.load()));
  ipcMain.handle("providers:request-log", () => codexProxy.requestLog());
  ipcMain.handle("workspace:open-external", (_event, input) => openWorkspaceExternal(input));
  ipcMain.handle("approval:respond", (_event, input: { requestId: string | number; decision: ApprovalDecision; threadId?: string }) => {
    // Approval requests are emitted by the per-thread app-server that's running
    // the turn. The decision must go back to THAT child's stdin — routing it to
    // the global server() leaves the command waiting forever (5-min hang on the
    // first command/file approval). Fall back to the global server only when no
    // live thread server matches.
    const requestKey = String(input.requestId);
    // Claude runtime canUseTool prompts share the same renderer dialog; their
    // request ids are claude-approval-* and resolve inside the runtime.
    if (claudeRuntime.respondApproval(requestKey, input.decision)) return;
    const target = approvalRequestServers.get(requestKey) ?? (input.threadId ? threadServers.get(input.threadId) : undefined) ?? server();
    approvalRequestServers.delete(requestKey);
    return target.respondApproval(input);
  });
  ipcMain.handle("thread:create", async (_event, input) => {
    if (requestedRuntime(input.runtime) === "claude-code") {
      const model = input.model || "sonnet";
      const provider = input.provider && input.provider !== "codex" ? input.provider : "claude-code";
      const thread = provider === "claude-code"
        ? claudeRuntime.createThread({ cwd: input.cwd, model })
        : { id: crypto.randomUUID(), cwd: input.cwd, model, runtime: "claude-code", provider };
      const accountLabel = provider !== "claude-code" ? await providerAccountLabel(provider, input.accountId) : undefined;
      await providerTranscripts.saveMeta({
        ...thread,
        runtime: "claude-code",
        provider,
        accountId: input.accountId,
        accountLabel,
        title: provider === "claude-code" ? "새 Claude Code 채팅" : "새 외부 모델 채팅",
        preview: "",
        updatedAt: Date.now(),
        archived: false,
      });
      return thread;
    }
    const instance = createAppServer(false);
    let bound = false;
    try {
      if (usesCodexProxy(input.provider)) {
        const routedModel = routedProviderModel(input.provider, input.model, input.accountId);
        const thread = await instance.createThread({ ...input, model: routedModel, modelProvider: "devil" });
        bindThreadServer(thread.id, instance);
        bound = true;
        loadedThreads.add(thread.id);
        await providerTranscripts.saveMeta({ ...thread, provider: input.provider, accountId: input.accountId, accountLabel: await providerAccountLabel(input.provider, input.accountId), title: "새 채팅", preview: "", updatedAt: Date.now(), archived: false });
        return { ...thread, runtime: "codex", provider: input.provider };
      }
      // API-key providers still use the established local transcript path until
      // their Responses adapters are registered with the local proxy as well.
      const thread = await instance.createThread({ ...input, model: input.provider && input.provider !== "codex" ? "gpt-5.4" : input.model });
      bindThreadServer(thread.id, instance);
      bound = true;
      loadedThreads.add(thread.id);
      return { ...thread, provider: input.provider ?? "codex" };
    } catch (error) {
      if (!bound) instance.dispose();
      throw error;
    }
  });
  ipcMain.handle("thread:list", async (_event, input) => {
    const runtime = requestedRuntime(input.runtime);
    if (runtime === "claude-code") {
      const requestedCwd = cwdKey(input.cwd);
      return filterRuntime((await providerTranscripts.summaries()).filter((summary) => cwdKey(summary.cwd) === requestedCwd && summary.archived === (input.archived ?? false)), "claude-code");
    }
    // Codex can still be booting while the renderer asks for a sidebar refresh.
    // Devil's own durable index must remain visible in that short window.
    const [codex, external] = await Promise.all([server().listThreads(input).catch(() => []), providerTranscripts.summaries()]);
    const requestedCwd = cwdKey(input.cwd);
    const extra = filterRuntime(external, "codex").filter((summary) => cwdKey(summary.cwd) === requestedCwd && summary.archived === (input.archived ?? false));
    const ids = new Set(extra.map((summary) => summary.id));
    const merged = [...extra, ...annotateCodexSummaries(codex.filter((summary) => !ids.has(summary.id)))];
    sortThreadsByRecency(merged);
    return applySessionIndexTitles(merged);
  });
  // Model discovery is optional at startup. The provider settings UI retains
  // its saved models while Codex's app-server finishes connecting.
  ipcMain.handle("codex:models", () => server().listModels().catch(() => []));
  ipcMain.handle("chat:new-chat-cwd", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(app.getPath("home"), "Documents", "Codex", date, "new-chat");
    await fsMkdir(dir, { recursive: true }).catch(() => undefined);
    return dir;
  });
  ipcMain.handle("thread:search", async (_event, input) => {
    if (requestedRuntime(input.runtime) === "claude-code") {
      const query = String(input.query ?? "").trim().toLowerCase();
      if (!query) return [];
      return filterRuntime(await providerTranscripts.summaries(), "claude-code")
        .filter((summary) => summary.archived === (input.archived ?? false))
        .filter((summary) => `${summary.title}\n${summary.preview}\n${summary.cwd}`.toLowerCase().includes(query));
    }
    return applySessionIndexTitles(annotateCodexSummaries(await server().searchThreads(input)));
  });
  ipcMain.handle("thread:resume", async (_event, input) => {
    if (requestedRuntime(input.runtime) === "claude-code") {
      const meta = filterRuntime(await providerTranscripts.summaries(), "claude-code").find((summary) => summary.id === input.id);
      return { ...claudeRuntime.resumeThread({ id: input.id, cwd: meta?.cwd, model: meta?.model || input.model || "sonnet" }), claudeSessionId: meta?.claudeSessionId };
    }
    if (await providerTranscripts.isExternal(input.id)) {
      const meta = (await providerTranscripts.summaries()).find((summary) => summary.id === input.id);
      // Provider thread still has a native Codex shell from `thread/start`.
      // Resume it opportunistically so Codex app-server can load its mirror,
      // but never block Devil's local transcript if Codex rejects that shell.
      await threadServer(input.id).resumeThread(input).then(() => loadedThreads.add(input.id)).catch(() => undefined);
      return { id: input.id, cwd: meta?.cwd ?? "", model: meta?.model || input.model };
    }
    const instance = await threadServerFor(input.id);
    const ref = await instance.resumeThread(input);
    loadedThreads.add(input.id);
    return { ...ref, provider: "codex" };
  });
  ipcMain.handle("thread:rename", async (_event, input) => {
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("채팅 이름을 입력하세요.");
    const meta = (await providerTranscripts.summaries()).find((summary) => summary.id === input.id);
    const runtime = threadRuntime(meta ?? { id: input.id, cwd: "", model: "", title: "", preview: "", updatedAt: 0, archived: false });
    const external = await providerTranscripts.isExternal(input.id);
    const saveExternalTitle = async (): Promise<void> => {
      await providerTranscripts.saveMeta({
        id: input.id,
        title: name,
        cwd: input.cwd ?? "",
        model: input.model ?? "",
        preview: input.preview ?? "",
        updatedAt: Date.now(),
        archived: false,
      });
    };

    let nativeRenameError: unknown;
    if (runtime === "codex") {
      try { await (threadServers.get(input.id) ?? server()).renameThread({ id: input.id, name }); }
      catch (error) { nativeRenameError = error; }
    }

    if (nativeRenameError) {
      try { await providerReconciler.renameThreadTitle({ threadId: input.id, title: name }); }
      catch (error) {
        if (!external) throw error;
      }
    }

    if (external || runtime === "claude-code") {
      await saveExternalTitle();
    }
  });
  ipcMain.handle("thread:fork", (_event, input) => server().forkThread(input));
  ipcMain.handle("thread:compact", async (_event, input: { id: string; cwd?: string; model: string; accountId?: string }) => {
    const meta = (await providerTranscripts.summaries()).find((summary) => summary.id === input.id);
    if (threadRuntime(meta ?? { id: input.id, cwd: "", model: "", title: "", preview: "", updatedAt: 0, archived: false }) === "claude-code") {
      throw new Error("Claude Code runtime은 Codex app-server 압축을 지원하지 않습니다.");
    }
    await ensureThreadLoaded({ threadId: input.id, cwd: input.cwd, model: input.model });
    await (await threadServerFor(input.id)).compactThread({ threadId: input.id });
  });
  ipcMain.handle("thread:read", async (_event, input) => {
    if (requestedRuntime(input.runtime) === "claude-code") return providerTranscripts.read(input.id);
    await repairMirroredRolloutJsonl(input.id).catch(() => undefined);
    // External threads render from Devil's local transcript. BUT a mostly-native
    // thread that took even one stray external turn is flagged external forever
    // (providerTurns.length > 0) — and then this branch would hide its full
    // native rollout, showing only the handful of locally stored items while
    // stock Codex still has the whole conversation. Prefer the native rollout
    // whenever it has more items (the merge preserves local attachments); fall
    // back to local if the app-server hasn't loaded the mirror yet.
    if (await providerTranscripts.isExternal(input.id)) {
      const local = await providerTranscripts.read(input.id);
      let native: ThreadHistoryItem[] = [];
      try { native = await server().readThread(input); }
      catch (error) { if (isRolloutVersionSkew(error) && local.length === 0) return [rolloutSkewNotice()]; }
      if (native.length > local.length) {
        return attachCodexTokenUsage(input.id, stripInternalDirectivesFromHistory(await enrichThreadImages(input.id, await providerTranscripts.mergeHistoryPreservingAttachments(input.id, stripInternalDirectivesFromHistory(native)))));
      }
      return attachCodexTokenUsage(input.id, stripInternalDirectivesFromHistory(local));
    }
    try {
      const rollout = await enrichThreadImages(input.id, await (await threadServerFor(input.id)).readThread(input));
      const cached = await historyCache.load(input.id);
      const merged = rollout.length ? mergeCachedActivities(rollout, cached) : cached ?? rollout;
      return attachCodexTokenUsage(input.id, stripInternalDirectivesFromHistory(merged));
    } catch (error) {
      if (isRolloutVersionSkew(error)) return [rolloutSkewNotice()];
      throw error;
    }
  });
  ipcMain.handle("thread:cache-history", async (_event, input) => {
    const items = stripInternalDirectivesFromHistory(input.items);
    if (requestedRuntime(input.runtime) === "claude-code" || await providerTranscripts.isExternal(input.id)) await providerTranscripts.replaceHistory(input.id, items);
    else await historyCache.save(input.id, items);
  });
  ipcMain.handle("thread:sync-history", async (_event, input) => {
    if (requestedRuntime(input.runtime) === "claude-code") return providerTranscripts.read(input.id);
    await repairMirroredRolloutJsonl(input.id).catch(() => undefined);
    if (!(await providerTranscripts.isExternal(input.id))) {
      const rollout = await enrichThreadImages(input.id, await (await threadServerFor(input.id)).readThread(input));
      const cached = await historyCache.load(input.id);
      const merged = rollout.length ? mergeCachedActivities(rollout, cached) : cached ?? rollout;
      return attachCodexTokenUsage(input.id, stripInternalDirectivesFromHistory(merged));
    }
    const local = await providerTranscripts.read(input.id);
    const native = await server().readThread(input).catch(() => []);
    if (native.length > local.length) {
      return attachCodexTokenUsage(input.id, stripInternalDirectivesFromHistory(await providerTranscripts.mergeHistoryPreservingAttachments(input.id, stripInternalDirectivesFromHistory(native))));
    }
    return attachCodexTokenUsage(input.id, stripInternalDirectivesFromHistory(local));
  });
  ipcMain.handle("thread:projects", async (_event, input) => {
    const archived = (input ?? {}).archived ?? false;
    const runtime = requestedRuntime((input ?? {}).runtime);
    if (runtime === "claude-code") return filterRuntime(await providerTranscripts.summaries(), "claude-code").filter((summary) => summary.archived === archived);
    const [codex, external] = await Promise.all([server().listProjects(input ?? {}).catch(() => []), providerTranscripts.summaries()]);
    const extra = filterRuntime(external, "codex").filter((summary) => summary.archived === archived);
    const ids = new Set(extra.map((summary) => summary.id));
    const merged = [...extra, ...annotateCodexSummaries(codex.filter((summary) => !ids.has(summary.id)))];
    sortThreadsByRecency(merged);
    return applySessionIndexTitles(merged);
  });
  ipcMain.handle("thread:archive", async (_event, input) => {
    const meta = (await providerTranscripts.summaries()).find((summary) => summary.id === input.id);
    if (threadRuntime(meta ?? { id: input.id, cwd: "", model: "", title: "", preview: "", updatedAt: 0, archived: false }) === "claude-code") {
      await providerTranscripts.archive(input.id);
      return;
    }
    const external = await providerTranscripts.isExternal(input.id);
    let nativeError: unknown;
    try { await (await threadServerFor(input.id)).archiveThread(input); }
    catch (error) { nativeError = error; }
    if (external) {
      await providerTranscripts.archive(input.id);
      return;
    }
    if (nativeError) throw nativeError;
  });
  ipcMain.handle("thread:unarchive", async (_event, input) => {
    const meta = (await providerTranscripts.summaries()).find((summary) => summary.id === input.id);
    if (threadRuntime(meta ?? { id: input.id, cwd: "", model: "", title: "", preview: "", updatedAt: 0, archived: false }) === "claude-code") {
      await providerTranscripts.unarchive(input.id);
      return;
    }
    const external = await providerTranscripts.isExternal(input.id);
    let nativeError: unknown;
    try { await (await threadServerFor(input.id)).unarchiveThread(input); }
    catch (error) { nativeError = error; }
    if (external) {
      await providerTranscripts.unarchive(input.id);
      return;
    }
    if (nativeError) throw nativeError;
  });
  ipcMain.handle("thread:delete", async (_event, input) => {
    const meta = (await providerTranscripts.summaries()).find((summary) => summary.id === input.id);
    if (threadRuntime(meta ?? { id: input.id, cwd: "", model: "", title: "", preview: "", updatedAt: 0, archived: false }) === "claude-code") {
      await providerTranscripts.delete(input.id);
      return;
    }
    const external = await providerTranscripts.isExternal(input.id);
    let nativeError: unknown;
    try { await (await threadServerFor(input.id)).deleteThread(input); }
    catch (error) { nativeError = error; }
    if (external) {
      await providerTranscripts.delete(input.id);
      return;
    }
    if (nativeError) throw nativeError;
  });
  ipcMain.handle("workspace:undo-file-changes", async (_event, input) => undoFileChanges(input));
  ipcMain.handle("workspace:stage-files", async (_event, input) => stageWorkspaceFiles(input));
  ipcMain.handle("workspace:unstage-files", async (_event, input) => unstageWorkspaceFiles(input));
  ipcMain.handle("workspace:apply-hunk", async (_event, input) => applyWorkspaceHunk(input));
  ipcMain.handle("workspace:list-branches", async (_event, input) => listGitBranches(input));
  ipcMain.handle("workspace:switch-branch", async (_event, input) => switchGitBranch(input));
  ipcMain.handle("workspace:list-worktrees", async (_event, input) => listGitWorktrees(input));
  ipcMain.handle("workspace:create-worktree", async (_event, input) => createGitWorktree(input));
  ipcMain.handle("skills:list", async (_event, input) => server().listSkills(input));
  ipcMain.handle("mcp:list", async (_event, input) => server().listMcpServers(input));
  ipcMain.handle("mcp:call", async (_event, input) => server().callMcpTool(input));
  ipcMain.handle("feedback:upload", async (_event, input) => server().uploadFeedback(input));
  ipcMain.handle("workspace:commit", async (_event, input) => commitWorkspace(input));
  ipcMain.handle("workspace:push", async (_event, input) => pushWorkspace(input));
  ipcMain.handle("workspace:create-pr", async (_event, input) => createPullRequest(input));
  ipcMain.handle("turn:send", async (_event, input) => {
    const attachmentEnrichment = await enrichDocumentAttachments(input.attachmentDetails);
    // When the "English output" setting is on, force English responses for every
    // provider by appending a directive to the model-bound text only. Transcripts
    // store the raw input.text, so the visible user message stays untouched.
    const { englishOutput } = await settingsStore.load();
    const englishDirective = englishOutput ? `\n\n---\n${ENGLISH_OUTPUT_DIRECTIVE}` : "";
    const turnInput = {
      ...input,
      text: `${input.text}${attachmentEnrichment.context}${englishDirective}`,
      attachmentDetails: attachmentEnrichment.attachments,
    };
    if (requestedRuntime(input.runtime) === "claude-code") {
      const existingHistory = await providerTranscripts.read(input.threadId);
      const meta = filterRuntime(await providerTranscripts.summaries(), "claude-code").find((summary) => summary.id === input.threadId);
      const firstTurn = existingHistory.length === 0;
      const nativeSessionId = meta?.claudeSessionId;
      const resumeClaudeCode = Boolean(nativeSessionId) || hasClaudeCodeConversation(existingHistory);
      const provider = input.provider && input.provider !== "codex" ? input.provider : "claude-code";
      const accountLabel = provider !== "claude-code" ? await providerAccountLabel(provider, input.accountId) : undefined;
      await providerTranscripts.append(input.threadId, {
        id: crypto.randomUUID(),
        kind: "user",
        text: input.text,
        ...(attachmentEnrichment.attachments.length ? { attachments: attachmentEnrichment.attachments } : {}),
      });
      await providerTranscripts.saveMeta({
        id: input.threadId,
        cwd: input.cwd ?? "",
        model: input.model || "sonnet",
        runtime: "claude-code",
        provider,
        accountId: input.accountId,
        accountLabel,
        preview: previewFromText(input.text),
        updatedAt: Date.now(),
        archived: false,
        ...(firstTurn ? { title: titleFromText(input.text) } : {}),
      });
      await rememberTurnFileSnapshot(input.threadId, input.cwd);
      if (provider !== "claude-code") {
        const text = await providerRuntime.send({ ...turnInput, provider });
        await providerTranscripts.append(input.threadId, { id: crypto.randomUUID(), kind: "agent", text, runtime: "claude-code", provider, model: input.model, accountId: input.accountId });
        return;
      }
      const requestLogId = crypto.randomUUID();
      const requestStartedAt = Date.now();
      await codexProxy.recordRuntimeRequest({
        id: requestLogId,
        provider,
        model: input.model || "sonnet",
        accountId: input.accountId,
        accountLabel,
        threadId: input.threadId,
        route: "claude-agent-sdk",
        status: "started",
        startedAt: requestStartedAt,
        ...(input.attachments?.length ? { images: input.attachments.length } : {}),
      });
      try {
        const result = await claudeRuntime.sendTurn({
          threadId: input.threadId,
          cwd: input.cwd,
          text: turnInput.text,
          model: input.model || "sonnet",
          resume: resumeClaudeCode,
          nativeSessionId,
          attachments: input.attachments,
          mcpConfig: await claudeMcpConfig({
            browser: (input.skills ?? []).some((skill: { name?: string; path?: string }) => skill.name === "browser-use" || skill.path === "devil://claude-runtime/browser-use"),
            computer: (input.skills ?? []).some((skill: { name?: string; path?: string }) => skill.name === "computer-use" || skill.path === "devil://claude-runtime/computer-use"),
          }),
          approvalPolicy: input.approvalPolicy,
          sandboxMode: input.sandboxMode,
          // Save the native session id as soon as it is known so a turn that
          // fails midway can still resume the same Claude session on retry.
          onSessionId: (sessionId) => { void providerTranscripts.saveMeta({ id: input.threadId, claudeSessionId: sessionId }); },
          onCompleted: (text) => providerTranscripts.append(input.threadId, { id: crypto.randomUUID(), kind: "agent", text, runtime: "claude-code", provider, model: input.model || "sonnet", accountId: input.accountId }),
        });
        await codexProxy.finishRuntimeRequest(requestLogId, { status: "completed", completedAt: Date.now(), durationMs: Date.now() - requestStartedAt, ...(result.usage ? { usage: result.usage } : {}) });
        await emitSyntheticFileChanges({ threadId: input.threadId, turnId: result.turnId, status: "completed", mirrorRollout: false });
        if (result.sessionId) await providerTranscripts.saveMeta({ id: input.threadId, claudeSessionId: result.sessionId });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await codexProxy.finishRuntimeRequest(requestLogId, { status: "failed", completedAt: Date.now(), durationMs: Date.now() - requestStartedAt, error: detail });
        throw error;
      }
      return;
    }
    if (usesCodexProxy(input.provider)) {
      const routedModel = routedProviderModel(input.provider, input.model, input.accountId);
      const accountLabel = await providerAccountLabel(input.provider, input.accountId);
      // External providers use app-server tools and native rollout storage so stock Codex can see the turn after reconcile.
      await providerReconciler.markPending({ threadId: input.threadId, actualProvider: input.provider, actualModel: input.model });
      await providerTranscripts.recordProviderTurn({ threadId: input.threadId, provider: input.provider, model: input.model, accountId: input.accountId, accountLabel });
      try {
        // Existing thread: provider was flipped to "devil" → restart + resume so
        // the app-server routes this turn through the proxy. New thread: nothing
        // to patch (already created with modelProvider:"devil") → just proceed.
        const switched = await providerReconciler.prepareExternalTurn(input.threadId);
        if (switched) {
          await (await restartThreadServer(input.threadId)).resumeThread({ id: input.threadId, model: routedModel, modelProvider: "devil", cwd: input.cwd }).then(() => loadedThreads.add(input.threadId)).catch(() => undefined);
        } else {
          // Thread server may be fresh (after a restart/prune) — resume so the
          // rollout is loaded before the turn, else "thread not found".
          await ensureThreadLoaded({ threadId: input.threadId, model: routedModel, cwd: input.cwd, modelProvider: "devil" });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await providerReconciler.discardPending(input.threadId);
        await providerTranscripts.markLatestProviderTurnSync(input.threadId, "failed", detail);
        throw error;
      }
      try {
        // Subagent side-chat turns continue a child thread; do not register them
        // as a top-level Devil sidebar conversation (matches stock Codex, where
        // subagents are hidden children, not new chats).
        if (!input.subagent) {
          const title = await externalThreadTitle(input.threadId, input.text);
          await providerTranscripts.append(input.threadId, {
            id: crypto.randomUUID(),
            kind: "user",
            text: input.text,
            ...(attachmentEnrichment.attachments.length ? { attachments: attachmentEnrichment.attachments } : {}),
          });
          await providerTranscripts.saveMeta({
            id: input.threadId,
            cwd: input.cwd ?? "",
            model: input.model,
            provider: input.provider,
            accountId: input.accountId,
            accountLabel,
            preview: previewFromText(input.text),
            updatedAt: Date.now(),
            ...(title ? { title } : {}),
          });
        }
        pendingProviderDiagnostics.set(input.threadId, { provider: input.provider, model: input.model, accountId: input.accountId, accountLabel, sidecars: input.sidecars, sandboxMode: input.sandboxMode, approvalPolicy: input.approvalPolicy, cwd: input.cwd });
        codexProxy.setSidecarSettings(input.threadId, input.sidecars);
        await rememberTurnFileSnapshot(input.threadId, input.cwd);
        await threadServer(input.threadId).sendTurn({ ...turnInput, model: routedModel });
      } catch (error) {
        await providerReconciler.discardPending(input.threadId);
        const detail = error instanceof Error ? error.message : String(error);
        await providerTranscripts.markLatestProviderTurnSync(input.threadId, "failed", detail);
        const pendingDiagnostics = pendingProviderDiagnostics.get(input.threadId);
        pendingProviderDiagnostics.delete(input.threadId);
        const sidecarActual = codexProxy.consumeSidecarStats(input.threadId);
        emitSidecarActivities({ threadId: input.threadId, sidecarActual });
        emitProviderDiagnostics({
          threadId: input.threadId,
          provider: pendingDiagnostics?.provider ?? input.provider,
          model: pendingDiagnostics?.model ?? input.model,
          accountLabel: pendingDiagnostics?.accountLabel,
          status: "failed",
          error: detail,
          sidecars: pendingDiagnostics?.sidecars ?? input.sidecars,
          sidecarActual,
          sandboxMode: pendingDiagnostics?.sandboxMode ?? input.sandboxMode,
          approvalPolicy: pendingDiagnostics?.approvalPolicy ?? input.approvalPolicy,
        });
        throw error;
      }
      return;
    }
    if (input.provider && input.provider !== "codex") {
      const firstTurn = !(await providerTranscripts.isExternal(input.threadId));
      const accountLabel = await providerAccountLabel(input.provider, input.accountId);
      await providerTranscripts.append(input.threadId, {
        id: crypto.randomUUID(),
        kind: "user",
        text: input.text,
        ...(attachmentEnrichment.attachments.length ? { attachments: attachmentEnrichment.attachments } : {}),
      });
      await providerTranscripts.saveMeta({
        id: input.threadId,
        cwd: input.cwd ?? "",
        model: input.model,
        provider: input.provider,
        accountId: input.accountId,
        accountLabel,
        preview: previewFromText(input.text),
        updatedAt: Date.now(),
        ...(firstTurn ? { title: titleFromText(input.text) } : {}),
      });
      const text = await providerRuntime.send(turnInput);
      await providerTranscripts.append(input.threadId, { id: crypto.randomUUID(), kind: "agent", text, runtime: "codex", provider: input.provider, model: input.model, accountId: input.accountId });
      return;
    }
    try {
      await rememberTurnFileSnapshot(input.threadId, input.cwd);
      await ensureThreadLoaded({ threadId: input.threadId, model: input.model, cwd: input.cwd });
      const instance = await threadServerFor(input.threadId);
      if (await maybeStartContextCompaction(instance, input)) return;
      pendingProviderDiagnostics.set(input.threadId, { provider: input.provider ?? "codex", model: input.model, sidecars: input.sidecars, sandboxMode: input.sandboxMode, approvalPolicy: input.approvalPolicy, cwd: input.cwd });
      codexProxy.setSidecarSettings(input.threadId, input.sidecars);
      await instance.sendTurn(turnInput);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const pendingDiagnostics = pendingProviderDiagnostics.get(input.threadId);
      pendingProviderDiagnostics.delete(input.threadId);
      const sidecarActual = codexProxy.consumeSidecarStats(input.threadId);
      emitSidecarActivities({ threadId: input.threadId, sidecarActual });
      emitProviderDiagnostics({
        threadId: input.threadId,
        provider: pendingDiagnostics?.provider ?? input.provider ?? "codex",
        model: pendingDiagnostics?.model ?? input.model,
        accountLabel: pendingDiagnostics?.accountLabel,
        status: "failed",
        error: detail,
        sidecars: pendingDiagnostics?.sidecars ?? input.sidecars,
        sidecarActual,
        sandboxMode: pendingDiagnostics?.sandboxMode ?? input.sandboxMode,
        approvalPolicy: pendingDiagnostics?.approvalPolicy ?? input.approvalPolicy,
      });
      throw error;
    }
  });
  ipcMain.handle("turn:interrupt", async (_event, input) => {
    if (requestedRuntime(input.runtime) === "claude-code") {
      if (claudeRuntime.interruptTurn(input)) return;
      if (providerRuntime.interrupt(input.threadId)) return;
      throw new Error("no active turn to interrupt");
    }
    if (providerRuntime.interrupt(input.threadId)) return;
    await threadServer(input.threadId).interruptTurn(input);
  });

  ipcHandlersReady = true;
  createBackgroundTray();
  if (showMainWindowWhenReady) showMainWindow();
  else createWindow();
  initAutoUpdate(() => windowRef);
  app.on("activate", () => showMainWindow());
});

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  trayRef?.destroy();
  trayRef = undefined;
  appServer?.dispose();
  for (const instance of threadServers.values()) instance.dispose();
  threadServers.clear();
  threadServerLastUsed.clear();
  activeThreadServerTurns.clear();
  terminalManager?.dispose();
  browserControl.stop(); // free 49874 so the next launch binds cleanly
  desktopControl.stop();
  askControl.stop();
  void unregisterDevilBrowserMcp();
  void unregisterDevilAskMcp();
  // Keep the managed provider block in ~/.codex/config.toml. Rollouts created
  // through it must remain recognisable to stock Codex after Devil exits.
  void codexProxy.stop();
});
