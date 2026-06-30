import { app, safeStorage, shell } from "electron";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderModel, ProviderUsageEntry, ProviderUsageWindow } from "./contracts.cjs";

type AntigravityToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  email?: string;
  projectId?: string;
};

type GoogleTokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
};

const CLIENT_ID = process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID
  || ["1071006060591", "-tmhssin2h21lcre235vtolojh4g403ep", ".apps.googleusercontent.com"].join("");
const CLIENT_SECRET = process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET
  || ["GO", "CSP", "X-K58F", "WR486Ld", "LJ1mLB8", "sXC4z6qDAf"].join("");
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROD_API = "https://cloudcode-pa.googleapis.com";
const DAILY_API = "https://daily-cloudcode-pa.googleapis.com";
const API_VERSION = "v1internal";
const CALLBACK_PORT = 51121;
const CALLBACK_REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const REFRESH_SKEW_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2_000;
const MODEL_CACHE_TTL_MS = 10 * 60_000;
const QUOTA_CACHE_TTL_MS = 90_000;
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_MODELS = [
  "gemini-3.5-flash-low",
  "gemini-3-flash-agent",
  "gemini-3.5-flash-extra-low",
  "gemini-3.1-pro-low",
  "gemini-pro-agent",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

export const ANTIGRAVITY_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.5-flash-low": 1_048_576,
  "gemini-3-flash-agent": 1_048_576,
  "gemini-3.5-flash-extra-low": 1_048_576,
  "gemini-3.1-pro-low": 1_048_576,
  "gemini-pro-agent": 1_048_576,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6-thinking": 1_000_000,
  "gpt-oss-120b-medium": 131_072,
};

const modelCache = new Map<string, { models: ProviderModel[]; fetchedAt: number }>();
const quotaCache = new Map<string, { windows: ProviderUsageWindow[]; fetchedAt: number }>();
let antigravityLoginInProgress = false;

function root(): string { return join(app.getPath("userData"), "providers"); }
function tokenPath(): string { return join(root(), "antigravity.oauth"); }

async function writeToken(value: AntigravityToken): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("이 시스템에서 OS Keychain 암호화를 사용할 수 없습니다.");
  await mkdir(root(), { recursive: true });
  await writeFile(tokenPath(), safeStorage.encryptString(JSON.stringify(value)).toString("base64"), { mode: 0o600 });
}

async function readStoredToken(): Promise<AntigravityToken | null> {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from((await readFile(path, "utf8")).trim(), "base64"))) as AntigravityToken;
  } catch {
    return null;
  }
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function emailFromToken(accessToken: string, idToken: string | undefined): string | undefined {
  const payload = (idToken ? decodeJwtPayload(idToken) : undefined) ?? decodeJwtPayload(accessToken);
  const email = payload?.email;
  return typeof email === "string" && email.length > 0 ? email.toLowerCase() : undefined;
}

function credentialsFromPayload(payload: GoogleTokenPayload, refreshFallback = ""): AntigravityToken {
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Antigravity token response did not include an access token");
  }
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token
    ? payload.refresh_token
    : refreshFallback;
  if (!refreshToken) throw new Error("Antigravity token response did not include a refresh token");
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    email: emailFromToken(payload.access_token, idToken),
  };
}

