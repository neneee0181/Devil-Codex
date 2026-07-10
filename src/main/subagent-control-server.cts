import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeId, ProviderId, ReasoningEffort } from "./contracts.cjs";

export interface SubagentDelegatePayload {
  task: string;
  cwd?: string;
  provider?: ProviderId;
  accountId?: string;
  model?: string;
  runtime?: AgentRuntimeId;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
}

export interface SubagentDelegateResult {
  taskId: string;
  threadId: string;
  status: "completed" | "failed" | "timed_out";
  result?: string;
  error?: string;
  provider?: ProviderId;
  accountId?: string;
  model?: string;
  runtime?: AgentRuntimeId;
}

export function subagentControlPath(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\devil-codex-subagent";
  const codexHome = process.env.DEVIL_CODEX_CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "devil-subagent.sock");
}

export class SubagentControlServer {
  private server: Server | undefined;

  constructor(
    private readonly delegate: (input: SubagentDelegatePayload) => Promise<SubagentDelegateResult>,
    private readonly secret: string,
  ) {}

  async start(): Promise<string> {
    const path = subagentControlPath();
    if (this.server) return path;
    if (process.platform !== "win32") { try { unlinkSync(path); } catch { /* none */ } }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", reject);
      server.listen(path, () => {
        this.server = server;
        if (process.platform !== "win32") { try { chmodSync(path, 0o600); } catch { /* best effort */ } }
        resolve();
      });
    });
    return path;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    if (process.platform !== "win32") { try { unlinkSync(subagentControlPath()); } catch { /* none */ } }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (!this.authorized(req)) return send(403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/delegate") return send(404, { error: "unknown" });
      const body = normalizeDelegatePayload(await readJson(req));
      if (!body.task) return send(400, { error: "task is required" });
      send(200, await this.delegate(body));
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private authorized(req: IncomingMessage): boolean {
    return Boolean(this.secret && req.headers["x-devil-codex-control-secret"] === this.secret);
  }
}

function normalizeDelegatePayload(raw: Record<string, unknown>): SubagentDelegatePayload {
  return {
    task: String(raw.task ?? "").trim(),
    cwd: raw.cwd ? String(raw.cwd) : undefined,
    provider: raw.provider ? String(raw.provider) as ProviderId : undefined,
    accountId: raw.accountId ? String(raw.accountId) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    runtime: raw.runtime === "claude-code" ? "claude-code" : raw.runtime === "codex" ? "codex" : undefined,
    reasoningEffort: raw.reasoningEffort === "low" || raw.reasoningEffort === "medium" || raw.reasoningEffort === "high" || raw.reasoningEffort === "xhigh"
      ? raw.reasoningEffort
      : undefined,
    timeoutMs: typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? Math.max(5_000, Math.min(raw.timeoutMs, 900_000)) : undefined,
  };
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
