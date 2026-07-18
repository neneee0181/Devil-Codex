import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, MenuItemConstructorOptions, nativeImage, Notification, shell, Tray, type MessageBoxOptions } from "electron";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { access, mkdir as fsMkdir, readdir, readFile, stat as fsStat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { CodexAppServer, syncStockThreadPermissions } from "./app-server.cjs";
import { getWorkspaceChanges, getWorkspaceDiff } from "./git-status.cjs";
import { applyWorkspaceHunk, commitWorkspace, createPullRequest, listGitBranches, pushWorkspace, stageWorkspaceFiles, switchGitBranch, unstageWorkspaceFiles } from "./git-workflow.cjs";
import { undoFileChanges } from "./file-rollback.cjs";
import { createWorkspaceEntry, deleteWorkspaceEntry, findWorkspaceFile, listWorkspaceDirectory, previewLocalImage, readWorkspaceEntry, renameWorkspaceEntry, writeWorkspaceFile } from "./file-service.cjs";
import { WorkspaceWatcher } from "./workspace-watcher.cjs";
import { TerminalManager } from "./terminal-manager.cjs";
import { CodexSettingsStore } from "./codex-settings.cjs";
import { translateText } from "./translate.cjs";
import { capabilityFor, ProviderSettingsStore } from "./provider-settings.cjs";
import { ProviderRuntime } from "./provider-runtime.cjs";
import { ProviderModelCatalog } from "./provider-model-catalog.cjs";
import { ProviderTranscriptStore } from "./provider-transcript.cjs";
import { CodexProviderReconciler } from "./codex-provider-reconcile.cjs";
import { CodexProxyServer, DEVIL_PROXY_PORT, readDevilProxySecret } from "./proxy/proxy-server.cjs";
import { UnrealMcpRelay, unrealMcpRelayOptionsFromEnv } from "./unreal-mcp-relay.cjs";
import { selectConfiguredModelRows, syncNativeCodexCatalog, syncStockCodexCatalog } from "./codex-stock-catalog.cjs";
import { disableStockProxyAutostart, ensureStockProxyAutostart } from "./stock-proxy-autostart.cjs";
import { AsyncSerialQueue, persistAndApplyWithRollback } from "./settings-transaction.cjs";
import { ClaudeCodeRuntime } from "./claude-runtime.cjs";
import { enrichDocumentAttachments } from "./document-attachments.cjs";
import { initAutoUpdate, checkForUpdatesNow, installUpdate } from "./auto-update.cjs";
import { registerDevilProvider, registerDevilStockBridge, unregisterDevilStockBridge, registerDevilNativeCatalog, unregisterDevilNativeCatalog, registerDevilBrowserMcp, unregisterDevilBrowserMcp, devilBrowserMcpRegistration, disableStockBrowserPluginForDevil, restoreStockBrowserPluginForDevil, registerDevilAskMcp, unregisterDevilAskMcp, registerDevilSubagentMcp, unregisterDevilSubagentMcp } from "./codex-config.cjs";
import { BrowserControlServer } from "./browser-control-server.cjs";
import { DesktopControlManager } from "./desktop-control.cjs";
import { DesktopControlServer } from "./desktop-control-server.cjs";
import { AskControlServer, type AskAnswerPayload, type AskQuestionPayload } from "./ask-control-server.cjs";
import { SubagentControlServer, type SubagentDelegatePayload, type SubagentDelegateResult } from "./subagent-control-server.cjs";
import { RemoteAuthStore } from "./remote-auth.cjs";
import { RemoteServer } from "./remote-server.cjs";
import { TAILSCALE_DOWNLOAD_URL, TailscaleCli } from "./tailscale.cjs";
import { providerAuthStatus as codexCliStatus, providerLogin as codexCliLogin, providerLogout as codexCliLogout } from "./provider-auth.cjs";
import { oauthLogin, oauthLogout, oauthModels, oauthStatus } from "./provider-oauth.cjs";
import { antigravityLogin, antigravityLogout, antigravityModels, antigravityStatus } from "./provider-antigravity.cjs";
import { clearProviderUsageCache, providerUsageReport } from "./provider-usage.cjs";
import { appendMirroredRolloutEvents, repairMirroredRolloutJsonl } from "./codex-rollout-mirror.cjs";
import { attachCodexTokenSnapshot, attachRolloutFinalAnswers, readCodexTokenSnapshot } from "./codex-token-usage.cjs";
import { applySessionIndexTitles } from "./codex-session-index.cjs";
import { codexHome } from "./codex-home.cjs";
import type { AgentRuntimeId, AppServerEvent, ApprovalDecision, ClaudeSlashCommandInfo, CodexSettings, CodexSkillInfo, ContextUsage, DevilMcpStatus, ExternalTarget, McpServerInfo, OpenWorkspaceTarget, ProviderId, QueuedTurnView, RemoteControlMode, RemoteControlStatus, RemoteDevice, SidecarSettings, ThreadApprovalPolicy, ThreadAttachment, ThreadHistoryItem, ThreadMetaUpdate, ThreadQueueCommand, ThreadQueueState, ThreadSandboxMode, ThreadSummary, WorkspaceChange } from "./contracts.cjs";

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

function frontmatterValue(markdown: string, key: string): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return "";
  const line = match[1].split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim().replace(/^['"]|['"]$/g, "") : "";
}

async function readSkillDirectory(root: string, scope: string, namePrefix = ""): Promise<CodexSkillInfo[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry): Promise<CodexSkillInfo | null> => {
    const skillPath = join(root, entry.name, "SKILL.md");
    const markdown = await readFile(skillPath, "utf8").catch(() => "");
    if (!markdown) return null;
    const name = frontmatterValue(markdown, "name") || entry.name;
    const description = frontmatterValue(markdown, "description") || markdown.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("---"))?.trim() || "";
    return { name: namePrefix ? `${namePrefix}:${name}` : name, description, path: skillPath, scope, enabled: true };
  }));
  return skills.filter((skill): skill is CodexSkillInfo => Boolean(skill?.name && skill.path));
}

async function listClaudeSkills(): Promise<CodexSkillInfo[]> {
  const base = await readSkillDirectory(join(app.getPath("home"), ".claude", "skills"), "claude");
  // Installed Claude plugins carry their own skills/ directory; the CLI shows
  // them namespaced as `plugin:skill`, so mirror that naming here.
  const pluginSkills: CodexSkillInfo[] = [];
  try {
    const registryPath = join(app.getPath("home"), ".claude", "plugins", "installed_plugins.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    for (const [pluginKey, installs] of Object.entries(registry.plugins ?? {})) {
      const pluginName = pluginKey.split("@")[0] ?? pluginKey;
      const installPath = installs?.[installs.length - 1]?.installPath;
      if (!installPath) continue;
      pluginSkills.push(...await readSkillDirectory(join(installPath, "skills"), "claude-plugin", pluginName));
    }
  } catch { /* No plugin registry — base skills only. */ }
  const seen = new Set(base.map((skill) => skill.name));
  const merged = [...base, ...pluginSkills.filter((skill) => !seen.has(skill.name))];
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

async function listClaudeSlashCommands(input: { cwd?: string; model?: string } = {}): Promise<ClaudeSlashCommandInfo[]> {
  return claudeRuntime.listSlashCommands({ cwd: input.cwd, model: input.model });
}

// Codex desktop installs marketplace plugins (Notion, GitHub, ...) under
// ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/skills, but the CLI
// app-server's skills/list does not register them, so scan the cache directly.
async function listCodexPluginSkills(): Promise<CodexSkillInfo[]> {
  const cacheRoot = join(app.getPath("home"), ".codex", "plugins", "cache");
  const skills: CodexSkillInfo[] = [];
  const marketplaces = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) continue;
    const plugins = await readdir(join(cacheRoot, marketplace.name), { withFileTypes: true }).catch(() => []);
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const versions = await readdir(join(cacheRoot, marketplace.name, plugin.name), { withFileTypes: true }).catch(() => []);
      const version = versions.filter((entry) => entry.isDirectory()).at(-1);
      if (!version) continue;
      // Namespace every cached skill with its plugin name. The renderer groups
      // these as `@plugin`, while `$plugin:skill` remains available for a
      // single-skill selection.
      skills.push(...await readSkillDirectory(join(cacheRoot, marketplace.name, plugin.name, version.name, "skills"), "plugin", plugin.name));
    }
  }
  const seen = new Set<string>();
  return skills.filter((skill) => !seen.has(skill.name) && seen.add(skill.name)).sort((a, b) => a.name.localeCompare(b.name));
}

function mcpServerNamesFrom(source: unknown): string[] {
  if (!source || typeof source !== "object") return [];
  const servers = (source as { mcpServers?: Record<string, unknown> }).mcpServers;
  return servers && typeof servers === "object" ? Object.keys(servers) : [];
}

// Claude Code loads MCP servers from ~/.claude.json (global + per-project),
// the project's .mcp.json, and installed plugin .mcp.json files. List them so
// the composer's "/" menu can mention them like stock Codex does.
async function listClaudeMcpServers(input: { cwd?: string } = {}): Promise<McpServerInfo[]> {
  const home = app.getPath("home");
  const names = new Set<string>();
  try {
    const config = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
    for (const name of mcpServerNamesFrom(config)) names.add(name);
    if (input.cwd) for (const name of mcpServerNamesFrom(config.projects?.[input.cwd])) names.add(name);
  } catch { /* Missing config is fine. */ }
  if (input.cwd) {
    try {
      const project = JSON.parse(await readFile(join(input.cwd, ".mcp.json"), "utf8"));
      for (const name of mcpServerNamesFrom(project)) names.add(name);
    } catch { /* No project .mcp.json. */ }
  }
  try {
    const registryPath = join(home, ".claude", "plugins", "installed_plugins.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    for (const installs of Object.values(registry.plugins ?? {})) {
      const installPath = installs?.[installs.length - 1]?.installPath;
      if (!installPath) continue;
      try {
        const pluginMcp = JSON.parse(await readFile(join(installPath, ".mcp.json"), "utf8"));
        for (const name of mcpServerNamesFrom(pluginMcp)) names.add(name);
      } catch { /* Plugin without MCP config. */ }
    }
  } catch { /* No plugin registry. */ }
  return [...names].sort().map((name) => ({ name, authStatus: "unsupported", tools: [], resources: 0 }));
}
import { createGitWorktree, listGitWorktrees } from "./worktree-service.cjs";
import { BrowserViewManager } from "./browser-view.cjs";
import { ThreadHistoryCache, mergeCachedActivities, normalizeCachedDelegateSubagents } from "./history-cache.cjs";

loadEnv({ path: join(process.cwd(), ".env.local"), quiet: true });
app.setName("devil-codex");
if (process.platform === "win32") app.setAppUserModelId("dev.devilcodex.app");

const ENGLISH_OUTPUT_DIRECTIVE = "[Output language directive] Respond only in English, even when the user writes in another language. Do not translate code, identifiers, file paths, or shell commands.";
const DEVIL_ASK_USER_DIRECTIVE = [
  "[Question tool routing]",
  "When work can proceed with a reasonable default or the repository context makes the answer clear, do not ask the user; state the assumption briefly and continue.",
  "This is Default mode: the native `request_user_input` tool is unavailable here. Never call it.",
  "When a decision is genuinely ambiguous and changes the implementation path, data flow, architecture, security posture, cost, dependency choice, UX behavior, or deployment behavior, pause and call the `ask_user` tool from the `devil_ask` MCP server instead of asking in plain text.",
  "Use this only for concrete trade-offs or branch points the user must decide. Keep questions specific, multiple-choice, and limited to the smallest number needed.",
].join("\n");
const NATIVE_ASK_USER_DIRECTIVE = [
  "[Question tool routing]",
  "This turn is in native Codex Plan mode. For a genuinely ambiguous decision that needs the user's answer, use the native `request_user_input` tool.",
  "Do not call the `devil_ask` MCP on this turn. Continue with a reasonable default when the repository context makes the answer clear.",
].join("\n");
const MAX_MIRRORED_COMMAND_OUTPUT_CHARS = 20_000;
const MAX_MIRRORED_FILE_DIFF_CHARS = 40_000;

function truncateMirroredRolloutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[Devil Codex truncated ${text.length - maxChars} chars from mirrored rollout output to reduce future context usage.]\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

