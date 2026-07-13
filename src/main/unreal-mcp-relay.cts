import { randomUUID } from "node:crypto";
import { createServer, request as requestHttp, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const UNREAL_MCP_RELAY_PORT = 3001;
export const UNREAL_MCP_UPSTREAM_URL = "http://127.0.0.1:3000/mcp";
const SESSION_HEADER = "mcp-session-id";
type Session = { initialize: string; upstreamId: string };
type UpstreamResponse = { statusCode: number; headers: IncomingHttpHeaders; stream: IncomingMessage };
export type UnrealMcpRelayOptions = { listenPort?: number; upstreamUrl?: string };

// Stable client sessions; upstream Unreal sessions are recreated after editor restart.
// tools/call is never replayed because a restart can happen after a mutation succeeded.
export class UnrealMcpRelay {
  private server?: Server;
  private readonly sessions = new Map<string, Session>();
  private readonly listenPort: number;
  private readonly upstreamUrl: string;

  constructor(input: UnrealMcpRelayOptions = {}) {
    this.listenPort = validPort(input.listenPort ?? UNREAL_MCP_RELAY_PORT, "Relay listen port");
    this.upstreamUrl = validUpstreamUrl(input.upstreamUrl ?? UNREAL_MCP_UPSTREAM_URL);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.listenPort, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.sessions.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.headers.origin || req.headers["sec-fetch-site"]) return this.error(res, 403, "Browser requests are not allowed.");
      if (req.url !== "/mcp") return this.error(res, 404, "Not found.");
      if (req.method === "POST") return await this.post(req, res);
      if (req.method === "GET") return await this.forward(req, res);
      if (req.method === "DELETE") return await this.remove(req, res);
      this.error(res, 405, "Method not allowed.");
    } catch (error) { this.error(res, 503, `Unreal MCP relay unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async post(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const method = parseMethod(body);
    if (method === "initialize") return await this.initialize(req, res, body);
    await this.forward(req, res, body, method === "tools/list");
  }

  private async initialize(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
    const upstream = await this.request(req, body);
    const upstreamId = responseHeader(upstream.headers, SESSION_HEADER);
    if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !upstreamId) return await this.copy(upstream, res);
    const virtualId = randomUUID();
    this.sessions.set(virtualId, { initialize: body, upstreamId });
    await this.copy(upstream, res, virtualId);
  }

  private async forward(req: IncomingMessage, res: ServerResponse, body?: string, retryRead = false): Promise<void> {
    const virtualId = header(req, SESSION_HEADER);
    const session = virtualId ? this.sessions.get(virtualId) : undefined;
    if (virtualId && !session) return this.error(res, 404, "Unknown MCP session. Restart this Codex task once.");
    let upstream = await this.request(req, body, session?.upstreamId);
    if (!session || !isStaleSession(upstream)) return await this.copy(upstream, res);
    if (!await this.restore(session, req)) return this.editorRestarted(res);
    if (!retryRead) return this.editorRestarted(res);
    upstream = await this.request(req, body, session.upstreamId);
    await this.copy(upstream, res);
  }

  private async remove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const virtualId = header(req, SESSION_HEADER);
    const session = virtualId ? this.sessions.get(virtualId) : undefined;
    if (virtualId) this.sessions.delete(virtualId);
    await this.copy(await this.request(req, undefined, session?.upstreamId), res);
  }

  private async restore(session: Session, req: IncomingMessage): Promise<boolean> {
    try {
      const response = await this.request(req, session.initialize, undefined, "POST");
      const upstreamId = responseHeader(response.headers, SESSION_HEADER);
      response.stream.resume();
      if (response.statusCode < 200 || response.statusCode >= 300 || !upstreamId) return false;
      session.upstreamId = upstreamId;
      return true;
    } catch { return false; }
  }

  private request(req: IncomingMessage, body?: string, sessionId?: string, method = req.method ?? "GET"): Promise<UpstreamResponse> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!value || name === "host" || name === "connection" || name === "content-length" || name === SESSION_HEADER) continue;
      headers[name] = Array.isArray(value) ? value.join(",") : value;
    }
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    return new Promise((resolve, reject) => {
      const upstream = requestHttp(this.upstreamUrl, { method, headers }, (stream) => resolve({ statusCode: stream.statusCode ?? 502, headers: stream.headers, stream }));
      upstream.once("error", reject);
      if (body !== undefined) upstream.write(body);
      upstream.end();
    });
  }

  private async copy(source: UpstreamResponse, target: ServerResponse, virtualSessionId?: string): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(source.headers)) {
      if (name !== SESSION_HEADER && name !== "transfer-encoding" && value !== undefined) headers[name] = Array.isArray(value) ? value.join(",") : value;
    }
    if (virtualSessionId) headers["Mcp-Session-Id"] = virtualSessionId;
    target.writeHead(source.statusCode, headers);
    source.stream.pipe(target);
  }

  private editorRestarted(res: ServerResponse): void { this.error(res, 503, "Unreal Editor restarted. Relay reconnected; retry this request. Mutating tool calls are never replayed automatically."); }
  private error(res: ServerResponse, status: number, message: string): void { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null })); }
}

function header(req: IncomingMessage, name: string): string | undefined { const value = req.headers[name]; return Array.isArray(value) ? value[0] : value; }
function responseHeader(headers: IncomingHttpHeaders, name: string): string | undefined { const value = headers[name]; return Array.isArray(value) ? value[0] : value; }
function parseMethod(source: string): string | undefined { try { return (JSON.parse(source) as { method?: string }).method; } catch { return undefined; } }
function isStaleSession(response: UpstreamResponse): boolean { return response.statusCode === 400 || response.statusCode === 401 || response.statusCode === 404; }
function readBody(req: IncomingMessage): Promise<string> { return new Promise((resolve, reject) => { let value = ""; req.setEncoding("utf8"); req.on("data", (chunk) => { value += chunk; }); req.on("end", () => resolve(value)); req.on("error", reject); }); }

export function unrealMcpRelayOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): UnrealMcpRelayOptions {
  const listenPort = env.DEVIL_UNREAL_MCP_RELAY_PORT ? Number(env.DEVIL_UNREAL_MCP_RELAY_PORT) : undefined;
  return { listenPort, upstreamUrl: env.DEVIL_UNREAL_MCP_UPSTREAM_URL };
}
function validPort(value: number, label: string): number { if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} must be an integer from 1 to 65535.`); return value; }
function validUpstreamUrl(value: string): string { const url = new URL(value); if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname) || url.pathname !== "/mcp") throw new Error("Unreal MCP upstream must be a loopback HTTP /mcp URL."); return url.toString(); }
