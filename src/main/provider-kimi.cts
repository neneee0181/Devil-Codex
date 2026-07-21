// Adapted from lidge-jun/opencodex Kimi OAuth support (MIT).
import { app, safeStorage, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import type { DeviceCodeInfo, ProviderAccount, ProviderId, ProviderModel } from "./contracts.cjs";
import {
  createAccountId,
  defaultAccountId,
  deleteAllStoredAccounts,
  deleteStoredAccount,
  getStoredAccount,
  listStoredAccounts,
  readJsonSecret,
  upsertStoredAccount,
  writeJsonSecret,
} from "./provider-accounts.cjs";

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";

const KIMI_PROVIDER = "kimi" as ProviderId;
const KIMI_CLI_VERSION = "0.14.0";
const DEVICE_ID_FILENAME = "kimi-device-id";
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_DEVICE_FLOW_TTL_SEC = 15 * 60;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

type KimiTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
  interval?: unknown;
};

type KimiStoredToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
  userId?: string;
};

export interface KimiDeviceIdentity {
  platform: string;
  release: string;
  arch: string;
  hostname: string;
  osVersion: string;
  deviceId: string;
}

export interface ParsedKimiDeviceAuthorization extends DeviceCodeInfo {
  deviceCode: string;
  interval: number;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeKimiJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Stable multiauth identity. user_id wins across both tokens before the weaker sub fallback. */
export function identityFromKimiTokens(accessToken: string, refreshToken?: string): { accountId?: string; email?: string } {
  const access = decodeKimiJwtPayload(accessToken);
  const refresh = refreshToken ? decodeKimiJwtPayload(refreshToken) : undefined;
  const accountId = nonEmptyString(access?.user_id)
    ?? nonEmptyString(refresh?.user_id)
    ?? nonEmptyString(access?.sub)
    ?? nonEmptyString(refresh?.sub);
  const email = (nonEmptyString(access?.email) ?? nonEmptyString(refresh?.email))?.toLowerCase();
  return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) };
}

export function parseKimiTokenPayload(payload: unknown, refreshFallback?: string, now = Date.now()): KimiStoredToken {
  const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as KimiTokenResponse : {};
  const accessToken = nonEmptyString(data.access_token);
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : undefined;
  if (!accessToken || expiresIn === undefined) throw new Error("Kimi token response missing required fields");
  const refreshToken = nonEmptyString(data.refresh_token) ?? nonEmptyString(refreshFallback);
  if (!refreshToken) throw new Error("Kimi token response missing refresh token");
  const identity = identityFromKimiTokens(accessToken, refreshToken);
  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000 - OAUTH_EXPIRY_SKEW_MS,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.accountId ? { userId: identity.accountId } : {}),
  };
}

export function parseKimiDeviceAuthorization(payload: unknown): ParsedKimiDeviceAuthorization {
  const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const userCode = nonEmptyString(data.user_code);
  const deviceCode = nonEmptyString(data.device_code);
  const baseVerificationUri = nonEmptyString(data.verification_uri);
  if (!userCode || !deviceCode || !baseVerificationUri) {
    throw new Error("Kimi device authorization response missing required fields");
  }
  const verificationUri = nonEmptyString(data.verification_uri_complete) ?? baseVerificationUri;
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
    ? data.expires_in
    : DEFAULT_DEVICE_FLOW_TTL_SEC;
  const interval = typeof data.interval === "number" && Number.isFinite(data.interval) && data.interval > 0
    ? data.interval
    : DEFAULT_POLL_INTERVAL_SEC;
  return { userCode, deviceCode, verificationUri, expiresIn, interval };
}

export function kimiCommonHeaders(identity: KimiDeviceIdentity): Record<string, string> {
  const platform = identity.platform === "darwin"
    ? "macOS"
    : identity.platform === "win32"
      ? "Windows"
      : identity.platform === "linux"
        ? "Linux"
        : identity.platform;
  return {
    "User-Agent": `KimiCLI/${KIMI_CLI_VERSION}`,
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": KIMI_CLI_VERSION,
    "X-Msh-Device-Name": identity.hostname,
    "X-Msh-Device-Model": [platform, identity.release, identity.arch].filter(Boolean).join(" ").trim(),
    "X-Msh-Os-Version": identity.osVersion,
    "X-Msh-Device-Id": identity.deviceId,
  };
}

export function kimiStorageBackendAllowsWrite(platform: string, backend: string): boolean {
  return platform !== "linux" || backend !== "basic_text";
}

export function parseKimiModelsPayload(payload: unknown): ProviderModel[] {
  const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const item = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
    const id = nonEmptyString(item.id)?.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const label = nonEmptyString(item.display_name)?.trim() || nonEmptyString(item.name)?.trim() || id;
    return [{ id, label }];
  });
}

function oauthHost(): string {
  return process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || KIMI_DEFAULT_OAUTH_HOST;
}