function stripInternalDirectives(text: string): string {
  const withoutDirectiveBlocks = text
    .replace(/\r\n/g, "\n")
    .replace(/^\[Devil Claude Code runtime tool instructions\][\s\S]*?\n\n/, "")
    .replace(/^Base directory for this skill:[\s\S]*?\n\n## User Request\n\n/, "")
    .replace(new RegExp(`\\n*---\\n${escapeRegExp(ENGLISH_OUTPUT_DIRECTIVE)}\\s*$`), "")
    .replace(new RegExp(`\\n*---\\n${escapeRegExp(DEVIL_ASK_USER_DIRECTIVE)}\\s*$`), "")
    .replace(new RegExp(`\\n*---\\n${escapeRegExp(NATIVE_ASK_USER_DIRECTIVE)}\\s*$`), "")
    .replace(/\n*---\n\[Question tool routing\][\s\S]*?(?=\n---\n|\n#|\n\d+\. |\n[A-Z][^\n]*:\n|$)/g, "")
    .trimEnd();
  return withoutDirectiveBlocks;
}

function isInternalContinuationSummary(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("This session is being continued from a previous conversation that ran out of context.")
    || normalized.startsWith("<task-notification")
    || normalized.startsWith("<scheduled-wakeup")
    || normalized.startsWith("<background-task");
}

function stripInternalDirectivesFromHistory(items: ThreadHistoryItem[]): ThreadHistoryItem[] {
  return items.flatMap((item) => {
    if (item.kind !== "user") return [item];
    if (isInternalContinuationSummary(item.text)) return [];
    return [{ ...item, text: stripInternalDirectives(item.text) }];
  });
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
const stockProxyServiceMode = process.argv.includes("--devil-stock-proxy");
const hasSingleInstanceLock = stockProxyServiceMode || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else if (!stockProxyServiceMode) {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

let windowRef: BrowserWindow | undefined;
let trayRef: Tray | undefined;
let isQuitting = false;
let desktopOwnsProxy = false;
let stockBridgeHandoffStarted = false;
let ipcHandlersReady = false;
type IpcHandler = (input: unknown) => Promise<unknown> | unknown;
const ipcHandlers = new Map<string, IpcHandler>();
function handle(channel: string, fn: IpcHandler): void {
  ipcHandlers.set(channel, fn);
  ipcMain.handle(channel, (_event, input) => fn(input));
}
let showMainWindowWhenReady = false;
const REMOTE_CONTROL_PORT = 49882;
const REMOTE_ALLOWED_CHANNELS = new Set<string>([
  "thread:list",
  "thread:read",
  "thread:create",
  "thread:resume",
  "thread:meta:update",
  "thread:projects",
  "thread:search",
  "thread:queue:get",
  "thread:active",
  "turn:queue:enqueue",
  "turn:queue:update",
  "turn:queue:remove",
  "turn:queue:steer",
  "turn:queue:clear",
  "turn:send",
  "turn:interrupt",
  "approval:respond",
  "ask:respond",
  "runtime:status",
  "runtime:connect",
  "providers:usage",
  "providers:load",
  "providers:select",
  "settings:load",
  "settings:update-permissions",
  "codex:models",
  "claude:slash-commands",
  "remote:status",
  "remote:scope",
]);
const REMOTE_ALLOWED_EVENTS = new Set<string>([
  "app-server:event",
  "ask:request",
  "app-server:status",
  "provider:usage-changed",
  "approval:resolved",
  "thread:meta-changed",
  "thread:queue-changed",
  "remote:status",
  "settings:changed",
  "provider:auth",
  "providers:changed",
]);
const FALLBACK_TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA1ElEQVQ4jcWTsQ2DMBBFXWUF/gCJFGELS5FSQsU4GYANQooMgESfCRAjQOnMQOLQM8BFtgJFoLBJkeJL9ln37mzfZ2EYbgBcAGgA5KgngNzkMrPwSPxWzsbKp92WrnzvC3ixcXOTgu7HAw3DMJPWmuq6piRJZhDmAhjVdR0JIdwBSilqmob6vp9iWZa5A9I0tWdRFE2Qoij8AQCobVsbK8vyDwAp5borKKVs5dWPOCx8I+fcH6C1pqqqKI7jxUEyxlg1ykEQPH4105l97GwgthNfO78BmdECbWW4kcMAAAAASUVORK5CYII=";
const historyCache = new ThreadHistoryCache();
const browserView = new BrowserViewManager((channel, payload) => sendToRenderer(channel, payload));
const workspaceWatcher = new WorkspaceWatcher((cwd) => sendToRenderer("workspace:fs-changed", { cwd }));
const browserControlSecret = randomBytes(24).toString("hex");
const desktopControlSecret = randomBytes(24).toString("hex");
const askControlSecret = randomBytes(24).toString("hex");
const subagentControlSecret = randomBytes(24).toString("hex");
const browserControl = new BrowserControlServer(browserView, browserControlSecret);
const desktopControl = new DesktopControlServer(new DesktopControlManager(), desktopControlSecret);
const askControl = new AskControlServer((channel, payload) => sendToRenderer(channel, payload), askControlSecret);
const subagentControl = new SubagentControlServer(delegateSubagentFromMcp, subagentControlSecret);
const CLAUDE_NATIVE_ASK_DIALOG_KINDS = ["askUserQuestion", "permission_ask_user_question"];
let appServer: CodexAppServer | undefined;
let remoteServer: RemoteServer | undefined;
let remoteAuthStore: RemoteAuthStore | undefined;
let remotePublicUrl: string | undefined;
let remoteLastError: string | undefined;
let remoteLastTailscaleStatus: Awaited<ReturnType<TailscaleCli["status"]>> | undefined;
let remoteProtocol: "http" | "https" = "http";
// Sync cache of settings.remoteAllowedThreadIds so sendToRenderer (called
// synchronously from many hot paths) can gate broadcasts without an await.
// Remote web is intentionally scoped to desktop-approved threads only.
// An empty set means the remote client can connect, but cannot list/read/create
// any thread until Settings -> 원격 제어 -> 허용 스레드 includes at least one.
let remoteAllowlistCache = new Set<string>();
const threadQueueSnapshots = new Map<string, QueuedTurnView[]>();
function applyRemoteAllowlistCache(settings: Pick<CodexSettings, "remoteAllowedThreadIds">): void {
  remoteAllowlistCache = new Set(settings.remoteAllowedThreadIds ?? []);
}
function remoteAccessDenied(): never {
  throw new Error("이 스레드는 원격 접속 허용 목록에 없습니다. 설정 -> 원격 제어 -> 허용 스레드에서 추가하세요.");
}
function filterRemoteAllowed<T extends { id: string }>(list: T[]): T[] {
  return list.filter((item) => remoteAllowlistCache.has(item.id));
}
function requireRemoteAllowed(id: string | undefined): void {
  if (!id || !remoteAllowlistCache.has(id)) remoteAccessDenied();
}

function sanitizeRemoteStatus(status: RemoteControlStatus): RemoteControlStatus {
  const { url: _url, qrDataUrl: _qrDataUrl, tailnetUrl: _tailnetUrl, tailnetQrDataUrl: _tailnetQrDataUrl, tokenPreview: _tokenPreview, ...safe } = status;
  return safe;
}

const remoteApprovalPolicies = new Set<ThreadApprovalPolicy>(["on-request", "never"]);
const remoteSandboxModes = new Set<ThreadSandboxMode>(["read-only", "workspace-write", "danger-full-access"]);
const remoteReasoningEfforts = new Set<CodexSettings["reasoningEffort"]>(["low", "medium", "high", "xhigh"]);
const remoteResponseSpeeds = new Set<CodexSettings["responseSpeed"]>(["standard", "fast"]);

function validRemoteSetting<T extends string>(values: Set<T>, value: unknown): T | undefined {
  return typeof value === "string" && values.has(value as T) ? value as T : undefined;
}
// Remote (phone/browser) clients dispatch through this map instead of the raw
// `ipcHandlers` the local renderer uses, so an active allowlist (Settings ->
// 원격 제어 -> 허용 스레드) can restrict a remote session to specific threads
// without touching local desktop access at all. Rebuilt fresh each time
// remote control (re)starts, by which point every handle() call below has
// already registered (see ipcHandlersReady ordering notes at startRemoteFromSettings).
function buildRemoteIpcHandlers(): Map<string, IpcHandler> {
  const remote = new Map(ipcHandlers);
  const wrapList = (channel: string): void => {
    const base = ipcHandlers.get(channel);
    if (!base) return;
    remote.set(channel, async (input) => {
      const result = await base(input);
      return Array.isArray(result) ? filterRemoteAllowed(result as Array<{ id: string }>) : result;
    });
  };
  const wrapSingle = (channel: string, idOf: (input: unknown) => string | undefined): void => {
    const base = ipcHandlers.get(channel);
    if (!base) return;
    remote.set(channel, async (input) => {
      requireRemoteAllowed(idOf(input));
      return base(input);
    });
  };
  wrapList("thread:list");
  wrapList("thread:search");
  wrapList("thread:projects");
  wrapSingle("thread:read", (input) => (input as { id?: string } | undefined)?.id);
  wrapSingle("thread:resume", (input) => (input as { id?: string } | undefined)?.id);
  wrapSingle("thread:meta:update", (input) => (input as { id?: string } | undefined)?.id);
  wrapSingle("thread:review", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("thread:queue:get", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("thread:active", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("turn:queue:enqueue", (input) => (input as { threadId?: string; entry?: { pending?: { threadId?: string } } } | undefined)?.threadId ?? (input as { entry?: { pending?: { threadId?: string } } } | undefined)?.entry?.pending?.threadId);
  wrapSingle("turn:queue:update", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("turn:queue:remove", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("turn:queue:steer", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("turn:queue:clear", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("turn:steer", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("turn:send", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("turn:interrupt", (input) => (input as { threadId?: string } | undefined)?.threadId);
  wrapSingle("approval:respond", (input) => (input as { threadId?: string } | undefined)?.threadId);
  remote.set("thread:create", async () => remoteAccessDenied());
  remote.set("remote:status", async () => sanitizeRemoteStatus(await remoteStatus()));
  remote.set("remote:scope", () => ({ restricted: true }));
  remote.set("providers:select", async (input) => {
    const saved = await providerSettingsStore.select(input as { provider: ProviderId; model: string; accountId?: string });
    await notifyProviderStateChanged((input as { provider?: ProviderId } | undefined)?.provider)
      .catch((error) => console.warn("[devil-codex providers] remote selection notification failed:", error instanceof Error ? error.message : error));
    return saved;
  });
  remote.set("settings:update-permissions", async (input) => {
    const current = await settingsStore.load();
    const request = isRecord(input) ? input : {};
    const next: CodexSettings = { ...current };
    const approvalPolicy = validRemoteSetting(remoteApprovalPolicies, request.approvalPolicy);
    const sandboxMode = validRemoteSetting(remoteSandboxModes, request.sandboxMode);
    const reasoningEffort = validRemoteSetting(remoteReasoningEfforts, request.reasoningEffort);
    const responseSpeed = validRemoteSetting(remoteResponseSpeeds, request.responseSpeed);
    if (approvalPolicy) next.approvalPolicy = approvalPolicy;
    if (sandboxMode) next.sandboxMode = sandboxMode;
    if (reasoningEffort) next.reasoningEffort = reasoningEffort;
    if (responseSpeed) next.responseSpeed = responseSpeed;
    const saved = await settingsStore.save(next);
    sendToRenderer("settings:changed", saved);
    return saved;
  });
  return remote;
}
const MAX_THREAD_APP_SERVERS = 8;
const threadServers = new Map<string, CodexAppServer>();
const threadServerLastUsed = new Map<string, number>();
const appServerThreadIds = new WeakMap<CodexAppServer, string>();
const activeThreadServerTurns = new Set<string>();
const activeThreadTurnIds = new Map<string, string>();
const approvalRequestServers = new Map<string, CodexAppServer>();
// Threads whose rollout is currently loaded on their (live) per-thread server.
// A fresh/replaced server doesn't know an existing thread until it's resumed —
// without this a restart or prune leaves "thread not found" on the next turn.
const loadedThreads = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeClaudeAskQuestions(raw: unknown): AskQuestionPayload[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 4).map((entry) => {
    const question = isRecord(entry) ? entry : {};
    const options = Array.isArray(question.options) ? question.options.slice(0, 4).map((option) => {
      const item = isRecord(option) ? option : {};
      return {
        label: String(item.label ?? ""),
        description: item.description ? String(item.description) : undefined,
      };
    }).filter((option) => option.label) : [];
    return {
      question: String(question.question ?? ""),
      header: question.header ? String(question.header).slice(0, 12) : undefined,
      options,
      multiSelect: Boolean(question.multiSelect),
    };
  }).filter((question) => question.question && question.options.length >= 2);
}

function answersByQuestion(answers: AskAnswerPayload[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const answer of answers) result[answer.question] = answer.answers.join(", ");
  return result;
}

async function claudeAskUserQuestionDialogOutput(input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<Record<string, unknown> | null> {
  const questions = normalizeClaudeAskQuestions(input.questions);
  if (!questions.length) return null;
  const answers = await askControl.ask(questions, options.signal);
  if (!answers) return null;
  return {
    questions: Array.isArray(input.questions) ? input.questions : questions,
    answers: answersByQuestion(answers),
  };
}

async function claudeAskUserQuestionPermissionResult(input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string; interrupt?: boolean } | null> {
  const output = await claudeAskUserQuestionDialogOutput(input, options);
  if (!output) return { behavior: "deny", message: "사용자가 AskUserQuestion 대화상자에서 답변을 취소했거나 입력을 해석할 수 없습니다.", interrupt: false };
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: output.answers,
    },
  };
}

async function handleClaudeUserDialog(request: { dialogKind: string; payload: Record<string, unknown> }, options: { signal: AbortSignal }): Promise<{ behavior: "completed"; result: unknown } | { behavior: "cancelled" }> {
  if (!CLAUDE_NATIVE_ASK_DIALOG_KINDS.includes(request.dialogKind)) return { behavior: "cancelled" };
  const input = isRecord(request.payload.input) ? request.payload.input : request.payload;
  const result = await claudeAskUserQuestionDialogOutput(input, options);
  return result ? { behavior: "completed", result } : { behavior: "cancelled" };
}

async function handleClaudeAskUserQuestionTool(input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string; interrupt?: boolean }> {
  return await claudeAskUserQuestionPermissionResult(input, options)
    ?? { behavior: "deny", message: "Claude Code AskUserQuestion 입력을 Devil Codex 질문 모달 스키마로 해석할 수 없습니다.", interrupt: false };
}

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
  const raw = picked.join(" | ").slice(0, 600);
  if (/token_revoked|invalidated oauth token|401 unauthorized/i.test(raw)) {
    return `Codex 로그인 토큰이 만료되었거나 취소되었습니다. 설정 > 연결에서 Codex 계정을 로그아웃한 뒤 다시 로그인해 주세요. 원문: ${raw}`;
  }
  return raw || undefined;
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

async function maybeStartContextCompaction(instance: CodexAppServer, input: { threadId: string; provider?: ProviderId; contextUsage?: ContextUsage; retriedAfterCompaction?: boolean; appServerBacked?: boolean }): Promise<boolean> {
  if (!input.appServerBacked && (input.provider ?? "codex") !== "codex") return false;
  if (input.retriedAfterCompaction) return false;
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
const settingsTransitionQueue = new AsyncSerialQueue();
let startupBridgeFailure = "";
const providerSettingsStore = new ProviderSettingsStore();
const providerRuntime = new ProviderRuntime(providerSettingsStore, (event) => { sendToRenderer("app-server:event", event); handleAppServerEvent(event); });
const providerModels = new ProviderModelCatalog(providerSettingsStore);
const providerTranscripts = new ProviderTranscriptStore();
const providerReconciler = new CodexProviderReconciler();
const claudeRuntime = new ClaudeCodeRuntime(baseServerCwd());
claudeRuntime.on("event", (event) => { sendToRenderer("app-server:event", event); handleAppServerEvent(event); });
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
const unrealMcpRelay = new UnrealMcpRelay(unrealMcpRelayOptionsFromEnv());

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

function annotateCodexSummaries<T extends ThreadSummary>(threads: T[], stored: ThreadSummary[] = []): T[] {
  const metaById = new Map(stored.map((summary) => [summary.id, summary]));
  return threads.map((thread) => {
    const meta = metaById.get(thread.id);
    return {
      ...thread,
      ...(meta?.model ? { model: meta.model } : {}),
      ...(meta?.runtime ? { runtime: meta.runtime } : {}),
      provider: (meta?.provider ?? "codex") as ProviderId,
      ...(meta?.accountId ? { accountId: meta.accountId } : {}),
      ...(meta?.approvalPolicy ? { approvalPolicy: meta.approvalPolicy } : {}),
      ...(meta?.sandboxMode ? { sandboxMode: meta.sandboxMode } : {}),
      ...(meta?.reasoningEffort ? { reasoningEffort: meta.reasoningEffort } : {}),
      ...(meta?.responseSpeed ? { responseSpeed: meta.responseSpeed } : {}),
      ...(meta?.planMode !== undefined ? { planMode: meta.planMode } : {}),
    };
  });
}

async function projectlessThreadIds(): Promise<Set<string>> {
  try {
    const state = JSON.parse(await readFile(join(codexHome(), ".codex-global-state.json"), "utf8")) as Record<string, unknown>;
    const atom = state["electron-persisted-atom-state"];
    const ids = atom && typeof atom === "object" ? (atom as Record<string, unknown>)["projectless-thread-ids"] : undefined;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : []);
  } catch {
    return new Set();
  }
}

function markProjectlessThreads<T extends ThreadSummary>(threads: T[], ids: Set<string>): T[] {
  return threads.map((thread) => ids.has(thread.id) ? { ...thread, projectless: true } : thread);
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
    `provider.nvidiaRateLimitRpm: ${config.nvidiaRateLimitRpm ?? 40}`,
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

// app-server:event carries a threadId; when a remote allowlist is active, a
// remote client must never see it for a thread it isn't scoped to (otherwise
// a phone limited to one thread could still watch an unrelated project's
// tool calls stream by). ask:request is a global "ask the human" signal and
// intentionally stays forwarded so the phone can answer devil_ask / ask_user
// MCP prompts even when the remote view is scoped to a subset of threads.
// app-server:status / provider:usage-changed aren't thread-scoped and stay
// unaffected.
function remoteEventThreadId(channel: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if (channel === "approval:resolved") return typeof (payload as { threadId?: unknown }).threadId === "string" ? String((payload as { threadId?: unknown }).threadId) : undefined;
  if (channel === "thread:meta-changed") return typeof (payload as { id?: unknown }).id === "string" ? String((payload as { id?: unknown }).id) : undefined;
  if (channel === "thread:queue-changed") return typeof (payload as { threadId?: unknown }).threadId === "string" ? String((payload as { threadId?: unknown }).threadId) : undefined;
  const params = (payload as { params?: Record<string, unknown> }).params;
  return typeof params?.threadId === "string" ? params.threadId : undefined;
}

function emitThreadQueueChanged(threadId: string, queue: QueuedTurnView[]): void {
  sendToRenderer("thread:queue-changed", { threadId, queue } satisfies ThreadQueueState);
}

function setThreadQueueSnapshot(threadId: string, queue: QueuedTurnView[]): void {
  const clean = queue.filter((entry) => entry && entry.id && entry.threadId === threadId).map((entry) => ({ id: entry.id, threadId, text: entry.text ?? "", ...(entry.attachments?.length ? { attachments: entry.attachments } : {}), ...(entry.steering ? { steering: true } : {}) }));
  if (clean.length) threadQueueSnapshots.set(threadId, clean);
  else threadQueueSnapshots.delete(threadId);
  emitThreadQueueChanged(threadId, clean);
}

function getThreadQueueSnapshot(threadId: string): QueuedTurnView[] {
  return threadQueueSnapshots.get(threadId)?.map((entry: QueuedTurnView) => ({ ...entry, ...(entry.attachments ? { attachments: [...entry.attachments] } : {}) })) ?? [];
}

function sendThreadQueueCommand(command: ThreadQueueCommand): void {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send("thread:queue-command", command);
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, payload);
  if (!remoteServer) return;
  const threadId = remoteEventThreadId(channel, payload);
  if (threadId && !remoteAllowlistCache.has(threadId)) return;
  remoteServer.broadcast(channel, channel === "remote:status" ? sanitizeRemoteStatus(payload as RemoteControlStatus) : payload);
}

function usageProviderFromRaw(provider: unknown): UsageCacheProvider | undefined {
  const normalized = provider === "claude" ? "claude-code" : provider;
  return isUsageCacheProvider(normalized as ProviderId | "unknown") ? normalized as UsageCacheProvider : undefined;
}

async function notifyProviderStateChanged(provider?: unknown): Promise<void> {
  const usageProvider = usageProviderFromRaw(provider);
  if (usageProvider) clearProviderUsageCache(usageProvider);
  restartAppServer();
  const [status, providers] = await Promise.all([combinedAuthStatus(), providerSettingsStore.load()]);
  sendToRenderer("provider:auth", status);
  sendToRenderer("providers:changed", providers);
  sendToRenderer("provider:usage-changed", { provider: usageProvider ?? "unknown", completed: true, at: Date.now() });
}

function emitRemoteStatus(): void {
  void remoteStatus()
    .then((status) => sendToRenderer("remote:status", status))
    .catch(() => undefined);
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
      { type: "update", unified_diff: truncateMirroredRolloutText(file.diff ?? "", MAX_MIRRORED_FILE_DIFF_CHARS) },
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
      stdout: truncateMirroredRolloutText(output, MAX_MIRRORED_COMMAND_OUTPUT_CHARS),
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
    if (turnId) activeThreadTurnIds.set(threadId, turnId);
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
  activeThreadTurnIds.delete(threadId);
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

function showBackgroundNotification(input: { title: string; body?: string; urgency?: "normal" | "critical"; force?: boolean }): { shown: boolean } {
  const win = windowRef;
  if (!input.force && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()) return { shown: false };
  if (!Notification.isSupported()) return { shown: false };
  const title = String(input.title ?? "").trim() || "Devil Codex";
  const body = String(input.body ?? "").trim();
  const notification = new Notification({
    title,
    body,
    urgency: input.urgency === "critical" ? "critical" : "normal",
    icon: appIconPath(),
  });
  notification.on("click", showMainWindow);
  notification.show();
  return { shown: true };
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

// macOS app-bundle names per target. Availability is decided by whether the
// bundle actually exists, so uninstalled editors are hidden instead of shown
// and failing to open. The resolved name is passed to `open -a <name>`.
const macAppNames: Partial<Record<ExternalTarget, string[]>> = {
  vscode: ["Visual Studio Code", "VSCodium", "Cursor"],
  antigravity: ["Antigravity"],
  "github-desktop": ["GitHub Desktop"],
  intellij: ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE", "IntelliJ IDEA Community Edition"],
  rider: ["Rider", "JetBrains Rider"],
};

async function macAppName(target: ExternalTarget): Promise<string | undefined> {
  const dirs = ["/Applications", join(envPath("HOME"), "Applications"), "/System/Applications"];
  for (const name of macAppNames[target] ?? []) {
    for (const dir of dirs) {
      try { await access(join(dir, `${name}.app`)); return name; } catch { /* try next */ }
    }
  }
  return undefined;
}

async function resolveOpenCommand(target: ExternalTarget): Promise<string | undefined> {
  if (target === "finder") return process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  if (target === "terminal") {
    if (process.platform === "win32") return await commandWorks("wt") ? "wt" : "cmd";
    return process.platform === "darwin" ? "open" : "x-terminal-emulator";
  }
  if (process.platform === "darwin") return macAppName(target);
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
    : process.platform === "darwin"
      ? ["vscode", "antigravity", "github-desktop", "intellij", "rider", "finder", "terminal"]
      : ["vscode", "finder", "terminal", "intellij"];
  const rows = await Promise.all(order.map(async (id) => ({ id, label: openTargetLabels[id], available: Boolean(await resolveOpenCommand(id)) })));
  return rows.filter((row) => row.available);
}

async function openWorkspaceExternal(input: { cwd: string; target: ExternalTarget }): Promise<{ ok: boolean; detail?: string }> {
  try {
    // File manager (Finder/Explorer): reveal a file in place, open a folder
    // directly. shell handles this natively on every platform.
    if (input.target === "finder") {
      const isDirectory = await fsStat(input.cwd).then((info) => info.isDirectory()).catch(() => false);
      if (isDirectory) { const detail = await shell.openPath(input.cwd); if (detail) throw new Error(detail); }
      else shell.showItemInFolder(input.cwd);
      return { ok: true };
    }
    if (process.platform === "darwin") {
      if (input.target === "terminal") await execFileAsync("open", ["-a", "Terminal", input.cwd]);
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
    ? [["open", ["-a", "Codex"]], ["open", ["-a", "ChatGPT"]], ["open", ["/Applications/Codex.app"]], ["open", ["/Applications/ChatGPT.app"]]]
    : process.platform === "win32"
      // Do not fall back to `Codex`/`codex`: on Windows that can resolve the
      // CLI bundled with Devil Codex and open a terminal trust prompt instead
      // of the stock desktop application.
      // The Store package currently registers its launchable display name as
      // "ChatGPT" even though its AppID remains OpenAI.Codex_*. Match the
      // stable AppID only, otherwise a Bridge toggle can close Codex and fail
      // to reopen it.
      ? [["powershell.exe", ["-NoProfile", "-Command", "$app = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*' } | Select-Object -First 1; if ($app) { Start-Process ('shell:AppsFolder\\' + $app.AppID); exit 0 }; exit 1"]]]
      : [["xdg-open", ["codex:"]]];
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

type KnownSite = { name: string; url: string; access?: string };
let knownSitesCache: { expiresAt: number; sites: KnownSite[] } | undefined;

async function knownSitesFromCodexHistory(): Promise<KnownSite[]> {
  if (knownSitesCache && knownSitesCache.expiresAt > Date.now()) return knownSitesCache.sites;
  const root = join(app.getPath("home"), ".codex", "sessions");
  const files: string[] = [];
  const walk = async (path: string): Promise<void> => {
    if (files.length >= 400) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= 400) break;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
    }
  };
  await walk(root);
  const sites = new Map<string, KnownSite>();
  for (const file of files) {
    const raw = await readFile(file, "utf8").catch(() => "");
    for (const match of raw.matchAll(/https:\/\/[^\s"\\]+\.chatgpt\.site[^\s"\\)]*/gi)) {
      const url = match[0];
      if (sites.has(url)) continue;
      const before = raw.slice(Math.max(0, (match.index ?? 0) - 700), match.index ?? 0);
      const name = before.match(/(?:site_name|title|name)\\?"?\s*[:=]\s*\\?"([^"\\\n]{2,100})/i)?.[1]
        ?? before.split(/\r?\n/).map((line) => line.trim()).reverse().find((line) => line && !/[{}\[\]"\\]/.test(line) && line.length < 100)
        ?? new URL(url).hostname.split(".")[0].replace(/[-_]+/g, " ");
      sites.set(url, { name, url, access: /(?:private|나만|비공개)/i.test(before) ? "나만" : "공유" });
    }
  }
  const result = [...sites.values()];
  knownSitesCache = { sites: result, expiresAt: Date.now() + 30_000 };
  return result;
}

async function stockCodexDesktopRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const command = "$p = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*' }; if ($p) { exit 0 }; exit 1";
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true });
      return true;
    }
    // This deliberately does not match the `codex` CLI. It is only safe to
    // force-close a known desktop application after a Bridge setting change.
    const names = process.platform === "darwin" ? ["Codex", "ChatGPT"] : ["codex-desktop"];
    for (const name of names) {
      try { await execFileAsync("pgrep", ["-x", name]); return true; } catch { /* try next app name */ }
    }
    return false;
  } catch {
    return false;
  }
}

async function restartStockCodexIfRunning(): Promise<void> {
  if (!await stockCodexDesktopRunning()) return;
  try {
    if (process.platform === "win32") {
      const command = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true });
    } else if (process.platform === "darwin") {
      await execFileAsync("osascript", ["-e", 'tell application "Codex" to quit']).catch(async () => {
        await execFileAsync("osascript", ["-e", 'tell application "ChatGPT" to quit']).catch(() => execFileAsync("pkill", ["-x", "Codex"]));
      });
    } else {
      await execFileAsync("pkill", ["-x", "codex-desktop"]);
    }
    // Give the OS process list a short time to release Codex's config and
    // singleton resources before re-opening it.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const result = await openNativeCodex();
    if (!result.ok) throw new Error(result.detail);
    console.log("[devil-codex stock bridge] restarted running stock Codex");
  } catch (error) {
    console.warn("[devil-codex stock bridge] stock Codex restart failed:", error instanceof Error ? error.message : error);
  }
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

  // Right-click menu so selected page text (file viewer, chat, etc.) can be
  // copied. The app menu only gives Cmd/Ctrl+C; without this a drag-selection
  // has no visible way to copy on the file panel and other read-only surfaces.
  windowRef.webContents.on("context-menu", (_event, params) => {
    // Only surface the native menu when there is something to act on; a plain
    // right-click with no selection is left to the renderer (e.g. the file tree
    // shows its own rename/move/delete/new menu).
    if (!params.selectionText && !params.isEditable) return;
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable && params.editFlags.canCut) items.push({ role: "cut" });
    if (params.selectionText) items.push({ role: "copy" });
    if (params.isEditable && params.editFlags.canPaste) items.push({ role: "paste" });
    if (items.length) items.push({ type: "separator" });
    items.push({ role: "selectAll" });
    Menu.buildFromTemplate(items).popup({ window: windowRef ?? undefined });
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
  activeThreadTurnIds.clear();
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

function lastAgentText(items: ThreadHistoryItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "agent" && typeof item.text === "string" && item.text.trim()) return item.text.trim();
    if (item.kind === "system" && typeof item.text === "string" && item.text.trim()) return item.text.trim();
  }
  return "";
}

type SubagentTerminalStatus = "completed" | "aborted" | "interrupted" | "timed_out";

function waitForAppServerTurnTerminal(instance: CodexAppServer, timeoutMs: number): Promise<SubagentTerminalStatus> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: SubagentTerminalStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      instance.off("event", onEvent);
      resolve(status);
    };
    const onEvent = (event: AppServerEvent): void => {
      if (event.method === "turn/completed") finish("completed");
      else if (event.method === "turn/aborted") finish("aborted");
      else if (event.method === "turn/interrupted") finish("interrupted");
    };
    const timer = setTimeout(() => finish("timed_out"), Math.max(5_000, timeoutMs));
    instance.on("event", onEvent);
  });
}

async function delegateSubagentFromMcp(input: SubagentDelegatePayload): Promise<SubagentDelegateResult> {
  const taskId = crypto.randomUUID();
  const [providerSettings, codexSettings] = await Promise.all([providerSettingsStore.load(), settingsStore.load()]);
  // MCP calls do not include their parent thread id. Until that protocol carries
  // per-turn permissions, the persisted Codex settings are the strongest safe
  // ceiling available here; never silently elevate a delegated task to full access.
  const approvalPolicy: ThreadApprovalPolicy = codexSettings.approvalPolicy === "never" ? "never" : "on-request";
  const sandboxMode: ThreadSandboxMode = codexSettings.sandboxMode === "danger-full-access" || codexSettings.sandboxMode === "read-only"
    ? codexSettings.sandboxMode
    : "workspace-write";
  const provider = input.provider ?? providerSettings.provider;
  const accountId = input.accountId ?? providerSettings.accountId;
  const model = input.model ?? providerSettings.model;
  const runtime = input.runtime ?? (provider === "claude-code" ? "claude-code" : "codex");
  const cwd = input.cwd || baseServerCwd();
  const timeoutMs = input.timeoutMs ?? 300_000;
  const reasoningEffort = input.reasoningEffort ?? codexSettings.reasoningEffort;
  const deadline = Date.now() + timeoutMs;
  const delegatedTask = [
    "[Devil subagent execution note]",
    "Use the available shell/PowerShell command tool for filesystem changes and verification.",
    "Do not call apply_patch in this delegated runtime; if a file must change, write it with shell commands and verify the result.",
    "",
    input.task,
  ].join("\n");

  if (runtime === "claude-code" || provider === "claude-code") {
    const thread = claudeRuntime.createThread({ cwd, model });
    let timedOut = false;
    try {
      let finalText = "";
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          claudeRuntime.interruptTurn({ threadId: thread.id });
          reject(new Error(`하위 에이전트가 ${Math.round(timeoutMs / 1000)}초 안에 완료되지 않았습니다.`));
        }, timeoutMs);
      });
      // Pin the SDK session id to the Devil thread id so the subagent tab can
      // later resume the same Claude session (mirrors the main-chat path).
      const result = await Promise.race([
        claudeRuntime.sendTurn({
          threadId: thread.id,
          cwd,
          text: delegatedTask,
          model,
          resume: false,
          nativeSessionId: thread.id,
          mcpConfig: await claudeMcpConfig(),
          approvalPolicy,
          sandboxMode,
          onCompleted: (text) => { finalText = text.trim(); },
        }),
        timeoutPromise,
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      // Persist the child conversation so the "subagent:<id>" tab (which reads
      // via providerTranscripts for claude-code threads) shows it. archived:true
      // keeps the hidden child out of the main sidebar, like Codex children.
      await providerTranscripts.append(thread.id, { id: crypto.randomUUID(), kind: "user", text: input.task }).catch(() => undefined);
      await providerTranscripts.append(thread.id, { id: crypto.randomUUID(), kind: "agent", text: finalText, runtime: "claude-code", provider: "claude-code", model }).catch(() => undefined);
      await providerTranscripts.saveMeta({
        id: thread.id,
        cwd,
        model,
        runtime: "claude-code",
        provider: "claude-code",
        claudeSessionId: result.sessionId ?? thread.id,
        title: titleFromText(input.task),
        preview: previewFromText(finalText || input.task),
        updatedAt: Date.now(),
        archived: true,
      }).catch(() => undefined);
      return { taskId, threadId: thread.id, status: "completed", result: finalText, provider: "claude-code", accountId, model, runtime };
    } catch (error) {
      return { taskId, threadId: thread.id, status: timedOut ? "timed_out" : "failed", error: error instanceof Error ? error.message : String(error), provider: "claude-code", accountId, model, runtime };
    }
  }

  const instance = createAppServer(false);
  let threadId = "";
  try {
    const createInput = usesCodexProxy(provider)
      ? { cwd, model: routedProviderModel(provider, model, accountId), modelProvider: "devil", approvalPolicy, sandboxMode, reasoningEffort }
      : { cwd, model, approvalPolicy, sandboxMode, reasoningEffort };
    const thread = await instance.createThread(createInput);
    threadId = thread.id;
    appServerThreadIds.set(instance, threadId);
    const sendInput = {
      threadId,
      cwd,
      text: delegatedTask,
      model: createInput.model,
      approvalPolicy,
      sandboxMode,
      reasoningEffort,
    };
    const terminal = waitForAppServerTurnTerminal(instance, timeoutMs);
    await instance.sendTurn(sendInput);
    const terminalStatus = await terminal;
    if (terminalStatus !== "completed") {
      const error = terminalStatus === "timed_out"
        ? `하위 에이전트가 ${Math.round(timeoutMs / 1000)}초 안에 완료되지 않았습니다.`
        : `하위 에이전트 작업이 ${terminalStatus} 상태로 끝났습니다.`;
      return { taskId, threadId, status: terminalStatus === "timed_out" ? "timed_out" : "failed", error, provider, accountId, model, runtime };
    }
    let history = await instance.readThread({ id: threadId }).catch(() => [] as ThreadHistoryItem[]);
    while (!lastAgentText(history) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      history = await instance.readThread({ id: threadId }).catch(() => history);
    }
    const result = lastAgentText(history);
    if (!result) return { taskId, threadId, status: "failed", error: "하위 에이전트가 완료 신호를 보냈지만 결과 텍스트를 찾지 못했습니다.", provider, accountId, model, runtime };
    return { taskId, threadId, status: "completed", result, provider, accountId, model, runtime };
  } catch (error) {
    return { taskId, threadId, status: "failed", error: error instanceof Error ? error.message : String(error), provider, accountId, model, runtime };
  } finally {
    appServerThreadIds.delete(instance);
    instance.dispose();
  }
}

function terminals(): TerminalManager {
  if (!terminalManager) terminalManager = new TerminalManager((payload) => sendToRenderer("terminal:data", payload));
  return terminalManager;
}

function remoteAuth(): RemoteAuthStore {
  if (!remoteAuthStore) remoteAuthStore = new RemoteAuthStore();
  return remoteAuthStore;
}

function remoteStaticDir(): string {
  return join(app.getAppPath(), "dist-mobile");
}

function cleanTailscaleName(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim().replace(/\.$/, "");
  return text || null;
}

function remoteTokenPreview(token: string): string {
  return token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-6)}` : token;
}

function remoteUrlWithToken(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/#.*$/, "")}/#t=${encodeURIComponent(token)}`;
}

function remoteTailnetBaseUrl(tailscaleIp: string | null): string | null {
  return tailscaleIp ? `http://${tailscaleIp}:${REMOTE_CONTROL_PORT}` : null;
}

function remoteDeviceRow(device: { deviceId: string; deviceName: string; approvedAt: number; lastSeenAt?: number }): RemoteDevice {
  return {
    id: device.deviceId,
    name: device.deviceName,
    createdAt: device.approvedAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function remoteClientRows(): RemoteControlStatus["clients"] {
  return (remoteServer?.listClients() ?? []).map((client) => ({
    id: client.deviceId,
    label: client.deviceName,
    createdAt: client.connectedAt,
    lastSeenAt: client.connectedAt,
  }));
}

async function remoteStatus(): Promise<RemoteControlStatus> {
  const [settings, authSnapshot] = await Promise.all([settingsStore.load(), remoteAuth().getSnapshot()]);
  const tailscale = remoteLastTailscaleStatus ?? await new TailscaleCli().status();
  return {
    enabled: settings.remoteControlEnabled && Boolean(remoteServer),
    mode: "funnel",
    ...(remotePublicUrl ? { url: remoteUrlWithToken(remotePublicUrl, authSnapshot.token) } : {}),
    ...(remotePublicUrl ? { qrDataUrl: await QRCode.toDataURL(remoteUrlWithToken(remotePublicUrl, authSnapshot.token), { margin: 1, width: 320 }) } : {}),
    ...(remoteTailnetBaseUrl(tailscale.tailscaleIp) && remoteServer ? { tailnetUrl: remoteUrlWithToken(remoteTailnetBaseUrl(tailscale.tailscaleIp)!, authSnapshot.token) } : {}),
    ...(remoteTailnetBaseUrl(tailscale.tailscaleIp) && remoteServer ? { tailnetQrDataUrl: await QRCode.toDataURL(remoteUrlWithToken(remoteTailnetBaseUrl(tailscale.tailscaleIp)!, authSnapshot.token), { margin: 1, width: 320 }) } : {}),
    tokenPreview: remoteTokenPreview(authSnapshot.token),
    ...(remoteLastError ? { error: remoteLastError } : {}),
    tailscale: {
      installed: tailscale.installed,
      running: tailscale.installed,
      loggedIn: tailscale.online,
      ...(cleanTailscaleName(tailscale.dnsName) ? { hostname: cleanTailscaleName(tailscale.dnsName)! } : {}),
      ...(tailscale.tailscaleIp ? { tailnet: tailscale.tailscaleIp } : {}),
      ...(remotePublicUrl ? { serviceUrl: remotePublicUrl } : {}),
      ...(tailscale.error ? { error: tailscale.error } : {}),
    },
    devices: authSnapshot.devices.map(remoteDeviceRow),
    clients: remoteClientRows(),
  };
}

async function startRemoteControl(mode: RemoteControlMode): Promise<RemoteControlStatus> {
  if (mode !== "funnel") throw new Error("tailnet 접속 모드는 현재 비활성화되어 있습니다. Funnel만 사용할 수 있습니다.");
  const previous = await settingsStore.load();
  if (previous.remoteControlMode !== "funnel") {
    await new TailscaleCli().funnelOn(REMOTE_CONTROL_PORT);
  }

  await stopRemoteControl({ saveSettings: false });
  remoteLastError = undefined;
  remotePublicUrl = undefined;
  remoteProtocol = "http";

  const tailscale = await new TailscaleCli().status();
  remoteLastTailscaleStatus = tailscale;
  if (!tailscale.installed) throw new Error(`Tailscale이 필요합니다. ${TAILSCALE_DOWNLOAD_URL}`);
  if (!tailscale.online) throw new Error(tailscale.error || "Tailscale 로그인 또는 연결이 필요합니다.");

  const dnsName = cleanTailscaleName(tailscale.dnsName);
  if (!dnsName) throw new Error("Tailscale Funnel URL을 만들 DNS 이름을 찾지 못했습니다.");
  const bindHost = "0.0.0.0";
  if (!bindHost) throw new Error("Tailscale 100.64/10 인터페이스 IP를 찾지 못했습니다.");

  const auth = remoteAuth();
  const tls = undefined;
  remoteProtocol = tls ? "https" : "http";
  const server = new RemoteServer({
    handlers: buildRemoteIpcHandlers(),
    allowedChannels: REMOTE_ALLOWED_CHANNELS,
    allowedEvents: REMOTE_ALLOWED_EVENTS,
    auth,
    staticDir: remoteStaticDir(),
    version: app.getVersion(),
    onDeviceApprovalNeeded: async (device) => {
      const options: MessageBoxOptions = {
        type: "question",
        buttons: ["허용", "거부"],
        defaultId: 0,
        cancelId: 1,
        title: "원격 접속 승인",
        message: `${device.deviceName} 기기의 원격 접속을 허용할까요?`,
        detail: "허용하면 이 기기에서 스레드 조회, 메시지 전송, 승인 응답을 할 수 있습니다.",
      };
      const result = windowRef && !windowRef.isDestroyed()
        ? await dialog.showMessageBox(windowRef, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
    onClientStateChanged: () => {
      emitRemoteStatus();
    },
  });
  const started = await server.start({ host: bindHost, port: REMOTE_CONTROL_PORT, ...(tls ? { tls } : {}) });
  remoteServer = server;

  try {
    await new TailscaleCli().funnelOn(started.port);
  } catch (error) {
    await stopRemoteControl({ saveSettings: false });
    throw error;
  }
  remotePublicUrl = `https://${dnsName}`;

  await settingsStore.save({ ...previous, remoteControlEnabled: true, remoteControlMode: "funnel" });
  const status = await remoteStatus();
  sendToRenderer("remote:status", status);
  return status;
}

async function stopRemoteControl(options: { saveSettings: boolean } = { saveSettings: true }): Promise<RemoteControlStatus> {
  const previousMode = (await settingsStore.load().catch(() => null))?.remoteControlMode;
  const server = remoteServer;
  remoteServer = undefined;
  remotePublicUrl = undefined;
  if (server) await server.stop();
  if (previousMode === "funnel") await new TailscaleCli().funnelOff().catch(() => undefined);
  if (options.saveSettings) {
    const previous = await settingsStore.load();
    await settingsStore.save({ ...previous, remoteControlEnabled: false });
  }
  const status = await remoteStatus();
  sendToRenderer("remote:status", status);
  return status;
}

async function regenerateRemoteToken(): Promise<RemoteControlStatus> {
  await remoteAuth().regenerateToken();
  for (const client of remoteServer?.listClients() ?? []) remoteServer?.disconnect(client.deviceId);
  const status = await remoteStatus();
  sendToRenderer("remote:status", status);
  return status;
}

async function revokeRemoteDevice(deviceId: string): Promise<RemoteControlStatus> {
  await remoteAuth().revokeDevice(deviceId);
  remoteServer?.disconnect(deviceId);
  const status = await remoteStatus();
  sendToRenderer("remote:status", status);
  return status;
}

async function startRemoteFromSettings(): Promise<void> {
  const settings = await settingsStore.load();
  applyRemoteAllowlistCache(settings);
  if (!settings.remoteControlEnabled) return;
  try {
    await startRemoteControl(settings.remoteControlMode);
  } catch (error) {
    remoteLastError = error instanceof Error ? error.message : String(error);
    console.warn("[devil-codex remote]", remoteLastError);
  }
}

// Start the local Codex Responses proxy and register it as a non-default Codex
// model provider so external-model turns can run through the app-server.
function mcpScripts(): { script: string; computerScript: string; askScript: string; subagentScript: string } {
  const scriptDir = app.isPackaged
    ? join(process.resourcesPath, "scripts")
    : join(__dirname, "..", "scripts");
  return {
    script: join(scriptDir, "devil-browser-mcp.cjs"),
    computerScript: join(scriptDir, "devil-computer-mcp.cjs"),
    askScript: join(scriptDir, "devil-ask-mcp.cjs"),
    subagentScript: join(scriptDir, "devil-subagent-mcp.cjs"),
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

async function setAskUserMcpEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    askControl.stop();
    await unregisterDevilAskMcp();
    restartAppServer();
    console.log("[devil-codex ask] disabled");
    return;
  }
  await setupDevilAskMcp();
  restartAppServer();
}

async function setupDevilSubagentMcp(): Promise<void> {
  try {
    const sock = await subagentControl.start();
    const { subagentScript } = mcpScripts();
    await registerDevilSubagentMcp({ execPath: process.execPath, script: subagentScript, sock, secret: subagentControlSecret });
    console.log(`[devil-codex subagent] control server on ${sock}, MCP script ${subagentScript}`);
  } catch (error) {
    console.error("[devil-codex subagent] FAILED to configure:", error instanceof Error ? error.message : error);
  }
}

async function setSubagentMcpEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    subagentControl.stop();
    await unregisterDevilSubagentMcp();
    restartAppServer();
    console.log("[devil-codex subagent] disabled");
    return;
  }
  await setupDevilSubagentMcp();
  restartAppServer();
}

async function setDevilMcpEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    browserControl.stop();
    desktopControl.stop();
    await unregisterDevilBrowserMcp();
    await restoreStockBrowserPluginForDevil();
    restartAppServer();
    console.log("[devil-codex mcp] disabled");
    return;
  }
  await disableStockBrowserPluginForDevil();
  const sock = await browserControl.start();
  const computerSock = await desktopControl.start();
  const { script, computerScript } = mcpScripts();
  await registerDevilBrowserMcp({ execPath: process.execPath, script, sock, secret: browserControlSecret, computerScript, computerSock, computerSecret: desktopControlSecret });
  restartAppServer();
  console.log(`[devil-codex browser] control server on ${sock}, MCP script ${script}`);
  console.log(`[devil-codex computer] control server on ${computerSock}, MCP script ${computerScript}`);
}

async function devilMcpStatus(): Promise<DevilMcpStatus> {
  const checkedAt = Date.now();
  const settings = await settingsStore.load();
  let registration = { browser: false, computer: false };
  try { registration = await devilBrowserMcpRegistration(); }
  catch (error) {
    return { state: "error", detail: `MCP 설정을 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, browserServer: browserControl.isRunning(), computerServer: desktopControl.isRunning(), browserRegistered: false, computerRegistered: false, checkedAt };
  }
  const browserServer = browserControl.isRunning();
  const computerServer = desktopControl.isRunning();
  if (settings.stockBridgeEnabled) return { state: "bridge", detail: "Bridge가 켜져 있어 Devil 전용 MCP는 비활성화되고, 순정 Codex의 Browser(iab) 플러그인이 복구됩니다.", browserServer, computerServer, browserRegistered: registration.browser, computerRegistered: registration.computer, checkedAt };
  if (!settings.devilMcpEnabled) return { state: "disabled", detail: "브라우저/컴퓨터 제어 MCP가 꺼져 있습니다.", browserServer, computerServer, browserRegistered: registration.browser, computerRegistered: registration.computer, checkedAt };
  if (browserServer && computerServer && registration.browser && registration.computer) {
    try {
      const servers = await server().listMcpServers();
      const browser = servers.find((item) => item.name === "devil_browser");
      const computer = servers.find((item) => item.name === "devil_computer");
      const browserLoaded = Boolean(browser?.tools.some((tool) => tool.name === "browser_navigate"));
      const computerLoaded = Boolean(computer?.tools.some((tool) => tool.name === "computer_screenshot"));
      if (browserLoaded && computerLoaded) {
        return { state: "ready", detail: "Codex App Server가 devil_browser와 devil_computer 도구까지 실제로 로드했습니다. 다음 메시지부터 모델이 사용할 수 있습니다.", browserServer, computerServer, browserRegistered: registration.browser, computerRegistered: registration.computer, checkedAt };
      }
      return { state: "error", detail: "제어 서버와 config 등록은 됐지만 Codex App Server가 Devil MCP 도구를 로드하지 않았습니다. 토글을 껐다 켜 다시 적용하세요.", browserServer, computerServer, browserRegistered: registration.browser, computerRegistered: registration.computer, checkedAt };
    } catch (error) {
      return { state: "error", detail: `Codex App Server의 MCP 로드 상태를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, browserServer, computerServer, browserRegistered: registration.browser, computerRegistered: registration.computer, checkedAt };
    }
  }
  return { state: "error", detail: "MCP가 켜져 있지만 제어 서버 또는 MCP 등록이 완성되지 않았습니다. 토글을 껐다 켜 다시 적용하세요.", browserServer, computerServer, browserRegistered: registration.browser, computerRegistered: registration.computer, checkedAt };
}

// These MCP servers live in the shared ~/.codex/config.toml.  They must only
// exist while the Devil desktop process is actively serving their local pipes;
// otherwise stock Codex can discover an unusable Devil tool after this app has
// closed.  Keep the config writes serial because each helper rewrites the same
// file.
async function unregisterDevilExclusiveMcps(): Promise<void> {
  // Bridge mode shares ~/.codex/config.toml with stock Codex. Do not leave
  // Devil-only tools visible there: stock Codex cannot use their in-process
  // sockets and should never discover Devil's browser/computer/ask/subagent
  // capabilities in the first place.
  browserControl.stop();
  desktopControl.stop();
  askControl.stop();
  subagentControl.stop();
  // These all rewrite the same config.toml, so they must be serial. Parallel
  // reads/writes could restore a block removed by a neighboring operation.
  await unregisterDevilBrowserMcp();
  await restoreStockBrowserPluginForDevil();
  await unregisterDevilAskMcp();
  await unregisterDevilSubagentMcp();
}

async function disableDevilExclusiveMcps(): Promise<void> {
  await unregisterDevilExclusiveMcps();
  restartAppServer();
}

async function restoreDevilExclusiveMcps(settings: CodexSettings): Promise<void> {
  if (settings.askUserMcpEnabled) await setupDevilAskMcp();
  else await unregisterDevilAskMcp();
  if (settings.subagentMcpEnabled) await setupDevilSubagentMcp();
  else await unregisterDevilSubagentMcp();
  await setDevilMcpEnabled(settings.devilMcpEnabled);
}

async function requireDevilChatAvailable(): Promise<void> {
  const settings = await settingsStore.load();
  if (settings.stockBridgeEnabled) throw new Error("순정 Codex Bridge가 켜져 있어 Devil Codex 채팅은 잠겨 있습니다. Bridge를 끄면 즉시 다시 사용할 수 있습니다.");
}

async function claudeMcpConfig(): Promise<string | undefined> {
  const settings = await settingsStore.load().catch(() => null);
  const { script, computerScript, askScript, subagentScript } = mcpScripts();
  const mcpServers: Record<string, unknown> = {};

  if (settings?.askUserMcpEnabled !== false) {
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
  }

  if (settings?.subagentMcpEnabled !== false) {
    try {
      const subagentSock = await subagentControl.start();
      mcpServers.devil_subagent = {
        command: process.execPath,
        args: [subagentScript],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          DEVIL_SUBAGENT_SOCK: subagentSock,
          DEVIL_SUBAGENT_SECRET: subagentControlSecret,
        },
      };
    } catch (error) {
      console.warn("[devil-codex subagent] Claude MCP disabled:", error instanceof Error ? error.message : error);
    }
  }

  if (settings?.devilMcpEnabled) {
    try {
      const sock = await browserControl.start();
      const computerSock = await desktopControl.start();
      mcpServers.devil_browser = {
        command: process.execPath,
        args: [script],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          DEVIL_BROWSER_SOCK: sock,
          DEVIL_BROWSER_SECRET: browserControlSecret,
        },
      };
      mcpServers.devil_computer = {
        command: process.execPath,
        args: [computerScript],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          DEVIL_COMPUTER_SOCK: computerSock,
          DEVIL_COMPUTER_SECRET: desktopControlSecret,
        },
      };
    } catch (error) {
      console.warn("[devil-codex mcp] Claude browser/computer MCP disabled:", error instanceof Error ? error.message : error);
    }
  }

  return Object.keys(mcpServers).length ? JSON.stringify({ mcpServers }) : undefined;
}

