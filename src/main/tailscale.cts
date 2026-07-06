import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";

export interface TailscaleStatusJson {
  BackendState?: string;
  Self?: {
    Online?: boolean;
    DNSName?: string;
    HostName?: string;
    TailscaleIPs?: string[];
  };
}

export interface TailscaleStatusResult {
  installed: boolean;
  online: boolean;
  dnsName: string | null;
  tailscaleIp: string | null;
  localInterfaceIp: string | null;
  cliPath: string | null;
  installUrl?: string;
  error?: string;
  raw?: TailscaleStatusJson;
}

export interface TailscaleCertInput {
  hostname: string;
  certFile: string;
  keyFile: string;
}

export interface TailscaleCliOptions {
  execTimeoutMs?: number;
  windowsFallbackPath?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function fallbackCliPath(): string {
  return process.platform === "win32"
    ? join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Tailscale", "tailscale.exe")
    : "tailscale";
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function extractCommandError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "").trim() : "";
    const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
    return stderr || stdout || safeMessage(error);
  }
  return safeMessage(error);
}

export function isTailscaleIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const firstOctet = parts[0] ?? -1;
  const secondOctet = parts[1] ?? -1;
  return firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127;
}

export function detectLocalTailscaleIp(): string | null {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      if (!isTailscaleIpv4(entry.address)) continue;
      return entry.address;
    }
  }
  return null;
}

export class TailscaleCli {
  private readonly execTimeoutMs: number;
  private readonly windowsFallbackPath: string;
  private detectedCliPath: string | null | undefined;

  constructor(options: TailscaleCliOptions = {}) {
    this.execTimeoutMs = options.execTimeoutMs ?? 8_000;
    this.windowsFallbackPath = options.windowsFallbackPath ?? fallbackCliPath();
  }

  async detectCli(): Promise<string | null> {
    if (this.detectedCliPath !== undefined) return this.detectedCliPath;
    const candidates = process.platform === "win32" ? ["tailscale", this.windowsFallbackPath] : ["tailscale"];
    for (const candidate of candidates) {
      if (candidate !== "tailscale" && !existsSync(candidate)) continue;
      try {
        await execFileAsync(candidate, ["version"], { timeout: this.execTimeoutMs });
        this.detectedCliPath = candidate;
        return candidate;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
        if (code && code !== "ENOENT") continue;
      }
    }
    this.detectedCliPath = null;
    return null;
  }

  async status(): Promise<TailscaleStatusResult> {
    const cliPath = await this.detectCli();
    if (!cliPath) {
      return {
        installed: false,
        online: false,
        dnsName: null,
        tailscaleIp: null,
        localInterfaceIp: detectLocalTailscaleIp(),
        cliPath: null,
        installUrl: TAILSCALE_DOWNLOAD_URL,
        error: "Tailscale CLI not found.",
      };
    }

    try {
      const result = await this.exec(cliPath, ["status", "--json"]);
      const parsed = JSON.parse(result.stdout) as TailscaleStatusJson;
      const dnsName = parsed.Self?.DNSName?.trim() ?? "";
      const tailscaleIp = parsed.Self?.TailscaleIPs?.find((value) => isTailscaleIpv4(String(value)));
      return {
        installed: true,
        online: Boolean(parsed.Self?.Online),
        dnsName: dnsName || null,
        tailscaleIp: tailscaleIp ?? null,
        localInterfaceIp: detectLocalTailscaleIp(),
        cliPath,
        raw: parsed,
        error: parsed.Self?.Online ? undefined : "Tailscale is installed but not connected.",
      };
    } catch (error) {
      return {
        installed: true,
        online: false,
        dnsName: null,
        tailscaleIp: null,
        localInterfaceIp: detectLocalTailscaleIp(),
        cliPath,
        error: extractCommandError(error),
      };
    }
  }

  async cert(input: TailscaleCertInput): Promise<{ certFile: string; keyFile: string }> {
    const cliPath = await this.requireCli();
    await mkdir(dirname(input.certFile), { recursive: true });
    await mkdir(dirname(input.keyFile), { recursive: true });
    await this.exec(cliPath, ["cert", "--cert-file", input.certFile, "--key-file", input.keyFile, input.hostname], 30_000);
    return { certFile: input.certFile, keyFile: input.keyFile };
  }

  // Brings the local Tailscale backend up (equivalent to `tailscale up`).
  // Covers both "daemon running but logged out" and "backend stopped" cases.
  // If the account needs interactive browser auth, `tailscale up` blocks and
  // prints a `https://login.tailscale.com/a/...` URL instead of returning -
  // we use a short timeout so the caller doesn't hang, then scrape that URL
  // out of whatever stdout/stderr was captured before the kill so the UI can
  // open it for the user instead of just failing silently.
  async up(): Promise<{ ok: boolean; authUrl?: string }> {
    const cliPath = await this.requireCli();
    try {
      await this.exec(cliPath, ["up", "--timeout=8s"], 10_000);
      return { ok: true };
    } catch (error) {
      const message = extractCommandError(error);
      const authUrl = message.match(/https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9_-]+/)?.[0];
      if (authUrl) return { ok: false, authUrl };
      throw new Error(message);
    }
  }

  async funnelOn(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535.");
    const cliPath = await this.requireCli();
    await this.exec(cliPath, ["funnel", "--bg", String(port)], 30_000);
  }

  async funnelOff(): Promise<void> {
    const cliPath = await this.requireCli();
    await this.exec(cliPath, ["funnel", "--https=443", "off"], 30_000);
  }

  private async requireCli(): Promise<string> {
    const cliPath = await this.detectCli();
    if (!cliPath) throw new Error(`Tailscale CLI not found. Install it from ${TAILSCALE_DOWNLOAD_URL}`);
    return cliPath;
  }

  private async exec(cliPath: string, args: string[], timeout = this.execTimeoutMs): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(cliPath, args, { timeout, windowsHide: true });
      return { stdout, stderr };
    } catch (error) {
      throw new Error(extractCommandError(error));
    }
  }
}
