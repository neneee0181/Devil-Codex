import { shell } from "electron";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import type { ProviderAccount } from "./contracts.cjs";
import { createAccountId, defaultAccountId, deleteAllStoredAccounts, deleteStoredAccount, getStoredAccount, legacySecretPath, listStoredAccounts, migrateLegacySecret, readJsonSecret, upsertStoredAccount, writeJsonSecret } from "./provider-accounts.cjs";

// In-app OAuth for providers that have their own login (no external CLI):
//   GitHub Copilot — GitHub device flow → copilot token
//   Claude Code     — Anthropic OAuth (PKCE) + localhost callback → API key
// Tokens are encrypted at rest with the OS keychain (safeStorage).

export type OAuthProvider = "copilot" | "claude-code";

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GH_API = "https://api.github.com";
const COPILOT_API = "https://api.githubcopilot.com";
const COPILOT_EDITOR_VERSION = "vscode/1.124.0";
const COPILOT_PLUGIN_VERSION = "copilot-chat/0.43.0";
const COPILOT_USER_AGENT = "GitHubCopilotChat/0.43.0";

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTH_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CREATE_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";
const CLAUDE_CALLBACK_PORT = 49155;
const CLAUDE_REDIRECT = `http://localhost:${CLAUDE_CALLBACK_PORT}/callback`;
const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference";
const ANTHROPIC_API = "https://api.anthropic.com/v1";
const CLAUDE_CODE_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";

type CopilotToken = { githubToken: string };
type CopilotSession = { token: string; expiresAt: number; apiUrl: string };
type ClaudeToken = { apiKey?: string; accessToken: string; refreshToken: string; expiresAt?: number };
const COPILOT_FALLBACK_MODELS = [
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { id: "gpt-5-mini", label: "GPT-5 Mini" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4.8", label: "Claude Opus 4.8" },
  { id: "claude-opus-4.7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "claude-opus-4.5", label: "Claude Opus 4.5" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "mai-code-1-flash", label: "MAI-Code-1-Flash" },
  { id: "raptor-mini", label: "Raptor Mini" },
];

// After an explicit Claude logout, suppress the auto-detect that would otherwise
// re-import Claude Code's own credentials and silently log the user back in.
const claudeOptOutPath = (): string => legacySecretPath("claude-code", "oauth").replace(/\.oauth$/, ".logout");
function claudeOptedOut(): boolean { return existsSync(claudeOptOutPath()); }
let claudeLoginInProgress = false;

async function migrateOAuth(provider: OAuthProvider): Promise<void> {
  await migrateLegacySecret({ provider, kind: "oauth", label: provider === "copilot" ? "GitHub Copilot 기본" : "Claude Code 기본", credentialKind: "oauth" });
}

async function selectedAccountId(provider: OAuthProvider, accountId?: string): Promise<string> {
  await migrateOAuth(provider);
  if (accountId) return accountId;
  return (await getStoredAccount(provider))?.id ?? defaultAccountId();
}

async function writeToken(provider: OAuthProvider, value: unknown, account: Partial<ProviderAccount> = {}): Promise<string> {
  await migrateOAuth(provider);
  const id = account.id ?? await createAccountId(provider, account.email || account.userId || account.label || provider);
  const label = account.email || account.label || (provider === "copilot" ? "GitHub Copilot 계정" : "Claude Code 계정");
  await writeJsonSecret(provider, id, "oauth", value);
  await upsertStoredAccount({ id, provider, label, email: account.email, userId: account.userId, credentialSource: "keychain", credentialKind: "oauth" });
  return id;
}

async function readToken<T>(provider: OAuthProvider, accountId?: string): Promise<T | null> {
  return readJsonSecret<T>(provider, await selectedAccountId(provider, accountId), "oauth");
}

async function deleteToken(provider: OAuthProvider, accountId?: string): Promise<void> {
  await migrateOAuth(provider);
  if (accountId) await deleteStoredAccount(provider, accountId);
  else await deleteAllStoredAccounts(provider);
}

// ---------- GitHub Copilot device flow ----------
export interface DeviceCodeInfo { userCode: string; verificationUri: string; expiresIn: number; }

const copilotTokenCache = new Map<string, CopilotSession>();

function copilotClientHeaders(): Record<string, string> {
  return {
    "User-Agent": COPILOT_USER_AGENT,
    "Editor-Version": COPILOT_EDITOR_VERSION,
    "Editor-Plugin-Version": COPILOT_PLUGIN_VERSION,
    "Copilot-Integration-Id": "vscode-chat",
    "Openai-Intent": "conversation-panel",
    "X-Initiator": "user",
  };
}

function normalizeCopilotApiUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return COPILOT_API;
  const candidate = value.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  try { return new URL(withScheme).origin; }
  catch { return COPILOT_API; }
}

function copilotModelLabel(id: string, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim();
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\bGpt\b/g, "GPT").replace(/\bMai\b/g, "MAI");
}

