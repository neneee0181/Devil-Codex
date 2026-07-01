import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
