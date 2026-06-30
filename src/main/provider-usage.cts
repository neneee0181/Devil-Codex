import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAuthStatus, ProviderUsageEntry, ProviderUsageReport, ProviderUsageWindow } from "./contracts.cjs";
import { claudeAccessTokenForUsage } from "./provider-oauth.cjs";
import { antigravityUsage } from "./provider-antigravity.cjs";

const CACHE_TTL_MS = 90_000;
const cache = new Map<string, { entry: ProviderUsageEntry; ts: number; subject?: string }>();

function clampPercent(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function windowEntry(label: string, used: unknown, resetsAt: unknown): ProviderUsageWindow {
  const usedPercent = clampPercent(used);
  return { label, usedPercent, remainingPercent: Math.max(0, 100 - usedPercent), resetsAt: resetsAt as string | number | null | undefined };
}

function resetValue(window: Record<string, unknown> | undefined): string | number | null {
  if (!window) return null;
  const absolute = window.reset_at ?? window.resets_at;
  if (absolute != null) {
    if (typeof absolute === "number" && absolute > 0 && absolute < 10_000_000_000) return absolute * 1000;
    return absolute as string | number;
  }
  const relative = window.reset_after_seconds ?? window.reset_after;
  return typeof relative === "number" ? Date.now() + relative * 1000 : null;
}

function usageValue(window: Record<string, unknown>): unknown {
  return window.used_percent ?? window.percent_used ?? window.utilization ?? window.usedPercent ?? window.percentUsed ?? window.used;
}

function secondsValue(window: Record<string, unknown>): number | null {
  const value = window.duration_seconds ?? window.window_seconds ?? window.period_seconds ?? window.limit_seconds;
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function windowLabel(key: string, window: Record<string, unknown>): string {
  const explicit = window.label ?? window.name ?? window.display_name ?? window.displayName ?? window.window_label ?? window.windowLabel;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const lower = key.toLowerCase();
  if (/five|5h|5_hour|5-hour|primary/.test(lower)) return "5시간";
  if (/seven|7d|7_day|7-day|weekly|secondary/.test(lower)) return "7일";
  if (/month|monthly|30d|30_day|30-day|tertiary/.test(lower)) return "월간";
  const seconds = secondsValue(window);
  if (seconds) {
    const hours = Math.round(seconds / 3600);
    const days = Math.round(seconds / 86400);
    if (hours <= 48) return `${hours}시간`;
    if (days >= 28 && days <= 31) return "월간";
    return `${days}일`;
  }
  return key.replace(/[_-]?window$/i, "").replace(/[_-]/g, " ");
}

function usageWindowFrom(key: string, value: unknown): ProviderUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const window = value as Record<string, unknown>;
  const used = usageValue(window);
  if (used == null) return null;
  return windowEntry(windowLabel(key, window), used, resetValue(window));
}

function collectUsageWindows(body: Record<string, unknown>): ProviderUsageWindow[] {
  const candidates: Array<[string, unknown]> = [];
  const direct = body.rate_limit && typeof body.rate_limit === "object" ? body.rate_limit as Record<string, unknown> : body;
  for (const key of ["primary_window", "primary", "five_hour", "fiveHour", "secondary_window", "secondary", "seven_day", "sevenDay", "monthly_window", "monthly", "month", "tertiary_window", "tertiary"]) {
    if (key in direct) candidates.push([key, direct[key]]);
  }
  for (const [key, value] of Object.entries(direct)) {
    if (/_window$/i.test(key) && !candidates.some(([existing]) => existing === key)) candidates.push([key, value]);
  }
  const arrayWindows = direct.windows ?? direct.rate_limit_windows ?? direct.rateLimitWindows;
  if (Array.isArray(arrayWindows)) {
    arrayWindows.forEach((value, index) => candidates.push([`window_${index}`, value]));
  }
  const seen = new Set<string>();
  const windows: ProviderUsageWindow[] = [];
  for (const [key, value] of candidates) {
    const window = usageWindowFrom(key, value);
    if (!window) continue;
    const dedupeKey = `${window.label}:${window.resetsAt ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    windows.push(window);
  }
  return windows;
}

function tokenSubject(token: string | null): string {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "missing";
}

function cached(provider: ProviderUsageEntry["provider"], subject?: string): ProviderUsageEntry | null {
  const item = cache.get(provider);
  return item && item.subject === subject && Date.now() - item.ts < CACHE_TTL_MS ? item.entry : null;
}

function remember(entry: ProviderUsageEntry, subject?: string): ProviderUsageEntry {
  cache.set(entry.provider, { entry, ts: Date.now(), subject });
  return entry;
}

export function clearProviderUsageCache(provider?: ProviderUsageEntry["provider"]): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}

async function codexAccessToken(): Promise<string | null> {
  const path = join(app.getPath("home"), ".codex", "auth.json");
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(await readFile(path, "utf8")) as { tokens?: { access_token?: string } };
    return auth.tokens?.access_token ?? null;
  } catch {
    return null;
  }
}

async function codexUsage(connected: boolean): Promise<ProviderUsageEntry | null> {
  if (!connected) return null;
  const token = await codexAccessToken();
  const subject = tokenSubject(token);
  const hit = cached("codex", subject);
  if (hit) return hit;
  if (!token) {
    return remember({ provider: "codex", label: "Codex", connected, windows: [], unavailable: "Codex 로그인 토큰을 찾지 못했습니다.", updatedAt: Date.now() }, subject);
  }
  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const unavailable = res.status === 401 || res.status === 403
        ? `ChatGPT usage API가 Codex OAuth 토큰을 거부했습니다. (${res.status})`
        : undefined;
      return remember({ provider: "codex", label: "Codex", connected, windows: [], unavailable, error: unavailable ? undefined : `${res.status} ${await res.text()}`, updatedAt: Date.now() }, subject);
    }
    const data = await res.json() as Record<string, unknown>;
    const rateLimitsById = data.rate_limits_by_limit_id as Record<string, unknown> | undefined;
    const rawLimits = [data.rate_limit, data.rate_limits, rateLimitsById?.codex]
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
    const windows = [
      ...rawLimits.flatMap((value) => collectUsageWindows(value)),
      ...Object.entries(rateLimitsById ?? {}).flatMap(([, value]) => value && typeof value === "object" ? collectUsageWindows(value as Record<string, unknown>) : []),
    ];
    const unique = [...new Map(windows.map((window) => [`${window.label}:${window.resetsAt ?? ""}`, window])).values()];
    return remember({ provider: "codex", label: "Codex", connected, windows: unique, unavailable: unique.length ? undefined : "Codex 사용량 데이터가 비어 있습니다.", updatedAt: Date.now() }, subject);
  } catch (error) {
    return remember({ provider: "codex", label: "Codex", connected, windows: [], error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() }, subject);
  }
}

async function claudeUsage(connected: boolean): Promise<ProviderUsageEntry | null> {
  if (!connected) return null;
  const token = await claudeAccessTokenForUsage();
  const subject = tokenSubject(token);
  const hit = cached("claude-code", subject);
  if (hit) return hit;
  if (!token) {
    return remember({ provider: "claude-code", label: "Claude Code", connected, windows: [], unavailable: "Claude Code OAuth 토큰을 찾지 못했습니다.", updatedAt: Date.now() }, subject);
  }
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return remember({ provider: "claude-code", label: "Claude Code", connected, windows: [], error: `${res.status} ${await res.text()}`, updatedAt: Date.now() }, subject);
    const data = await res.json() as Record<string, unknown>;
    const fiveHour = data.five_hour as Record<string, unknown> | undefined;
    const sevenDay = data.seven_day as Record<string, unknown> | undefined;
    const windows = [
      fiveHour ? windowEntry("5시간", fiveHour.utilization, fiveHour.resets_at) : null,
      sevenDay ? windowEntry("7일", sevenDay.utilization, sevenDay.resets_at) : null,
    ].filter(Boolean) as ProviderUsageWindow[];
    return remember({ provider: "claude-code", label: "Claude Code", connected, windows, unavailable: windows.length ? undefined : "Claude Code 사용량 데이터가 비어 있습니다.", updatedAt: Date.now() }, subject);
  } catch (error) {
    return remember({ provider: "claude-code", label: "Claude Code", connected, windows: [], error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() }, subject);
  }
}

function copilotUsage(connected: boolean): ProviderUsageEntry | null {
  if (!connected) return null;
  return {
    provider: "copilot",
    label: "GitHub Copilot",
    connected,
    windows: [],
    unavailable: "GitHub Copilot은 현재 rcodex/opencodex 기준으로 구독 사용량 조회 API가 확인되지 않았습니다.",
    updatedAt: Date.now(),
  };
}

export async function providerUsageReport(auth: ProviderAuthStatus): Promise<ProviderUsageReport> {
  const entries = (await Promise.all([
    codexUsage(auth.codex),
    claudeUsage(auth.claude),
    Promise.resolve(copilotUsage(auth.copilot)),
    auth.antigravity ? antigravityUsage(true) : Promise.resolve(null),
  ])).filter(Boolean) as ProviderUsageEntry[];
  return { entries };
}
