import { app, safeStorage } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAccount, ProviderId } from "./contracts.cjs";

export type ProviderSecretKind = "credential" | "oauth";

type AccountsShape = {
  version: 1;
  accounts: Partial<Record<ProviderId, ProviderAccount[]>>;
};

const DEFAULT_ACCOUNT_ID = "default";
const ENV_ACCOUNT_ID = "env";
const LOCAL_ACCOUNT_ID = "local";

function root(): string {
  return join(app.getPath("userData"), "providers");
}

function accountsPath(): string {
  return join(root(), "accounts.json");
}

function accountDir(provider: ProviderId): string {
  return join(root(), "accounts", provider);
}

function extension(kind: ProviderSecretKind): string {
  return kind === "oauth" ? "oauth" : "credential";
}

export function defaultAccountId(): string {
  return DEFAULT_ACCOUNT_ID;
}

export function envAccountId(): string {
  return ENV_ACCOUNT_ID;
}

export function localAccountId(): string {
  return LOCAL_ACCOUNT_ID;
}

export function providerSecretPath(provider: ProviderId, accountId: string, kind: ProviderSecretKind): string {
  return join(accountDir(provider), `${accountId}.${extension(kind)}`);
}

export function legacySecretPath(provider: ProviderId, kind: ProviderSecretKind): string {
  return join(root(), `${provider}.${extension(kind)}`);
}

function now(): number {
  return Date.now();
}

