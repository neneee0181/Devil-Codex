import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApprovalDecision, AppServerEvent, CodexSkillInfo, McpServerInfo, ProviderModel, ReasoningEffort, ResponseSpeed, RuntimeStatus, ThreadApprovalPolicy, ThreadHistoryItem, ThreadRef, ThreadSandboxMode, ThreadSummary } from "./contracts.cjs";
import { codexHome } from "./codex-home.cjs";
import { mapThreadHistory } from "./thread-history.cjs";

// Resolve the codex executable. Packaged builds ship the binary under
// resources/codex; otherwise fall back to an explicit override or PATH.
// The bundled binary still reads the user's shared ~/.codex so stock-Codex
// sync keeps working.
export function codexBin(): string {
  const override = process.env.DEVIL_CODEX_BIN;
  if (override && existsSync(override)) return override;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const resources = process.resourcesPath;
  if (resources) {
    const bundled = join(resources, "codex", exe);
    if (existsSync(bundled)) return bundled;
  }
  // Dev mode: check vendor/codex in project root (__dirname = dist-electron/).
  const vendor = join(__dirname, "..", "vendor", "codex", exe);
  if (existsSync(vendor)) return vendor;
  return "codex";
}

type JsonRpcResponse = {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const EDITED_USER_MESSAGE_MARKER = "[수정된 사용자 메시지]";
const EDITED_CONTINUATION_PREFIX = "아래는 편집 지점 이전 대화입니다.";

function stripEditedContinuationTitle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  const markerIndex = text.lastIndexOf(EDITED_USER_MESSAGE_MARKER);
  if (markerIndex >= 0) return text.slice(markerIndex + EDITED_USER_MESSAGE_MARKER.length).trim();
  if (!text.startsWith(EDITED_CONTINUATION_PREFIX)) return text;
  const lastUserIndex = text.lastIndexOf("사용자:");
  if (lastUserIndex > EDITED_CONTINUATION_PREFIX.length) return text.slice(lastUserIndex + "사용자:".length).trim();
  return "수정된 대화";
}

function compactThreadText(value: unknown, fallback: string, maxLength: number): string {
  const text = stripEditedContinuationTitle(String(value ?? "").trim()) || fallback;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function threadTitle(thread: Record<string, unknown>): string {
  return compactThreadText(thread.title ?? thread.name ?? thread.preview, "New thread", 64);
}

function threadPreview(value: unknown): string {
  return compactThreadText(value, "", 160);
}

// thread/start and thread/resume take the sandbox as a SandboxMode string in
// the `sandbox` field (camelCase RPC name, kebab value e.g. "danger-full-access").
function threadPermissionFields(approvalPolicy: ThreadApprovalPolicy, sandboxMode: ThreadSandboxMode): Record<string, unknown> {
  return { approvalPolicy, sandbox: sandboxMode };
}

// turn/start overrides permissions per-turn with `approvalPolicy` and the
// structured `sandboxPolicy` object ({ type: "dangerFullAccess" } | ...).
// The TurnStartParams struct has no `sandbox`/`sandboxMode` field, so the old
// mode-string keys were silently dropped and every turn ran at the thread's
// stale default (read-only) regardless of the UI selection.
function turnPermissionFields(approvalPolicy: ThreadApprovalPolicy, sandboxMode: ThreadSandboxMode, cwd: string): Record<string, unknown> {
  return { approvalPolicy, sandboxPolicy: stockSandboxPolicy(sandboxMode, cwd) };
}

function isPermissionParameterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /approvalPolicy|approval_policy|sandboxMode|sandbox_mode|sandbox|unknown field|unknown parameter|invalid params|invalid request/i.test(message);
}

function shouldFallbackWithoutPermissions(approvalPolicy: ThreadApprovalPolicy, sandboxMode: ThreadSandboxMode): boolean {
  return approvalPolicy === "on-request" && sandboxMode === "workspace-write";
}

