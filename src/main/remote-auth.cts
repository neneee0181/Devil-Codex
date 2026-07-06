import { app, safeStorage } from "electron";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ApprovedRemoteDevice {
  deviceId: string;
  deviceName: string;
  approvedAt: number;
  lastSeenAt?: number;
}

export interface PendingRemoteDevice {
  deviceId: string;
  deviceName: string;
}

export interface RemoteAuthSnapshot {
  token: string;
  tokenIssuedAt: number;
  devices: ApprovedRemoteDevice[];
  encryption: "safeStorage" | "plain";
}

export type RemoteAuthResult =
  | { status: "ok"; device: ApprovedRemoteDevice }
  | { status: "pending"; device: PendingRemoteDevice }
  | { status: "denied"; reason: string; retryAfterMs?: number };

interface RemoteAuthFile {
  version: 1;
  tokenIssuedAt: number;
  token: {
    mode: "safeStorage" | "plain";
    value: string;
  };
  devices: ApprovedRemoteDevice[];
}

export interface RemoteAuthStoreOptions {
  path?: string;
  now?: () => number;
  failureWindowMs?: number;
  blockDurationMs?: number;
  maxFailures?: number;
}

interface FailureEntry {
  attempts: number[];
  blockedUntil: number;
}

const DEFAULT_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_BLOCK_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;

function authPath(): string {
  return join(app.getPath("userData"), "remote-auth.json");
}

function makeToken(): string {
  return randomBytes(32).toString("hex");
}

function nowMs(): number {
  return Date.now();
}

function normalizeDevice(input: PendingRemoteDevice): PendingRemoteDevice {
  return {
    deviceId: String(input.deviceId ?? "").trim(),
    deviceName: String(input.deviceName ?? "").trim() || "Unknown device",
  };
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function encodeToken(token: string): { mode: "safeStorage" | "plain"; value: string } {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      mode: "safeStorage",
      value: safeStorage.encryptString(token).toString("base64"),
    };
  }
  return { mode: "plain", value: token };
}

function decodeToken(entry: RemoteAuthFile["token"]): string | null {
  if (entry.mode === "plain") return entry.value;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(entry.value, "base64"));
  } catch {
    return null;
  }
}

