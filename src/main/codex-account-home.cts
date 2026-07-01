import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexHome } from "./codex-home.cjs";
import { codexAuthSubject, type CodexAuthJson, readCodexStoredAuth, readCurrentCodexAuth } from "./provider-codex-accounts.cjs";

function accountRoot(): string {
  return join(app.getPath("userData"), "codex-accounts");
}

export function codexAccountHomePath(accountId: string): string {
  const digest = createHash("sha256").update(accountId).digest("hex").slice(0, 24);
  return join(accountRoot(), digest);
}

function hasUsableAuth(auth: CodexAuthJson | null): auth is CodexAuthJson {
  return Boolean(auth?.tokens?.access_token || auth?.OPENAI_API_KEY);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function currentCodexAccountId(): Promise<string | undefined> {
  const current = await readCurrentCodexAuth();
  return current ? codexAuthSubject(current)?.id : undefined;
}

async function syncBaseConfig(targetHome: string): Promise<void> {
  const sourcePath = join(codexHome(), "config.toml");
  if (!existsSync(sourcePath)) return;
  const source = await readFile(sourcePath, "utf8");
  await writeFile(join(targetHome, "config.toml"), source, { encoding: "utf8", mode: 0o600 });
}

export async function codexHomeForAccount(accountId?: string): Promise<string | undefined> {
  if (!accountId) return undefined;
  if (accountId === await currentCodexAccountId()) return undefined;

  const stored = await readCodexStoredAuth(accountId);
  if (!hasUsableAuth(stored)) throw new Error("선택한 Codex 계정 토큰을 찾지 못했습니다. 해당 계정으로 다시 로그인한 뒤 선택하세요.");

  const home = codexAccountHomePath(accountId);
  await mkdir(home, { recursive: true });
  await syncBaseConfig(home);

  const authPath = join(home, "auth.json");
  const existing = await readJsonFile<CodexAuthJson>(authPath);
  const existingSubject = existing ? codexAuthSubject(existing) : null;
  const auth = hasUsableAuth(existing) && existingSubject?.id === accountId ? existing : stored;
  await writeFile(authPath, JSON.stringify(auth), { encoding: "utf8", mode: 0o600 });
  return home;
}