async function postToken(body: Record<string, string>, signal?: AbortSignal): Promise<GoogleTokenPayload> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Antigravity token request failed: ${response.status}`);
  return (await response.json()) as GoogleTokenPayload;
}

function extractProjectId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
      return (value as { id: string }).id;
    }
  }
  return undefined;
}

async function loadCodeAssistProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  const response = await fetch(`${PROD_API}/${API_VERSION}:loadCodeAssist`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "*/*", "Content-Type": "application/json" },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    signal: requestSignal(signal),
  });
  if (!response.ok) return undefined;
  return extractProjectId((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined);
}

async function onboardProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("Antigravity onboarding aborted");
    const response = await fetch(`${DAILY_API}/${API_VERSION}:onboardUser`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "*/*", "Content-Type": "application/json" },
      body: JSON.stringify({ tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity" } }),
      signal: requestSignal(signal),
    });
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_MS));
        continue;
      }
      return undefined;
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.done === true) return extractProjectId(data.response as Record<string, unknown> | undefined);
    await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_MS));
  }
  return undefined;
}

export async function discoverAntigravityProject(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  return (await loadCodeAssistProject(accessToken, signal)) ?? (await onboardProject(accessToken, signal));
}

async function exchangeAntigravityCode(code: string, verifier: string): Promise<AntigravityToken> {
  const creds = credentialsFromPayload(await postToken({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code: code.split("#")[0]!,
    redirect_uri: CALLBACK_REDIRECT,
    code_verifier: verifier,
  }));
  const projectId = await discoverAntigravityProject(creds.accessToken);
  if (!projectId) {
    throw new Error("Antigravity login could not discover a Cloud Code Assist project for this account.");
  }
  return { ...creds, projectId };
}

async function refreshAntigravityToken(refreshToken: string, signal?: AbortSignal): Promise<AntigravityToken> {
  const creds = credentialsFromPayload(await postToken({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  }, signal), refreshToken);
  const projectId = await discoverAntigravityProject(creds.accessToken, signal).catch(() => undefined);
  return projectId ? { ...creds, projectId } : creds;
}

function waitForAntigravityCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const page = (msg: string, ok: boolean): string => `<!DOCTYPE html><meta charset="utf8"><body style="font-family:-apple-system,sans-serif;background:#121212;color:#e2e2e2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:${ok ? "#6ad08a" : "#ef7770"}">${msg}</h2><p style="color:#888">devil-codex로 돌아가세요.</p></div></body>`;
      if (error || state !== expectedState || !code) {
        res.writeHead(error ? 200 : 400, { "content-type": "text/html" });
        res.end(page(error ? `로그인 실패: ${error}` : "잘못된 콜백", false));
        server.close(); reject(new Error(error || "Antigravity OAuth 콜백 오류"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("Antigravity 연결됨! 탭을 닫아도 됩니다.", true));
      server.close(); resolve(code);
    });
    server.on("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1");
    setTimeout(() => { server.close(); reject(new Error("Antigravity 로그인 시간 초과")); }, 5 * 60 * 1000);
  });
}

async function readAntigravityToken(): Promise<AntigravityToken | null> {
  const stored = await readStoredToken();
  if (!stored?.refreshToken) return stored;
  let next = stored;
  if (!stored.accessToken || !stored.expiresAt || stored.expiresAt <= Date.now() + 60_000) {
    next = { ...stored, ...(await refreshAntigravityToken(stored.refreshToken).catch(() => stored)) };
  }
  if (next.accessToken && !next.projectId) {
    const projectId = await discoverAntigravityProject(next.accessToken).catch(() => undefined);
    if (projectId) next = { ...next, projectId };
  }
  if (next !== stored) await writeToken(next).catch(() => undefined);
  return next;
}

export async function antigravityStatus(): Promise<boolean> {
  if (antigravityLoginInProgress) return false;
  const token = await readAntigravityToken();
  return Boolean(token?.accessToken && token.refreshToken && token.projectId);
}

export async function antigravityLogin(onDone: () => void): Promise<null> {
  antigravityLoginInProgress = true;
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_REDIRECT,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  const wait = waitForAntigravityCallback(state);
  void shell.openExternal(`${AUTH_ENDPOINT}?${params.toString()}`);
  void (async () => {
    try {
      await writeToken(await exchangeAntigravityCode(await wait, verifier));
    } catch {
      // The UI observes status staying false.
    } finally {
      antigravityLoginInProgress = false;
      onDone();
    }
  })();
  return null;
}

export async function antigravityLogout(): Promise<void> {
  if (existsSync(tokenPath())) await unlink(tokenPath());
  modelCache.clear();
  quotaCache.clear();
}

export async function antigravityAuth(): Promise<{ accessToken: string; projectId: string } | null> {
  const token = await readAntigravityToken();
  if (!token?.accessToken || !token.projectId) return null;
  return { accessToken: token.accessToken, projectId: token.projectId };
}

