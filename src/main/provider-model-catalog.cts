import type { ProviderId, ProviderInfo, ProviderSettings } from "./contracts.cjs";
import { apiProviderConfig, apiProviderUrl, ProviderSettingsStore } from "./provider-settings.cjs";

type ExternalProvider = Exclude<ProviderId, "codex">;
type ModelRow = { id?: unknown; display_name?: unknown; name?: unknown; supportedGenerationMethods?: unknown };
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const modelCache = new Map<ExternalProvider, { models: ProviderInfo["models"]; fetchedAt: number }>();

function humanLabel(value: string): string {
  return value.replace(/^models\//, "").replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeModels(rows: ModelRow[]): ProviderInfo["models"] {
  const ids = new Set<string>();
  return rows.flatMap((row) => {
    const id = String(row.id ?? row.name ?? "").replace(/^models\//, "");
    if (!id || ids.has(id)) return [];
    ids.add(id);
    return [{ id, label: String(row.display_name ?? humanLabel(id)) }];
  }).sort((left, right) => left.label.localeCompare(right.label));
}

export class ProviderModelCatalog {
  constructor(private readonly settings: ProviderSettingsStore) {}

  async refresh(provider: ExternalProvider): Promise<ProviderSettings> {
    const key = await this.settings.readApiKey(provider);
    const cached = modelCache.get(provider);
    if (cached && cached.fetchedAt > Date.now() - MODEL_CACHE_TTL_MS) {
      return this.settings.saveModels(provider, cached.models);
    }

    try {
      const response = await this.request(provider, key);
      if (!response.ok) {
        const detail = await response.text();
        const message = `모델 목록 조회 실패: ${response.status}${detail ? ` ${detail}` : ""}`;
        if (response.status === 401 || response.status === 403) {
          await this.settings.clearModels(provider);
          throw new Error(message);
        }
        return this.withFallback(provider, message);
      }
      const payload = await response.json() as { data?: ModelRow[]; models?: ModelRow[] };
      const rows = provider === "google"
        ? (payload.models ?? []).filter((model) => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"))
        : payload.data ?? [];
      const models = normalizeModels(rows);
      if (!models.length) return this.withFallback(provider, "사용 가능한 대화 모델이 없습니다.");
      modelCache.set(provider, { models, fetchedAt: Date.now() });
      return this.settings.saveModels(provider, models);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("401") || message.includes("403")) {
        await this.settings.clearModels(provider);
        throw error;
      }
      return this.withFallback(provider, message);
    }
  }

  private async withFallback(provider: ExternalProvider, reason: string): Promise<ProviderSettings> {
    const cached = modelCache.get(provider);
    if (cached?.models.length) return this.settings.saveModels(provider, cached.models);
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
    return fetch(apiProviderUrl(provider, config.modelPath), { headers: key ? { Authorization: `Bearer ${key}` } : undefined });
  }
}
