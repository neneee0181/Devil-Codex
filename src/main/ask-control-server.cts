import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Unix domain socket / Windows named pipe (Codex sandboxes the MCP and blocks
// localhost TCP). Mirrors the browser/desktop control bridges; lives in ~/.codex
// so the sandboxed MCP can reach it.
export function askControlPath(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\devil-codex-ask";
  const codexHome = process.env.DEVIL_CODEX_CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "devil-ask.sock");
}

export interface AskQuestionPayload { question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }
export interface AskAnswerPayload { question: string; header?: string; answers: string[] }

// How long a pending ask waits for the user before auto-cancelling. Generous —
// the user may step away — but bounded so a forgotten dialog frees the MCP call.
const ANSWER_TIMEOUT_MS = 25 * 60 * 1000;

// Bridge so the devil_ask MCP (a separate process Codex spawns) can pose a
// structured question to the user. The model calls the MCP tool → MCP script →
// here → renderer shows a modal → user answers → resolved back to the model.
export class AskControlServer {
  private server: Server | undefined;
  private readonly pending = new Map<string, (answers: AskAnswerPayload[] | null) => void>();

  constructor(private readonly send: (channel: string, payload: unknown) => void, private readonly secret: string) {}

  async start(): Promise<string> {
    const path = askControlPath();
    if (this.server) return path;
    if (process.platform !== "win32") { try { unlinkSync(path); } catch { /* none */ } }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", reject);
      server.listen(path, () => {
        this.server = server;
        // Restrict the socket to the current user (defence in depth so another
        // local account can't pop dialogs through the bridge).
        if (process.platform !== "win32") { try { chmodSync(path, 0o600); } catch { /* best effort */ } }
        resolve();
      });
    });
    return path;
  }

  stop(): void {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.server?.close();
    this.server = undefined;
    if (process.platform !== "win32") { try { unlinkSync(askControlPath()); } catch { /* none */ } }
  }

  // Renderer calls this (via IPC) when the user submits or dismisses the modal.
  resolve(id: string, answers: AskAnswerPayload[] | null): void {
    const resolver = this.pending.get(id);
    if (!resolver) return;
    this.pending.delete(id);
    resolver(answers);
  }

  ask(questions: AskQuestionPayload[], signal?: AbortSignal): Promise<AskAnswerPayload[] | null> {
    if (!questions.length) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<AskAnswerPayload[] | null>((resolve) => {
      let settled = false;
      const finish = (answers: AskAnswerPayload[] | null): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        resolve(answers);
      };
      const onAbort = (): void => finish(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, finish);
      this.send("ask:request", { id, questions });
      setTimeout(() => finish(null), ANSWER_TIMEOUT_MS);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (!this.authorized(req)) return send(403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ask") return send(404, { error: "unknown" });
      const body = await readJson(req);
      const questions = normalizeQuestions(body.questions);
      if (!questions.length) return send(400, { error: "no questions" });
      const answers = await this.ask(questions);
      send(200, { answers, cancelled: answers === null });
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private authorized(req: IncomingMessage): boolean {
    return Boolean(this.secret && req.headers["x-devil-codex-control-secret"] === this.secret);
  }
}

function normalizeQuestions(raw: unknown): AskQuestionPayload[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 4).map((q) => {
    const item = (q ?? {}) as Record<string, unknown>;
    const options = Array.isArray(item.options) ? item.options.slice(0, 4).map((o) => {
      const opt = (o ?? {}) as Record<string, unknown>;
      return { label: String(opt.label ?? ""), description: opt.description ? String(opt.description) : undefined };
    }).filter((o) => o.label) : [];
    return {
      question: String(item.question ?? ""),
      header: item.header ? String(item.header).slice(0, 12) : undefined,
      options,
      multiSelect: Boolean(item.multiSelect),
    };
  }).filter((q) => q.question && q.options.length >= 2);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