function humanLabel(value: string): string {
  return value.replace(/^models\//, "").replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fallbackModels(): ProviderModel[] {
  return ANTIGRAVITY_MODELS.map((id) => ({ id, label: humanLabel(id) }));
}

async function fetchAvailableModels(accessToken: string, projectId: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${PROD_API}/${API_VERSION}:fetchAvailableModels`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "User-Agent": antigravityUserAgent(),
        "x-client-name": "antigravity",
        "x-client-version": "1.0.13",
        "x-request-source": "local",
      },
      body: JSON.stringify({ project: projectId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function modelsFromAvailable(data: Record<string, unknown> | null): ProviderModel[] {
  const rawModels = data?.models;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) return [];
  return Object.entries(rawModels as Record<string, { isInternal?: boolean; displayName?: string }>)
    .filter(([id, info]) => Boolean(id) && !info?.isInternal)
    .map(([id, info]) => ({ id, label: info.displayName || humanLabel(id) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export async function antigravityModels(): Promise<ProviderModel[]> {
  const auth = await antigravityAuth();
  if (!auth) return [];
  const cacheKey = `${auth.accessToken.slice(0, 16)}:${auth.projectId}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.fetchedAt > Date.now() - MODEL_CACHE_TTL_MS) return cached.models;
  const models = modelsFromAvailable(await fetchAvailableModels(auth.accessToken, auth.projectId));
  const next = models.length ? models : fallbackModels();
  modelCache.set(cacheKey, { models: next, fetchedAt: Date.now() });
  return next;
}

function parseResetTime(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function quotaWindowsFromAvailable(data: Record<string, unknown> | null): ProviderUsageWindow[] {
  const rawModels = data?.models;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) return [];
  return Object.entries(rawModels as Record<string, Record<string, unknown>>).flatMap(([name, info]) => {
    if (!name || info.isInternal) return [];
    const quotaInfo = info.quotaInfo as Record<string, unknown> | undefined;
    if (!quotaInfo) return [];
    const remaining = typeof quotaInfo.remainingFraction === "number" ? quotaInfo.remainingFraction : Number(quotaInfo.remainingFraction ?? 0);
    const remainingPercent = Math.max(0, Math.min(100, remaining * 100));
    return [{
      label: typeof info.displayName === "string" ? info.displayName : humanLabel(name),
      usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
      remainingPercent: Math.round(remainingPercent * 10) / 10,
      resetsAt: parseResetTime(quotaInfo.resetTime),
    }];
  }).sort((left, right) => left.label.localeCompare(right.label));
}

export async function antigravityUsage(connected: boolean): Promise<ProviderUsageEntry> {
  if (!connected) {
    return { provider: "antigravity", label: "Antigravity", connected, windows: [], unavailable: "Antigravity OAuth 토큰을 찾지 못했습니다.", updatedAt: Date.now() };
  }
  const auth = await antigravityAuth();
  if (!auth) {
    return { provider: "antigravity", label: "Antigravity", connected: false, windows: [], unavailable: "Antigravity OAuth 토큰을 찾지 못했습니다.", updatedAt: Date.now() };
  }
  const cacheKey = `${auth.accessToken.slice(0, 16)}:${auth.projectId}`;
  const cached = quotaCache.get(cacheKey);
  if (cached && cached.fetchedAt > Date.now() - QUOTA_CACHE_TTL_MS) {
    return { provider: "antigravity", label: "Antigravity", connected, windows: cached.windows, updatedAt: Date.now() };
  }
  try {
    const windows = quotaWindowsFromAvailable(await fetchAvailableModels(auth.accessToken, auth.projectId));
    quotaCache.set(cacheKey, { windows, fetchedAt: Date.now() });
    return { provider: "antigravity", label: "Antigravity", connected, windows, unavailable: windows.length ? undefined : "Antigravity 사용량 데이터가 비어 있습니다.", updatedAt: Date.now() };
  } catch (error) {
    return { provider: "antigravity", label: "Antigravity", connected, windows: [], error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
  }
}

export function antigravityUserAgent(version = "1.0.13"): string {
  return `antigravity/cli/${version} (aidev_client; os_type=darwin; arch=arm64)`;
}