let deviceIdCache: string | undefined;
function deviceId(): string {
  if (deviceIdCache) return deviceIdCache;
  const path = join(app.getPath("userData"), "providers", DEVICE_ID_FILENAME);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return deviceIdCache = existing;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const created = randomUUID().replace(/-/g, "");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${created}\n`, { mode: 0o600 });
  deviceIdCache = created;
  return created;
}

function commonHeaders(): Record<string, string> {
  return kimiCommonHeaders({
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    osVersion: os.version(),
    deviceId: deviceId(),
  });
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Kimi login cancelled")); return; }
    const aborted = () => {
      clearTimeout(timer);
      reject(new Error("Kimi login cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function requestDeviceAuthorization(signal?: AbortSignal): Promise<ParsedKimiDeviceAuthorization> {
  const response = await fetch(`${oauthHost()}/api/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...commonHeaders() },
    body: new URLSearchParams({ client_id: KIMI_CLIENT_ID }),
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Kimi device authorization failed: ${response.status} ${await response.text()}`);
  return parseKimiDeviceAuthorization(await response.json());
}

async function pollForToken(device: ParsedKimiDeviceAuthorization, signal?: AbortSignal): Promise<KimiStoredToken> {
  const deadline = Date.now() + device.expiresIn * 1000;
  let waitMs = Math.max(1, device.interval) * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Kimi login cancelled");
    const response = await fetch(`${oauthHost()}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...commonHeaders() },
      body: new URLSearchParams({
        client_id: KIMI_CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: requestSignal(signal),
    });
    const payload = await response.json() as KimiTokenResponse;
    if (response.ok && nonEmptyString(payload.access_token)) return parseKimiTokenPayload(payload);
    const error = nonEmptyString(payload.error);
    if (error === "authorization_pending") { await sleep(waitMs, signal); continue; }
    if (error === "slow_down") {
      waitMs += 5_000;
      const retryAfter = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
      if (retryAfter && retryAfter > waitMs) waitMs = retryAfter;
      await sleep(waitMs, signal);
      continue;
    }
    if (error === "expired_token") throw new Error("Kimi device authorization expired");
    if (error === "access_denied") throw new Error("Kimi device authorization denied");
    const description = nonEmptyString(payload.error_description);
    throw new Error(`Kimi device flow failed: ${error ?? response.status}${description ? `: ${description}` : ""}`);
  }
  throw new Error("Kimi device flow timed out");
}