export class CodexAppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private lineBuffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private status: RuntimeStatus;
  private connecting?: Promise<RuntimeStatus>;

  constructor(private readonly cwd: string) {
    super();
    this.status = this.probe();
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  async connect(): Promise<RuntimeStatus> {
    if (this.child && !this.child.killed && this.status.state === "connected") return this.status;
    if (this.connecting) return this.connecting;
    this.connecting = this.start();
    try { return await this.connecting; }
    finally { this.connecting = undefined; }
  }

  private async start(): Promise<RuntimeStatus> {

    const available = this.probe();
    if (available.state === "unavailable") return available;

    this.status = { ...available, state: "connecting", detail: "Starting Codex app-server" };
    this.emitStatus();

    try {
      this.child = spawn(codexBin(), ["app-server"], {
        cwd: this.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stdout.setEncoding("utf8");
      this.child.stderr.setEncoding("utf8");
      this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
      this.child.stderr.on("data", (chunk: string) => this.emit("diagnostic", chunk.trim()));
      this.child.on("error", (error) => this.fail(error.message));
      this.child.on("exit", (code, signal) => {
        this.child = undefined;
        if (this.status.state !== "error") {
          this.status = {
            ...this.status,
            state: "ready",
            detail: `Codex app-server exited (${signal ?? code ?? "unknown"})`,
          };
          this.emitStatus();
        }
      });

      await this.request("initialize", {
        clientInfo: {
          name: "Codex Desktop",
          title: "Codex",
          version: available.codexVersion?.replace(/^codex-cli\s+/, "") || "0.142.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.notify("initialized", {});
      this.status = { ...available, state: "connected", detail: "Codex app-server connected" };
      this.emitStatus();
      return this.status;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Unable to connect to Codex app-server");
      return this.status;
    }
  }

  async createThread(input: { cwd: string; model: string; modelProvider?: string; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode; reasoningEffort?: ReasoningEffort; responseSpeed?: ResponseSpeed }): Promise<ThreadRef> {
    await this.ensureConnected();
    const approvalPolicy = input.approvalPolicy ?? "on-request";
    const sandboxMode = input.sandboxMode ?? "workspace-write";
    const baseParams = {
      cwd: input.cwd,
      model: input.model,
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
    };
    let result: { thread?: { id?: string } };
    try {
      result = (await this.request("thread/start", {
        ...baseParams,
        ...threadPermissionFields(approvalPolicy, sandboxMode),
      })) as { thread?: { id?: string } };
    } catch (error) {
      if (!isPermissionParameterError(error)) throw error;
      if (!shouldFallbackWithoutPermissions(approvalPolicy, sandboxMode)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Codex app-server rejected requested permissions (${approvalPolicy}, ${sandboxMode}): ${message}`);
      }
      result = (await this.request("thread/start", baseParams)) as { thread?: { id?: string } };
    }
    const id = result.thread?.id;
    if (!id) throw new Error("Codex app-server returned a thread without an id");
    await syncStockThreadPermissions(id, input.cwd, approvalPolicy, sandboxMode).catch(() => undefined);
    return { id, cwd: input.cwd, model: input.model };
  }

  async listThreads(input: { cwd: string; archived?: boolean }): Promise<ThreadSummary[]> {
    await this.ensureConnected();
    const result = (await this.request("thread/list", {
      cwd: input.cwd,
      archived: input.archived ?? false,
      limit: 40,
      sortKey: "updated_at",
      sortDirection: "desc",
    })) as { data?: Array<Record<string, unknown>> };
    return (result.data ?? []).map((thread) => ({
      id: String(thread.id),
      cwd: String(thread.cwd ?? input.cwd),
      model: "gpt-5.4",
      title: threadTitle(thread),
      preview: threadPreview(thread.preview),
      updatedAt: Number(thread.updatedAt ?? 0),
      archived: input.archived ?? false,
    }));
  }

  async listProjects(input: { archived?: boolean } = {}): Promise<ThreadSummary[]> {
    await this.ensureConnected();
    const result = (await this.request("thread/list", {
      archived: input.archived ?? false,
      limit: 200,
      sortKey: "updated_at",
      sortDirection: "desc",
    })) as { data?: Array<Record<string, unknown>> };
    return (result.data ?? []).map((thread) => ({
      id: String(thread.id),
      cwd: String(thread.cwd ?? ""),
      model: "gpt-5.4",
      title: threadTitle(thread),
      preview: threadPreview(thread.preview),
      updatedAt: Number(thread.updatedAt ?? 0),
      archived: input.archived ?? false,
    }));
  }

  async searchThreads(input: { query: string; archived?: boolean }): Promise<ThreadSummary[]> {
    await this.ensureConnected();
    const query = input.query.trim();
    if (!query) return [];
    const result = (await this.request("thread/search", {
      searchTerm: query,
      archived: input.archived ?? false,
      limit: 80,
      sortKey: "updated_at",
      sortDirection: "desc",
    })) as { data?: Array<{ thread?: Record<string, unknown>; snippet?: string }> };
    return (result.data ?? []).flatMap((entry) => {
      const thread = entry.thread;
      if (!thread?.id) return [];
      return [{
        id: String(thread.id),
        cwd: String(thread.cwd ?? ""),
        model: "gpt-5.4",
        title: threadTitle(thread),
        preview: threadPreview(entry.snippet ?? thread.preview),
        updatedAt: Number(thread.updatedAt ?? 0),
        archived: input.archived ?? false,
      }];
    });
  }

  async resumeThread(input: { id: string; model: string; modelProvider?: string; cwd?: string }): Promise<ThreadRef> {
    await this.ensureConnected();
    const result = (await this.request("thread/resume", {
      threadId: input.id,
      model: input.model,
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    })) as {
      thread?: { id?: string };
      cwd?: string;
      model?: string;
    };
    const id = result.thread?.id;
    if (!id) throw new Error("Codex app-server returned a thread without an id");
    return { id, cwd: String(result.cwd ?? this.cwd), model: String(result.model ?? input.model) };
  }

  async renameThread(input: { id: string; name: string }): Promise<void> {
    await this.ensureConnected();
    const name = input.name.trim();
    if (!name) throw new Error("채팅 이름을 입력하세요.");
    const attempts: Array<[string, Record<string, string>]> = [
      ["thread/title/set", { threadId: input.id, title: name }],
      ["thread/title/set", { id: input.id, title: name }],
      ["thread/name/set", { threadId: input.id, name }],
      ["thread/rename", { threadId: input.id, name }],
      ["thread/rename", { threadId: input.id, title: name }],
      ["thread/update", { threadId: input.id, name }],
      ["thread/update", { threadId: input.id, title: name }],
      ["thread/update", { id: input.id, name }],
      ["thread/update", { id: input.id, title: name }],
    ];
    const errors: string[] = [];
    for (const [method, params] of attempts) {
      try {
        await this.request(method, params);
        return;
      } catch (error) {
        errors.push(`${method}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(errors.join(" | "));
  }

  async forkThread(input: { id: string; cwd: string; model: string }): Promise<ThreadRef> {
    await this.ensureConnected();
    const result = (await this.request("thread/fork", { threadId: input.id, cwd: input.cwd, model: input.model })) as { thread?: { id?: string }; cwd?: string; model?: string };
    const id = result.thread?.id;
    if (!id) throw new Error("Codex app-server가 fork thread id를 반환하지 않았습니다.");
    return { id, cwd: String(result.cwd ?? input.cwd), model: String(result.model ?? input.model) };
  }

  async listModels(): Promise<ProviderModel[]> {
    await this.ensureConnected();
    const result = (await this.request("model/list", { includeHidden: false, limit: 200 })) as {
      data?: Array<{ id?: string; model?: string; displayName?: string; hidden?: boolean }>;
    };
    const seen = new Set<string>();
    return (result.data ?? []).flatMap((row) => {
      const id = String(row.model ?? row.id ?? "");
      if (!id || row.hidden || seen.has(id)) return [];
      seen.add(id);
      return [{ id, label: String(row.displayName ?? id) }];
    });
  }

  async readThread(input: { id: string }): Promise<ThreadHistoryItem[]> {
    await this.ensureConnected();
    const result = (await this.request("thread/read", { threadId: input.id, includeTurns: true })) as {
      thread?: { turns?: Array<Record<string, unknown> & { items?: Array<Record<string, unknown>> }> };
    };
    return mapThreadHistory(result.thread?.turns ?? []);
  }

  async archiveThread(input: { id: string }): Promise<void> {
    await this.ensureConnected();
    await this.request("thread/archive", { threadId: input.id });
  }

  async deleteThread(input: { id: string }): Promise<void> {
    await this.ensureConnected();
    await this.request("thread/delete", { threadId: input.id });
  }

  async unarchiveThread(input: { id: string }): Promise<void> {
    await this.ensureConnected();
    await this.request("thread/unarchive", { threadId: input.id });
  }

  async listSkills(input: { cwd: string; forceReload?: boolean }): Promise<CodexSkillInfo[]> {
    await this.ensureConnected();
    const result = (await this.request("skills/list", { cwds: [input.cwd], forceReload: input.forceReload ?? false })) as { data?: Array<{ skills?: Array<Record<string, unknown>> }> };
    return (result.data ?? []).flatMap((entry) => entry.skills ?? []).map((skill) => ({
      name: String(skill.name ?? ""),
      description: String(skill.shortDescription ?? skill.description ?? ""),
      path: String(skill.path ?? ""),
      scope: String(skill.scope ?? ""),
      enabled: skill.enabled !== false,
    })).filter((skill) => skill.name && skill.path);
  }

  async listMcpServers(input: { threadId?: string } = {}): Promise<McpServerInfo[]> {
    await this.ensureConnected();
    const result = (await this.request("mcpServerStatus/list", { limit: 100, detail: "full", threadId: input.threadId ?? null })) as { data?: Array<Record<string, unknown>> };
    return (result.data ?? []).map((server) => ({
      name: String(server.name ?? ""),
      authStatus: String(server.authStatus ?? "unsupported"),
      tools: Object.values((server.tools ?? {}) as Record<string, Record<string, unknown>>).map((tool) => ({ name: String(tool.name ?? ""), title: String(tool.title ?? tool.name ?? ""), description: String(tool.description ?? "") })),
      resources: Array.isArray(server.resources) ? server.resources.length : 0,
    })).filter((server) => server.name);
  }

  async callMcpTool(input: { threadId: string; server: string; tool: string; arguments?: unknown }): Promise<unknown> {
    await this.ensureConnected();
    return this.request("mcpServer/tool/call", { threadId: input.threadId, server: input.server, tool: input.tool, arguments: input.arguments ?? {} });
  }

  async uploadFeedback(input: { reason: string; threadId?: string }): Promise<void> {
    await this.ensureConnected();
    const reason = input.reason.trim();
    if (!reason) throw new Error("피드백 내용을 입력하세요.");
    await this.request("feedback/upload", { classification: "other", reason, threadId: input.threadId ?? null, includeLogs: false });
  }

  async sendTurn(input: { threadId: string; cwd: string; text: string; model: string; skills?: Array<{ name: string; path: string }>; attachments?: string[]; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode; reasoningEffort?: ReasoningEffort; responseSpeed?: ResponseSpeed }): Promise<void> {
    await this.ensureConnected();
    const items = [
      ...(input.skills ?? []).map((skill) => ({ type: "skill", name: skill.name, path: skill.path })),
      { type: "text", text: input.text, text_elements: [] },
      ...(input.attachments ?? []).map((url) => ({ type: "image", url })),
    ];
    const baseParams = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      input: items,
      reasoning: { effort: input.reasoningEffort ?? "medium" },
      service_tier: input.responseSpeed === "fast" ? "priority" : "default",
      serviceTier: input.responseSpeed === "fast" ? "priority" : "default",
    };
    const requestedApprovalPolicy = input.approvalPolicy ?? "on-request";
    const requestedSandbox = input.sandboxMode ?? "workspace-write";
    const permissionParams = {
      ...baseParams,
      ...turnPermissionFields(requestedApprovalPolicy, requestedSandbox, input.cwd),
    };
    await syncStockThreadPermissions(input.threadId, input.cwd, requestedApprovalPolicy, requestedSandbox).catch(() => undefined);
    try {
      await this.request("turn/start", permissionParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isPermissionParameterError(error)) throw error;
      if (!shouldFallbackWithoutPermissions(requestedApprovalPolicy, requestedSandbox)) {
        throw new Error(`Codex app-server rejected requested permissions (${requestedApprovalPolicy}, ${requestedSandbox}): ${message}`);
      }
      await this.request("turn/start", baseParams);
    }
  }

  async interruptTurn(input: { threadId: string; turnId?: string }): Promise<void> {
    await this.ensureConnected();
    await this.request("turn/interrupt", { threadId: input.threadId, ...(input.turnId ? { turnId: input.turnId } : {}) });
  }

  async respondApproval(input: { requestId: string | number; decision: ApprovalDecision }): Promise<void> {
    await this.ensureConnected();
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify({ id: input.requestId, result: { decision: input.decision } })}\n`);
  }

  dispose(): void {
    for (const request of this.pending.values()) request.reject(new Error("Codex app-server stopped"));
    this.pending.clear();
    this.child?.kill();
    this.child = undefined;
  }

  private probe(): RuntimeStatus {
    const check = spawnSync(codexBin(), ["--version"], { cwd: this.cwd, encoding: "utf8" });
    if (check.error || check.status !== 0) {
      return {
        state: "unavailable",
        detail: "Codex CLI not found. Install Codex or set DEVIL_CODEX_BIN.",
        cwd: this.cwd,
      };
    }
    return {
      state: "ready",
      detail: "Codex CLI available",
      cwd: this.cwd,
      codexVersion: check.stdout.trim(),
    };
  }

  private async ensureConnected(): Promise<void> {
    const status = await this.connect();
    if (status.state !== "connected") throw new Error(status.detail);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    const message = JSON.stringify({ method, id, params });
    this.child.stdin.write(`${message}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private consume(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handle(JSON.parse(line) as JsonRpcResponse);
      } catch {
        this.emit("diagnostic", "Codex app-server sent invalid JSON");
      }
    }
  }

  private handle(message: JsonRpcResponse): void {
    if (message.method && message.id !== undefined) {
      // MCP tools (e.g. our devil_browser) trigger an elicitation request that
      // must be answered or the tool call hangs forever. We don't surface MCP
      // elicitation UI, so auto-accept it (the embedded browser is trusted).
      if (message.method === "mcpServer/elicitation/request") {
        this.child?.stdin.write(`${JSON.stringify({ id: message.id, result: { action: "accept", content: null, _meta: null } })}\n`);
        this.emit("event", { method: message.method, params: message.params } satisfies AppServerEvent);
        return;
      }
      this.emit("event", { method: message.method, params: message.params, requestId: message.id } satisfies AppServerEvent);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server error"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("event", { method: message.method, params: message.params } satisfies AppServerEvent);
  }

  private fail(detail: string): void {
    this.status = { ...this.status, state: "error", detail };
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit("status", this.status);
  }
}

const STOCK_STATE_PATH = join(codexHome(), ".codex-global-state.json");

function stockSandboxPolicy(mode: ThreadSandboxMode, cwd: string): Record<string, unknown> {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false };
}

function stockPermissionProfile(mode: ThreadSandboxMode): { id: string; extends: null } | null {
  if (mode === "danger-full-access") return { id: ":danger-full-access", extends: null };
  if (mode === "read-only") return { id: ":read-only", extends: null };
  return null;
}

async function syncStockThreadPermissions(threadId: string, cwd: string, approvalPolicy: ThreadApprovalPolicy, sandboxMode: ThreadSandboxMode): Promise<void> {
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(await readFile(STOCK_STATE_PATH, "utf8")) as Record<string, unknown>; } catch { state = {}; }
  const atom = typeof state["electron-persisted-atom-state"] === "object" && state["electron-persisted-atom-state"] !== null
    ? state["electron-persisted-atom-state"] as Record<string, unknown>
    : {};
  const permissions = typeof atom["heartbeat-thread-permissions-by-id"] === "object" && atom["heartbeat-thread-permissions-by-id"] !== null
    ? atom["heartbeat-thread-permissions-by-id"] as Record<string, unknown>
    : {};
  permissions[threadId] = {
    activePermissionProfile: stockPermissionProfile(sandboxMode),
    approvalPolicy,
    approvalsReviewer: "user",
    sandboxPolicy: stockSandboxPolicy(sandboxMode, cwd),
  };
  atom["heartbeat-thread-permissions-by-id"] = permissions;
  if (sandboxMode === "workspace-write") {
    const roots = typeof atom["thread-writable-roots"] === "object" && atom["thread-writable-roots"] !== null
      ? atom["thread-writable-roots"] as Record<string, unknown>
      : {};
    roots[threadId] = [cwd];
    atom["thread-writable-roots"] = roots;
  }
  state["electron-persisted-atom-state"] = atom;
  await mkdir(dirname(STOCK_STATE_PATH), { recursive: true });
  await writeFile(STOCK_STATE_PATH, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
}
