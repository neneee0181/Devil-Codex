import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codex-home.cjs";
import type { ProviderId, ProviderInfo, ProviderSettings } from "./contracts.cjs";

const CATALOG_FILE = "devil-codex-catalog.json";
const NATIVE_CATALOG_FILE = "devil-codex-native-catalog.json";
const CATALOG_BACKUP_FILE = "devil-codex-native-models-backup.json";

type CatalogEntry = Record<string, unknown>;
type Catalog = { models?: CatalogEntry[]; [key: string]: unknown };

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function externalModelId(provider: ProviderId, accountId: string | undefined, model: string): string {
  return `${provider}${accountId ? `@${encodeURIComponent(accountId)}` : ""}:${model}`;
}

function providerModels(provider: ProviderInfo): Array<{ id: string; label: string }> {
  if (provider.id === "codex") return [];
  return provider.accounts.flatMap((account) => {
    const models = account.models?.length ? account.models : provider.models;
    return models.map((model) => ({
      id: externalModelId(provider.id, account.id, model.id),
      label: provider.accounts.length > 1 ? `${provider.label} (${account.label}) · ${model.label}` : `${provider.label} · ${model.label}`,
    }));
  });
}

function nativeTemplate(catalog: Catalog): CatalogEntry | undefined {
  return catalog.models?.find((entry) => typeof entry.slug === "string" && !entry.slug.includes("/"));
}

function externalEntry(template: CatalogEntry, model: { id: string; label: string }, priority: number): CatalogEntry {
  const entry = clone(template);
  entry.slug = model.id;
  entry.display_name = model.label;
  entry.description = `External model routed through the local Devil Codex proxy.`;
  entry.priority = priority;
  entry.visibility = "list";
  entry.upgrade = null;
  // A routed provider may not support Codex-hosted search or parallel calls.
  entry.supports_parallel_tool_calls = false;
  entry.supports_search_tool = false;
  delete entry.web_search_tool_type;
  // The local Bridge intentionally serves HTTP/SSE only. Keep OpenCodex's
  // default-off catalog shape: Codex's built-in OpenAI provider still probes
  // WebSocket, and the proxy answers that probe with 426 to request HTTP/SSE
  // fallback while preserving the stock thread identity.
  delete entry.supports_websockets;
  delete entry.prefer_websockets;
  return entry;
}

export function buildStockCatalog(native: Catalog, providers: ProviderInfo[], featuredModelIds: string[] = []): Catalog {
  const template = nativeTemplate(native);
  if (!template) throw new Error("Codex native model catalog does not contain a usable template.");
  const selected = new Set(featuredModelIds);
  const external = providers.flatMap(providerModels)
    .filter((model) => selected.has(model.id))
    .filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index)
    .sort((left, right) => (featuredModelIds.indexOf(left.id) - featuredModelIds.indexOf(right.id)) || left.label.localeCompare(right.label));
  const featured = new Map(featuredModelIds.map((id, index) => [id, index]));
  const nativeModels = (native.models ?? [])
    .filter((entry) => typeof entry.slug !== "string" || !entry.slug.includes(":"))
    // Native Codex models must stay before every Devil-routed model in both
    // the picker and the compact subagent candidate list.
    .map((entry, index) => ({ ...entry, priority: index }));
  const orderedExternal = [...external];
  return {
    ...native,
    models: [...nativeModels, ...orderedExternal.map((model, index) => externalEntry(template, model, 100 + index))],
  };
}

export function stockCatalogPath(home = codexHome()): string { return join(home, CATALOG_FILE); }

export function nativeCatalogPath(home = codexHome()): string { return join(home, NATIVE_CATALOG_FILE); }

function nativeCatalogSourcePath(home: string): string {
  const backup = join(home, CATALOG_BACKUP_FILE);
  return existsSync(backup) ? backup : join(home, "models_cache.json");
}

export async function syncNativeCodexCatalog(home = codexHome()): Promise<{ path: string; models: number }> {
  const sourcePath = nativeCatalogSourcePath(home);
  if (!existsSync(sourcePath)) throw new Error(`Codex model cache was not found: ${sourcePath}`);
  const backup = join(home, CATALOG_BACKUP_FILE);
  if (!existsSync(backup)) await copyFile(sourcePath, backup);
  const native = JSON.parse(await readFile(sourcePath, "utf8")) as Catalog;
  const catalog = {
    ...native,
    models: (native.models ?? []).filter((entry) => typeof entry.slug !== "string" || !entry.slug.includes(":")),
  };
  const target = nativeCatalogPath(home);
  await writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { path: target, models: catalog.models.length };
}

export async function syncStockCodexCatalog(providers: ProviderInfo[], home = codexHome(), featuredModelIds: string[] = []): Promise<{ path: string; added: number }> {
  const sourcePath = nativeCatalogSourcePath(home);
  if (!existsSync(sourcePath)) throw new Error(`Codex model cache was not found: ${sourcePath}`);
  const native = JSON.parse(await readFile(sourcePath, "utf8")) as Catalog;
  const target = stockCatalogPath(home);
  const backup = join(home, CATALOG_BACKUP_FILE);
  if (!existsSync(backup)) await copyFile(sourcePath, backup);
  const catalog = buildStockCatalog(native, providers, featuredModelIds);
  await writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const added = (catalog.models ?? []).filter((entry) => typeof entry.slug === "string" && entry.slug.includes(":")).length;
  return { path: target, added };
}

export function stockCatalogModelIds(catalog: Catalog): string[] {
  return (catalog.models ?? []).flatMap((entry) => typeof entry.slug === "string" && entry.slug.includes(":") ? [entry.slug] : []);
}
