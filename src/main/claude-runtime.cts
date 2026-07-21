import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import type { AppServerEvent, ApprovalDecision, ClaudeSlashCommandInfo, ContextUsage, RuntimeStatus, ThreadApprovalPolicy, ThreadRef, ThreadSandboxMode } from "./contracts.cjs";

type ClaudeSdkMessage = Record<string, unknown>;
type ClaudeSdkOptions = Record<string, unknown>;
type ClaudeSdkContentBlock = Record<string, unknown>;
type ClaudeSdkUserMessage = { type: "user"; message: { role: "user"; content: string | ClaudeSdkContentBlock[] }; parent_tool_use_id: null };
type ClaudeSdkQuery = AsyncIterable<ClaudeSdkMessage> & {
  initializationResult?: () => Promise<{ commands?: unknown[] }>;
  supportedCommands?: () => Promise<unknown[]>;
  getContextUsage?: () => Promise<unknown>;
  setModel?: (model?: string) => Promise<void>;
  setPermissionMode?: (mode: string) => Promise<void>;
};
type TurnUsageSnapshot = { usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; total_tokens: number; cache_miss_reason?: string; cache_missed_input_tokens?: number }; contextUsage?: ContextUsage; modelContextWindow?: number };
export type ClaudeTurnUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; totalTokens: number; cacheMissReason?: string; cacheMissedInputTokens?: number };

const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 1500;
// Keep an idle Claude Code process alive briefly so follow-up turns reuse the
// same session process (no SessionStart hook re-fire, warm prompt cache). The
// Anthropic prompt cache TTL is 5 minutes; past ~10 minutes a fresh resume
// costs the same, so reap the process to free memory.
const CLAUDE_INSTANCE_IDLE_MS = 10 * 60_000;

type TurnContext = {
  threadId: string;
  turnId: string;
  fallbackItemId: string;
  currentTextItemId?: string;
  onTextDelta: (itemId: string, delta: string) => void;
  onFinalText: (text: string) => void;
  onSessionId: (sessionId: string) => void;
  onUsage: (snapshot: TurnUsageSnapshot) => void;
};

function claudeBin(): string {
  const override = process.env.DEVIL_CLAUDE_BIN;
  if (override) return override;
  return process.platform === "win32" ? "claude.cmd" : "claude";
}

function unpackedAsarPath(path: string): string {
  return path.includes("app.asar") ? path.replace("app.asar", "app.asar.unpacked") : path;
}

function commandSpec(bin: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", bin, ...args] };
  }
  return { command: bin, args };
}

