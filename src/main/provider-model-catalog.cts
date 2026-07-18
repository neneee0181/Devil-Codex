import type { ProviderId, ProviderInfo, ProviderSettings } from "./contracts.cjs";
import { apiProviderConfig, apiProviderUrl, ProviderSettingsStore } from "./provider-settings.cjs";

type ExternalProvider = Exclude<ProviderId, "codex">;
type ModelRow = {
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  supportedGenerationMethods?: unknown;
  pricing?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  inputTokenLimit?: unknown;
  architecture?: unknown;
  supported_parameters?: unknown;
};
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const modelCache = new Map<string, { models: ProviderInfo["models"]; fetchedAt: number }>();

function humanLabel(value: string): string {
  return value.replace(/^models\//, "").replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeModels(rows: ModelRow[]): ProviderInfo["models"] {
  const ids = new Set<string>();
  return rows.flatMap((row) => {
    const id = String(row.id ?? row.name ?? "").replace(/^models\//, "");
    if (!id || ids.has(id)) return [];
    ids.add(id);
    const context = [row.context_length, row.context_window, row.inputTokenLimit]
      .find((value) => typeof value === "number" && Number.isFinite(value) && value > 0) as number | undefined;
    const architecture = row.architecture && typeof row.architecture === "object" && !Array.isArray(row.architecture)
      ? row.architecture as Record<string, unknown>
      : undefined;
    const rawModalities = architecture?.input_modalities;
    const inputModalities = Array.isArray(rawModalities)
      ? rawModalities.filter((value): value is "text" | "image" => value === "text" || value === "image")
      : undefined;
    const parameters = Array.isArray(row.supported_parameters)
      ? row.supported_parameters.filter((value): value is string => typeof value === "string")
      : undefined;
    return [{
      id,
      label: String(row.display_name ?? humanLabel(id)),
      ...(context ? { contextWindow: context } : {}),
      ...(inputModalities?.length ? { inputModalities: [...new Set(inputModalities)] } : {}),
      ...(parameters?.includes("reasoning") || parameters?.includes("reasoning_effort")
        ? { reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }
        : {}),
      ...(parameters?.includes("tools") ? { parallelToolCalls: true } : {}),
    }];
  }).sort((left, right) => left.label.localeCompare(right.label));
}

function numericPrice(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isOpenRouterFreeModel(row: ModelRow): boolean {
  const id = String(row.id ?? row.name ?? "").replace(/^models\//, "");
  if (id === "openrouter/free" || id.endsWith(":free")) return true;
  const pricing = row.pricing;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return false;
  const record = pricing as Record<string, unknown>;
  const prompt = numericPrice(record.prompt);
  const completion = numericPrice(record.completion);
  const request = numericPrice(record.request);
  return prompt === 0 && completion === 0 && (request === undefined || request === 0);
}

function isOpenCodeFreeModel(row: ModelRow): boolean {
  const id = String(row.id ?? row.name ?? "").replace(/^models\//, "");
  return id === "big-pickle" || id.endsWith("-free");
}

export class ProviderModelCatalog {
  constructor(private readonly settings: ProviderSettingsStore) {}

  async refresh(provider: ExternalProvider, accountId?: string): Promise<ProviderSettings> {
    const key = await this.settings.readApiKey(provider, accountId);
    const cacheKey = `${provider}:${accountId ?? "default"}`;
    const cached = modelCache.get(cacheKey);
    if (cached && cached.fetchedAt > Date.now() - MODEL_CACHE_TTL_MS) {
      return this.settings.saveModels(provider, cached.models, accountId);
    }

    try {
      const response = await this.request(provider, key);
      if (!response.ok) {
        const detail = await response.text();
        const message = `모델 목록 조회 실패: ${response.status}${detail ? ` ${detail}` : ""}`;
        if (response.status === 401 || response.status === 403) {
          await this.settings.clearModels(provider, accountId);
          throw new Error(message);
        }
        return this.withFallback(provider, message, accountId);
      }
      const payload = await response.json() as { data?: ModelRow[]; models?: ModelRow[] };
      const rows = provider === "google"
        ? (payload.models ?? []).filter((model) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"))
        : provider === "openrouter-free"
          ? (payload.data ?? []).filter(isOpenRouterFreeModel)
          : provider === "opencode-free"
            ? (payload.data ?? []).filter(isOpenCodeFreeModel)
          : payload.data ?? [];
      const models = normalizeModels(rows);
      if (!models.length) return this.withFallback(provider, "사용 가능한 대화 모델이 없습니다.", accountId);
      modelCache.set(cacheKey, { models, fetchedAt: Date.now() });
      return this.settings.saveModels(provider, models, accountId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("401") || message.includes("403")) {
        await this.settings.clearModels(provider, accountId);
        throw error;
      }
      return this.withFallback(provider, message, accountId);
    }
  }

  private async withFallback(provider: ExternalProvider, reason: string, accountId?: string): Promise<ProviderSettings> {
    const cached = modelCache.get(`${provider}:${accountId ?? "default"}`);
    if (cached?.models.length) return this.settings.saveModels(provider, cached.models, accountId);
    const existing = await this.settings.load();
    const saved = existing.providers.find((item) => item.id === provider);
    if (saved?.modelsLoaded) return existing;
    throw new Error(reason);
  }

  private request(provider: ExternalProvider, key: string): Promise<Response> {
    const config = apiProviderConfig(provider);
    if (!config) throw new Error(`지원하지 않는 Provider입니다: ${provider}`);
    if (config.adapter === "anthropic") return fetch(apiProviderUrl(provider, config.modelPath), { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    if (config.adapter === "google") return fetch(`${apiProviderUrl(provider, config.modelPath)}?key=${encodeURIComponent(key)}`);
    return fetch(apiProviderUrl(provider, config.modelPath), { headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(config.headers ?? {}) } });
  }
}
