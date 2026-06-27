import { app } from "electron";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAuthStatus, ProviderUsageEntry, ProviderUsageReport, ProviderUsageWindow } from "./contracts.cjs";
import { claudeAccessTokenForUsage } from "./provider-oauth.cjs";

const CACHE_TTL_MS = 90_000;
const cache = new Map<string, { entry: ProviderUsageEntry; ts: number }>();

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

function cached(provider: ProviderUsageEntry["provider"]): ProviderUsageEntry | null {
  const item = cache.get(provider);
  return item && Date.now() - item.ts < CACHE_TTL_MS ? item.entry : null;
}

function remember(entry: ProviderUsageEntry): ProviderUsageEntry {
  cache.set(entry.provider, { entry, ts: Date.now() });
  return entry;
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
  const hit = cached("codex");
  if (hit) return hit;
  const token = await codexAccessToken();
  if (!token) {
    return remember({ provider: "codex", label: "Codex", connected, windows: [], unavailable: "Codex 로그인 토큰을 찾지 못했습니다.", updatedAt: Date.now() });
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
      return remember({ provider: "codex", label: "Codex", connected, windows: [], unavailable, error: unavailable ? undefined : `${res.status} ${await res.text()}`, updatedAt: Date.now() });
    }
    const data = await res.json() as Record<string, unknown>;
    const rateLimitsById = data.rate_limits_by_limit_id as Record<string, unknown> | undefined;
    const rawLimit = (data.rate_limit ?? data.rate_limits ?? rateLimitsById?.codex ?? {}) as Record<string, unknown>;
    const body = rawLimit.rate_limit && typeof rawLimit.rate_limit === "object" ? rawLimit.rate_limit as Record<string, unknown> : rawLimit;
    const primary = (body.primary_window ?? body.primary) as Record<string, unknown> | undefined;
    const secondary = (body.secondary_window ?? body.secondary) as Record<string, unknown> | undefined;
    const windows = [
      primary ? windowEntry("5시간", primary.used_percent ?? primary.percent_used, resetValue(primary)) : null,
      secondary ? windowEntry("7일", secondary.used_percent ?? secondary.percent_used, resetValue(secondary)) : null,
    ].filter(Boolean) as ProviderUsageWindow[];
    return remember({ provider: "codex", label: "Codex", connected, windows, unavailable: windows.length ? undefined : "Codex 사용량 데이터가 비어 있습니다.", updatedAt: Date.now() });
  } catch (error) {
    return remember({ provider: "codex", label: "Codex", connected, windows: [], error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() });
  }
}

async function claudeUsage(connected: boolean): Promise<ProviderUsageEntry | null> {
  if (!connected) return null;
  const hit = cached("claude-code");
  if (hit) return hit;
  const token = await claudeAccessTokenForUsage();
  if (!token) {
    return remember({ provider: "claude-code", label: "Claude Code", connected, windows: [], unavailable: "Claude Code OAuth 토큰을 찾지 못했습니다.", updatedAt: Date.now() });
  }
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return remember({ provider: "claude-code", label: "Claude Code", connected, windows: [], error: `${res.status} ${await res.text()}`, updatedAt: Date.now() });
    const data = await res.json() as Record<string, unknown>;
    const fiveHour = data.five_hour as Record<string, unknown> | undefined;
    const sevenDay = data.seven_day as Record<string, unknown> | undefined;
    const windows = [
      fiveHour ? windowEntry("5시간", fiveHour.utilization, fiveHour.resets_at) : null,
      sevenDay ? windowEntry("7일", sevenDay.utilization, sevenDay.resets_at) : null,
    ].filter(Boolean) as ProviderUsageWindow[];
    return remember({ provider: "claude-code", label: "Claude Code", connected, windows, unavailable: windows.length ? undefined : "Claude Code 사용량 데이터가 비어 있습니다.", updatedAt: Date.now() });
  } catch (error) {
    return remember({ provider: "claude-code", label: "Claude Code", connected, windows: [], error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() });
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
  ])).filter(Boolean) as ProviderUsageEntry[];
  return { entries };
}
