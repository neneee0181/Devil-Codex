import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type { AppServerEvent, RuntimeStatus, ThreadApprovalPolicy, ThreadRef, ThreadSandboxMode } from "./contracts.cjs";

type ClaudeSdkMessage = Record<string, unknown>;
type ClaudeSdkOptions = Record<string, unknown>;
type ClaudeSdkUserMessage = { type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null };
type TurnUsageSnapshot = { usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number; total_tokens: number }; modelContextWindow?: number };

type TurnContext = {
  threadId: string;
  turnId: string;
  itemId: string;
  onDelta: (delta: string) => void;
  onSessionId: (sessionId: string) => void;
  onUsage: (snapshot: TurnUsageSnapshot) => void;
};

function claudeBin(): string {
  const override = process.env.DEVIL_CLAUDE_BIN;
  if (override) return override;
  return process.platform === "win32" ? "claude.cmd" : "claude";
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
      if (existsSync(resolved)) return resolved;
    } catch {
      // try the next candidate package
    }
  }
  return undefined;
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

function permissionMode(approvalPolicy?: ThreadApprovalPolicy, sandboxMode?: ThreadSandboxMode): string {
  if (sandboxMode === "danger-full-access" || approvalPolicy === "never") return "bypassPermissions";
  if (sandboxMode === "read-only") return "default";
  // Claude Code's acceptEdits mode only auto-accepts file edits; tools such as
  // WebFetch can still stop for approval, which cannot be answered from `-p`
  // print mode. Auto mode is the closest match for Devil's normal agent mode:
  // routine tool calls proceed, while Claude still keeps its own risk gate.
  return "auto";
}

