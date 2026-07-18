import { copyFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeTextFileAtomic } from "./atomic-file.cjs";
import { codexHome } from "./codex-home.cjs";
import type { ProviderId, ProviderInfo, ProviderModel } from "./contracts.cjs";
import { providerAccountReady } from "./provider-settings.cjs";
import { neutralizeIdentity } from "./proxy/identity.cjs";
import { providerContextWindow, providerNativeImageInput, providerParallelToolCalls, providerReasoningEfforts } from "./proxy/provider-policy.cjs";

const CATALOG_FILE = "devil-codex-catalog.json";
const NATIVE_CATALOG_FILE = "devil-codex-native-catalog.json";
const CATALOG_BACKUP_FILE = "devil-codex-native-models-backup.json";

type CatalogEntry = Record<string, unknown>;
type Catalog = { models?: CatalogEntry[]; [key: string]: unknown };
type RoutedModel = ProviderModel & { id: string; provider: ProviderId; upstreamId: string };
export interface StockCatalogOptions { webSearch?: boolean; vision?: boolean }

const DEFAULT_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
  { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
];

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function externalModelId(provider: ProviderId, accountId: string | undefined, model: string): string {
  // Codex Desktop expects routed catalog slugs in the provider/model form.
  return `${provider}${accountId ? `@${encodeURIComponent(accountId)}` : ""}/${model}`;
}

function isRoutedModelSlug(slug: unknown): boolean {
  return typeof slug === "string" && (slug.includes("/") || slug.includes(":"));
}

function mergeModels(...groups: Array<ProviderModel[] | undefined>): ProviderModel[] {
  const seen = new Set<string>();
  return groups.flatMap((group) => group ?? []).filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function connectedAccount(provider: ProviderInfo, account: ProviderInfo["accounts"][number]): boolean {
  if (provider.id === "codex") return false;
  return providerAccountReady(provider, account);
}

function providerModels(provider: ProviderInfo): RoutedModel[] {
  if (provider.id === "codex") return [];
  return provider.accounts.flatMap((account) => {
    if (!connectedAccount(provider, account)) return [];
    // Account refreshes and provider-wide refreshes can complete at different
    // times. Keep the union so a newer provider list does not hide models that
    // are still valid for an already-connected account.
    const models = mergeModels(account.models, provider.models);
    return models.map((model) => ({
      ...model,
      id: externalModelId(provider.id, account.id, model.id),
      label: provider.accounts.length > 1 ? `${provider.label} (${account.label}) · ${model.label}` : `${provider.label} · ${model.label}`,
      provider: provider.id,
      upstreamId: model.id,
    }));
  });
}

function nativeTemplate(catalog: Catalog): CatalogEntry | undefined {
  return catalog.models?.find((entry) => typeof entry.slug === "string" && !entry.slug.includes("/"));
}

function applyReasoningLevels(entry: CatalogEntry, efforts: string[] | undefined): void {
  const requested = efforts ?? DEFAULT_REASONING_LEVELS.map((level) => level.effort);
  const normalized = [...new Set(requested.filter((effort) => DEFAULT_REASONING_LEVELS.some((level) => level.effort === effort)))];
  if (normalized.length && !normalized.includes("max")) normalized.push("max");
  if (normalized.length && !normalized.includes("ultra")) normalized.push("ultra");
  entry.supported_reasoning_levels = DEFAULT_REASONING_LEVELS.filter((level) => normalized.includes(level.effort));
  if (!normalized.length) delete entry.default_reasoning_level;
  else entry.default_reasoning_level = normalized.includes("medium") ? "medium" : normalized.includes("high") ? "high" : normalized[0];
}

function externalEntry(template: CatalogEntry, model: RoutedModel, priority: number, options: StockCatalogOptions): CatalogEntry {
  const entry = clone(template);
  entry.slug = model.id;
  entry.display_name = model.label;
  entry.description = `External model routed through the local Devil Codex proxy.`;
  entry.priority = priority;
  entry.visibility = "list";
  entry.upgrade = null;
  delete entry.availability_nux;
  delete entry.model_messages;
  delete entry.tool_mode;
  delete entry.multi_agent_version;
  delete entry.use_responses_lite;
  delete entry.supports_websockets;
  delete entry.prefer_websockets;
  delete entry.additional_speed_tiers;
  delete entry.service_tier;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  if (typeof entry.base_instructions === "string") entry.base_instructions = neutralizeIdentity(entry.base_instructions);

  const reasoning = model.reasoningEfforts ?? providerReasoningEfforts(model.provider, model.upstreamId);
  applyReasoningLevels(entry, reasoning);
  entry.supports_parallel_tool_calls = model.parallelToolCalls ?? providerParallelToolCalls(model.provider);
  entry.supports_search_tool = options.webSearch === true;
  if (options.webSearch) entry.web_search_tool_type = "text_and_image";
  else delete entry.web_search_tool_type;

  const contextWindow = model.contextWindow ?? providerContextWindow(model.provider, model.upstreamId) ?? 128_000;
  entry.context_window = contextWindow;
  entry.max_context_window = contextWindow;
  entry.auto_compact_token_limit = Math.floor(contextWindow * 0.9);
  const nativeImages = providerNativeImageInput(model.provider, model.upstreamId)
    ?? model.inputModalities?.includes("image")
    ?? model.capability?.images === "native";
  entry.input_modalities = nativeImages || options.vision ? ["text", "image"] : ["text"];
  entry.supports_image_detail_original = false;
  return entry;
}

export function buildStockCatalog(native: Catalog, providers: ProviderInfo[], featuredModelIds: string[] = [], options: StockCatalogOptions = {}): Catalog {
  const template = nativeTemplate(native);
  if (!template) throw new Error("Codex native model catalog does not contain a usable template.");
  const availableExternal = providers.flatMap(providerModels)
    .filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index);
  const external = selectConfiguredModelRows(availableExternal, featuredModelIds);
  const nativeModels = (native.models ?? [])
    .filter((entry) => !isRoutedModelSlug(entry.slug))
    // Native Codex models must stay before every Devil-routed model in both
    // the picker and the compact subagent candidate list.
    .map((entry, index) => ({ ...entry, priority: index }));
  const orderedExternal = [...external];
  return {
    ...native,
    models: [...nativeModels, ...orderedExternal.map((model, index) => externalEntry(template, model, 100 + index, options))],
  };
}

