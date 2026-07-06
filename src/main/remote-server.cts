import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { RemoteAuthStore } from "./remote-auth.cjs";

export type RemoteHandler = (input: unknown) => Promise<unknown> | unknown;

export interface RemoteServerOptions {
  handlers: Map<string, RemoteHandler>;
  allowedChannels: Set<string>;
  allowedEvents: Set<string>;
  auth: RemoteAuthStore;
  onDeviceApprovalNeeded: (device: { deviceId: string; deviceName: string }) => Promise<boolean>;
  staticDir: string;
  version?: string;
  heartbeatIntervalMs?: number;
  maxMissedHeartbeats?: number;
}

export interface RemoteServerTlsOptions {
  cert: string | Buffer;
  key: string | Buffer;
}

export interface RemoteServerStartInput {
  host: string;
  port: number;
  tls?: RemoteServerTlsOptions;
}

export interface RemoteClientInfo {
  deviceId: string;
  deviceName: string;
  connectedAt: number;
}

type ServerLike = HttpServer | HttpsServer;

type RemoteInboundMessage =
  | { type: "auth"; token: string; deviceId: string; deviceName?: string }
  | { type: "call"; id: number; channel: string; input?: unknown };

interface ClientState {
  socket: WebSocket;
  address: string;
  deviceId?: string;
  deviceName?: string;
  connectedAt?: number;
  authenticated: boolean;
  authPending: boolean;
  missedHeartbeats: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MISSED_HEARTBEATS = 2;
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function normalizeAddress(address: string | undefined): string {
  const value = String(address ?? "").trim();
  if (value.startsWith("::ffff:")) return value.slice(7);
  if (value === "::1") return "127.0.0.1";
  return value || "unknown";
}

function requestAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return normalizeAddress(forwarded.split(",")[0]?.trim());
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return normalizeAddress(forwarded[0]);
  }
  return normalizeAddress(request.socket.remoteAddress);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function isInsideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function mimeType(pathname: string): string {
  return MIME_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

export class RemoteServer {
  private readonly staticRoot: string;
  private readonly heartbeatIntervalMs: number;
  private readonly maxMissedHeartbeats: number;
  private server: ServerLike | undefined;
  private wsServer: WebSocketServer | undefined;
  private readonly clients = new Map<WebSocket, ClientState>();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RemoteServerOptions) {
    this.staticRoot = resolve(options.staticDir);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxMissedHeartbeats = options.maxMissedHeartbeats ?? DEFAULT_MAX_MISSED_HEARTBEATS;
  }

  // Swap the dispatch table live (e.g. the thread allowlist changed) without
  // dropping existing WebSocket connections or re-running the Tailscale/auth
  // startup dance.
  setHandlers(handlers: Map<string, RemoteHandler>): void {
    this.options.handlers = handlers;
  }

  async start(input: RemoteServerStartInput): Promise<{ port: number }> {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address === "object") return { port: address.port };
      return { port: input.port };
    }

    const server = input.tls
      ? createHttpsServer({ cert: input.tls.cert, key: input.tls.key }, (req, res) => void this.handleHttp(req, res))
      : createHttpServer((req, res) => void this.handleHttp(req, res));
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

    server.on("upgrade", (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(request, socket as Duplex, head, (client) => {
        wsServer.emit("connection", client, request);
      });
    });
    wsServer.on("connection", (socket, request) => {
      void this.handleConnection(socket, request);
    });

    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(input.port, input.host, () => {
        server.off("error", reject);
        resolvePromise();
      });
    });

    this.server = server;
    this.wsServer = wsServer;
    this.heartbeatTimer = setInterval(() => this.pulseClients(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();

    const address = server.address();
    if (!address || typeof address === "string") return { port: input.port };
    return { port: address.port };
  }

  broadcast(channel: string, payload: unknown): void {
    if (!this.options.allowedEvents.has(channel)) return;
    for (const client of this.clients.values()) {
      if (!client.authenticated) continue;
      sendJson(client.socket, { type: "event", channel, payload });
    }
  }

  listClients(): RemoteClientInfo[] {
    const items: RemoteClientInfo[] = [];
    for (const client of this.clients.values()) {
      if (!client.authenticated || !client.deviceId || !client.deviceName || !client.connectedAt) continue;
      items.push({
        deviceId: client.deviceId,
        deviceName: client.deviceName,
        connectedAt: client.connectedAt,
      });
    }
    return items.sort((left, right) => left.connectedAt - right.connectedAt);
  }

  disconnect(deviceId: string): void {
    for (const client of this.clients.values()) {
      if (client.deviceId !== deviceId) continue;
      sendJson(client.socket, { type: "auth-denied", reason: "Device access revoked." });
      client.socket.close(1008, "Device access revoked.");
    }
  }

  async stop(): Promise<void> {
    const timer = this.heartbeatTimer;
    this.heartbeatTimer = undefined;
    if (timer) clearInterval(timer);

    for (const client of this.clients.values()) client.socket.close(1001, "Server stopping");
    this.clients.clear();

    const wsServer = this.wsServer;
    this.wsServer = undefined;
    if (wsServer) {
      await new Promise<void>((resolvePromise) => wsServer.close(() => resolvePromise()));
    }

    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        return this.respondJson(res, 405, { error: "Method not allowed." });
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        return this.respondJson(res, 200, { ok: true, version: this.options.version ?? "unknown" });
      }

      if (url.pathname === "/ws") return this.respondJson(res, 426, { error: "Upgrade required." });
      return await this.serveStatic(req, res, url.pathname);
    } catch (error) {
      this.respondJson(res, 500, { error: safeMessage(error) });
    }
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const decoded = this.normalizePathname(pathname);
    if (decoded === null) return this.respondJson(res, 400, { error: "Invalid path." });

    let relative = decoded === "/" ? "/index.html" : decoded;
    const candidate = resolve(this.staticRoot, "." + relative);
    if (!isInsideRoot(this.staticRoot, candidate)) return this.respondJson(res, 403, { error: "Forbidden." });

    let target = candidate;
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) {
        target = resolve(candidate, "index.html");
        if (!isInsideRoot(this.staticRoot, target)) return this.respondJson(res, 403, { error: "Forbidden." });
      }
    } catch {
      if (relative.endsWith("/")) {
        target = resolve(candidate, "index.html");
      }
    }

    if (!existsSync(target)) return this.respondJson(res, 404, { error: "Not found." });
    const fileInfo = await stat(target).catch(() => null);
    if (!fileInfo || !fileInfo.isFile()) return this.respondJson(res, 404, { error: "Not found." });

    res.writeHead(200, {
      "cache-control": target.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
      "content-length": String(fileInfo.size),
      "content-type": mimeType(target),
      "x-content-type-options": "nosniff",
    });
    if ((req.method ?? "GET") === "HEAD") {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  }

  private normalizePathname(pathname: string): string | null {
    try {
      const decoded = decodeURIComponent(pathname || "/");
      if (!decoded.startsWith("/")) return null;
      return decoded;
    } catch {
      return null;
    }
  }

  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const client: ClientState = {
      socket,
      address: requestAddress(request),
      authenticated: false,
      authPending: false,
      missedHeartbeats: 0,
    };
    this.clients.set(socket, client);

    socket.on("pong", () => {
      const current = this.clients.get(socket);
      if (!current) return;
      current.missedHeartbeats = 0;
    });
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("error", () => {
      this.clients.delete(socket);
    });
    socket.on("message", (data, isBinary) => {
      void this.handleSocketMessage(client, data, isBinary);
    });
  }

  private async handleSocketMessage(client: ClientState, data: RawData, isBinary: boolean): Promise<void> {
    try {
      if (isBinary) {
        client.socket.close(1003, "Binary messages are not supported.");
        return;
      }

      const message = this.parseMessage(this.rawDataToString(data));
      if (!message) {
        sendJson(client.socket, { type: "result", id: null, ok: false, error: "Invalid message." });
        return;
      }

      if (message.type === "auth") {
        await this.handleAuth(client, message);
        return;
      }

      if (!client.authenticated) {
        client.socket.close(1008, "Authentication required.");
        return;
      }

      await this.handleCall(client, message);
    } catch {
      if (client.socket.readyState === WebSocket.OPEN) {
        sendJson(client.socket, { type: "result", id: null, ok: false, error: "Request failed." });
      }
      client.socket.close(1011, "Request failed.");
    }
  }

  private parseMessage(raw: string): RemoteInboundMessage | null {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isJsonRecord(parsed) || typeof parsed.type !== "string") return null;
      if (parsed.type === "auth") {
        if (typeof parsed.token !== "string" || typeof parsed.deviceId !== "string") return null;
        return {
          type: "auth",
          token: parsed.token,
          deviceId: parsed.deviceId,
          deviceName: typeof parsed.deviceName === "string" ? parsed.deviceName : undefined,
        };
      }
      if (parsed.type === "call") {
        if (typeof parsed.id !== "number" || !Number.isFinite(parsed.id) || typeof parsed.channel !== "string") return null;
        return { type: "call", id: parsed.id, channel: parsed.channel, input: parsed.input };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async handleAuth(client: ClientState, message: Extract<RemoteInboundMessage, { type: "auth" }>): Promise<void> {
    if (client.authPending) {
      sendJson(client.socket, { type: "auth-pending" });
      return;
    }

    let result;
    try {
      result = await this.options.auth.beginAuthorization({
        token: message.token,
        deviceId: message.deviceId,
        deviceName: message.deviceName,
        ip: client.address,
      });
    } catch {
      sendJson(client.socket, { type: "auth-denied", reason: "Authentication failed." });
      client.socket.close(1008, "Authentication failed.");
      return;
    }

    if (result.status === "denied") {
      sendJson(client.socket, { type: "auth-denied", reason: result.reason, retryAfterMs: result.retryAfterMs });
      client.socket.close(1008, "Authentication failed.");
      return;
    }

    if (result.status === "ok") {
      client.authenticated = true;
      client.deviceId = result.device.deviceId;
      client.deviceName = result.device.deviceName;
      client.connectedAt = Date.now();
      client.missedHeartbeats = 0;
      sendJson(client.socket, { type: "auth-ok" });
      return;
    }

    client.authPending = true;
    sendJson(client.socket, { type: "auth-pending" });
    let approved = false;
    try {
      approved = await this.options.onDeviceApprovalNeeded(result.device);
    } catch {
      approved = false;
    } finally {
      client.authPending = false;
    }

    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (!approved) {
      const failure = this.options.auth.recordFailure(client.address);
      sendJson(client.socket, {
        type: "auth-denied",
        reason: "Device approval denied.",
        retryAfterMs: failure.retryAfterMs,
      });
      client.socket.close(1008, "Device approval denied.");
      return;
    }

    let device;
    try {
      device = await this.options.auth.approveDevice(result.device);
    } catch {
      sendJson(client.socket, { type: "auth-denied", reason: "Authentication failed." });
      client.socket.close(1008, "Authentication failed.");
      return;
    }
    this.options.auth.clearFailures(client.address);
    client.authenticated = true;
    client.deviceId = device.deviceId;
    client.deviceName = device.deviceName;
    client.connectedAt = Date.now();
    client.missedHeartbeats = 0;
    sendJson(client.socket, { type: "auth-ok" });
  }

  private async handleCall(client: ClientState, message: Extract<RemoteInboundMessage, { type: "call" }>): Promise<void> {
    if (!this.options.allowedChannels.has(message.channel)) {
      sendJson(client.socket, { type: "result", id: message.id, ok: false, error: "Channel not allowed." });
      return;
    }

    const handler = this.options.handlers.get(message.channel);
    if (!handler) {
      sendJson(client.socket, { type: "result", id: message.id, ok: false, error: "Unknown channel." });
      return;
    }

    try {
      const value = await handler(message.input);
      sendJson(client.socket, { type: "result", id: message.id, ok: true, value });
    } catch (error) {
      sendJson(client.socket, { type: "result", id: message.id, ok: false, error: safeMessage(error) });
    }
  }

  private pulseClients(): void {
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        this.clients.delete(client.socket);
        continue;
      }
      client.missedHeartbeats += 1;
      if (client.missedHeartbeats > this.maxMissedHeartbeats) {
        client.socket.terminate();
        this.clients.delete(client.socket);
        continue;
      }
      client.socket.ping();
    }
  }

  private respondJson(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
  }

  private rawDataToString(data: RawData): string {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
    return Buffer.from(data).toString("utf8");
  }
}
