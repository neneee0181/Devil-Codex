import type { AppServerEvent, AskAnswer, AskRequest } from "../shared/contracts";

export type RemoteCallChannel =
  | "thread:list"
  | "thread:read"
  | "thread:create"
  | "thread:resume"
  | "thread:meta:update"
  | "thread:projects"
  | "thread:search"
  | "thread:queue:get"
  | "turn:queue:enqueue"
  | "turn:queue:update"
  | "turn:queue:remove"
  | "turn:queue:steer"
  | "turn:queue:clear"
  | "turn:send"
  | "turn:interrupt"
  | "approval:respond"
  | "ask:respond"
  | "runtime:status"
  | "runtime:connect"
  | "providers:usage"
  | "providers:load"
  | "providers:select"
  | "settings:load"
  | "settings:update-permissions"
  | "codex:models"
  | "claude:slash-commands"
  | "remote:status"
  | "remote:scope";

type AuthMessage = { type: "auth"; token: string; deviceId: string; deviceName: string };
type CallMessage = { type: "call"; id: number; channel: RemoteCallChannel; input?: unknown };
type ResultMessage = { type: "result"; id: number; ok: boolean; value?: unknown; error?: string };
type EventMessage = { type: "event"; channel: string; payload: unknown };
type AuthStateMessage =
  | { type: "auth-ok" }
  | { type: "auth-pending" }
  | { type: "auth-denied"; reason?: string };

type IncomingMessage = ResultMessage | EventMessage | AuthStateMessage;
type PendingCall = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type BridgeConnectionState =
  | "idle"
  | "connecting"
  | "awaiting-auth"
  | "ready"
  | "auth-pending"
  | "auth-denied"
  | "disconnected"
  | "error";

export interface BridgeSnapshot {
  state: BridgeConnectionState;
  authenticated: boolean;
  deviceId: string;
  deviceName: string;
  tokenPresent: boolean;
  reason?: string;
}

const TOKEN_KEY = "devil-remote-token";
const DEVICE_ID_KEY = "devil-remote-device-id";
const allowedChannels = new Set<RemoteCallChannel>([
  "thread:list",
  "thread:read",
  "thread:create",
  "thread:resume",
  "thread:meta:update",
  "thread:projects",
  "thread:search",
  "thread:queue:get",
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

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function browserName(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) return "Chrome";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) return "Safari";
  return "Browser";
}

function platformName(agent: Navigator): string {
  const platform = (agent as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || agent.platform || "";
  if (/iphone/i.test(platform) || /iphone/i.test(agent.userAgent)) return "iPhone";
  if (/ipad/i.test(platform) || /ipad/i.test(agent.userAgent)) return "iPad";
  if (/android/i.test(platform) || /android/i.test(agent.userAgent)) return "Android";
  if (/mac/i.test(platform)) return "Mac";
  if (/win/i.test(platform)) return "Windows";
  return platform || "Device";
}

function makeDeviceName(agent: Navigator): string {
  return `${platformName(agent)} ${browserName(agent.userAgent)}`.trim();
}

function ensureDeviceId(): string {
  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const value = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_ID_KEY, value);
  return value;
}

function setToken(token: string | null): void {
  if (token && token.trim()) window.sessionStorage.setItem(TOKEN_KEY, token.trim());
  else window.sessionStorage.removeItem(TOKEN_KEY);
}

export function consumeHashToken(): string | null {
  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(raw);
  const token = params.get("t");
  if (token) setToken(token);
  if (window.location.hash) {
    const next = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, "", next);
  }
  return token;
}