async function claudeSdk(): Promise<{ query: (input: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeSdkOptions }) => AsyncIterable<ClaudeSdkMessage> }> {
  return import("@anthropic-ai/claude-agent-sdk");
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

function parseMcpServers(config: string | undefined): Record<string, unknown> | undefined {
  if (!config) return undefined;
  try {
    const parsed = JSON.parse(config) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : undefined;
  } catch {
    return undefined;
  }
}

function resultUsage(message: ClaudeSdkMessage): TurnUsageSnapshot | undefined {
  const raw = message.usage;
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const cached = num(record.cache_read_input_tokens) + num(record.cache_creation_input_tokens);
  const input = num(record.input_tokens) + cached;
  const output = num(record.output_tokens);
  if (input + output <= 0) return undefined;
  const models = message.modelUsage && typeof message.modelUsage === "object"
    ? Object.values(message.modelUsage as Record<string, { contextWindow?: unknown }>)
    : [];
  const contextWindow = models.reduce((max, model) => Math.max(max, typeof model.contextWindow === "number" ? model.contextWindow : 0), 0);
  return {
    usage: { input_tokens: input, output_tokens: output, ...(cached ? { cached_input_tokens: cached } : {}), total_tokens: input + output },
    ...(contextWindow > 0 ? { modelContextWindow: contextWindow } : {}),
  };
}

export class ClaudeCodeRuntime extends EventEmitter {
  private active = new Map<string, AbortController>();
  private toolRuns = new Map<string, { threadId: string; name: string; kind: "command" | "tool" | "fileChange"; summary: string; path?: string }>();

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

  async sendTurn(input: { threadId: string; cwd: string; text: string; model: string; resume?: boolean; nativeSessionId?: string; mcpConfig?: string; approvalPolicy?: ThreadApprovalPolicy; sandboxMode?: ThreadSandboxMode; onSessionId?: (sessionId: string) => void; onCompleted?: (text: string) => Promise<void> | void }): Promise<{ sessionId?: string; turnId: string }> {
    if (this.active.has(input.threadId)) throw new Error("이 Claude Code thread는 이미 응답 생성 중입니다.");
    const turnId = `claude-${crypto.randomUUID()}`;
    const itemId = `claude-message-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    let text = "";
    let nativeSessionId = input.nativeSessionId;
    let usageSnapshot: TurnUsageSnapshot | undefined;
    const abortController = new AbortController();
    const mode = permissionMode(input.approvalPolicy, input.sandboxMode);
    this.emitEvent({ method: "turn/started", params: { threadId: input.threadId, turnId, turn: { id: turnId, startedAt: startedAt / 1000 } } });

    const messages = (async function* (): AsyncGenerator<ClaudeSdkUserMessage> {
      yield { type: "user", message: { role: "user", content: input.text }, parent_tool_use_id: null };
    })();
    const context: TurnContext = {
      threadId: input.threadId,
      turnId,
      itemId,
      onDelta: (delta) => { text += delta; },
      onSessionId: (sessionId) => {
        if (sessionId === nativeSessionId) return;
        nativeSessionId = sessionId;
        input.onSessionId?.(sessionId);
      },
      onUsage: (snapshot) => { usageSnapshot = snapshot; },
    };
    this.active.set(input.threadId, abortController);
    const run = (async () => {
      const { query } = await claudeSdk();
      const options: ClaudeSdkOptions = {
        cwd: input.cwd,
        model: input.model,
        abortController,
        includePartialMessages: true,
        permissionMode: mode,
        allowDangerouslySkipPermissions: mode === "bypassPermissions",
        mcpServers: parseMcpServers(input.mcpConfig),
        maxTurns: 100,
        // Resume the previous native session when Devil knows it. New sessions
        // keep the SDK's auto-generated id: forcing sessionId=threadId breaks a
        // retry after a failed first turn ("session id already in use").
        ...(input.resume && input.nativeSessionId ? { resume: input.nativeSessionId } : {}),
      };
      for await (const message of query({ prompt: messages, options })) {
        this.handleSdkMessage(message, context);
      }
    })();

    const result = await run.then(async () => {
      await Promise.resolve(input.onCompleted?.(text)).catch(() => undefined);
      this.emitEvent({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: itemId, type: "agentMessage", text } } });
      this.emitEvent({
        method: "turn/completed",
        params: {
          threadId: input.threadId,
          turnId,
          turn: {
            id: turnId,
            status: "completed",
            durationMs: Date.now() - startedAt,
            ...(usageSnapshot ? { usage: usageSnapshot.usage, ...(usageSnapshot.modelContextWindow ? { modelContextWindow: usageSnapshot.modelContextWindow } : {}) } : {}),
          },
        },
      });
      return { sessionId: nativeSessionId, turnId };
    }).catch(async (error) => {
      // interruptTurn() removes the controller before aborting, so a missing
      // entry means this rejection came from a user stop, not a failure.
      const interrupted = !this.active.has(input.threadId);
      const status = interrupted ? "interrupted" : "failed";
      if (!interrupted) {
        const message = cleanErrorMessage(error instanceof Error ? error.message : error);
        this.emitEvent({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: `claude-error-${turnId}`, type: "error", message, status } } });
      } else if (text) {
        await Promise.resolve(input.onCompleted?.(text)).catch(() => undefined);
        this.emitEvent({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: itemId, type: "agentMessage", text } } });
      }
      this.emitEvent({ method: "turn/completed", params: { threadId: input.threadId, turnId, turn: { id: turnId, status, durationMs: Date.now() - startedAt } } });
      if (!interrupted) throw error;
      // A stop is a normal outcome (Codex parity): resolve so the renderer
      // does not render a spurious "요청 실패" system row.
      return { sessionId: nativeSessionId, turnId };
    }).finally(() => {
      this.active.delete(input.threadId);
      this.streamedAgentText.delete(`${input.threadId}:${turnId}`);
      for (const [id, tool] of this.toolRuns) {
        if (tool.threadId === input.threadId) this.toolRuns.delete(id);
      }
    });
    return result;
  }

  interruptTurn(input: { threadId: string }): boolean {
    const controller = this.active.get(input.threadId);
    if (!controller) return false;
    this.active.delete(input.threadId);
    controller.abort();
    return true;
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
      } else if (typeof message.result === "string" && message.result && !this.hasStreamedAgentText(context.threadId, context.turnId)) {
        context.onDelta(message.result);
        this.emitEvent({ method: "item/agentMessage/delta", params: { threadId: context.threadId, turnId: context.turnId, itemId: context.itemId, delta: message.result } });
      }
      return;
    }
    if (message.type === "system" && message.subtype === "permission_denied") {
      this.emitEvent({ method: "item/completed", params: { threadId: context.threadId, turnId: context.turnId, item: { id: message.tool_use_id, type: "mcpToolCall", tool: message.tool_name, status: "failed", result: { content: [{ type: "text", text: message.message }] } } } });
      return;
    }
    if (message.type === "stream_event") {
      // Subagent-internal stream traffic carries parent_tool_use_id; skip it so
      // nested tool output does not pollute the main turn's message stream.
      if (message.parent_tool_use_id) return;
      const event = (message.event ?? {}) as Record<string, unknown>;
      if (event.type === "content_block_start") {
        const block = (event.content_block ?? {}) as Record<string, unknown>;
        // Separate consecutive narration blocks (text → tool → text) so the
        // streamed bubble does not glue two sentences together.
        if (block.type === "text" && this.hasStreamedAgentText(context.threadId, context.turnId)) {
          context.onDelta("\n\n");
          this.emitEvent({ method: "item/agentMessage/delta", params: { threadId: context.threadId, turnId: context.turnId, itemId: context.itemId, delta: "\n\n" } });
        }
        return;
      }
      if (event.type !== "content_block_delta") return;
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.thinking === "string" && delta.thinking) {
        this.emitEvent({ method: "item/reasoning/summaryTextDelta", params: { threadId: context.threadId, turnId: context.turnId, itemId: `claude-reasoning-${context.turnId}`, delta: delta.thinking } });
        return;
      }
      if (typeof delta.text === "string" && delta.text) {
        context.onDelta(delta.text);
        this.markStreamedAgentText(context.threadId, context.turnId);
        this.emitEvent({ method: "item/agentMessage/delta", params: { threadId: context.threadId, turnId: context.turnId, itemId: context.itemId, delta: delta.text } });
      }
      return;
    }
    if ((message.type === "assistant" || message.type === "user") && !message.parent_tool_use_id) {
      this.handleMessageContent(message.message as Record<string, unknown>, context.threadId, context.turnId);
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
          this.emitEvent({
            method: "item/completed",
            params: { threadId, turnId, item: { id, type: "mcpToolCall", tool: known.name, status: part.is_error ? "failed" : "completed", result: { content: [{ type: "text", text: output || known.path || known.summary }] } } },
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
