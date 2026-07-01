import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAccount } from "./contracts.cjs";
import { codexHome } from "./codex-home.cjs";
import { listStoredAccounts, readJsonSecret, upsertStoredAccount, writeJsonSecret } from "./provider-accounts.cjs";

export type CodexAuthJson = {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  last_refresh?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
};

type CodexRefreshResponse = {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  error?: unknown;
  code?: unknown;
};

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID_ENV = "CODEX_APP_SERVER_LOGIN_CLIENT_ID";
const CODEX_REFRESH_TOKEN_URL_ENV = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";

function authPath(): string {
  return join(codexHome(), "auth.json");
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function codexAuthSubject(auth: CodexAuthJson): { id: string; email?: string; userId?: string; label: string } | null {
  const idPayload = decodeJwtPayload(auth.tokens?.id_token);
  const accessPayload = decodeJwtPayload(auth.tokens?.access_token);
  const payload = idPayload ?? accessPayload ?? {};
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const userId = auth.tokens?.account_id || (typeof payload.sub === "string" ? payload.sub : undefined);
  const seed = userId || email || auth.tokens?.access_token || auth.OPENAI_API_KEY;
  if (!seed) return null;
  const id = userId || `codex-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
  return { id, email, userId, label: email || userId || "Codex 계정" };
}

export async function readCurrentCodexAuth(): Promise<CodexAuthJson | null> {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as CodexAuthJson;
  } catch {
    return null;
  }
}

export async function writeCurrentCodexAuth(auth: CodexAuthJson): Promise<void> {
  await mkdir(codexHome(), { recursive: true });
  await writeFile(authPath(), JSON.stringify(auth, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export async function importCurrentCodexAuth(): Promise<ProviderAccount | null> {
  const auth = await readCurrentCodexAuth();
  if (!auth?.tokens?.access_token && !auth?.OPENAI_API_KEY) return null;
  const subject = codexAuthSubject(auth);
  if (!subject) return null;
  await writeJsonSecret("codex", subject.id, "oauth", auth);
  return upsertStoredAccount({
    id: subject.id,
    provider: "codex",
    label: subject.label,
    email: subject.email,
    userId: subject.userId,
    credentialSource: "keychain",
    credentialKind: "oauth",
  });
}

export async function readCodexStoredAuth(accountId?: string): Promise<CodexAuthJson | null> {
  if (accountId) return readJsonSecret<CodexAuthJson>("codex", accountId, "oauth");
  const accounts = await listStoredAccounts("codex");
  if (accounts[0]) return readJsonSecret<CodexAuthJson>("codex", accounts[0].id, "oauth");
  return readCurrentCodexAuth();
}

function codexRefreshEndpoint(): string {
  return process.env[CODEX_REFRESH_TOKEN_URL_ENV] || CODEX_REFRESH_TOKEN_URL;
}

function codexClientId(): string {
  return process.env[CODEX_CLIENT_ID_ENV] || CODEX_CLIENT_ID;
}

function refreshErrorCode(data: CodexRefreshResponse | string): string | undefined {
  if (typeof data === "string") {
    try { return refreshErrorCode(JSON.parse(data) as CodexRefreshResponse); } catch { return undefined; }
  }
  if (typeof data.code === "string") return data.code;
  const error = data.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export async function refreshCodexAuth(auth: CodexAuthJson): Promise<CodexAuthJson | null> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) return null;
  const response = await fetch(codexRefreshEndpoint(), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: codexClientId(), grant_type: "refresh_token", refresh_token: refreshToken }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  let data: CodexRefreshResponse = {};
  try { data = body ? JSON.parse(body) as CodexRefreshResponse : {}; } catch { /* non-JSON error body */ }
  if (!response.ok) {
    const code = refreshErrorCode(data) ?? refreshErrorCode(body);
    throw new Error(`Codex token refresh failed (${response.status}${code ? ` ${code}` : ""})`);
  }
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Codex token refresh response did not include an access token");
  }
  return {
    ...auth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...auth.tokens,
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : refreshToken,
      id_token: typeof data.id_token === "string" && data.id_token ? data.id_token : auth.tokens?.id_token,
    },
  };
}