function mergeCopilotModels(...lists: Array<Array<{ id: string; label: string }>>): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  return lists.flatMap((list) => list.flatMap((model) => {
    const id = model.id.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: model.label || copilotModelLabel(id) }];
  }));
}

async function startCopilotDevice(): Promise<{ deviceCode: string; interval: number } & DeviceCodeInfo> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "User-Agent": COPILOT_USER_AGENT },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub device auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval?: number };
  return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri, expiresIn: data.expires_in, interval: data.interval ?? 5 };
}

async function pollCopilotDevice(deviceCode: string, intervalSec: number, expiresIn: number): Promise<string> {
  const startedAt = Date.now();
  let intervalMs = Math.max(1, intervalSec) * 1000;
  while (Date.now() - startedAt < expiresIn * 1000) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "User-Agent": COPILOT_USER_AGENT },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub token polling failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as { access_token?: string; error?: string; error_description?: string };
    if (data.access_token) return data.access_token;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { intervalMs += 5_000; continue; }
    if (data.error === "access_denied") throw new Error("GitHub Copilot 로그인이 거부되었습니다.");
    if (data.error === "expired_token") throw new Error("GitHub Copilot 로그인 코드가 만료되었습니다.");
    throw new Error(data.error_description || data.error || "GitHub Copilot 로그인 실패");
  }
  throw new Error("GitHub Copilot 로그인 시간이 초과되었습니다.");
}