async function refreshKimiToken(refreshToken: string, signal?: AbortSignal): Promise<KimiStoredToken> {
  const response = await fetch(`${oauthHost()}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...commonHeaders() },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: KIMI_CLIENT_ID }),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as KimiTokenResponse | undefined;
    throw new Error(`Kimi token refresh failed: ${response.status}${nonEmptyString(payload?.error_description) ? `: ${payload!.error_description}` : ""}`);
  }
  return parseKimiTokenPayload(await response.json(), refreshToken);
}

async function selectedAccountId(accountId?: string): Promise<string> {
  if (accountId) return accountId;
  return (await getStoredAccount(KIMI_PROVIDER))?.id ?? defaultAccountId();
}

function tokenIdentity(token: KimiStoredToken): Pick<ProviderAccount, "label" | "email" | "userId"> {
  return { label: token.email || token.userId || "Kimi 계정", email: token.email, userId: token.userId };
}

export function matchingKimiAccountId(
  accounts: ProviderAccount[],
  identity: Pick<ProviderAccount, "email" | "userId">,
): string | undefined {
  if (identity.userId) {
    const strongMatch = accounts.find((account) => account.userId === identity.userId);
    if (strongMatch) return strongMatch.id;
  }
  if (identity.email) {
    const emailMatchWithoutStrongIdentity = accounts.find((account) =>
      !account.userId && account.email === identity.email);
    if (emailMatchWithoutStrongIdentity) return emailMatchWithoutStrongIdentity.id;
  }
  if (!identity.userId && !identity.email) return accounts[0]?.id;
  const only = accounts.length === 1 ? accounts[0] : undefined;
  return only && !only.userId && !only.email ? only.id : undefined;
}

async function writeToken(token: KimiStoredToken, accountId?: string): Promise<string> {
  if (!kimiStorageBackendAllowsWrite(process.platform, safeStorage.getSelectedStorageBackend())) {
    throw new Error("Linux 보안 키링이 없어 Kimi 로그인 정보를 저장할 수 없습니다. safeStorage basic_text 대신 libsecret 또는 KWallet을 설정하세요.");
  }
  const identity = tokenIdentity(token);
  const accounts = await listStoredAccounts(KIMI_PROVIDER);
  const id = accountId
    ?? matchingKimiAccountId(accounts, identity)
    ?? await createAccountId(KIMI_PROVIDER, identity.email || identity.userId || "Kimi");
  await writeJsonSecret(KIMI_PROVIDER, id, "oauth", token);
  await upsertStoredAccount({
    id,
    provider: KIMI_PROVIDER,
    ...identity,
    credentialSource: "keychain",
    credentialKind: "oauth",
  });
  return id;
}

const refreshes = new Map<string, Promise<KimiStoredToken | null>>();
let credentialGeneration = 0;
let pendingLogout: Promise<void> | undefined;

async function validToken(accountId: string): Promise<KimiStoredToken | null> {
  const logout = pendingLogout;
  if (logout) await logout;
  const generation = credentialGeneration;
  const stored = await readJsonSecret<KimiStoredToken>(KIMI_PROVIDER, accountId, "oauth");
  if (generation !== credentialGeneration || pendingLogout) return null;
  if (!stored?.accessToken || !stored.refreshToken) return null;
  if (stored.expiresAt > Date.now() + 60_000) return stored;
  const active = refreshes.get(accountId);
  if (active) return active;
  const refresh = (async () => {
    try {
      const fresh = await refreshKimiToken(stored.refreshToken);
      if (generation !== credentialGeneration || pendingLogout) return null;
      const merged = { ...stored, ...fresh, email: fresh.email ?? stored.email, userId: fresh.userId ?? stored.userId };
      await writeToken(merged, accountId);
      return generation === credentialGeneration && !pendingLogout ? merged : null;
    } catch {
      return null;
    } finally {
      refreshes.delete(accountId);
    }
  })();
  refreshes.set(accountId, refresh);
  return refresh;
}

let loginSession = 0;
let activeLogin: AbortController | undefined;
let activeLoginTask: Promise<void> | undefined;

export async function kimiLogin(onDone: () => void): Promise<DeviceCodeInfo> {
  const requestedGeneration = credentialGeneration;
  const logout = pendingLogout;
  if (logout) await logout;
  const previousLogin = activeLoginTask;
  activeLogin?.abort();
  if (previousLogin) await previousLogin.catch(() => undefined);
  const currentLogout = pendingLogout;
  if (currentLogout) await currentLogout;
  if (requestedGeneration !== credentialGeneration) throw new Error("Kimi login cancelled");
  const session = ++loginSession;
  const generation = credentialGeneration;
  const controller = new AbortController();
  activeLogin = controller;
  let device: ParsedKimiDeviceAuthorization;
  try {
    device = await requestDeviceAuthorization(controller.signal);
  } catch (error) {
    if (activeLogin === controller) activeLogin = undefined;
    throw error;
  }
  if (controller.signal.aborted || loginSession !== session || credentialGeneration !== generation) {
    if (activeLogin === controller) activeLogin = undefined;
    throw new Error("Kimi login cancelled");
  }
  void shell.openExternal(device.verificationUri);
  const task = (async () => {
    try {
      const token = await pollForToken(device, controller.signal);
      if (controller.signal.aborted || loginSession !== session || credentialGeneration !== generation) return;
      await writeToken(token);
    } catch (error) {
      if (!controller.signal.aborted) console.warn("[devil-codex kimi] login failed:", error instanceof Error ? error.message : String(error));
    } finally {
      if (activeLogin === controller) {
        activeLogin = undefined;
        activeLoginTask = undefined;
      }
      if (loginSession === session) {
        try { onDone(); } catch { /* renderer notification must not reject the login worker */ }
      }
    }
  })();
  activeLoginTask = task;
  void task;
  return { userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn };
}

export function kimiLogout(accountId?: string): Promise<void> {
  credentialGeneration += 1;
  loginSession += 1;
  const previousLogout = pendingLogout;
  const loginTask = activeLoginTask;
  activeLogin?.abort();
  activeLogin = undefined;
  const operation = (async () => {
    if (previousLogout) await previousLogout;
    if (loginTask) await loginTask.catch(() => undefined);
    if (activeLoginTask === loginTask) activeLoginTask = undefined;
    await Promise.allSettled([...refreshes.values()]);
    if (accountId) await deleteStoredAccount(KIMI_PROVIDER, accountId);
    else await deleteAllStoredAccounts(KIMI_PROVIDER);
  })();
  let tracked: Promise<void>;
  tracked = operation.finally(() => {
    if (pendingLogout === tracked) pendingLogout = undefined;
  });
  pendingLogout = tracked;
  return tracked;
}

export async function kimiStatus(): Promise<boolean> {
  return (await listStoredAccounts(KIMI_PROVIDER)).length > 0;
}

export async function kimiAuth(accountId?: string): Promise<{
  accessToken: string;
  accountId: string;
  accountLabel?: string;
  email?: string;
  userId?: string;
} | null> {
  const id = await selectedAccountId(accountId);
  const token = await validToken(id);
  if (!token) return null;
  const account = await getStoredAccount(KIMI_PROVIDER, id);
  return {
    accessToken: token.accessToken,
    accountId: id,
    accountLabel: account?.label,
    email: account?.email ?? token.email,
    userId: account?.userId ?? token.userId,
  };
}

export async function kimiModels(accountId?: string): Promise<ProviderModel[]> {
  const auth = await kimiAuth(accountId);
  if (!auth) return [];
  try {
    const response = await fetch(`${KIMI_CODE_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    return parseKimiModelsPayload(await response.json());
  } catch {
    return [];
  }
}