export function storedToken(): string | null {
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function clearStoredToken(): void {
  setToken(null);
}

export class RemoteBridge {
  private socket: WebSocket | null = null;
  private pending = new Map<number, PendingCall>();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private stateListeners = new Set<(snapshot: BridgeSnapshot) => void>();
  private nextId = 1;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private manualClose = false;
  private snapshot: BridgeSnapshot;

  readonly deviceId = ensureDeviceId();
  readonly deviceName = makeDeviceName(window.navigator);

  constructor() {
    this.snapshot = {
      state: "idle",
      authenticated: false,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      tokenPresent: Boolean(storedToken()),
    };
  }

  getSnapshot(): BridgeSnapshot {
    return this.snapshot;
  }

  onState(listener: (snapshot: BridgeSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.snapshot);
    return () => this.stateListeners.delete(listener);
  }

  subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
    const bucket = this.listeners.get(channel) ?? new Set<(payload: unknown) => void>();
    bucket.add(listener as (payload: unknown) => void);
    this.listeners.set(channel, bucket);
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener as (payload: unknown) => void);
      if (!current.size) this.listeners.delete(channel);
    };
  }

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    const token = storedToken();
    this.manualClose = false;
    if (!token) {
      this.updateSnapshot({ state: "error", authenticated: false, tokenPresent: false, reason: "토큰이 없습니다." });
      return;
    }
    this.clearReconnectTimer();
    this.updateSnapshot({ state: "connecting", authenticated: false, tokenPresent: true, reason: undefined });
    const socket = new WebSocket(wsUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.updateSnapshot({ state: "awaiting-auth", authenticated: false, tokenPresent: true, reason: undefined });
      const message: AuthMessage = { type: "auth", token, deviceId: this.deviceId, deviceName: this.deviceName };
      socket.send(JSON.stringify(message));
    });

    socket.addEventListener("message", (event) => {
      let message: IncomingMessage;
      try {
        message = JSON.parse(String(event.data)) as IncomingMessage;
      } catch {
        this.updateSnapshot({ state: "error", authenticated: false, tokenPresent: Boolean(storedToken()), reason: "서버 메시지를 해석할 수 없습니다." });
        return;
      }
      if (message.type === "auth-ok") {
        this.updateSnapshot({ state: "ready", authenticated: true, tokenPresent: true, reason: undefined });
        return;
      }
      if (message.type === "auth-pending") {
        this.updateSnapshot({ state: "auth-pending", authenticated: false, tokenPresent: true, reason: "PC에서 기기 승인을 기다리는 중입니다." });
        return;
      }
      if (message.type === "auth-denied") {
        this.updateSnapshot({ state: "auth-denied", authenticated: false, tokenPresent: true, reason: message.reason ?? "접속이 거부되었습니다." });
        this.manualClose = true;
        socket.close();
        return;
      }
      if (message.type === "result") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error ?? "요청이 실패했습니다."));
        return;
      }
      if (message.type === "event") {
        this.emit(message.channel, message.payload);
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.rejectAllPending("연결이 종료되었습니다.");
      if (this.manualClose || this.snapshot.state === "auth-denied") {
        this.updateSnapshot({ state: "disconnected", authenticated: false, tokenPresent: Boolean(storedToken()), reason: this.snapshot.reason });
        return;
      }
      this.updateSnapshot({ state: "disconnected", authenticated: false, tokenPresent: Boolean(storedToken()), reason: "재연결 중입니다." });
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.updateSnapshot({ state: "error", authenticated: false, tokenPresent: Boolean(storedToken()), reason: "WebSocket 연결 오류" });
    });
  }

  disconnect(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  async call<T>(channel: RemoteCallChannel, input?: unknown): Promise<T> {
    if (!allowedChannels.has(channel)) throw new Error(`허용되지 않은 채널: ${channel}`);
    await this.waitUntilReady();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("연결이 준비되지 않았습니다.");
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      const message: CallMessage = { type: "call", id, channel, ...(input === undefined ? {} : { input }) };
      socket.send(JSON.stringify(message));
    });
  }

  async respondAsk(id: string, answers: AskAnswer[] | null): Promise<void> {
    await this.call<void>("ask:respond", { id, answers });
  }

  private async waitUntilReady(): Promise<void> {
    if (this.snapshot.state === "ready" && this.snapshot.authenticated) return;
    if (this.snapshot.state === "auth-denied") throw new Error(this.snapshot.reason ?? "접속이 거부되었습니다.");
    if (!storedToken()) throw new Error("세션 토큰이 없습니다.");
    this.connect();
    await new Promise<void>((resolve, reject) => {
      const off = this.onState((snapshot) => {
        if (snapshot.state === "ready" && snapshot.authenticated) {
          off();
          resolve();
        } else if (snapshot.state === "auth-denied") {
          off();
          reject(new Error(snapshot.reason ?? "접속이 거부되었습니다."));
        }
      });
    });
  }

  private emit(channel: string, payload: unknown): void {
    const bucket = this.listeners.get(channel);
    if (!bucket) return;
    for (const listener of bucket) listener(payload);
  }

  private rejectAllPending(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private updateSnapshot(update: Partial<BridgeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.stateListeners) listener(this.snapshot);
  }
}

export function isAskRequest(value: unknown): value is AskRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && Array.isArray(record.questions);
}

export function isAppServerEvent(value: unknown): value is AppServerEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.method === "string" && "params" in record;
}