async function copilotIdentity(githubToken: string): Promise<Pick<ProviderAccount, "label" | "email" | "userId">> {
  try {
    const res = await fetch(`${GH_API}/user`, {
      headers: { Authorization: `token ${githubToken}`, "User-Agent": COPILOT_USER_AGENT, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { label: "GitHub Copilot 계정" };
    const data = await res.json() as { login?: string; email?: string; id?: number | string };
    const email = typeof data.email === "string" && data.email ? data.email.toLowerCase() : undefined;
    const userId = data.id != null ? String(data.id) : undefined;
    const label = email || data.login || userId || "GitHub Copilot 계정";
    return { label, email, userId };
  } catch {
    return { label: "GitHub Copilot 계정" };
  }
}

async function getCopilotSession(githubToken: string): Promise<CopilotSession> {
  const cached = copilotTokenCache.get(githubToken);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached;
  // Editor headers must be sent at token exchange too — the returned Copilot
  // token's model access (gpt-5.x, claude) is scoped to the editor identity.
  // Without them the token is limited and /chat/completions rejects newer models.
  const res = await fetch(`${GH_API}/copilot_internal/v2/token`, {
    headers: {
      Authorization: `token ${githubToken}`,
      ...copilotClientHeaders(),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Copilot token exchange failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { token: string; expires_at: number; endpoints?: { api?: string } };
  const session = { token: data.token, expiresAt: data.expires_at * 1000, apiUrl: normalizeCopilotApiUrl(data.endpoints?.api) };
  copilotTokenCache.set(githubToken, session);
  return session;
}

async function getCopilotToken(githubToken: string): Promise<string> {
  return (await getCopilotSession(githubToken)).token;
}

// ---------- Claude Code OAuth (PKCE) ----------
function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>; }
  catch { return undefined; }
}

function claudeIdentity(token: ClaudeToken): Pick<ProviderAccount, "label" | "email" | "userId"> {
  const payload = decodeJwtPayload(token.accessToken);
  const email = typeof payload?.email === "string" && payload.email ? payload.email.toLowerCase() : undefined;
  const userId = typeof payload?.sub === "string" && payload.sub ? payload.sub : undefined;
  return { label: email || userId || "Claude Code 계정", email, userId };
}

function detectClaudeCodeToken(): ClaudeToken | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5_000 }).trim();
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken || !oauth.refreshToken) return null;
    return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt ?? 0 };
  } catch {
    return null;
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function waitForClaudeCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CLAUDE_CALLBACK_PORT}`);
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const page = (msg: string, ok: boolean): string => `<!DOCTYPE html><meta charset="utf8"><body style="font-family:-apple-system,sans-serif;background:#121212;color:#e2e2e2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:${ok ? "#6ad08a" : "#ef7770"}">${msg}</h2><p style="color:#888">devil-codex로 돌아가세요.</p></div></body>`;
      if (error || state !== expectedState || !code) {
        res.writeHead(error ? 200 : 400, { "content-type": "text/html" });
        res.end(page(error ? `로그인 실패: ${error}` : "잘못된 콜백", false));
        server.close(); reject(new Error(error || "Claude OAuth 콜백 오류"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("Claude Code 연결됨! 탭을 닫아도 됩니다.", true));
      server.close(); resolve(code);
    });
    server.on("error", reject);
    server.listen(CLAUDE_CALLBACK_PORT, "127.0.0.1");
    setTimeout(() => { server.close(); reject(new Error("Claude 로그인 시간 초과")); }, 5 * 60 * 1000);
  });
}

async function exchangeClaudeCode(code: string, verifier: string, state: string): Promise<ClaudeToken> {
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code.split("#")[0]!, redirect_uri: CLAUDE_REDIRECT, client_id: CLAUDE_CLIENT_ID, code_verifier: verifier, state }).toString(),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Claude token exchange failed (${res.status})`);
  const data = await res.json() as { access_token: string; refresh_token: string; expires_in?: number };
  const token: ClaudeToken = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
  try {
    const keyRes = await fetch(CLAUDE_CREATE_KEY_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${data.access_token}`, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ name: "devil-codex" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (keyRes.ok) { const kd = await keyRes.json() as { raw_key?: string; key?: string }; token.apiKey = kd.raw_key ?? kd.key; }
  } catch { /* fall back to OAuth access token */ }
  return token;
}

async function refreshClaudeToken(refreshToken: string): Promise<ClaudeToken> {
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Claude token refresh failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
}

async function readClaudeToken(accountId?: string): Promise<ClaudeToken | null> {
  let stored = await readToken<ClaudeToken>("claude-code", accountId);
  if ((!stored?.accessToken || !stored.refreshToken) && !claudeOptedOut() && !claudeLoginInProgress) {
    stored = detectClaudeCodeToken();
    if (stored && !accountId) await writeToken("claude-code", stored, { id: defaultAccountId(), ...claudeIdentity(stored) });
  }
  if (!stored?.accessToken || !stored.refreshToken) return stored;
  if (stored.expiresAt && stored.expiresAt > Date.now() + 60_000) return stored;
  try {
    const fresh = await refreshClaudeToken(stored.refreshToken);
    await writeToken("claude-code", { ...stored, ...fresh }, { id: accountId ?? (await selectedAccountId("claude-code")), ...claudeIdentity({ ...stored, ...fresh }) });
    return { ...stored, ...fresh };
  } catch {
    return stored;
  }
}

function copilotHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...copilotClientHeaders() };
}

function copilotSupportsResponsesApi(model: string): boolean {
  const id = model.toLowerCase();
  return /^gpt-5(?:[.\-_]|$)/.test(id) || /^gpt-4\.1(?:[.\-_]|$)/.test(id) || /^o\d/.test(id) || /^codex(?:[.\-_]|$)/.test(id);
}

// ---------- Raw credentials for the local Codex Responses proxy ----------
export async function claudeAuth(accountId?: string): Promise<{ apiKey?: string; accessToken?: string } | null> {
  const stored = await readClaudeToken(accountId);
  if (!stored) return null;
  // Prefer the official Claude Code OAuth bearer token. A created API key can
  // bill/authorize differently from the user's Claude Code subscription.
  return stored.accessToken ? { accessToken: stored.accessToken } : { apiKey: stored.apiKey };
}

export async function claudeAccessTokenForUsage(accountId?: string): Promise<string | null> {
  const stored = await readClaudeToken(accountId);
  return stored?.accessToken ?? null;
}

export const copilotChatHeaders = copilotHeaders;
export async function copilotAuth(accountId?: string): Promise<{ bearer: string; apiUrl: string } | null> {
  const stored = await readToken<CopilotToken>("copilot", accountId);
  if (!stored?.githubToken) return null;
  const session = await getCopilotSession(stored.githubToken);
  return { bearer: session.token, apiUrl: session.apiUrl };
}

export async function copilotBearer(accountId?: string): Promise<string | null> {
  const stored = await readToken<CopilotToken>("copilot", accountId);
  if (!stored?.githubToken) return null;
  return getCopilotToken(stored.githubToken);
}

// ---------- Chat credentials/requests for the runtime ----------
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

export async function claudeChat(model: string, text: string, signal: AbortSignal, accountId?: string): Promise<Response> {
  const stored = await readClaudeToken(accountId);
  if (!stored) throw new Error("Claude Code 로그인이 필요합니다.");
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  const body: Record<string, unknown> = { model, max_tokens: 8192, stream: true, messages: [{ role: "user", content: text }] };
  if (stored.apiKey) {
    // API key fallback. Normal Claude Code OAuth should use the subscription
    // bearer token below instead.
    headers["x-api-key"] = stored.apiKey;
  }
  if (stored.accessToken) {
    // OAuth subscription token: Bearer + Claude Code/oauth betas + Claude Code identity prompt.
    delete headers["x-api-key"];
    headers.authorization = `Bearer ${stored.accessToken}`;
    headers["anthropic-beta"] = CLAUDE_CODE_OAUTH_BETA;
    body.system = CLAUDE_CODE_SYSTEM;
  }
  return fetch(`${ANTHROPIC_API}/messages`, { method: "POST", signal, headers, body: JSON.stringify(body) });
}

export async function copilotChat(model: string, text: string, signal: AbortSignal, accountId?: string): Promise<Response> {
  const stored = await readToken<CopilotToken>("copilot", accountId);
  if (!stored?.githubToken) throw new Error("GitHub Copilot 로그인이 필요합니다.");
  const session = await getCopilotSession(stored.githubToken);
  if (copilotSupportsResponsesApi(model)) {
    return fetch(`${session.apiUrl}/responses`, {
      method: "POST",
      signal,
      headers: copilotHeaders(session.token),
      body: JSON.stringify({
        model,
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
      }),
    });
  }
  return fetch(`${session.apiUrl}/chat/completions`, { method: "POST", signal, headers: copilotHeaders(session.token), body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: text }] }) });
}