async function startCodexProxy(): Promise<void> {
  try {
    const port = await codexProxy.start();
    desktopOwnsProxy = true;
    await registerDevilProvider(port, codexProxy.secretToken());
  } catch (error) {
    if (/EADDRINUSE/i.test(error instanceof Error ? error.message : String(error))) {
      console.log("[devil-codex proxy] background stock bridge is already running");
    } else {
      console.error("[devil-codex proxy]", error instanceof Error ? error.message : error);
    }
  }
  await unrealMcpRelay.start().catch((error) => {
    if (!/EADDRINUSE/i.test(error instanceof Error ? error.message : String(error))) console.error("[devil-codex unreal-mcp]", error);
  });
  try {
    const settings = await settingsStore.load();
    if (settings.stockBridgeEnabled) await disableDevilExclusiveMcps();
    else await restoreDevilExclusiveMcps(settings);
  } catch (error) {
    console.error("[devil-codex mcp] FAILED to configure:", error instanceof Error ? error.message : error);
  }
}

async function syncStockCodexCatalogOnly(): Promise<{ path: string; added: number }> {
  const [providerSettings, codexSettings] = await Promise.all([providerSettingsStore.load(), settingsStore.load()]);
  return syncStockCodexCatalog(providerSettings.providers, undefined, codexSettings.stockBridgeModels, {
    webSearch: codexSettings.stockBridgeWebSearch,
    vision: codexSettings.stockBridgeVision,
  });
}

