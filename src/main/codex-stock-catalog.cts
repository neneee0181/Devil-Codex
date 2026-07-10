import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codex-home.cjs";
import type { ProviderId, ProviderInfo, ProviderSettings } from "./contracts.cjs";

const CATALOG_FILE = "devil-codex-catalog.json";
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
  delete entry.supports_websockets;
  return entry;
}

export function stockFeaturedSubagentModels(settings: Pick<ProviderSettings, "provider" | "model" | "accountId" | "providers">): string[] {
  const selected = settings.providers.find((provider) => provider.id === settings.provider && provider.id !== "codex");
  const fallback = settings.providers.find((provider) => provider.id !== "codex" && provider.accounts.length > 0);
  const provider = selected ?? fallback;
  if (!provider) return [];
  const account = provider.accounts.find((candidate) => candidate.id === settings.accountId) ?? provider.accounts[0];
  const models = account?.models?.length ? account.models : provider.models;
  const ordered = [
    ...(provider.id === settings.provider ? models.filter((model) => model.id === settings.model) : []),
    ...models,
  ].filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index).slice(0, 5);
  return ordered.map((model) => externalModelId(provider.id, account?.id, model.id));
}

export function buildStockCatalog(native: Catalog, providers: ProviderInfo[], featuredModelIds: string[] = []): Catalog {
  const template = nativeTemplate(native);
  if (!template) throw new Error("Codex native model catalog does not contain a usable template.");
  const external = providers.flatMap(providerModels)
    .filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index)
    .sort((left, right) => left.label.localeCompare(right.label));
  const featured = new Map(featuredModelIds.map((id, index) => [id, index]));
  const nativeModels = (native.models ?? [])
    .filter((entry) => typeof entry.slug !== "string" || !entry.slug.includes(":"))
    // Codex's spawn_agent presents the five lowest-priority visible models.
    // Keep native entries available but reserve that compact shortlist for the
    // explicitly selected external models.
    .map((entry, index) => ({ ...entry, priority: 20 + index }));
  const orderedExternal = [...external].sort((left, right) => {
    const leftRank = featured.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = featured.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftRank === rightRank ? left.label.localeCompare(right.label) : leftRank - rightRank;
  });
  return {
    ...native,
    models: [...nativeModels, ...orderedExternal.map((model, index) => externalEntry(template, model, featured.get(model.id) ?? 100 + index))],
  };
}

export function stockCatalogPath(home = codexHome()): string { return join(home, CATALOG_FILE); }

export async function syncStockCodexCatalog(providers: ProviderInfo[], home = codexHome(), featuredModelIds: string[] = []): Promise<{ path: string; added: number }> {
  const sourcePath = join(home, "models_cache.json");
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