function normalizeAccount(account: ProviderAccount): ProviderAccount {
  const stamp = now();
  return {
    ...account,
    id: account.id || DEFAULT_ACCOUNT_ID,
    label: account.label || account.email || account.userId || account.id || "기본 계정",
    createdAt: account.createdAt ?? stamp,
    updatedAt: stamp,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
}

async function readShape(): Promise<AccountsShape> {
  try {
    const parsed = JSON.parse(await readFile(accountsPath(), "utf8")) as Partial<AccountsShape>;
    if (parsed.version === 1 && parsed.accounts && typeof parsed.accounts === "object") {
      return { version: 1, accounts: parsed.accounts as AccountsShape["accounts"] };
    }
  } catch {
    // Missing or malformed account metadata starts empty. Credential files remain
    // untouched and are re-discovered through migration paths.
  }
  return { version: 1, accounts: {} };
}

async function writeShape(shape: AccountsShape): Promise<void> {
  await mkdir(root(), { recursive: true });
  await writeFile(accountsPath(), JSON.stringify(shape, null, 2) + "\n", { mode: 0o600 });
}

let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

export async function listStoredAccounts(provider: ProviderId): Promise<ProviderAccount[]> {
  const shape = await readShape();
  return [...(shape.accounts[provider] ?? [])];
}

export async function getStoredAccount(provider: ProviderId, accountId?: string): Promise<ProviderAccount | null> {
  const accounts = await listStoredAccounts(provider);
  const wanted = accountId || DEFAULT_ACCOUNT_ID;
  return accounts.find((account) => account.id === wanted) ?? accounts[0] ?? null;
}

export async function upsertStoredAccount(account: ProviderAccount): Promise<ProviderAccount> {
  return withLock(async () => {
    const nextAccount = normalizeAccount(account);
    const shape = await readShape();
    const accounts = [...(shape.accounts[nextAccount.provider] ?? [])];
    const index = accounts.findIndex((item) => item.id === nextAccount.id);
    if (index >= 0) {
      accounts[index] = { ...accounts[index], ...nextAccount, createdAt: accounts[index]!.createdAt ?? nextAccount.createdAt };
    } else {
      accounts.push(nextAccount);
    }
    shape.accounts[nextAccount.provider] = accounts;
    await writeShape(shape);
    return accounts.find((item) => item.id === nextAccount.id)!;
  });
}

export async function deleteStoredAccount(provider: ProviderId, accountId?: string): Promise<void> {
  const id = accountId || DEFAULT_ACCOUNT_ID;
  await withLock(async () => {
    const shape = await readShape();
    shape.accounts[provider] = (shape.accounts[provider] ?? []).filter((account) => account.id !== id);
    await writeShape(shape);
  });
  for (const kind of ["credential", "oauth"] as const) {
    const path = providerSecretPath(provider, id, kind);
    if (existsSync(path)) await unlink(path).catch(() => undefined);
  }
}

export async function deleteAllStoredAccounts(provider: ProviderId): Promise<void> {
  const accounts = await listStoredAccounts(provider);
  await Promise.all(accounts.map((account) => deleteStoredAccount(provider, account.id)));
}

export async function createAccountId(provider: ProviderId, preferredLabel?: string): Promise<string> {
  const base = slug(preferredLabel || "") || "account";
  const used = new Set((await listStoredAccounts(provider)).map((account) => account.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function migrateLegacySecret(input: {
  provider: ProviderId;
  kind: ProviderSecretKind;
  label: string;
  email?: string;
  userId?: string;
  credentialSource?: ProviderAccount["credentialSource"];
  credentialKind?: ProviderAccount["credentialKind"];
}): Promise<void> {
  const legacy = legacySecretPath(input.provider, input.kind);
  if (!existsSync(legacy)) return;
  const id = DEFAULT_ACCOUNT_ID;
  await mkdir(accountDir(input.provider), { recursive: true });
  const target = providerSecretPath(input.provider, id, input.kind);
  if (!existsSync(target)) {
    await rename(legacy, target).catch(async () => {
      const source = await readFile(legacy, "utf8");
      await writeFile(target, source, { mode: 0o600 });
      await unlink(legacy).catch(() => undefined);
    });
  } else {
    await unlink(legacy).catch(() => undefined);
  }
  await upsertStoredAccount({
    id,
    provider: input.provider,
    label: input.email || input.label,
    email: input.email,
    userId: input.userId,
    credentialSource: input.credentialSource ?? "keychain",
    credentialKind: input.credentialKind ?? input.kind,
  });
}

export async function writeEncryptedText(provider: ProviderId, accountId: string, kind: ProviderSecretKind, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("이 시스템에서 OS Keychain 암호화를 사용할 수 없습니다.");
  await mkdir(accountDir(provider), { recursive: true });
  await writeFile(providerSecretPath(provider, accountId, kind), safeStorage.encryptString(value).toString("base64"), { mode: 0o600 });
}

export async function readEncryptedText(provider: ProviderId, accountId: string, kind: ProviderSecretKind): Promise<string | null> {
  const path = providerSecretPath(provider, accountId, kind);
  if (!existsSync(path)) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("이 시스템에서 OS Keychain 암호화를 사용할 수 없습니다.");
  try {
    return safeStorage.decryptString(Buffer.from((await readFile(path, "utf8")).trim(), "base64"));
  } catch {
    return null;
  }
}

export async function writeJsonSecret(provider: ProviderId, accountId: string, kind: ProviderSecretKind, value: unknown): Promise<void> {
  await writeEncryptedText(provider, accountId, kind, JSON.stringify(value));
}

export async function readJsonSecret<T>(provider: ProviderId, accountId: string, kind: ProviderSecretKind): Promise<T | null> {
  const text = await readEncryptedText(provider, accountId, kind);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function virtualAccount(input: {
  provider: ProviderId;
  id: string;
  label: string;
  credentialSource: ProviderAccount["credentialSource"];
  credentialKind: ProviderAccount["credentialKind"];
  email?: string;
  userId?: string;
}): ProviderAccount {
  return {
    id: input.id,
    provider: input.provider,
    label: input.label,
    email: input.email,
    userId: input.userId,
    credentialSource: input.credentialSource,
    credentialKind: input.credentialKind,
    createdAt: 0,
    updatedAt: 0,
  };
}