async function syncStockCodexCatalogAfterProviderChange(action: string): Promise<void> {
  await syncStockCodexCatalogOnly().catch((error) => {
    console.warn(`[devil-codex providers] stock catalog sync after ${action} failed:`, error instanceof Error ? error.message : error);
  });
}

async function activateDevilNativeCatalog(): Promise<void> {
  const catalog = await syncNativeCodexCatalog();
  await registerDevilNativeCatalog(catalog.path);
  console.log(`[devil-codex native catalog] ${catalog.models} native models available to the bundled app-server`);
}

async function syncStockCodexBridge(): Promise<void> {
  const port = await codexProxy.start();
  await registerDevilProvider(port, codexProxy.secretToken());
  const catalog = await syncStockCodexCatalogOnly();
  await registerDevilStockBridge(port, codexProxy.secretToken(), catalog.path);
  const expectedModels = (await settingsStore.load()).stockBridgeModels;
  const baseUrl = `http://127.0.0.1:${port}/${codexProxy.secretToken()}/stock/v1`;
  const response = await fetch(`${baseUrl}/models`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Stock Codex Bridge health check failed (${response.status}).`);
  const body = await response.json() as { data?: Array<{ id?: unknown }> };
  const available = (body.data ?? []).flatMap((item) => typeof item.id === "string" ? [{ id: item.id }] : []);
  const missing = expectedModels.filter((model) => selectConfiguredModelRows(available, [model]).length === 0);
  if (missing.length) throw new Error(`Stock Codex Bridge did not expose selected models: ${missing.join(", ")}`);
  console.log(`[devil-codex stock bridge] ${catalog.added} external models injected into ${catalog.path}`);
}

async function activateStockCodexBridge(): Promise<void> {
  await unregisterDevilNativeCatalog();
  const catalog = await syncStockCodexCatalogOnly();
  await registerDevilStockBridge(DEVIL_PROXY_PORT, await readDevilProxySecret(), catalog.path);
}

async function deactivateStockCodexBridge(): Promise<void> {
  await unregisterDevilStockBridge();
  await unregisterDevilNativeCatalog();
  await disableStockProxyAutostart().catch((error) => console.warn("[devil-codex stock bridge] autostart removal failed:", error instanceof Error ? error.message : error));
  if (stockProxyServiceMode) return;
  if (process.platform === "win32") {
    const command = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--devil-stock-proxy*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true })
      .catch((error) => console.warn("[devil-codex stock bridge] stop failed:", error instanceof Error ? error.message : error));
  } else {
    await execFileAsync("pkill", ["-f", "--", "--devil-stock-proxy"])
      .catch((error) => {
        // pgrep/pkill uses exit code 1 when there is simply no background
        // proxy, which is the expected state for most toggle operations.
        if (!/exit code 1|code: 1/i.test(error instanceof Error ? error.message : String(error))) console.warn("[devil-codex stock bridge] stop failed:", error instanceof Error ? error.message : error);
      });
  }
}

function stockBridgeCatalogChanged(previous: CodexSettings, next: CodexSettings): boolean {
  return previous.stockBridgeModels.join("\u0000") !== next.stockBridgeModels.join("\u0000")
    || previous.stockBridgeWebSearch !== next.stockBridgeWebSearch
    || previous.stockBridgeVision !== next.stockBridgeVision;
}

function ensureStockProxyAutostartBestEffort(): void {
  void ensureStockProxyAutostart({ packaged: app.isPackaged, executable: process.execPath })
    .catch((error) => console.warn("[devil-codex stock bridge] autostart registration failed:", error instanceof Error ? error.message : error));
}

async function applySettingsRuntime(previous: CodexSettings, next: CodexSettings): Promise<void> {
  // In Bridge mode these preferences remain saved, but are intentionally not
  // materialized in shared Codex config where stock Codex could see them.
  if (!next.stockBridgeEnabled) {
    if (previous.devilMcpEnabled !== next.devilMcpEnabled) await setDevilMcpEnabled(next.devilMcpEnabled);
    if (previous.askUserMcpEnabled !== next.askUserMcpEnabled) await setAskUserMcpEnabled(next.askUserMcpEnabled);
    if (previous.subagentMcpEnabled !== next.subagentMcpEnabled) await setSubagentMcpEnabled(next.subagentMcpEnabled);
  }

  const bridgeChanged = previous.stockBridgeEnabled !== next.stockBridgeEnabled;
  const catalogChanged = stockBridgeCatalogChanged(previous, next);
  if (bridgeChanged) {
    if (next.stockBridgeEnabled) {
      await disableDevilExclusiveMcps();
      await syncStockCodexBridge();
      ensureStockProxyAutostartBestEffort();
    } else {
      await deactivateStockCodexBridge();
      await restoreDevilExclusiveMcps(next);
    }
  } else if (next.stockBridgeEnabled && catalogChanged) {
    await syncStockCodexBridge();
  }
  if (bridgeChanged || (next.stockBridgeEnabled && catalogChanged)) await restartStockCodexIfRunning();

  if (previous.remoteControlEnabled !== next.remoteControlEnabled || previous.remoteControlMode !== next.remoteControlMode) {
    if (next.remoteControlEnabled) await startRemoteControl(next.remoteControlMode);
    else await stopRemoteControl();
  } else if (remoteServer && previous.remoteAllowedThreadIds.join(",") !== next.remoteAllowedThreadIds.join(",")) {
    remoteServer.setHandlers(buildRemoteIpcHandlers());
  }
}

function launchStockProxyService(): void {
  if (stockProxyServiceMode) return;
  const args = app.isPackaged ? ["--devil-stock-proxy"] : [app.getAppPath(), "--devil-stock-proxy"];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

async function startStockProxyService(): Promise<void> {
  const settings = await settingsStore.load().catch(() => null);
  if (settings?.stockBridgeEnabled === false) {
    await deactivateStockCodexBridge();
    console.log("[devil-codex stock bridge] disabled by settings");
    app.exit(0);
    return;
  }
  // A background Bridge owner must never leave Devil's desktop-only MCPs in
  // the shared config. This also cleans registrations left by an interrupted
  // desktop shutdown before stock Codex can discover them.
  await unregisterDevilExclusiveMcps();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await syncStockCodexBridge();
      await unrealMcpRelay.start();
      console.log("[devil-codex stock bridge] background proxy service ready");
      return;
    } catch (error) {
      if (attempt === 59) {
        console.error("[devil-codex stock bridge] background proxy failed:", error instanceof Error ? error.message : error);
        app.exit(1);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
}

if (stockProxyServiceMode) app.whenReady().then(startStockProxyService);
else if (hasSingleInstanceLock) app.whenReady().then(async () => {
  // A prior desktop exit leaves a headless owner behind for stock Codex. Take
  // ownership back now so a Bridge toggle is immediately actionable without
  // asking the user to fully terminate Devil Codex first.
  await deactivateStockCodexBridge().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[devil-codex stock bridge] startup cleanup failed:", detail);
    startupBridgeFailure = `기존 Bridge 상태 일부를 정리하지 못했습니다. 앱은 계속 시작합니다.\n\n${detail}`;
  });
  const settings = await settingsStore.load().catch(() => null);
  await startCodexProxy();
  if (settings?.stockBridgeEnabled === true) {
    try {
      await syncStockCodexBridge();
      ensureStockProxyAutostartBestEffort();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[devil-codex stock bridge] startup activation failed:", detail);
      startupBridgeFailure = [startupBridgeFailure, `Bridge를 시작하지 못해 안전하게 껐습니다.\n\n${detail}\n\n설정의 Bridge 탭에서 다시 시도할 수 있습니다.`].filter(Boolean).join("\n\n");
      try {
        const restored = await settingsStore.save({ ...settings, stockBridgeEnabled: false });
        applyRemoteAllowlistCache(restored);
        await deactivateStockCodexBridge();
        await restoreDevilExclusiveMcps(restored);
      } catch (rollbackError) {
        startupBridgeFailure += `\n\n복구 중 추가 오류: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      }
    }
  }
  configureMenu();
  // Provider/MCP registration can touch config, sockets, and named pipes. Keep
  // it off the critical startup path so a slow helper never blocks the window
  // or the primary Codex app-server connection.
  void startRemoteFromSettings().catch((error) => console.error("[devil-codex remote startup]", error instanceof Error ? error.message : error));
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
  ipcMain.handle("app:notify", (_event, input: { title: string; body?: string; urgency?: "normal" | "critical"; force?: boolean }) => showBackgroundNotification(input));
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
  const selectBrowser = (key?: string) => browserView.focus(key);
  ipcMain.handle("browser:register", (_event, input: { key: string; webContentsId: number }) => browserView.register(input.key, input.webContentsId));
  ipcMain.handle("browser:focus", (_event, input: { key: string }) => browserView.focus(input.key));
  ipcMain.handle("browser:navigate", (_event, input: { key?: string; url: string }) => { selectBrowser(input.key); browserView.navigate(input.url); });
  ipcMain.handle("browser:back", (_event, input?: { key?: string }) => { selectBrowser(input?.key); browserView.goBack(); });
  ipcMain.handle("browser:forward", (_event, input?: { key?: string }) => { selectBrowser(input?.key); browserView.goForward(); });
  ipcMain.handle("browser:reload", (_event, input?: { key?: string }) => { selectBrowser(input?.key); browserView.reload(); });
  ipcMain.handle("browser:hard-reload", (_event, input?: { key?: string }) => { selectBrowser(input?.key); browserView.hardReload(); });
  ipcMain.handle("browser:stop", (_event, input?: { key?: string }) => { selectBrowser(input?.key); browserView.stop(); });
  ipcMain.handle("browser:state", (_event, input?: { key?: string }) => selectBrowser(input?.key));
  ipcMain.handle("browser:screenshot", async (_event, input?: { key?: string }) => { selectBrowser(input?.key); return browserView.screenshot(); });
  ipcMain.handle("browser:find", (_event, input: { key?: string; text: string; forward?: boolean; findNext?: boolean }) => { selectBrowser(input.key); browserView.find(input.text, { forward: input.forward, findNext: input.findNext }); });
  ipcMain.handle("browser:stop-find", (_event, input?: { key?: string }) => { selectBrowser(input?.key); browserView.stopFind(); });
  ipcMain.handle("browser:zoom", (_event, input: { key?: string; factor?: number; delta?: number; reset?: boolean }) => {
    selectBrowser(input.key);
    if (input.reset) return browserView.setZoom(1);
    if (typeof input.factor === "number") return browserView.setZoom(input.factor);
    if (typeof input.delta === "number") return browserView.setZoom(browserView.getZoom() + input.delta);
    return browserView.getZoom();
  });
  ipcMain.handle("browser:clear-cookies", async (_event, input?: { key?: string }) => { selectBrowser(input?.key); await browserView.clearCookies(); });
  ipcMain.handle("browser:clear-cache", async (_event, input?: { key?: string }) => { selectBrowser(input?.key); await browserView.clearCache(); });
  ipcMain.handle("browser:capture-rect", async (_event, input: { key?: string; x: number; y: number; width: number; height: number }) => { selectBrowser(input.key); return browserView.captureRect(input); });
  ipcMain.handle("browser:ai-click", (_event, input: { key?: string; x?: number; y?: number; selector?: string }) => { selectBrowser(input.key); return browserView.aiClick(input); });
  ipcMain.handle("browser:ai-type", (_event, input: { key?: string; text: string }) => { selectBrowser(input.key); return browserView.aiType(input.text); });
  ipcMain.handle("browser:upload-files", (_event, input: { key?: string; paths: string[] }) => { selectBrowser(input.key); return browserView.uploadFiles(input.paths); });
  ipcMain.handle("browser:ai-key", (_event, input: { key?: string }) => { selectBrowser(input.key); return browserView.aiKey(input.key ?? ""); });
  ipcMain.handle("browser:ai-scroll", (_event, input: { key?: string; dy: number }) => { selectBrowser(input.key); return browserView.aiScroll(input.dy); });
  ipcMain.handle("browser:ai-read", () => browserView.aiReadText());
  handle("ask:respond", (input) => {
    const payload = input as { id: string; answers: AskAnswerPayload[] | null };
    askControl.resolve(payload.id, payload.answers);
  });
  handle("runtime:status", () => server().getStatus());
  handle("runtime:connect", () => {
    // Treat an explicit (re)connect as "reload everything": drop stale children
    // so fresh auth/config (e.g. after a Codex re-login) takes effect.
    restartAppServer();
    return server().connect();
  });
  ipcMain.handle("update:check", () => checkForUpdatesNow(() => windowRef));
  ipcMain.handle("update:install", () => installUpdate(() => windowRef));
  ipcMain.handle("subagent:info", (_event, input) => providerReconciler.getSubagentInfo(input.id));
  ipcMain.handle("claude:skills", () => listClaudeSkills());
  handle("claude:slash-commands", (input) => listClaudeSlashCommands((input ?? {}) as { cwd?: string; model?: string }));
  ipcMain.handle("claude:mcp-list", (_event, input) => listClaudeMcpServers(input ?? {}));
  ipcMain.handle("codex:plugin-skills", () => listCodexPluginSkills());
  ipcMain.handle("sites:known-list", () => knownSitesFromCodexHistory());
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
  ipcMain.handle("workspace:write-file", (_event, input) => writeWorkspaceFile(input.cwd, input.path, input.content));
  ipcMain.handle("workspace:rename-entry", (_event, input) => renameWorkspaceEntry(input.cwd, input.from, input.to));
  ipcMain.handle("workspace:delete-entry", (_event, input) => deleteWorkspaceEntry(input.cwd, input.path));
  ipcMain.handle("workspace:create-entry", (_event, input) => createWorkspaceEntry(input.cwd, input.path, input.kind));
  ipcMain.handle("workspace:watch", (_event, input) => { workspaceWatcher.watch(input.cwd); });
  ipcMain.handle("workspace:unwatch", (_event, input) => { workspaceWatcher.unwatch(input.cwd); });
  ipcMain.handle("workspace:find-file", (_event, input) => findWorkspaceFile(input.cwd, input.query));
  ipcMain.handle("workspace:list-open-targets", () => listOpenWorkspaceTargets());
  ipcMain.handle("file:preview-image", (_event, input) => previewLocalImage(input.path));
  ipcMain.handle("app:open-native-codex", () => openNativeCodex());
  ipcMain.handle("app:open-external-url", async (_event, input) => {
    const url = String(input?.url ?? "");
    if (!/^https?:\/\//i.test(url)) throw new Error("지원하지 않는 URL입니다.");
    await shell.openExternal(url);
  });
  ipcMain.handle("clipboard:read-text", () => clipboard.readText());
  ipcMain.handle("clipboard:write-text", (_event, input: { text?: string }) => {
    clipboard.writeText(String(input?.text ?? ""));
  });
  ipcMain.handle("terminal:shells", () => terminals().profiles());
  ipcMain.handle("terminal:create", (_event, input) => terminals().create(input.cwd, input.cols, input.rows, input.key, input.shellId));
  ipcMain.handle("terminal:write", (_event, input) => terminals().write(input.id, input.data));
  ipcMain.handle("terminal:resize", (_event, input) => terminals().resize(input.id, input.cols, input.rows));
  ipcMain.handle("terminal:close", (_event, input) => terminals().close(input.id));
  ipcMain.handle("translate:text", (_event, input: { text: string; to?: string; from?: string }) => translateText(input));
  handle("settings:load", () => settingsStore.load());
  ipcMain.handle("devil-mcp:status", () => devilMcpStatus());
  ipcMain.handle("settings:save", (_event, input: CodexSettings) => settingsTransitionQueue.run(async () => {
    const previous = await settingsStore.load();
    const next = await persistAndApplyWithRollback({
      previous,
      next: input,
      persist: (value) => settingsStore.save(value),
      apply: async (before, saved) => {
        applyRemoteAllowlistCache(saved);
        await applySettingsRuntime(before, saved);
      },
      restore: async (failed, restored) => {
        applyRemoteAllowlistCache(restored);
        try {
          await applySettingsRuntime(failed, restored);
        } finally {
          // The persisted rollback is authoritative even if one best-effort
          // runtime cleanup step also fails. Never leave the renderer locked
          // to the optimistic Bridge state.
          sendToRenderer("settings:changed", restored);
        }
      },
    });
    sendToRenderer("settings:changed", next);
    return next;
  }));
  ipcMain.handle("remote:status", () => remoteStatus());
  ipcMain.handle("remote:enable", async (_event, input: { mode?: RemoteControlMode }) => startRemoteControl(input?.mode === "tailnet" ? "tailnet" : "funnel"));
  ipcMain.handle("remote:disable", () => stopRemoteControl());
  ipcMain.handle("remote:regenerate-token", () => regenerateRemoteToken());
  ipcMain.handle("remote:revoke-device", (_event, input: { deviceId?: string }) => revokeRemoteDevice(String(input?.deviceId ?? "")));
  // Quick-actions "Tailscale 켜기" button: brings the local backend up without
  // making the user hunt for a terminal. Refreshes the cached status either
  // way so the Settings view reflects the outcome immediately.
  ipcMain.handle("remote:tailscale-up", async () => {
    const result = await new TailscaleCli().up();
    remoteLastTailscaleStatus = await new TailscaleCli().status();
    return { status: await remoteStatus(), authUrl: result.authUrl };
  });
  // Local desktop access is always unrestricted - this only exists so the
  // Settings UI/preload surface matches the shape a remote client gets back
  // from the same channel (which buildRemoteIpcHandlers overrides with the
  // real allowlist state).
  ipcMain.handle("remote:scope", () => ({ restricted: false }));
  handle("providers:load", () => providerSettingsStore.load());
  ipcMain.handle("providers:select", async (_event, input) => {
    const saved = await providerSettingsStore.select(input);
    await syncStockCodexCatalogAfterProviderChange("selection");
    await notifyProviderStateChanged((input as { provider?: ProviderId } | undefined)?.provider)
      .catch((error) => console.warn("[devil-codex providers] selection notification failed:", error instanceof Error ? error.message : error));
    return saved;
  });
  ipcMain.handle("providers:save-key", async (_event, input) => {
    const saved = await providerSettingsStore.saveKey(input);
    let result = saved;
    try {
      result = await providerModels.refresh(input.provider, saved.accountId ?? input.accountId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[devil-codex providers] model refresh after key save failed:", message);
    }
    await syncStockCodexCatalogAfterProviderChange("key save");
    sendToRenderer("providers:changed", result);
    return result;
  });
  ipcMain.handle("providers:clear-key", async (_event, input) => {
    const saved = await providerSettingsStore.clearKey(input.provider, input.accountId);
    await syncStockCodexCatalogAfterProviderChange("key removal");
    sendToRenderer("providers:changed", saved);
    return saved;
  });
  ipcMain.handle("providers:refresh-models", async (_event, input) => {
    const saved = await refreshProviderModels(input.provider, input.accountId);
    await syncStockCodexCatalogAfterProviderChange("model refresh");
    return saved;
  });
  ipcMain.handle("providers:auth-status", () => combinedAuthStatus());
  ipcMain.handle("providers:login", async (_event, input) => {
    if (input.provider === "codex") {
      codexCliLogin("codex");
      void (async () => { await syncStockCodexCatalogOnly(); await notifyProviderStateChanged("codex"); })().catch((error) => console.warn("[devil-codex providers] post-login refresh failed:", error));
      return null;
    }
    if (input.provider === "antigravity") {
      return antigravityLogin(() => {
        void (async () => { await syncStockCodexCatalogOnly(); await notifyProviderStateChanged("antigravity"); })().catch((error) => console.warn("[devil-codex providers] post-login refresh failed:", error));
      });
    }
    const oauthProvider = input.provider === "claude" ? "claude-code" : "copilot";
    return oauthLogin(oauthProvider, () => {
      void (async () => { await syncStockCodexCatalogOnly(); await notifyProviderStateChanged(oauthProvider); })().catch((error) => console.warn("[devil-codex providers] post-login refresh failed:", error));
    });
  });
  ipcMain.handle("providers:logout", async (_event, input) => {
    let changedProvider: UsageCacheProvider | undefined;
    if (input.provider === "codex") {
      await codexCliLogout("codex");
      changedProvider = "codex";
    }
    else if (input.provider === "antigravity") {
      await antigravityLogout(input.accountId);
      changedProvider = "antigravity";
    }
    else {
      const provider = input.provider === "claude" ? "claude-code" : "copilot";
      await oauthLogout(provider, input.accountId);
      changedProvider = provider;
    }
    await syncStockCodexCatalogAfterProviderChange("logout");
    await notifyProviderStateChanged(changedProvider)
      .catch((error) => console.warn("[devil-codex providers] logout notification failed:", error instanceof Error ? error.message : error));
    return combinedAuthStatus();
  });
  ipcMain.handle("providers:oauth-models", (_event, input) => input.provider === "antigravity" ? antigravityModels(input.accountId) : oauthModels(input.provider, input.accountId));
  handle("providers:usage", async (input) => {
    const request = (input ?? {}) as { force?: boolean };
    return providerUsageReport(await combinedAuthStatus(), await providerSettingsStore.load(), { force: Boolean(request.force) });
  });
  ipcMain.handle("providers:request-log", () => codexProxy.requestLog());
  ipcMain.handle("workspace:open-external", (_event, input) => openWorkspaceExternal(input));
  handle("approval:respond", async (input) => {
    const payload = input as { requestId: string | number; decision: ApprovalDecision; threadId?: string };
    // Approval requests are emitted by the per-thread app-server that's running
    // the turn. The decision must go back to THAT child's stdin — routing it to
    // the global server() leaves the command waiting forever (5-min hang on the
    // first command/file approval). Fall back to the global server only when no
    // live thread server matches.
    const requestKey = String(payload.requestId);
    try {
      // Claude runtime canUseTool prompts share the same renderer dialog; their
      // request ids are claude-approval-* and resolve inside the runtime.
      if (!claudeRuntime.respondApproval(requestKey, payload.decision)) {
        const target = approvalRequestServers.get(requestKey) ?? (payload.threadId ? threadServers.get(payload.threadId) : undefined) ?? server();
        approvalRequestServers.delete(requestKey);
        await target.respondApproval(payload);
      }
      sendToRenderer("approval:resolved", { requestId: requestKey, ...(payload.threadId ? { threadId: payload.threadId } : {}) });
    } catch (error) {
      approvalRequestServers.delete(requestKey);
      throw error;
    }
  });
  handle("thread:create", async (input) => {
    await requireDevilChatAvailable();
    const request = input as any;
    if (requestedRuntime(request.runtime) === "claude-code") {
      const model = request.model || "claude-sonnet-5";
      const provider = request.provider && request.provider !== "codex" ? request.provider : "claude-code";
      const thread = provider === "claude-code"
        ? claudeRuntime.createThread({ cwd: request.cwd, model })
        : { id: crypto.randomUUID(), cwd: request.cwd, model, runtime: "claude-code", provider };
      const accountLabel = provider !== "claude-code" ? await providerAccountLabel(provider, request.accountId) : undefined;
      await providerTranscripts.saveMeta({
        ...thread,
        runtime: "claude-code",
        provider,
        accountId: request.accountId,
        accountLabel,
        claudeSessionId: provider === "claude-code" ? thread.id : undefined,
        title: provider === "claude-code" ? "새 Claude Code 채팅" : "새 외부 모델 채팅",
        preview: "",
        updatedAt: Date.now(),
        archived: false,
      });
      return provider === "claude-code" ? { ...thread, claudeSessionId: thread.id } : thread;
    }
    const instance = createAppServer(false);
    let bound = false;
    try {
      if (usesCodexProxy(request.provider)) {
        const routedModel = routedProviderModel(request.provider, request.model, request.accountId);
        const thread = await instance.createThread({ ...request, model: routedModel, modelProvider: "devil" });
        bindThreadServer(thread.id, instance);
        bound = true;
        loadedThreads.add(thread.id);
        await providerTranscripts.saveMeta({ ...thread, provider: request.provider, accountId: request.accountId, accountLabel: await providerAccountLabel(request.provider, request.accountId), title: "새 채팅", preview: "", updatedAt: Date.now(), archived: false });
        return { ...thread, runtime: "codex", provider: request.provider };
      }
      // API-key providers still use the established local transcript path until
      // their Responses adapters are registered with the local proxy as well.
      const thread = await instance.createThread({ ...request, model: request.provider && request.provider !== "codex" ? "gpt-5.5" : request.model });
      bindThreadServer(thread.id, instance);
      bound = true;
      loadedThreads.add(thread.id);
      return { ...thread, provider: request.provider ?? "codex" };
    } catch (error) {
      if (!bound) instance.dispose();
      throw error;
    }
  });
  handle("thread:list", async (input) => {
    const request = input as any;
    const runtime = requestedRuntime(request.runtime);
    if (runtime === "claude-code") {
      const requestedCwd = cwdKey(request.cwd);
      return filterRuntime((await providerTranscripts.summaries()).filter((summary) => cwdKey(summary.cwd) === requestedCwd && summary.archived === (request.archived ?? false)), "claude-code");
    }
    // Codex can still be booting while the renderer asks for a sidebar refresh.
    // Devil's own durable index must remain visible in that short window.
    const [codex, external, projectlessIds] = await Promise.all([server().listThreads(request).catch(() => []), providerTranscripts.summaries(), projectlessThreadIds()]);
    const markedCodex = markProjectlessThreads(codex, projectlessIds);
    const requestedCwd = cwdKey(request.cwd);
    const codexIds = new Set(markedCodex.map((summary) => summary.id));
    const extra = filterRuntime(external, "codex").filter((summary) => !codexIds.has(summary.id) && cwdKey(summary.cwd) === requestedCwd && summary.archived === (request.archived ?? false));
    const ids = new Set(extra.map((summary) => summary.id));
    const merged = [...extra, ...annotateCodexSummaries(markedCodex.filter((summary) => !ids.has(summary.id)), external)];
    sortThreadsByRecency(merged);
    return applySessionIndexTitles(merged);
  });
  // Model discovery is optional at startup. The provider settings UI retains
  // its saved models while Codex's app-server finishes connecting.
  handle("codex:models", () => server().listModels().catch(() => []));
  ipcMain.handle("chat:new-chat-cwd", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(app.getPath("home"), "Documents", "Codex", date, "new-chat");
    await fsMkdir(dir, { recursive: true }).catch(() => undefined);
    return dir;
  });
  handle("thread:search", async (input) => {
    const request = input as any;
    if (requestedRuntime(request.runtime) === "claude-code") {
      const query = String(request.query ?? "").trim().toLowerCase();
      if (!query) return [];
      return filterRuntime(await providerTranscripts.summaries(), "claude-code")
        .filter((summary) => summary.archived === (request.archived ?? false))
        .filter((summary) => `${summary.title}\n${summary.preview}\n${summary.cwd}`.toLowerCase().includes(query));
    }
    const [codex, stored, projectlessIds] = await Promise.all([server().searchThreads(request), providerTranscripts.summaries(), projectlessThreadIds()]);
    return applySessionIndexTitles(annotateCodexSummaries(markProjectlessThreads(codex, projectlessIds), stored));
  });
  handle("thread:resume", async (input) => {
    const request = input as any;
    if (requestedRuntime(request.runtime) === "claude-code") {
      const meta = filterRuntime(await providerTranscripts.summaries(), "claude-code").find((summary) => summary.id === request.id);
      return { ...claudeRuntime.resumeThread({ id: request.id, cwd: meta?.cwd, model: meta?.model || request.model || "claude-sonnet-5" }), claudeSessionId: meta?.claudeSessionId };
    }
    if (await providerTranscripts.isExternal(request.id)) {
      const meta = (await providerTranscripts.summaries()).find((summary) => summary.id === request.id);
      // Provider thread still has a native Codex shell from `thread/start`.
      // Resume it opportunistically so Codex app-server can load its mirror,
      // but never block Devil's local transcript if Codex rejects that shell.
      await threadServer(request.id).resumeThread(request).then(() => loadedThreads.add(request.id)).catch(() => undefined);
      return { id: request.id, cwd: meta?.cwd ?? "", model: meta?.model || request.model };
    }
    const instance = await threadServerFor(request.id);
    const ref = await instance.resumeThread(request);
    loadedThreads.add(request.id);
    return { ...ref, provider: "codex" };
  });
  handle("thread:meta:update", async (input) => {
    const request = input as ThreadMetaUpdate;
    const id = String(request?.id ?? "");
    if (!id) return;
    const meta: ThreadMetaUpdate = {
      id,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.runtime ? { runtime: request.runtime } : {}),
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.accountId ? { accountId: request.accountId } : { accountId: undefined }),
      ...(request.approvalPolicy ? { approvalPolicy: request.approvalPolicy } : {}),
      ...(request.sandboxMode ? { sandboxMode: request.sandboxMode } : {}),
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      ...(request.responseSpeed ? { responseSpeed: request.responseSpeed } : {}),
      ...(request.planMode !== undefined ? { planMode: Boolean(request.planMode) } : {}),
      ...(request.acceptEdits !== undefined ? { acceptEdits: Boolean(request.acceptEdits) } : {}),
    };
    await providerTranscripts.saveMeta(meta);
    sendToRenderer("thread:meta-changed", meta);
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
  handle("thread:review", async (input) => {
    const request = input as { threadId?: string; target?: Record<string, unknown>; delivery?: "inline" | "detached"; runtime?: AgentRuntimeId; cwd?: string; model?: string };
    const threadId = String(request.threadId ?? "");
    if (!threadId) throw new Error("리뷰할 채팅이 없습니다.");
    if (requestedRuntime(request.runtime) === "claude-code") throw new Error("Claude Code runtime은 Codex 네이티브 리뷰를 지원하지 않습니다.");
    const meta = (await providerTranscripts.summaries()).find((summary) => summary.id === threadId);
    if (threadRuntime(meta ?? { id: threadId, cwd: "", model: "", title: "", preview: "", updatedAt: 0, archived: false }) === "claude-code") {
      throw new Error("Claude Code runtime은 Codex 네이티브 리뷰를 지원하지 않습니다.");
    }
    await ensureThreadLoaded({ threadId, cwd: request.cwd ?? meta?.cwd, model: request.model ?? meta?.model ?? "gpt-5.5" });
    return await (await threadServerFor(threadId)).startReview({
      threadId,
      delivery: request.delivery ?? "inline",
      target: request.target ?? { type: "uncommittedChanges" },
    });
  });
  handle("thread:read", async (input) => {
    const request = input as any;
    if (requestedRuntime(request.runtime) === "claude-code") return normalizeCachedDelegateSubagents(stripInternalDirectivesFromHistory(await providerTranscripts.read(request.id)));
    await repairMirroredRolloutJsonl(request.id).catch(() => undefined);
    // External threads render from Devil's local transcript. BUT a mostly-native
    // thread that took even one stray external turn is flagged external forever
    // (providerTurns.length > 0) — and then this branch would hide its full
    // native rollout, showing only the handful of locally stored items while
    // stock Codex still has the whole conversation. Prefer the native rollout
    // whenever it has more items (the merge preserves local attachments); fall
    // back to local if the app-server hasn't loaded the mirror yet.
    if (await providerTranscripts.isExternal(request.id)) {
      const local = await providerTranscripts.read(request.id);
      let native: ThreadHistoryItem[] = [];
      try { native = await server().readThread(request); }
      catch (error) { if (isRolloutVersionSkew(error) && local.length === 0) return [rolloutSkewNotice()]; }
      if (native.length > local.length) {
        return attachCodexTokenUsage(request.id, stripInternalDirectivesFromHistory(await enrichThreadImages(request.id, await providerTranscripts.mergeHistoryPreservingAttachments(request.id, stripInternalDirectivesFromHistory(native)))));
      }
      return attachCodexTokenUsage(request.id, normalizeCachedDelegateSubagents(stripInternalDirectivesFromHistory(local)));
    }
    try {
      const rollout = await enrichThreadImages(request.id, await (await threadServerFor(request.id)).readThread(request));
      const cached = await historyCache.load(request.id);
      const merged = rollout.length ? mergeCachedActivities(rollout, cached) : cached ?? rollout;
      return attachCodexTokenUsage(request.id, stripInternalDirectivesFromHistory(merged));
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
    if (requestedRuntime(input.runtime) === "claude-code") return normalizeCachedDelegateSubagents(stripInternalDirectivesFromHistory(await providerTranscripts.read(input.id)));
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
      return attachCodexTokenUsage(input.id, stripInternalDirectivesFromHistory(await enrichThreadImages(input.id, await providerTranscripts.mergeHistoryPreservingAttachments(input.id, stripInternalDirectivesFromHistory(native)))));
    }
    return attachCodexTokenUsage(input.id, normalizeCachedDelegateSubagents(stripInternalDirectivesFromHistory(local)));
  });
  handle("thread:projects", async (input) => {
    const request = (input ?? {}) as any;
    const archived = request.archived ?? false;
    const runtime = requestedRuntime(request.runtime);
    if (runtime === "claude-code") return filterRuntime(await providerTranscripts.summaries(), "claude-code").filter((summary) => summary.archived === archived);
    const [codex, external, projectlessIds] = await Promise.all([server().listProjects(request).catch(() => []), providerTranscripts.summaries(), projectlessThreadIds()]);
    const markedCodex = markProjectlessThreads(codex, projectlessIds);
    const codexIds = new Set(markedCodex.map((summary) => summary.id));
    const extra = filterRuntime(external, "codex").filter((summary) => !codexIds.has(summary.id) && summary.archived === archived);
    const ids = new Set(extra.map((summary) => summary.id));
    const merged = [...extra, ...annotateCodexSummaries(markedCodex.filter((summary) => !ids.has(summary.id)), external)];
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
  handle("thread:queue:get", async (input) => getThreadQueueSnapshot(String((input as { threadId?: string } | undefined)?.threadId ?? "")));
  handle("thread:active", async (input) => {
    const threadId = String((input as { threadId?: string } | undefined)?.threadId ?? "");
    const turnId = threadId ? activeThreadTurnIds.get(threadId) : undefined;
    return { threadId, running: Boolean(threadId && activeThreadServerTurns.has(threadId)), ...(turnId ? { turnId } : {}) };
  });
  handle("thread:queue:sync", async (input) => {
    const request = input as ThreadQueueState;
    const threadId = String(request?.threadId ?? "");
    if (!threadId) return;
    setThreadQueueSnapshot(threadId, Array.isArray(request?.queue) ? request.queue : []);
  });
  handle("turn:queue:enqueue", async (input) => {
    await requireDevilChatAvailable();
    const request = input as { threadId?: string; entry?: { id: string; pending: any; userItem: ThreadHistoryItem; steering?: boolean }; front?: boolean };
    const threadId = String(request?.threadId ?? request?.entry?.pending?.threadId ?? "");
    if (!threadId || !request?.entry) return;
    sendThreadQueueCommand({ type: "enqueue", threadId, entry: request.entry as any, ...(request.front ? { front: true } : {}) });
  });
  handle("turn:queue:update", async (input) => {
    await requireDevilChatAvailable();
    const request = input as { threadId?: string; id?: string; text?: string };
    const threadId = String(request?.threadId ?? "");
    const id = String(request?.id ?? "");
    if (!threadId || !id) return;
    sendThreadQueueCommand({ type: "update", threadId, id, text: String(request?.text ?? "") });
  });
  handle("turn:queue:remove", async (input) => {
    const request = input as { threadId?: string; id?: string };
    const threadId = String(request?.threadId ?? "");
    const id = String(request?.id ?? "");
    if (!threadId || !id) return;
    sendThreadQueueCommand({ type: "remove", threadId, id });
  });
  handle("turn:queue:steer", async (input) => {
    await requireDevilChatAvailable();
    const request = input as { threadId?: string; id?: string };
    const threadId = String(request?.threadId ?? "");
    const id = String(request?.id ?? "");
    if (!threadId || !id) return;
    sendThreadQueueCommand({ type: "steer", threadId, id });
  });
  handle("turn:queue:clear", async (input) => {
    const request = input as { threadId?: string };
    const threadId = String(request?.threadId ?? "");
    if (!threadId) return;
    sendThreadQueueCommand({ type: "clear", threadId });
  });
  handle("turn:steer", async (input) => {
    await requireDevilChatAvailable();
    const request = input as { threadId?: string; text?: string; expectedTurnId?: string; runtime?: AgentRuntimeId };
    const threadId = String(request.threadId ?? "");
    const text = String(request.text ?? "").trim();
    const expectedTurnId = String(request.expectedTurnId ?? "");
    if (!threadId || !text || !expectedTurnId) throw new Error("스티어링할 실행 중 턴이 없습니다.");
    if (requestedRuntime(request.runtime) === "claude-code") throw new Error("Claude Code runtime은 현재 턴 네이티브 스티어링을 지원하지 않습니다.");
    return await threadServer(threadId).steerTurn({ threadId, text, expectedTurnId });
  });
  handle("turn:send", async (input) => {
    await requireDevilChatAvailable();
    const request = input as any;
    const attachmentEnrichment = await enrichDocumentAttachments(request.attachmentDetails);
    // When the "English output" setting is on, force English responses for every
    // provider by appending a directive to the model-bound text only. Transcripts
    // store the raw input.text, so the visible user message stays untouched.
    const { englishOutput, askUserMcpEnabled } = await settingsStore.load();
    const englishDirective = englishOutput ? `\n\n---\n${ENGLISH_OUTPUT_DIRECTIVE}` : "";
    // Codex exposes request_user_input only in Plan mode. Explicitly route
    // questions so Default turns never select that unavailable native tool,
    // while Plan turns keep using the stock Codex question experience.
    const questionDirective = request.planMode
      ? `\n\n---\n${NATIVE_ASK_USER_DIRECTIVE}`
      : askUserMcpEnabled
        ? `\n\n---\n${DEVIL_ASK_USER_DIRECTIVE}`
        : "";
    const turnInput = {
      ...request,
      text: `${request.text}${attachmentEnrichment.context}${englishDirective}${questionDirective}`,
      attachmentDetails: attachmentEnrichment.attachments,
    };
    if (!request.subagent && requestedRuntime(request.runtime) !== "claude-code") {
      const meta: ThreadMetaUpdate = {
        id: request.threadId,
        cwd: request.cwd ?? "",
        model: request.model,
        runtime: "codex",
        provider: request.provider ?? "codex",
        ...(request.accountId ? { accountId: request.accountId } : { accountId: undefined }),
        ...(request.approvalPolicy ? { approvalPolicy: request.approvalPolicy } : {}),
        ...(request.sandboxMode ? { sandboxMode: request.sandboxMode } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        ...(request.responseSpeed ? { responseSpeed: request.responseSpeed } : {}),
        ...(request.planMode !== undefined ? { planMode: Boolean(request.planMode) } : {}),
      };
      await providerTranscripts.saveMeta(meta);
      sendToRenderer("thread:meta-changed", meta);
    }
    if (requestedRuntime(request.runtime) === "claude-code") {
      const existingHistory = await providerTranscripts.read(request.threadId);
      const meta = filterRuntime(await providerTranscripts.summaries(), "claude-code").find((summary) => summary.id === request.threadId);
      const firstTurn = existingHistory.length === 0;
      const nativeSessionId = meta?.claudeSessionId;
      const nativeSessionExists = await claudeRuntime.sessionExists({ sessionId: nativeSessionId, cwd: request.cwd });
      const resumeClaudeCode = nativeSessionExists || hasClaudeCodeConversation(existingHistory);
      const provider = request.provider && request.provider !== "codex" ? request.provider : "claude-code";
      const accountLabel = provider !== "claude-code" ? await providerAccountLabel(provider, request.accountId) : undefined;
      await providerTranscripts.append(request.threadId, {
        id: crypto.randomUUID(),
        kind: "user",
        text: request.text,
        ...(attachmentEnrichment.attachments.length ? { attachments: attachmentEnrichment.attachments } : {}),
      });
      await providerTranscripts.saveMeta({
        id: request.threadId,
        cwd: request.cwd ?? "",
        model: request.model || "claude-sonnet-5",
        runtime: "claude-code",
        provider,
        accountId: request.accountId,
        accountLabel,
        preview: previewFromText(request.text),
        updatedAt: Date.now(),
        archived: false,
        ...(firstTurn ? { title: titleFromText(request.text) } : {}),
      });
      await rememberTurnFileSnapshot(request.threadId, request.cwd);
      if (provider !== "claude-code") {
        const text = await providerRuntime.send({ ...turnInput, provider });
        await providerTranscripts.append(request.threadId, { id: crypto.randomUUID(), kind: "agent", text, runtime: "claude-code", provider, model: request.model, accountId: request.accountId });
        return;
      }
      const requestLogId = crypto.randomUUID();
      const requestStartedAt = Date.now();
      await codexProxy.recordRuntimeRequest({
        id: requestLogId,
        provider,
        model: request.model || "claude-sonnet-5",
        accountId: request.accountId,
        accountLabel,
        threadId: request.threadId,
        route: "claude-agent-sdk",
        status: "started",
        startedAt: requestStartedAt,
        ...(request.attachments?.length ? { images: request.attachments.length } : {}),
      });
      try {
        const result = await claudeRuntime.sendTurn({
          threadId: request.threadId,
          cwd: request.cwd,
          text: turnInput.text,
          model: request.model || "claude-sonnet-5",
          resume: resumeClaudeCode,
          nativeSessionId,
          attachments: request.attachments,
          mcpConfig: await claudeMcpConfig(),
          approvalPolicy: request.approvalPolicy,
          sandboxMode: request.sandboxMode,
          planMode: Boolean(request.planMode),
          acceptEdits: Boolean(request.acceptEdits),
          ...(askUserMcpEnabled ? {
            onUserDialog: handleClaudeUserDialog,
            supportedDialogKinds: CLAUDE_NATIVE_ASK_DIALOG_KINDS,
            onAskUserQuestionTool: handleClaudeAskUserQuestionTool,
          } : {}),
          // Save the native session id as soon as it is known so a turn that
          // fails midway can still resume the same Claude session on retry.
          onSessionId: (sessionId) => { void providerTranscripts.saveMeta({ id: request.threadId, claudeSessionId: sessionId }); },
          onCompleted: (text, completed) => text.trim()
            ? providerTranscripts.append(request.threadId, { id: crypto.randomUUID(), kind: "agent", text, turnId: completed.turnId, runtime: "claude-code", provider, model: request.model || "claude-sonnet-5", accountId: request.accountId })
            : undefined,
        });
        if (result.contextUsage) await providerTranscripts.setTurnContextUsage(request.threadId, result.turnId, result.contextUsage);
        await codexProxy.finishRuntimeRequest(requestLogId, { status: "completed", completedAt: Date.now(), durationMs: Date.now() - requestStartedAt, ...(result.usage ? { usage: result.usage } : {}) });
        await emitSyntheticFileChanges({ threadId: request.threadId, turnId: result.turnId, status: "completed", mirrorRollout: false });
        if (result.sessionId) await providerTranscripts.saveMeta({ id: request.threadId, claudeSessionId: result.sessionId });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await codexProxy.finishRuntimeRequest(requestLogId, { status: "failed", completedAt: Date.now(), durationMs: Date.now() - requestStartedAt, error: detail });
        throw error;
      }
      return;
    }
    if (usesCodexProxy(request.provider)) {
      const routedModel = routedProviderModel(request.provider, request.model, request.accountId);
      const accountLabel = await providerAccountLabel(request.provider, request.accountId);
      // External providers use app-server tools and native rollout storage so stock Codex can see the turn after reconcile.
      await providerReconciler.markPending({ threadId: request.threadId, actualProvider: request.provider, actualModel: request.model });
      let externalInstance: CodexAppServer | undefined;
      try {
        // Ensure even a freshly created external-provider thread is persisted as
        // modelProvider:"devil" before the first turn. Some app-server builds
        // briefly write the new rollout as "openai"; sending during that window
        // routes the turn to Codex direct instead of the local proxy.
        const switched = await providerReconciler.prepareExternalTurn(request.threadId, { waitMs: 2500 });
        if (switched) {
          externalInstance = await restartThreadServer(request.threadId);
          await externalInstance.resumeThread({ id: request.threadId, model: routedModel, modelProvider: "devil", cwd: request.cwd }).then(() => loadedThreads.add(request.threadId)).catch(() => undefined);
        } else {
          // Thread server may be fresh (after a restart/prune) — resume so the
          // rollout is loaded before the turn, else "thread not found".
          await ensureThreadLoaded({ threadId: request.threadId, model: routedModel, cwd: request.cwd, modelProvider: "devil" });
          externalInstance = await threadServerFor(request.threadId);
        }
        if (await maybeStartContextCompaction(externalInstance, { ...request, appServerBacked: true })) return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await providerReconciler.discardPending(request.threadId);
        await providerTranscripts.markLatestProviderTurnSync(request.threadId, "failed", detail);
        throw error;
      }
      await providerTranscripts.recordProviderTurn({ threadId: request.threadId, provider: request.provider, model: request.model, accountId: request.accountId, accountLabel });
      try {
        // Subagent side-chat turns continue a child thread; do not register them
        // as a top-level Devil sidebar conversation (matches stock Codex, where
        // subagents are hidden children, not new chats).
        if (!request.subagent) {
          const title = await externalThreadTitle(request.threadId, request.text);
          await providerTranscripts.append(request.threadId, {
            id: crypto.randomUUID(),
            kind: "user",
            text: request.text,
            ...(attachmentEnrichment.attachments.length ? { attachments: attachmentEnrichment.attachments } : {}),
          });
          await providerTranscripts.saveMeta({
            id: request.threadId,
            cwd: request.cwd ?? "",
            model: request.model,
            provider: request.provider,
            accountId: request.accountId,
            accountLabel,
            preview: previewFromText(request.text),
            updatedAt: Date.now(),
            ...(title ? { title } : {}),
          });
        }
        pendingProviderDiagnostics.set(request.threadId, { provider: request.provider, model: request.model, accountId: request.accountId, accountLabel, sidecars: request.sidecars, sandboxMode: request.sandboxMode, approvalPolicy: request.approvalPolicy, cwd: request.cwd });
        codexProxy.setSidecarSettings(request.threadId, request.sidecars);
        await rememberTurnFileSnapshot(request.threadId, request.cwd);
        await (externalInstance ?? threadServer(request.threadId)).sendTurn({ ...turnInput, model: routedModel });
      } catch (error) {
        await providerReconciler.discardPending(request.threadId);
        const detail = error instanceof Error ? error.message : String(error);
        await providerTranscripts.markLatestProviderTurnSync(request.threadId, "failed", detail);
        const pendingDiagnostics = pendingProviderDiagnostics.get(request.threadId);
        pendingProviderDiagnostics.delete(request.threadId);
        const sidecarActual = codexProxy.consumeSidecarStats(request.threadId);
        emitSidecarActivities({ threadId: request.threadId, sidecarActual });
        emitProviderDiagnostics({
          threadId: request.threadId,
          provider: pendingDiagnostics?.provider ?? request.provider,
          model: pendingDiagnostics?.model ?? request.model,
          accountLabel: pendingDiagnostics?.accountLabel,
          status: "failed",
          error: detail,
          sidecars: pendingDiagnostics?.sidecars ?? request.sidecars,
          sidecarActual,
          sandboxMode: pendingDiagnostics?.sandboxMode ?? request.sandboxMode,
          approvalPolicy: pendingDiagnostics?.approvalPolicy ?? request.approvalPolicy,
        });
        throw error;
      }
      return;
    }
    if (request.provider && request.provider !== "codex") {
      const firstTurn = !(await providerTranscripts.isExternal(request.threadId));
      const accountLabel = await providerAccountLabel(request.provider, request.accountId);
      await providerTranscripts.append(request.threadId, {
        id: crypto.randomUUID(),
        kind: "user",
        text: request.text,
        ...(attachmentEnrichment.attachments.length ? { attachments: attachmentEnrichment.attachments } : {}),
      });
      await providerTranscripts.saveMeta({
        id: request.threadId,
        cwd: request.cwd ?? "",
        model: request.model,
        provider: request.provider,
        accountId: request.accountId,
        accountLabel,
        preview: previewFromText(request.text),
        updatedAt: Date.now(),
        ...(firstTurn ? { title: titleFromText(request.text) } : {}),
      });
      const agentItemId = crypto.randomUUID();
      let agentText = "";
      try {
        const text = await providerRuntime.send({ ...turnInput, onDelta: (delta) => { agentText += delta; void providerTranscripts.upsertPartialAgent(request.threadId, agentItemId, { id: agentItemId, kind: "agent", text: agentText, status: "inProgress", runtime: "codex", provider: request.provider, model: request.model, accountId: request.accountId }).catch(() => undefined); } });
        await providerTranscripts.upsertPartialAgent(request.threadId, agentItemId, { id: agentItemId, kind: "agent", text: text.trim() || agentText, status: "completed", runtime: "codex", provider: request.provider, model: request.model, accountId: request.accountId });
      } catch (error) {
        if (agentText.trim()) await providerTranscripts.upsertPartialAgent(request.threadId, agentItemId, { id: agentItemId, kind: "agent", text: agentText, status: "interrupted", runtime: "codex", provider: request.provider, model: request.model, accountId: request.accountId }).catch(() => undefined);
        throw error;
      }
      return;
    }
    try {
      await rememberTurnFileSnapshot(request.threadId, request.cwd);
      await ensureThreadLoaded({ threadId: request.threadId, model: request.model, cwd: request.cwd });
      const instance = await threadServerFor(request.threadId);
      if (await maybeStartContextCompaction(instance, request)) return;
      pendingProviderDiagnostics.set(request.threadId, { provider: request.provider ?? "codex", model: request.model, sidecars: request.sidecars, sandboxMode: request.sandboxMode, approvalPolicy: request.approvalPolicy, cwd: request.cwd });
      codexProxy.setSidecarSettings(request.threadId, request.sidecars);
      await instance.sendTurn(turnInput);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const pendingDiagnostics = pendingProviderDiagnostics.get(request.threadId);
      pendingProviderDiagnostics.delete(request.threadId);
      const sidecarActual = codexProxy.consumeSidecarStats(request.threadId);
      emitSidecarActivities({ threadId: request.threadId, sidecarActual });
      emitProviderDiagnostics({
        threadId: request.threadId,
        provider: pendingDiagnostics?.provider ?? request.provider ?? "codex",
        model: pendingDiagnostics?.model ?? request.model,
        accountLabel: pendingDiagnostics?.accountLabel,
        status: "failed",
        error: detail,
        sidecars: pendingDiagnostics?.sidecars ?? request.sidecars,
        sidecarActual,
        sandboxMode: pendingDiagnostics?.sandboxMode ?? request.sandboxMode,
        approvalPolicy: pendingDiagnostics?.approvalPolicy ?? request.approvalPolicy,
      });
      throw error;
    }
  });
  handle("turn:interrupt", async (input) => {
    const request = input as any;
    if (requestedRuntime(request.runtime) === "claude-code") {
      if (claudeRuntime.interruptTurn(request)) return;
      if (providerRuntime.interrupt(request.threadId)) return;
      throw new Error("no active turn to interrupt");
    }
    if (providerRuntime.interrupt(request.threadId)) return;
    await threadServer(request.threadId).interruptTurn(request);
  });

  ipcHandlersReady = true;
  createBackgroundTray();
  if (showMainWindowWhenReady) showMainWindow();
  else createWindow();
  if (startupBridgeFailure && windowRef) {
    const message = startupBridgeFailure;
    startupBridgeFailure = "";
    setTimeout(() => {
      if (windowRef && !windowRef.isDestroyed()) void dialog.showMessageBox(windowRef, { type: "error", title: "Bridge 시작 실패", message });
    }, 450);
  }
  initAutoUpdate(() => windowRef);
  app.on("activate", () => showMainWindow());
});

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  // The bridge config must be fully written before Electron releases the
  // desktop process. Otherwise stock Codex can see a catalog entry whose
  // background proxy was never started.
  if (!stockProxyServiceMode && !stockBridgeHandoffStarted) {
    event.preventDefault();
    stockBridgeHandoffStarted = true;
    void (async () => {
      try {
        const settings = await settingsStore.load().catch(() => null);
        if (settings?.stockBridgeEnabled === false) {
          await deactivateStockCodexBridge();
        } else {
          await activateStockCodexBridge();
          if (desktopOwnsProxy) launchStockProxyService();
        }
        // Do not fire-and-forget these writes: Electron can otherwise exit
        // first and leave global Devil MCP entries visible to stock Codex.
        await unregisterDevilExclusiveMcps();
      } catch (error) {
        console.error("[devil-codex stock bridge] handoff failed:", error instanceof Error ? error.message : error);
      }
      app.quit();
    })();
    return;
  }
  isQuitting = true;
  // Leave a small headless owner for the stock-Codex bridge before the desktop
  // instance releases port 49873. The service reuses the same encrypted
  // Provider settings and managed config/catalog files.
  trayRef?.destroy();
  trayRef = undefined;
  appServer?.dispose();
  claudeRuntime.disposeAllInstances();
  for (const instance of threadServers.values()) instance.dispose();
  threadServers.clear();
  threadServerLastUsed.clear();
  activeThreadServerTurns.clear();
  activeThreadTurnIds.clear();
  terminalManager?.dispose();
  browserControl.stop(); // free 49874 so the next launch binds cleanly
  desktopControl.stop();
  askControl.stop();
  subagentControl.stop();
  workspaceWatcher.disposeAll();
  void stopRemoteControl({ saveSettings: false });
  // Keep the managed provider block in ~/.codex/config.toml. Rollouts created
  // through it must remain recognisable to stock Codex after Devil exits.
  void codexProxy.stop();
  void unrealMcpRelay.stop();
});