export function stockCatalogPath(home = codexHome()): string { return join(home, CATALOG_FILE); }

export function nativeCatalogPath(home = codexHome()): string { return join(home, NATIVE_CATALOG_FILE); }

function nativeCatalogSourcePath(home: string): string {
  const backup = join(home, CATALOG_BACKUP_FILE);
  return existsSync(backup) ? backup : join(home, "models_cache.json");
}

async function atomicWriteCatalog(path: string, catalog: Catalog): Promise<void> {
  await writeTextFileAtomic(path, `${JSON.stringify(catalog, null, 2)}\n`);
}

export async function syncNativeCodexCatalog(home = codexHome()): Promise<{ path: string; models: number }> {
  const sourcePath = nativeCatalogSourcePath(home);
  if (!existsSync(sourcePath)) throw new Error(`Codex model cache was not found: ${sourcePath}`);
  const backup = join(home, CATALOG_BACKUP_FILE);
  if (!existsSync(backup)) await copyFile(sourcePath, backup);
  const native = JSON.parse(await readFile(sourcePath, "utf8")) as Catalog;
  const catalog = {
    ...native,
    models: (native.models ?? []).filter((entry) => !isRoutedModelSlug(entry.slug)),
  };
  const target = nativeCatalogPath(home);
  await atomicWriteCatalog(target, catalog);
  return { path: target, models: catalog.models.length };
}

export async function syncStockCodexCatalog(providers: ProviderInfo[], home = codexHome(), featuredModelIds: string[] = [], options: StockCatalogOptions = {}): Promise<{ path: string; added: number }> {
  const sourcePath = nativeCatalogSourcePath(home);
  if (!existsSync(sourcePath)) throw new Error(`Codex model cache was not found: ${sourcePath}`);
  const native = JSON.parse(await readFile(sourcePath, "utf8")) as Catalog;
  const target = stockCatalogPath(home);
  const backup = join(home, CATALOG_BACKUP_FILE);
  if (!existsSync(backup)) await copyFile(sourcePath, backup);
  const catalog = buildStockCatalog(native, providers, featuredModelIds, options);
  await atomicWriteCatalog(target, catalog);
  const added = (catalog.models ?? []).filter((entry) => isRoutedModelSlug(entry.slug)).length;
  return { path: target, added };
}

export function stockCatalogModelIds(catalog: Catalog): string[] {
  return (catalog.models ?? []).flatMap((entry) => isRoutedModelSlug(entry.slug) && typeof entry.slug === "string" ? [entry.slug] : []);
}

/** Keep the proxy discovery endpoint in the exact same order/scope as Bridge settings. */
export function selectConfiguredModelRows<T extends { id: string }>(rows: T[], selectedIds: string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const emitted = new Set<string>();
  return selectedIds.flatMap((id) => {
    let row = byId.get(id);
    if (!row) {
      const slash = id.indexOf("/");
      const colon = id.indexOf(":");
      const separator = [slash, colon].filter((value) => value > 0).sort((left, right) => left - right)[0];
      const rawProvider = separator === undefined ? "" : id.slice(0, separator);
      // Pre-account Bridge ids (`provider/model`) can be healed only when
      // exactly one connected account exposes that route. Never guess across
      // multiple accounts or replace an explicit, now-missing account id.
      if (separator !== undefined && !rawProvider.includes("@")) {
        const accountless = `${rawProvider}/${id.slice(separator + 1)}`;
        const candidates = rows.filter((candidate) => {
          const candidateSlash = candidate.id.indexOf("/");
          if (candidateSlash <= 0) return false;
          const candidateProvider = candidate.id.slice(0, candidateSlash).split("@", 1)[0];
          return `${candidateProvider}/${candidate.id.slice(candidateSlash + 1)}` === accountless;
        });
        if (candidates.length === 1) row = candidates[0];
      }
    }
    if (!row || emitted.has(row.id)) return [];
    emitted.add(row.id);
    return [row];
  });
}