// The Agent SDK ships a bundled Claude Code binary per platform via
// optionalDependencies, so a separately installed `claude` CLI is not
// required. Resolve the same candidate packages the SDK itself tries.
function sdkBundledExecutable(): string | undefined {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${suffix}`,
    ...(process.platform === "linux" ? [`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude`] : []),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = require.resolve(candidate);
      const unpacked = unpackedAsarPath(resolved);
      if (existsSync(unpacked)) return unpacked;
      if (existsSync(resolved) && !resolved.includes("app.asar")) return resolved;
    } catch {
      // try the next candidate package
    }
  }
  return undefined;
}

function claudeCodeExecutable(): string | undefined {
  const override = process.env.DEVIL_CLAUDE_BIN;
  if (override && existsSync(override)) return override;
  return sdkBundledExecutable();
}

function claudeProjectKey(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const windows = /^([A-Za-z]):[\\/](.*)$/.exec(normalized);
  if (windows) return `${windows[1]}--${windows[2]!.split(/[\\/]+/).filter(Boolean).join("-")}`;
  return `-${normalized.replace(/^\/+/, "").split(/[\\/]+/).filter(Boolean).join("-")}`;
}

async function normalizeClaudeSessionEntrypoint(cwd: string, sessionId: string | undefined): Promise<void> {
  if (!sessionId || !cwd) return;
  const path = await claudeSessionPath(cwd, sessionId);
  if (!path) return;
  let source = "";
  try { source = await readFile(path, "utf8"); } catch { return; }
  if (!source.includes('"entrypoint":"sdk-cli"')) return;
  const next = source.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    try {
      const parsed = JSON.parse(line) as { entrypoint?: unknown };
      if (parsed.entrypoint === "sdk-cli") parsed.entrypoint = "cli";
      return JSON.stringify(parsed);
    } catch {
      return line;
    }
  }).join("\n");
  if (next !== source) await writeFile(path, next, "utf8");
}

const claudeSessionPathCache = new Map<string, string>();

async function claudeSessionPath(cwd: string, sessionId: string): Promise<string | undefined> {
  const cached = claudeSessionPathCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const direct = join(homedir(), ".claude", "projects", claudeProjectKey(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) {
    claudeSessionPathCache.set(sessionId, direct);
    return direct;
  }
  const root = join(homedir(), ".claude", "projects");
  const target = `${sessionId}.jsonl`;
  const scan = async (dir: string, depth = 0): Promise<string | undefined> => {
    if (depth > 5) return undefined;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === target) return path;
      if (entry.isDirectory()) {
        const found = await scan(path, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  const found = await scan(root);
  if (found) claudeSessionPathCache.set(sessionId, found);
  return found;
}

function normalizeClaudeSessionEntrypointSoon(cwd: string, sessionId: string | undefined): void {
  for (const delayMs of [0, 150, 600, 1500]) {
    setTimeout(() => {
      void normalizeClaudeSessionEntrypoint(cwd, sessionId).catch(() => undefined);
    }, delayMs);
  }
}

// The SDK's `exports` map hides its package.json from require(), so read it
// from disk next to the resolved platform binary package.
function sdkClaudeCodeVersion(bundledExecutable: string): string | undefined {
  try {
    const metaPath = join(dirname(bundledExecutable), "..", "claude-agent-sdk", "package.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { claudeCodeVersion?: string; version?: string };
    return meta.claudeCodeVersion ?? meta.version;
  } catch {
    return undefined;
  }
}

// The stock CLI's Shift+Tab cycle: default -> acceptEdits -> plan -> back to
// default (bypassPermissions is a separate, deliberate "full access" escalation
// surfaced through Devil's own approval picker, not this cycle).
type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

function permissionMode(approvalPolicy?: ThreadApprovalPolicy, sandboxMode?: ThreadSandboxMode, planMode?: boolean, acceptEditsMode?: boolean): ClaudePermissionMode {
  if (planMode) return "plan";
  if (sandboxMode === "danger-full-access" || approvalPolicy === "never") return "bypassPermissions";
  if (acceptEditsMode) return "acceptEdits";
  // Claude Code's own permission engine decides WHEN to ask; Devil only
  // supplies the answer UI via the canUseTool bridge (same modal as Codex
  // approvals). Keep the default mode aligned with the stock CLI instead of
  // auto-accepting edits; fewer silent tool loops means less repeated cached
  // context usage in long sessions.
  if (sandboxMode === "read-only") return "default";
  return "default";
}

type ClaudeSdkModule = {
  query: (input: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkOptions }) => ClaudeSdkQuery;
  getSessionInfo?: (sessionId: string, options?: { dir?: string }) => Promise<unknown>;
};

async function claudeSdk(): Promise<ClaudeSdkModule> {
  // Cast: Devil builds content blocks as plain records instead of importing
  // the SDK's parameter types, keeping this module free of type-only deps.
  return import("@anthropic-ai/claude-agent-sdk") as unknown as Promise<ClaudeSdkModule>;
}

function cleanErrorMessage(value: unknown): string {
  return String(value ?? "").replace(/\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function messageContent(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = event.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? content.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object") : [];
}

function toolInput(part: Record<string, unknown>): Record<string, unknown> {
  const input = part.input;
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  if (/^(bash|powershell)$/i.test(name)) return String(input.command ?? name);
  if (/^(read|edit|write|notebookedit)$/i.test(name)) return String(input.file_path ?? input.path ?? name);
  // ExitPlanMode's `plan` field is the markdown plan text itself — show that
  // instead of a raw JSON blob so the approval card reads like the stock CLI's
  // plan review screen.
  if (name === "ExitPlanMode" && typeof input.plan === "string") return input.plan;
  return Object.keys(input).length ? JSON.stringify(input) : name;
}

function fileChangePath(name: string, input: Record<string, unknown>): string | undefined {
  if (!/^(edit|write|multiedit|notebookedit)$/i.test(name)) return undefined;
  const path = input.file_path ?? input.path ?? input.notebook_path;
  return typeof path === "string" && path.trim() ? path : undefined;
}

function toolResultText(part: Record<string, unknown>): string {
  const content = part.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      return String(record.text ?? record.content ?? "");
    }
    return "";
  }).filter(Boolean).join("\n");
  return "";
}

// An MCP tool result reaches us in whichever image shape its transport used:
// the MCP wire shape ({type:"image",data,mimeType}) or - what the Claude Agent
// SDK actually hands back for devil_browser/devil_computer screenshots - the
// Anthropic content-block shape ({type:"image",source:{type:"base64",
// media_type,data}}). Reading only `data` silently dropped every screenshot,
// so the activity card fell back to printing the tool name. Normalize both to
// the MCP shape the renderer's mcpResultContent() consumes.
function imageResultBlock(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof record.data === "string") return { type: "image", data: record.data, mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png" };
  const source = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : undefined;
  if (!source) return undefined;
  if (typeof source.data === "string") return { type: "image", data: source.data, mimeType: typeof source.media_type === "string" ? source.media_type : "image/png" };
  if (typeof source.url === "string") return { type: "image_url", image_url: { url: source.url } };
  return undefined;
}

// Like toolResultText, but keeps image blocks instead of collapsing them to
// "" (record.text ?? record.content is empty for an image part, so a plain
// text join silently drops screenshots — e.g. browser_screenshot/
// computer_screenshot results). The renderer's mcpResultContent() expects
// {type:"image",data,mimeType} entries to render the actual screenshot.
function toolResultContent(part: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = part.content;
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry): Array<Record<string, unknown>> => {
    if (typeof entry === "string") return entry ? [{ type: "text", text: entry }] : [];
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (type === "image") {
      const image = imageResultBlock(record);
      if (image) return [image];
    }
    if (type === "image_url") return [record];
    const text = String(record.text ?? record.content ?? "");
    return text ? [{ type: "text", text }] : [];
  });
}

function assistantContentText(message: Record<string, unknown>): string {
  return messageContent({ message })
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function parseMcpServers(config: string | undefined): Record<string, unknown> | undefined {
  if (!config) return undefined;
  try {
    const parsed = JSON.parse(config) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : undefined;
  } catch {
    return undefined;
  }
}

function normalizeSlashCommand(value: unknown): ClaudeSlashCommandInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return undefined;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const argumentHint = typeof record.argumentHint === "string" ? record.argumentHint.trim() : "";
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0).map((alias) => alias.trim())
    : [];
  return { name, description, ...(argumentHint ? { argumentHint } : {}), ...(aliases.length ? { aliases } : {}) };
}

const IMAGE_MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// Composer image attachments arrive as data URLs (paste) or file paths
// (drag/select). Convert each into an Anthropic image content block; anything
// unreadable or in an unsupported format is skipped rather than failing the turn.
function imageBlock(source: string): ClaudeSdkContentBlock | undefined {
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(source);
  if (dataUrl) return { type: "image", source: { type: "base64", media_type: dataUrl[1]!.toLowerCase(), data: dataUrl[2]! } };
  if (/^https?:\/\//i.test(source)) return { type: "image", source: { type: "url", url: source } };
  const mediaType = IMAGE_MEDIA_TYPES[extname(source).toLowerCase().replace(".", "")];
  if (!mediaType) return undefined;
  try {
    return { type: "image", source: { type: "base64", media_type: mediaType, data: readFileSync(source).toString("base64") } };
  } catch {
    return undefined;
  }
}

function userMessageContent(text: string, attachments: string[] | undefined): string | ClaudeSdkContentBlock[] {
  const images = (attachments ?? []).map(imageBlock).filter((block): block is ClaudeSdkContentBlock => Boolean(block));
  if (!images.length) return text;
  return [{ type: "text", text }, ...images];
}

function turnUsageResult(snapshot: TurnUsageSnapshot | undefined): ClaudeTurnUsage | undefined {
  if (!snapshot) return undefined;
  return {
    inputTokens: snapshot.usage.input_tokens,
    outputTokens: snapshot.usage.output_tokens,
    ...(snapshot.usage.cached_input_tokens ? { cachedInputTokens: snapshot.usage.cached_input_tokens } : {}),
    ...(snapshot.usage.cache_read_input_tokens ? { cacheReadInputTokens: snapshot.usage.cache_read_input_tokens } : {}),
    ...(snapshot.usage.cache_creation_input_tokens ? { cacheCreationInputTokens: snapshot.usage.cache_creation_input_tokens } : {}),
    ...(snapshot.usage.cache_miss_reason ? { cacheMissReason: snapshot.usage.cache_miss_reason } : {}),
    ...(snapshot.usage.cache_missed_input_tokens ? { cacheMissedInputTokens: snapshot.usage.cache_missed_input_tokens } : {}),
    totalTokens: snapshot.usage.total_tokens,
  };
}

function resultUsage(message: ClaudeSdkMessage): TurnUsageSnapshot | undefined {
  const raw = message.usage;
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const cacheRead = num(record.cache_read_input_tokens);
  const cacheCreation = num(record.cache_creation_input_tokens);
  const cached = cacheRead + cacheCreation;
  const input = num(record.input_tokens);
  const output = num(record.output_tokens);
  if (input + cached + output <= 0) return undefined;
  const diagnostics = message.diagnostics && typeof message.diagnostics === "object" ? message.diagnostics as Record<string, unknown> : {};
  const miss = diagnostics.cache_miss_reason && typeof diagnostics.cache_miss_reason === "object"
    ? diagnostics.cache_miss_reason as Record<string, unknown>
    : undefined;
  const cacheMissReason = typeof diagnostics.cache_miss_reason === "string"
    ? diagnostics.cache_miss_reason
    : typeof miss?.type === "string" ? miss.type : undefined;
  const cacheMissedInputTokens = num(diagnostics.cache_missed_input_tokens ?? miss?.cache_missed_input_tokens);
  const models = message.modelUsage && typeof message.modelUsage === "object"
    ? Object.values(message.modelUsage as Record<string, { contextWindow?: unknown }>)
    : [];
  const contextWindow = models.reduce((max, model) => Math.max(max, typeof model.contextWindow === "number" ? model.contextWindow : 0), 0);
  const promptInput = input + cached;
  return {
    usage: {
      input_tokens: input,
      output_tokens: output,
      ...(cached ? { cached_input_tokens: cached } : {}),
      ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
      ...(cacheCreation ? { cache_creation_input_tokens: cacheCreation } : {}),
      ...(cacheMissReason ? { cache_miss_reason: cacheMissReason } : {}),
      ...(cacheMissedInputTokens ? { cache_missed_input_tokens: cacheMissedInputTokens } : {}),
      total_tokens: promptInput + output,
    },
    ...(contextWindow > 0 && promptInput > 0 ? {
      contextUsage: {
        usedTokens: promptInput,
        maxTokens: contextWindow,
        source: "claude-code-result",
        scope: "last-request",
        includesCache: Boolean(cached),
        inputTokens: input,
        cachedInputTokens: cached,
        outputTokens: output,
      },
    } : {}),
    ...(contextWindow > 0 ? { modelContextWindow: contextWindow } : {}),
  };
}

function contextUsageFromSdkControl(value: unknown): ContextUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const totalTokens = compactNumber(raw.totalTokens ?? raw.total_tokens);
  const maxTokens = compactNumber(raw.maxTokens ?? raw.max_tokens ?? raw.rawMaxTokens ?? raw.raw_max_tokens);
  if (!totalTokens || !maxTokens) return undefined;
  const rawMaxTokens = compactNumber(raw.rawMaxTokens ?? raw.raw_max_tokens);
  const percentage = compactNumber(raw.percentage);
  const autoCompactThreshold = compactNumber(raw.autoCompactThreshold ?? raw.auto_compact_threshold);
  const autoCompactEnabled = typeof raw.isAutoCompactEnabled === "boolean"
    ? raw.isAutoCompactEnabled
    : typeof raw.autoCompactEnabled === "boolean"
      ? raw.autoCompactEnabled
      : undefined;
  const categories = Array.isArray(raw.categories)
    ? raw.categories.flatMap((category) => {
      if (!category || typeof category !== "object") return [];
      const record = category as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      const tokens = compactNumber(record.tokens);
      if (!name || !tokens) return [];
      const color = typeof record.color === "string" ? record.color : undefined;
      const isDeferred = typeof record.isDeferred === "boolean" ? record.isDeferred : undefined;
      return [{ name, tokens, ...(color ? { color } : {}), ...(typeof isDeferred === "boolean" ? { isDeferred } : {}) }];
    })
    : undefined;
  return {
    usedTokens: totalTokens,
    maxTokens,
    source: "claude-code-sdk",
    scope: "current-context",
    includesCache: false,
    ...(rawMaxTokens ? { rawMaxTokens } : {}),
    ...(percentage ? { percentage } : {}),
    ...(autoCompactThreshold ? { autoCompactThreshold } : {}),
    ...(typeof autoCompactEnabled === "boolean" ? { autoCompactEnabled } : {}),
    ...(categories?.length ? { categories } : {}),
  };
}

async function sdkCurrentContextUsage(request: ClaudeSdkQuery): Promise<ContextUsage | undefined> {
  if (typeof request.getContextUsage !== "function") return undefined;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), CLAUDE_CONTEXT_USAGE_TIMEOUT_MS);
    request.getContextUsage!()
      .then((value) => resolve(contextUsageFromSdkControl(value)))
      .catch(() => resolve(undefined))
      .finally(() => clearTimeout(timer));
  });
}

function claudeCodeSettings(): Record<string, unknown> {
  // Let Claude Code use its native auto-compact threshold/window. Devil only
  // makes sure the default auto-compact behavior is enabled for SDK sessions.
  return { autoCompactEnabled: true };
}

function compactMetadata(message: ClaudeSdkMessage): Record<string, unknown> {
  const raw = message.compact_metadata ?? message.compactMetadata;
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function compactNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function compactDetail(meta: Record<string, unknown>): string {
  const pre = compactNumber(meta.pre_tokens ?? meta.preTokens);
  const post = compactNumber(meta.post_tokens ?? meta.postTokens);
  const duration = compactNumber(meta.duration_ms ?? meta.durationMs);
  const parts = [
    pre ? `압축 전 ${Math.round(pre).toLocaleString()} tokens` : "",
    post ? `압축 후 ${Math.round(post).toLocaleString()} tokens` : "",
    duration ? `${Math.round(duration)}ms` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

type ActiveTurn = { context: TurnContext; resolve: () => void; reject: (error: unknown) => void };
type BackgroundTurn = ActiveTurn & { background: true; startedAt: number; usageSnapshot?: TurnUsageSnapshot };

function isBackgroundTurn(turn: ActiveTurn): turn is BackgroundTurn {
  return (turn as { background?: unknown }).background === true;
}

// One live Claude Code process per Devil thread. Later turns stream into the
// same process instead of respawning per turn, matching the stock CLI's
// single-process conversation: SessionStart hooks fire once, the prompt-cache
// prefix stays warm, and turn startup skips process/MCP re-init.
type ThreadInstance = {
  fingerprint: string;
  request: ClaudeSdkQuery;
  push: (message: ClaudeSdkUserMessage) => void;
  end: () => void;
  abortController: AbortController;
  model: string;
  sessionId?: string;
  currentTurn?: ActiveTurn;
  idleTimer?: NodeJS.Timeout;
  disposed: boolean;
  // Live permission mode of the running process. default/acceptEdits/plan
  // switch in place via the SDK's setPermissionMode() (same trick as model
  // changes); only a bypassPermissions transition needs a fresh process
  // (allowDangerouslySkipPermissions + the canUseTool wiring are spawn-time
  // fixed).
  currentMode: ClaudePermissionMode;
};

type PermissionResultLike =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };
type UserDialogRequestLike = { dialogKind: string; payload: Record<string, unknown>; toolUseID?: string };
type UserDialogResultLike = { behavior: "completed"; result: unknown } | { behavior: "cancelled" };
type OnUserDialogLike = (request: UserDialogRequestLike, options: { signal: AbortSignal }) => Promise<UserDialogResultLike>;
type OnAskUserQuestionToolLike = (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<PermissionResultLike>;

export class ClaudeCodeRuntime extends EventEmitter {
  private active = new Map<string, AbortController>();
  private instances = new Map<string, ThreadInstance>();
  private toolRuns = new Map<string, { threadId: string; name: string; kind: "command" | "tool" | "fileChange"; summary: string; path?: string }>();
  private pendingApprovals = new Map<string, { threadId: string; resolve: (decision: ApprovalDecision) => void }>();

  constructor(private readonly cwd: string) {
    super();
  }

  getStatus(): RuntimeStatus {
    return this.probe();
  }

  async connect(): Promise<RuntimeStatus> {
    return this.probe();
  }

  createThread(input: { cwd: string; model: string }): ThreadRef {
    return { id: crypto.randomUUID(), cwd: input.cwd, model: input.model, runtime: "claude-code", provider: "claude-code" };
  }

  resumeThread(input: { id: string; cwd?: string; model: string }): ThreadRef {
    return { id: input.id, cwd: input.cwd ?? this.cwd, model: input.model, runtime: "claude-code", provider: "claude-code" };
  }

  async sessionExists(input: { sessionId?: string; cwd?: string }): Promise<boolean> {
    if (!input.sessionId) return false;
    try {
      const { getSessionInfo } = await claudeSdk();
      if (!getSessionInfo) return false;
      return Boolean(await getSessionInfo(input.sessionId, { dir: input.cwd ?? this.cwd }));
    } catch {
      return false;
    }
  }

  async listSlashCommands(input: { cwd?: string; model?: string; mcpConfig?: string; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode } = {}): Promise<ClaudeSlashCommandInfo[]> {
    const abortController = new AbortController();
    const { query } = await claudeSdk();
    const pathToClaudeCodeExecutable = claudeCodeExecutable();
    const mode = permissionMode(input.approvalPolicy, input.sandboxMode);
    const messages = (async function* (): AsyncGenerator<ClaudeSdkUserMessage> {})();
    const request = query({
      prompt: messages,
      options: {
        cwd: input.cwd ?? this.cwd,
        model: input.model ?? "claude-sonnet-5",
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
        abortController,
        includePartialMessages: false,
        permissionMode: mode,
        allowDangerouslySkipPermissions: mode === "bypassPermissions",
        mcpServers: parseMcpServers(input.mcpConfig),
      },
    });
    try {
      const rawCommands = typeof request.supportedCommands === "function"
        ? await request.supportedCommands()
        : typeof request.initializationResult === "function"
          ? (await request.initializationResult()).commands ?? []
          : [];
      const seen = new Set<string>();
      return rawCommands.flatMap((command) => {
        const normalized = normalizeSlashCommand(command);
        if (!normalized) return [];
        const key = normalized.name.toLowerCase();
        if (seen.has(key)) return [];
        seen.add(key);
        return [normalized];
      });
    } finally {
      abortController.abort();
    }
  }

  async sendTurn(input: { threadId: string; cwd: string; text: string; model: string; resume?: boolean; nativeSessionId?: string; mcpConfig?: string; attachments?: string[]; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode; planMode?: boolean; acceptEdits?: boolean; onUserDialog?: OnUserDialogLike; supportedDialogKinds?: string[]; onAskUserQuestionTool?: OnAskUserQuestionToolLike; onSessionId?: (sessionId: string) => void; onCompleted?: (text: string, meta: { turnId: string }) => Promise<void> | void }): Promise<{ sessionId?: string; turnId: string; usage?: ClaudeTurnUsage; contextUsage?: ContextUsage }> {
    if (this.active.has(input.threadId)) throw new Error("이 Claude Code thread는 이미 응답 생성 중입니다.");
    const turnId = `claude-${crypto.randomUUID()}`;
    const itemId = `claude-message-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    let streamedText = "";
    let finalText = "";
    let nativeSessionId = input.nativeSessionId;
    let usageSnapshot: TurnUsageSnapshot | undefined;
    let sdkContextUsage: ContextUsage | undefined;
    const mode = permissionMode(input.approvalPolicy, input.sandboxMode, input.planMode, input.acceptEdits);
    // Reserve the thread's "occupied" slot *before* the first await below. The
    // real per-instance abortController does not exist until obtainInstance()
    // resolves (spawning/reusing a process is async), so without this
    // placeholder a second sendTurn() for the same thread issued while the
    // first is still starting up would also pass the `this.active.has()`
    // guard above and race into obtainInstance concurrently - corrupting
    // `this.instances` (last writer wins) and orphaning one turn's process
    // with no one left to read its response (renderer sees it as "hung").
    // This also makes interruptTurn() correctly report an active turn during
    // the startup window instead of falsely returning "no active turn".
    const startAbort = new AbortController();
    this.active.set(input.threadId, startAbort);
    this.emitEvent({ method: "turn/started", params: { threadId: input.threadId, turnId, turn: { id: turnId, startedAt: startedAt / 1000 } } });

    const content = userMessageContent(input.text, input.attachments);
    let instance: ThreadInstance;
    try {
      instance = await this.obtainInstance(input, mode);
    } catch (error) {
      if (this.active.get(input.threadId) === startAbort) this.active.delete(input.threadId);
      this.emitEvent({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: `claude-error-${turnId}`, type: "error", message: cleanErrorMessage(error instanceof Error ? error.message : error), status: "failed" } } });
      this.emitEvent({ method: "turn/completed", params: { threadId: input.threadId, turnId, turn: { id: turnId, status: "failed", durationMs: Date.now() - startedAt } } });
      throw error;
    }
    // interruptTurn() always removes (or, for a freshly-created instance,
    // replaces) this reservation before aborting/disposing - so anything
    // other than "still ours" means a steer/stop landed during startup.
    // Checking signal.aborted alone would miss the reused-instance path,
    // where interruptTurn() disposes the instance directly without ever
    // calling startAbort.abort().
    if (startAbort.signal.aborted || this.active.get(input.threadId) !== startAbort) {
      // Steered/interrupted while the process was still starting up - the
      // instance we just obtained was never handed a turn, so drop it and
      // report the turn as interrupted (same outcome as aborting mid-stream).
      this.disposeInstance(input.threadId, instance, { abort: true });
      if (this.active.get(input.threadId) === startAbort) this.active.delete(input.threadId);
      this.emitEvent({ method: "turn/completed", params: { threadId: input.threadId, turnId, turn: { id: turnId, status: "interrupted", durationMs: Date.now() - startedAt } } });
      return { sessionId: input.nativeSessionId, turnId };
    }
    // Startup finished without interruption - swap the reservation for the
    // instance's real controller so interruptTurn() can abort the live
    // process/stream from here on (matches the abort semantics used for the
    // rest of the turn's lifetime).
    this.active.set(input.threadId, instance.abortController);
    const context: TurnContext = {
      threadId: input.threadId,
      turnId,
      fallbackItemId: itemId,
      onTextDelta: (_itemId, delta) => { streamedText += delta; },
      onFinalText: (text) => { finalText = text; },
      onSessionId: (sessionId) => {
        normalizeClaudeSessionEntrypointSoon(input.cwd, sessionId);
        instance.sessionId = sessionId;
        if (sessionId === nativeSessionId) return;
        nativeSessionId = sessionId;
        input.onSessionId?.(sessionId);
      },
      onUsage: (snapshot) => { usageSnapshot = snapshot; },
    };
    const run = (async () => {
      await new Promise<void>((resolve, reject) => {
        if (instance.disposed) {
          reject(new Error("Claude Code 세션 프로세스가 종료되었습니다."));
          return;
        }
        instance.currentTurn = { context, resolve, reject };
        instance.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      });
      if (!instance.disposed) sdkContextUsage = await sdkCurrentContextUsage(instance.request);
    })();

    const result = await run.then(async () => {
      await normalizeClaudeSessionEntrypoint(input.cwd, nativeSessionId);
      const completedText = finalText || streamedText;
      await Promise.resolve(input.onCompleted?.(completedText, { turnId })).catch(() => undefined);
      if (completedText && !this.hasStreamedAgentText(input.threadId, turnId)) {
        this.emitEvent({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: itemId, type: "agentMessage", text: completedText } } });
      }
      if (usageSnapshot?.usage.cache_miss_reason) {
        this.emitEvent({
          method: "item/completed",
          params: {
            threadId: input.threadId,
            turnId,
            item: {
              id: `claude-cache-miss-${turnId}`,
              type: "providerDiagnostics",
              title: "Claude 캐시 미스",
              detail: [
                `reason: ${usageSnapshot.usage.cache_miss_reason}`,
                usageSnapshot.usage.cache_missed_input_tokens ? `missed input: ${usageSnapshot.usage.cache_missed_input_tokens.toLocaleString()} tokens` : "",
              ].filter(Boolean).join("\n"),
              status: "completed",
            },
          },
        });
      }
      this.emitEvent({
        method: "turn/completed",
        params: {
          threadId: input.threadId,
          turnId,
          turn: {
            id: turnId,
            status: "completed",
            durationMs: Date.now() - startedAt,
            ...(usageSnapshot ? {
              usage: usageSnapshot.usage,
              ...(usageSnapshot.modelContextWindow ? { modelContextWindow: usageSnapshot.modelContextWindow } : {}),
            } : {}),
            ...(sdkContextUsage ?? usageSnapshot?.contextUsage ? { contextUsage: sdkContextUsage ?? usageSnapshot?.contextUsage } : {}),
          },
        },
      });
      return { sessionId: nativeSessionId, turnId, usage: turnUsageResult(usageSnapshot), ...(sdkContextUsage ?? usageSnapshot?.contextUsage ? { contextUsage: sdkContextUsage ?? usageSnapshot?.contextUsage } : {}) };
    }).catch(async (error) => {
      await normalizeClaudeSessionEntrypoint(input.cwd, nativeSessionId);
      // interruptTurn() removes the controller before aborting, so a missing
      // entry means this rejection came from a user stop, not a failure.
      const interrupted = !this.active.has(input.threadId);
      const status = interrupted ? "interrupted" : "failed";
      if (!interrupted) {
        const message = cleanErrorMessage(error instanceof Error ? error.message : error);
        this.emitEvent({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: `claude-error-${turnId}`, type: "error", message, status } } });
      } else if (finalText || streamedText) {
        const completedText = finalText || streamedText;
        await Promise.resolve(input.onCompleted?.(completedText, { turnId })).catch(() => undefined);
        if (!this.hasStreamedAgentText(input.threadId, turnId)) {
          this.emitEvent({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: itemId, type: "agentMessage", text: completedText } } });
        }
      }
      this.emitEvent({ method: "turn/completed", params: { threadId: input.threadId, turnId, turn: { id: turnId, status, durationMs: Date.now() - startedAt } } });
      if (!interrupted) throw error;
      // A stop is a normal outcome (Codex parity): resolve so the renderer
      // does not render a spurious "요청 실패" system row.
      return { sessionId: nativeSessionId, turnId, usage: turnUsageResult(usageSnapshot), ...(sdkContextUsage ?? usageSnapshot?.contextUsage ? { contextUsage: sdkContextUsage ?? usageSnapshot?.contextUsage } : {}) };
    }).finally(() => {
      const currentTurn = instance.currentTurn;
      const stillThisTurn = currentTurn?.context.turnId === turnId;
      const anotherTurnStarted = Boolean(currentTurn && !stillThisTurn);
      if (!anotherTurnStarted) this.active.delete(input.threadId);
      this.streamedAgentText.delete(`${input.threadId}:${turnId}`);
      if (!anotherTurnStarted) {
        for (const [id, tool] of this.toolRuns) {
          if (tool.threadId === input.threadId) this.toolRuns.delete(id);
        }
        for (const [id, pending] of this.pendingApprovals) {
          if (pending.threadId === input.threadId) {
            this.pendingApprovals.delete(id);
            pending.resolve("cancel");
          }
        }
      }
      if (stillThisTurn) instance.currentTurn = undefined;
      if (!anotherTurnStarted) {
        this.scheduleIdleReap(input.threadId, instance);
      }
    });
    return result;
  }

  interruptTurn(input: { threadId: string }): boolean {
    const controller = this.active.get(input.threadId);
    if (!controller) return false;
    this.active.delete(input.threadId);
    // Stopping aborts the whole process (the pump rejects the pending turn and
    // the catch path reports "interrupted"). The next turn resumes the same
    // native session in a fresh process, matching pre-persistent behavior.
    const instance = this.instances.get(input.threadId);
    if (instance) this.disposeInstance(input.threadId, instance, { abort: true });
    else controller.abort();
    return true;
  }

  disposeAllInstances(): void {
    for (const [threadId, instance] of [...this.instances]) this.disposeInstance(threadId, instance, { abort: true });
  }

  // Bypass mode is the only mode that needs a fresh process: it fixes
  // allowDangerouslySkipPermissions and drops the canUseTool bridge entirely
  // at spawn time. default/acceptEdits/plan all spawn identically (bridge
  // present) and cycle live via setPermissionMode, so they share one bucket.
  private instanceFingerprint(input: { cwd: string; mcpConfig?: string; supportedDialogKinds?: string[]; onUserDialog?: OnUserDialogLike; onAskUserQuestionTool?: OnAskUserQuestionToolLike }, bypass: boolean): string {
    return JSON.stringify([input.cwd, input.mcpConfig ?? "", bypass, input.supportedDialogKinds ?? [], Boolean(input.onUserDialog), Boolean(input.onAskUserQuestionTool)]);
  }

  // Reuse the thread's live process when its launch config still matches.
  // Model changes go through the SDK's setModel control request; a
  // default/acceptEdits/plan mode change goes through setPermissionMode the
  // same way (stock CLI's Shift+Tab never restarts the process either).
  // Only an MCP config change or a bypassPermissions transition needs a fresh
  // process (those are fixed at spawn), which resumes the same native session.
  private async obtainInstance(input: { threadId: string; cwd: string; model: string; resume?: boolean; nativeSessionId?: string; mcpConfig?: string; supportedDialogKinds?: string[]; onUserDialog?: OnUserDialogLike; onAskUserQuestionTool?: OnAskUserQuestionToolLike }, mode: ClaudePermissionMode): Promise<ThreadInstance> {
    const fingerprint = this.instanceFingerprint(input, mode === "bypassPermissions");
    const existing = this.instances.get(input.threadId);
    if (existing && !existing.disposed && existing.fingerprint === fingerprint) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      if (existing.model !== input.model) {
        if (typeof existing.request.setModel === "function") {
          try {
            await existing.request.setModel(input.model);
            existing.model = input.model;
          } catch {
            this.disposeInstance(input.threadId, existing, { abort: true });
          }
        } else {
          this.disposeInstance(input.threadId, existing, { abort: true });
        }
      }
      if (!existing.disposed && existing.currentMode !== mode) {
        if (typeof existing.request.setPermissionMode === "function") {
          try {
            await existing.request.setPermissionMode(mode);
            existing.currentMode = mode;
          } catch {
            this.disposeInstance(input.threadId, existing, { abort: true });
          }
        } else {
          this.disposeInstance(input.threadId, existing, { abort: true });
        }
      }
      if (!existing.disposed) return existing;
    } else if (existing) {
      this.disposeInstance(input.threadId, existing, { abort: true });
    }
    return this.createInstance(input, mode, fingerprint, existing?.sessionId);
  }

  private async createInstance(input: { threadId: string; cwd: string; model: string; resume?: boolean; nativeSessionId?: string; mcpConfig?: string; supportedDialogKinds?: string[]; onUserDialog?: OnUserDialogLike; onAskUserQuestionTool?: OnAskUserQuestionToolLike }, mode: ClaudePermissionMode, fingerprint: string, knownSessionId?: string): Promise<ThreadInstance> {
    const { query } = await claudeSdk();
    const pathToClaudeCodeExecutable = claudeCodeExecutable();
    const abortController = new AbortController();
    const queue: ClaudeSdkUserMessage[] = [];
    let notify: (() => void) | undefined;
    let ended = false;
    const messages = (async function* (): AsyncGenerator<ClaudeSdkUserMessage> {
      while (!ended) {
        while (queue.length) yield queue.shift()!;
        if (ended) break;
        await new Promise<void>((resolve) => { notify = resolve; });
      }
    })();
    const wake = (): void => {
      const pending = notify;
      notify = undefined;
      pending?.();
    };
    const instance: ThreadInstance = {
      fingerprint,
      request: undefined as unknown as ClaudeSdkQuery,
      push: (message) => { queue.push(message); wake(); },
      end: () => { ended = true; wake(); },
      abortController,
      model: input.model,
      sessionId: knownSessionId ?? input.nativeSessionId,
      disposed: false,
      currentMode: mode,
    };
    const resumeSessionId = knownSessionId ?? input.nativeSessionId;
    const options: ClaudeSdkOptions = {
      cwd: input.cwd,
      model: input.model,
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      abortController,
      includePartialMessages: true,
      settings: claudeCodeSettings(),
      permissionMode: mode,
      allowDangerouslySkipPermissions: mode === "bypassPermissions",
      ...(mode === "bypassPermissions" ? {} : { canUseTool: this.canUseToolBridge(input.threadId, () => instance.currentTurn?.context.turnId ?? "", instance, input.onAskUserQuestionTool) }),
      ...(input.onUserDialog && input.supportedDialogKinds?.length ? {
        onUserDialog: input.onUserDialog,
        supportedDialogKinds: input.supportedDialogKinds,
        toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
      } : {}),
      mcpServers: parseMcpServers(input.mcpConfig),
      // Resume an existing native Claude session when it is already on disk.
      // For a brand-new Devil thread, reserve the same UUID as Claude's
      // sessionId so creation/sync behaves like Codex's native thread id.
      ...(input.resume && resumeSessionId ? { resume: resumeSessionId } : input.nativeSessionId ? { sessionId: input.nativeSessionId } : {}),
    };
    instance.request = query({ prompt: messages, options });
    this.instances.set(input.threadId, instance);
    void this.pumpInstance(input.threadId, instance);
    return instance;
  }

  // Single reader for the instance's lifetime: routes SDK messages to the
  // in-flight turn and completes it on the per-turn "result" message.
  private async pumpInstance(threadId: string, instance: ThreadInstance): Promise<void> {
    try {
      for await (const message of instance.request) {
        const turn = instance.currentTurn ?? this.backgroundTurnForMessage(threadId, instance, message);
        if (!turn) {
          const sessionId = "session_id" in message && typeof message.session_id === "string" ? message.session_id : undefined;
          if (sessionId) instance.sessionId = sessionId;
          continue;
        }
        this.handleSdkMessage(message, turn.context);
        if (message.type === "result") {
          instance.currentTurn = undefined;
          if (isBackgroundTurn(turn)) {
            const status = String(message.subtype ?? "") === "success" ? "completed" : "failed";
            this.emitEvent({
              method: "turn/completed",
              params: {
                threadId,
                turnId: turn.context.turnId,
                turn: {
                  id: turn.context.turnId,
                  status,
                  durationMs: Date.now() - turn.startedAt,
                  ...(turn.usageSnapshot ? {
                    usage: turn.usageSnapshot.usage,
                    ...(turn.usageSnapshot.modelContextWindow ? { modelContextWindow: turn.usageSnapshot.modelContextWindow } : {}),
                    ...(turn.usageSnapshot.contextUsage ? { contextUsage: turn.usageSnapshot.contextUsage } : {}),
                  } : {}),
                },
              },
            });
            if (this.active.get(threadId) === instance.abortController) this.active.delete(threadId);
            this.streamedAgentText.delete(`${threadId}:${turn.context.turnId}`);
          }
          turn.resolve();
        }
      }
      instance.currentTurn?.reject(new Error("Claude Code 프로세스가 예기치 않게 종료되었습니다."));
    } catch (error) {
      const turn = instance.currentTurn;
      instance.currentTurn = undefined;
      turn?.reject(error);
    } finally {
      this.disposeInstance(threadId, instance, { abort: true });
    }
  }

  private backgroundTurnForMessage(threadId: string, instance: ThreadInstance, message: ClaudeSdkMessage): BackgroundTurn | undefined {
    if (instance.disposed || instance.currentTurn) return undefined;
    if (!this.isClaudeContinuationMessage(message)) return undefined;
    const turnId = `claude-bg-${crypto.randomUUID()}`;
    const itemId = `claude-message-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const turn: BackgroundTurn = {
      background: true,
      startedAt,
      context: {
        threadId,
        turnId,
        fallbackItemId: itemId,
        onTextDelta: () => undefined,
        onFinalText: () => undefined,
        onSessionId: (sessionId) => {
          instance.sessionId = sessionId;
        },
        onUsage: (snapshot) => {
          turn.usageSnapshot = snapshot;
        },
      },
      resolve: () => undefined,
      reject: () => undefined,
    };
    instance.currentTurn = turn;
    this.active.set(threadId, instance.abortController);
    this.emitEvent({ method: "turn/started", params: { threadId, turnId, turn: { id: turnId, startedAt: startedAt / 1000 } } });
    return turn;
  }

  private isClaudeContinuationMessage(message: ClaudeSdkMessage): boolean {
    if (message.parent_tool_use_id) return false;
    if (message.type === "result") return false;
    if (message.type === "assistant" || message.type === "user" || message.type === "stream_event") return true;
    if (message.type === "system") {
      const subtype = String(message.subtype ?? "");
      return subtype === "compact_boundary" || subtype === "status" || subtype === "permission_denied";
    }
    return false;
  }

  private disposeInstance(threadId: string, instance: ThreadInstance, opts: { abort: boolean }): void {
    if (this.instances.get(threadId) === instance) this.instances.delete(threadId);
    if (instance.disposed) return;
    instance.disposed = true;
    if (instance.idleTimer) {
      clearTimeout(instance.idleTimer);
      instance.idleTimer = undefined;
    }
    instance.end();
    if (opts.abort) instance.abortController.abort();
    const turn = instance.currentTurn;
    instance.currentTurn = undefined;
    turn?.reject(new Error("Claude Code 세션 프로세스가 종료되었습니다."));
  }

  private scheduleIdleReap(threadId: string, instance: ThreadInstance): void {
    if (instance.disposed || instance.currentTurn) return;
    if (instance.idleTimer) clearTimeout(instance.idleTimer);
    const timer = setTimeout(() => {
      if (!instance.currentTurn) this.disposeInstance(threadId, instance, { abort: true });
    }, CLAUDE_INSTANCE_IDLE_MS);
    timer.unref?.();
    instance.idleTimer = timer;
  }

  // Answer a pending canUseTool prompt. Returns false when the request id is
  // not ours so the caller can fall through to the app-server approval path.
  respondApproval(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  // Claude Code decides when a tool needs permission; Devil supplies the
  // answer UI. Emits the same requestApproval events the Codex app-server
  // uses, so the renderer reuses the existing approval dialog unchanged.
  private canUseToolBridge(threadId: string, turnId: () => string, instance: ThreadInstance, onAskUserQuestionTool?: OnAskUserQuestionToolLike): (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; suggestions?: unknown[] }) => Promise<PermissionResultLike> {
    return (toolName, input, options) => new Promise<PermissionResultLike>((resolve) => {
      if (toolName === "AskUserQuestion" && onAskUserQuestionTool) {
        void onAskUserQuestionTool(input, { signal: options.signal })
          .then(resolve)
          .catch(() => resolve({ behavior: "deny", message: "AskUserQuestion 모달 처리 중 오류가 발생했습니다.", interrupt: false }));
        return;
      }
      const requestId = `claude-approval-${crypto.randomUUID()}`;
      const summary = toolSummary(toolName, input);
      const changedPath = fileChangePath(toolName, input);
      const finish = (decision: ApprovalDecision): void => {
        this.pendingApprovals.delete(requestId);
        options.signal.removeEventListener("abort", onAbort);
        if (decision === "accept" || decision === "acceptForSession") {
          // Stock CLI parity: approving ExitPlanMode is a one-way soft
          // transition back to default mode for the rest of the session — the
          // user has to Shift+Tab (here: re-click the mode chip) to re-enter
          // plan mode. Without this, Devil kept forcing "plan" on every later
          // turn since the composer's plan toggle stayed stuck on.
          if (toolName === "ExitPlanMode" && instance.currentMode === "plan") {
            instance.currentMode = "default";
            if (typeof instance.request?.setPermissionMode === "function") {
              void instance.request.setPermissionMode("default").catch(() => undefined);
            }
            this.emitEvent({ method: "claude/planModeExited", params: { threadId } });
          }
          resolve({
            behavior: "allow",
            updatedInput: input,
            ...(decision === "acceptForSession" && options.suggestions?.length ? { updatedPermissions: options.suggestions } : {}),
          });
          return;
        }
        resolve({ behavior: "deny", message: "사용자가 Devil Codex 승인 대화상자에서 이 도구 실행을 거부했습니다.", interrupt: decision === "cancel" });
      };
      const onAbort = (): void => finish("cancel");
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApprovals.set(requestId, { threadId, resolve: finish });
      const isCommand = /^(bash|powershell)$/i.test(toolName);
      // File-editing tools render as file-change approvals; everything else
      // (shell, WebFetch, MCP tools...) reads best as a command approval row.
      this.emitEvent({
        method: changedPath ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval",
        requestId,
        params: {
          threadId,
          turnId: turnId(),
          itemId: requestId,
          command: isCommand ? summary : `${toolName}: ${summary}`,
          ...(changedPath ? { grantRoot: changedPath } : {}),
          reason: `Claude Code가 ${toolName} 도구 실행 승인을 요청했습니다.`,
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      });
    });
  }

  private handleSdkMessage(message: ClaudeSdkMessage, context: TurnContext): void {
    const sessionId = "session_id" in message && typeof message.session_id === "string" ? message.session_id : undefined;
    if (sessionId) context.onSessionId(sessionId);
    if (message.type === "result") {
      const usage = resultUsage(message);
      if (usage) context.onUsage(usage);
      if (message.subtype !== "success") {
        const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.join("\n") : "";
        const denials = Array.isArray(message.permission_denials) ? message.permission_denials as Array<Record<string, unknown>> : [];
        const fallback = denials.length ? denials.map((d) => `${String(d.tool_name ?? "tool")}: ${JSON.stringify(d.tool_input ?? {})}`).join("\n") : "";
        const detail = errors || fallback || message.subtype;
        this.emitEvent({ method: "item/completed", params: { threadId: context.threadId, turnId: context.turnId, item: { id: `claude-result-error-${crypto.randomUUID()}`, type: "error", message: detail, status: "failed" } } });
      } else if (typeof message.result === "string" && message.result) {
        context.onFinalText(message.result);
        if (!this.hasStreamedAgentText(context.threadId, context.turnId)) {
          const itemId = context.currentTextItemId ?? context.fallbackItemId;
          context.onTextDelta(itemId, message.result);
          // This delta carries the whole final answer in one shot (the SDK
          // gave us no earlier content_block_delta stream to mark it via).
          // Without marking it, sendTurn()'s run.then() fallback still sees
          // hasStreamedAgentText() === false once this "result" message
          // returns and emits ITS OWN item/completed with the same text
          // under a different id — a second, duplicate standalone bubble.
          this.markStreamedAgentText(context.threadId, context.turnId);
          this.emitEvent({ method: "item/agentMessage/delta", params: { threadId: context.threadId, turnId: context.turnId, itemId, delta: message.result } });
        }
      }
      return;
    }
    if (message.type === "system" && message.subtype === "permission_denied") {
      this.emitEvent({ method: "item/completed", params: { threadId: context.threadId, turnId: context.turnId, item: { id: message.tool_use_id, type: "mcpToolCall", tool: message.tool_name, status: "failed", result: { content: [{ type: "text", text: message.message }] } } } });
      return;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      const meta = compactMetadata(message);
      const trigger = String(meta.trigger ?? "");
      const title = trigger === "manual" ? "컨텍스트가 수동으로 압축됨" : "컨텍스트가 자동으로 압축됨";
      const detail = compactDetail(meta);
      this.emitEvent({
        method: "item/completed",
        params: {
          threadId: context.threadId,
          turnId: context.turnId,
          item: {
            id: String(message.uuid ?? `claude-compact-${crypto.randomUUID()}`),
            type: "contextCompaction",
            title,
            detail,
            status: "completed",
          },
        },
      });
      return;
    }
    if (message.type === "system" && message.subtype === "status" && message.status === "compacting") {
      this.emitEvent({
        method: "item/started",
        params: {
          threadId: context.threadId,
          turnId: context.turnId,
          item: {
            id: `claude-compacting-${context.turnId}`,
            type: "contextCompaction",
            title: "컨텍스트 압축 중",
            status: "inProgress",
          },
        },
      });
      return;
    }
    if (message.type === "stream_event") {
      // Subagent-internal stream traffic carries parent_tool_use_id; skip it so
      // nested tool output does not pollute the main turn's message stream.
      if (message.parent_tool_use_id) return;
      const event = (message.event ?? {}) as Record<string, unknown>;
      if (event.type === "content_block_start") {
        const block = (event.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "text") context.currentTextItemId = `claude-message-${crypto.randomUUID()}`;
        return;
      }
      if (event.type !== "content_block_delta") return;
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.thinking === "string" && delta.thinking) {
        this.emitEvent({ method: "item/reasoning/summaryTextDelta", params: { threadId: context.threadId, turnId: context.turnId, itemId: `claude-reasoning-${context.turnId}`, delta: delta.thinking } });
        return;
      }
      if (typeof delta.text === "string" && delta.text) {
        const itemId = context.currentTextItemId ?? context.fallbackItemId;
        context.onTextDelta(itemId, delta.text);
        this.markStreamedAgentText(context.threadId, context.turnId);
        this.emitEvent({ method: "item/agentMessage/delta", params: { threadId: context.threadId, turnId: context.turnId, itemId, delta: delta.text } });
      }
      return;
    }
    if ((message.type === "assistant" || message.type === "user") && !message.parent_tool_use_id) {
      const sdkMessage = message.message as Record<string, unknown>;
      if (message.type === "assistant") {
        const stopReason = String(sdkMessage.stop_reason ?? "");
        const text = assistantContentText(sdkMessage);
        if (text && stopReason && stopReason !== "tool_use") context.onFinalText(text);
      }
      this.handleMessageContent(sdkMessage, context.threadId, context.turnId);
    }
  }

  private handleMessageContent(message: Record<string, unknown>, threadId: string, turnId: string): void {
    for (const part of messageContent({ message })) {
      if (part.type === "tool_result") {
        const id = String(part.tool_use_id ?? "");
        // Only resolve tool calls this turn started. Unknown ids come from
        // resumed-session replays or subagent internals; re-emitting them would
        // inject stale activity rows into the current turn.
        const known = id ? this.toolRuns.get(id) : undefined;
        if (!known) continue;
        const output = toolResultText(part);
        if (known.kind === "command") {
          this.emitEvent({
            method: "item/completed",
            params: { threadId, turnId, item: { id, type: "commandExecution", command: known.summary, aggregatedOutput: output, status: part.is_error ? "failed" : "completed" } },
          });
        } else {
          const content = toolResultContent(part);
          this.emitEvent({
            method: "item/completed",
            params: { threadId, turnId, item: { id, type: "mcpToolCall", tool: known.name, status: part.is_error ? "failed" : "completed", result: { content: content.length ? content : [{ type: "text", text: output || known.path || known.summary }] } } },
          });
        }
        this.toolRuns.delete(id);
        continue;
      }
      if (part.type !== "tool_use") continue;
      const name = String(part.name ?? "Claude Code tool");
      const input = toolInput(part);
      const id = String(part.id ?? `claude-tool-${crypto.randomUUID()}`);
      const summary = toolSummary(name, input);
      const changedPath = fileChangePath(name, input);
      this.toolRuns.set(id, { threadId, name, kind: /^(bash|powershell)$/i.test(name) ? "command" : changedPath ? "fileChange" : "tool", summary, path: changedPath });
      // item/started renders the entry as in-progress; the matching
      // tool_result above resolves it to completed/failed.
      if (/^(bash|powershell)$/i.test(name)) {
        this.emitEvent({
          method: "item/started",
          params: { threadId, turnId, item: { id, type: "commandExecution", command: summary } },
        });
      } else {
        this.emitEvent({
          method: "item/started",
          params: { threadId, turnId, item: { id, type: "mcpToolCall", tool: name, result: { content: [{ type: "text", text: changedPath ?? summary }] } } },
        });
      }
    }
  }

  private probe(): RuntimeStatus {
    const bundled = sdkBundledExecutable();
    if (bundled) {
      const version = sdkClaudeCodeVersion(bundled);
      return { state: "connected", detail: "Claude Agent SDK bundled runtime", cwd: this.cwd, ...(version ? { claudeVersion: version } : {}) };
    }
    const command = commandSpec(claudeBin(), ["--version"]);
    const check = spawnSync(command.command, command.args, { cwd: this.cwd, encoding: "utf8", windowsHide: true });
    if (check.error || check.status !== 0) {
      return { state: "unavailable", detail: "Claude Code runtime not found. Reinstall Devil Codex, install Claude Code, or set DEVIL_CLAUDE_BIN.", cwd: this.cwd };
    }
    return { state: "connected", detail: "Claude Code CLI available", cwd: this.cwd, claudeVersion: check.stdout.trim() };
  }

  private emitEvent(event: AppServerEvent): void {
    this.emit("event", event);
  }

  private readonly streamedAgentText = new Set<string>();

  private markStreamedAgentText(threadId: string, turnId: string): void {
    this.streamedAgentText.add(`${threadId}:${turnId}`);
  }

  private hasStreamedAgentText(threadId: string, turnId: string): boolean {
    return this.streamedAgentText.has(`${threadId}:${turnId}`);
  }
}