// ---------- Public API ----------
export async function oauthStatus(): Promise<{ copilot: boolean; claude: boolean }> {
  await Promise.all([migrateOAuth("copilot"), migrateOAuth("claude-code")]);
  const [copilotAccounts, claudeAccounts, claude] = await Promise.all([listStoredAccounts("copilot"), listStoredAccounts("claude-code"), readClaudeToken()]);
  return { copilot: copilotAccounts.length > 0, claude: claudeAccounts.length > 0 || Boolean(claude?.apiKey || (claude?.accessToken && claude.refreshToken)) };
}

// Kicks off login; for copilot returns the device code to show the user while a
// background poll stores the token, then calls onDone. Claude opens a browser
// and a localhost callback completes it.
export async function oauthLogin(provider: OAuthProvider, onDone: () => void): Promise<DeviceCodeInfo | null> {
  if (provider === "copilot") {
    const device = await startCopilotDevice();
    void shell.openExternal(device.verificationUri);
    void (async () => {
      try {
        const githubToken = await pollCopilotDevice(device.deviceCode, device.interval, device.expiresIn);
        await writeToken("copilot", { githubToken } satisfies CopilotToken, await copilotIdentity(githubToken));
      } catch { /* surfaced via status staying false */ }
      finally { onDone(); }
    })();
    return { userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn };
  }
  claudeLoginInProgress = true;
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  const params = new URLSearchParams({ response_type: "code", client_id: CLAUDE_CLIENT_ID, redirect_uri: CLAUDE_REDIRECT, scope: CLAUDE_SCOPES, code_challenge: challenge, code_challenge_method: "S256", state });
  const wait = waitForClaudeCallback(state);
  void shell.openExternal(`${CLAUDE_AUTH_URL}?${params}`);
  void (async () => {
    try {
      const code = await wait;
      if (existsSync(claudeOptOutPath())) await unlink(claudeOptOutPath()).catch(() => undefined);
      const token = await exchangeClaudeCode(code, verifier, state);
      await writeToken("claude-code", token, claudeIdentity(token));
    } catch { /* status stays false */ }
    finally { claudeLoginInProgress = false; onDone(); }
  })();
  return null;
}

export async function oauthLogout(provider: OAuthProvider, accountId?: string): Promise<void> {
  await deleteToken(provider, accountId);
  // Mark Claude as opted out so auto-detect won't re-import its credentials.
  if (provider === "claude-code") await writeFile(claudeOptOutPath(), "1", { mode: 0o600 }).catch(() => undefined);
}

export async function oauthModels(provider: OAuthProvider, accountId?: string): Promise<Array<{ id: string; label: string }>> {
  if (provider === "copilot") {
    const stored = await readToken<CopilotToken>("copilot", accountId);
    if (!stored?.githubToken) return [];
    try {
      const session = await getCopilotSession(stored.githubToken);
      const res = await fetch(`${session.apiUrl}/models`, { headers: copilotHeaders(session.token), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return COPILOT_FALLBACK_MODELS;
      const data = await res.json() as { data?: Array<{ id?: unknown; display_name?: unknown; name?: unknown }>; models?: Array<{ id?: unknown; display_name?: unknown; name?: unknown }> };
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const models = rows.flatMap((m) => {
        if (typeof m.id !== "string" || !m.id.trim()) return [];
        const label = typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : undefined;
        return [{ id: m.id, label: copilotModelLabel(m.id, label) }];
      });
      return mergeCopilotModels(models, COPILOT_FALLBACK_MODELS);
    } catch { return []; }
  }
  const stored = await readClaudeToken(accountId);
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (stored?.accessToken) {
    headers.authorization = `Bearer ${stored.accessToken}`;
    headers["anthropic-beta"] = CLAUDE_CODE_OAUTH_BETA;
  } else if (stored?.apiKey) {
    headers["x-api-key"] = stored.apiKey;
  } else {
    return [];
  }
  try {
    const res = await fetch(`${ANTHROPIC_API}/models?limit=100`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string; display_name?: string }> };
    return (data.data ?? []).map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
  } catch { return []; }
}