function equalToken(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class RemoteAuthStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly failureWindowMs: number;
  private readonly blockDurationMs: number;
  private readonly maxFailures: number;
  private readonly failures = new Map<string, FailureEntry>();
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: RemoteAuthStoreOptions = {}) {
    this.filePath = options.path ?? authPath();
    this.now = options.now ?? nowMs;
    this.failureWindowMs = options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
    this.blockDurationMs = options.blockDurationMs ?? DEFAULT_BLOCK_DURATION_MS;
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  }

  async getSnapshot(): Promise<RemoteAuthSnapshot> {
    const state = await this.readState();
    return {
      token: state.token,
      tokenIssuedAt: state.tokenIssuedAt,
      devices: [...state.devices],
      encryption: state.file.token.mode,
    };
  }

  async ensureToken(): Promise<string> {
    return (await this.readState()).token;
  }

  async regenerateToken(): Promise<string> {
    return this.withLock(async () => {
      const token = makeToken();
      const next: RemoteAuthFile = {
        version: 1,
        tokenIssuedAt: this.now(),
        token: encodeToken(token),
        devices: [],
      };
      await this.writeFile(next);
      return token;
    });
  }

  async listApprovedDevices(): Promise<ApprovedRemoteDevice[]> {
    return [...(await this.readState()).devices];
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState();
      const next: RemoteAuthFile = {
        ...state.file,
        devices: state.devices.filter((device) => device.deviceId !== deviceId),
      };
      await this.writeFile(next);
    });
  }

  async approveDevice(input: PendingRemoteDevice): Promise<ApprovedRemoteDevice> {
    const device = normalizeDevice(input);
    if (!device.deviceId) throw new Error("Device ID is required.");
    return this.withLock(async () => {
      const state = await this.readState();
      const stamp = this.now();
      const approved: ApprovedRemoteDevice = {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        approvedAt: stamp,
        lastSeenAt: stamp,
      };
      const devices = state.devices.filter((item) => item.deviceId !== device.deviceId);
      devices.push(approved);
      const next: RemoteAuthFile = { ...state.file, devices };
      await this.writeFile(next);
      return approved;
    });
  }

  async markDeviceSeen(deviceId: string, deviceName?: string): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState();
      const devices = state.devices.map((device) => {
        if (device.deviceId !== deviceId) return device;
        return {
          ...device,
          deviceName: deviceName?.trim() || device.deviceName,
          lastSeenAt: this.now(),
        };
      });
      await this.writeFile({ ...state.file, devices });
    });
  }

  recordFailure(ip: string): { blocked: boolean; retryAfterMs?: number } {
    const key = ip.trim() || "unknown";
    const stamp = this.now();
    const current = this.failures.get(key) ?? { attempts: [], blockedUntil: 0 };
    const attempts = current.attempts.filter((value) => value > stamp - this.failureWindowMs);
    attempts.push(stamp);
    let blockedUntil = current.blockedUntil;
    if (attempts.length >= this.maxFailures) blockedUntil = stamp + this.blockDurationMs;
    this.failures.set(key, { attempts, blockedUntil });
    if (blockedUntil > stamp) return { blocked: true, retryAfterMs: blockedUntil - stamp };
    return { blocked: false };
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip.trim() || "unknown");
  }

  getBlockStatus(ip: string): { blocked: boolean; retryAfterMs?: number } {
    const key = ip.trim() || "unknown";
    const current = this.failures.get(key);
    if (!current) return { blocked: false };
    const stamp = this.now();
    const attempts = current.attempts.filter((value) => value > stamp - this.failureWindowMs);
    if (current.blockedUntil > stamp) {
      this.failures.set(key, { attempts, blockedUntil: current.blockedUntil });
      return { blocked: true, retryAfterMs: current.blockedUntil - stamp };
    }
    if (attempts.length) this.failures.set(key, { attempts, blockedUntil: 0 });
    else this.failures.delete(key);
    return { blocked: false };
  }

  async beginAuthorization(input: {
    token: string;
    deviceId: string;
    deviceName?: string;
    ip: string;
  }): Promise<RemoteAuthResult> {
    const blocked = this.getBlockStatus(input.ip);
    if (blocked.blocked) return { status: "denied", reason: "Too many failed authentication attempts.", retryAfterMs: blocked.retryAfterMs };

    const device = normalizeDevice({ deviceId: input.deviceId, deviceName: input.deviceName ?? "" });
    if (!device.deviceId) {
      const failure = this.recordFailure(input.ip);
      return failure.blocked
        ? { status: "denied", reason: "Too many failed authentication attempts.", retryAfterMs: failure.retryAfterMs }
        : { status: "denied", reason: "Device ID is required.", retryAfterMs: failure.retryAfterMs };
    }

    const state = await this.readState();
    if (!equalToken(state.token, String(input.token ?? "").trim())) {
      const failure = this.recordFailure(input.ip);
      return failure.blocked
        ? { status: "denied", reason: "Too many failed authentication attempts.", retryAfterMs: failure.retryAfterMs }
        : { status: "denied", reason: "Invalid authentication token.", retryAfterMs: failure.retryAfterMs };
    }

    const approved = state.devices.find((item) => item.deviceId === device.deviceId);
    if (!approved) return { status: "pending", device };

    this.clearFailures(input.ip);
    await this.markDeviceSeen(approved.deviceId, device.deviceName).catch(() => undefined);
    return {
      status: "ok",
      device: {
        ...approved,
        deviceName: device.deviceName || approved.deviceName,
        lastSeenAt: this.now(),
      },
    };
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async readState(): Promise<{ file: RemoteAuthFile; token: string; tokenIssuedAt: number; devices: ApprovedRemoteDevice[] }> {
    const parsed = await this.readFile();
    if (parsed) {
      const token = decodeToken(parsed.token);
      if (token) {
        return { file: parsed, token, tokenIssuedAt: parsed.tokenIssuedAt, devices: [...parsed.devices] };
      }
    }

    const token = makeToken();
    const next: RemoteAuthFile = {
      version: 1,
      tokenIssuedAt: this.now(),
      token: encodeToken(token),
      devices: [],
    };
    await this.writeFile(next);
    return { file: next, token, tokenIssuedAt: next.tokenIssuedAt, devices: [] };
  }

  private async readFile(): Promise<RemoteAuthFile | null> {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<RemoteAuthFile>;
      if (raw.version !== 1) return null;
      const devices = Array.isArray(raw.devices)
        ? raw.devices
          .map((entry) => ({
            deviceId: String(entry?.deviceId ?? "").trim(),
            deviceName: String(entry?.deviceName ?? "").trim() || "Unknown device",
            approvedAt: Number(entry?.approvedAt ?? 0) || 0,
            lastSeenAt: entry?.lastSeenAt == null ? undefined : Number(entry.lastSeenAt) || undefined,
          }))
          .filter((entry) => entry.deviceId && entry.approvedAt > 0)
        : [];
      const tokenValue = raw.token?.value ? String(raw.token.value) : "";
      const tokenMode = raw.token?.mode === "safeStorage" ? "safeStorage" : raw.token?.mode === "plain" ? "plain" : null;
      if (!tokenMode || !tokenValue) return null;
      return {
        version: 1,
        tokenIssuedAt: Number(raw.tokenIssuedAt ?? 0) || this.now(),
        token: { mode: tokenMode, value: tokenValue },
        devices,
      };
    } catch (error) {
      throw new Error(`Failed to read remote auth store: ${safeMessage(error)}`);
    }
  }

  private async writeFile(data: RemoteAuthFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  }
}
