import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAccount, ProviderId, ProviderInfo, ProviderModel, ProviderModelCapability, ProviderSettings } from "./contracts.cjs";
import { ANTIGRAVITY_MODELS } from "./provider-antigravity.cjs";
import { codexAuthSubject, readCurrentCodexAuth } from "./provider-codex-accounts.cjs";
import { createAccountId, defaultAccountId, deleteStoredAccount, envAccountId, getStoredAccount, listStoredAccounts, localAccountId, migrateLegacySecret, readEncryptedText, upsertStoredAccount, virtualAccount, writeEncryptedText } from "./provider-accounts.cjs";

export type ProviderAdapterKind = "openai-chat" | "anthropic" | "google";
export interface ApiProviderConfig {
  adapter: ProviderAdapterKind;
  baseUrl: string;
  modelPath: string;
  keyRequired: boolean;
  allowImages: boolean;
}

const apiProviderConfigs: Partial<Record<ProviderId, ApiProviderConfig>> = {
  openai: { adapter: "openai-chat", baseUrl: "https://api.openai.com/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", modelPath: "/v1/models?limit=100", keyRequired: true, allowImages: true },
  google: { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", modelPath: "/v1beta/models", keyRequired: true, allowImages: true },
  deepseek: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", modelPath: "/models", keyRequired: true, allowImages: false },
  xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  openrouter: { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  "openrouter-free": { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  groq: { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", modelPath: "/models", keyRequired: true, allowImages: false },
  mistral: { adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  cerebras: { adapter: "openai-chat", baseUrl: "https://api.cerebras.ai/v1", modelPath: "/models", keyRequired: true, allowImages: false },
  together: { adapter: "openai-chat", baseUrl: "https://api.together.xyz/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  fireworks: { adapter: "openai-chat", baseUrl: "https://api.fireworks.ai/inference/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  moonshot: { adapter: "openai-chat", baseUrl: "https://api.moonshot.ai/v1", modelPath: "/models", keyRequired: true, allowImages: false },
  huggingface: { adapter: "openai-chat", baseUrl: "https://router.huggingface.co/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  nvidia: { adapter: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1", modelPath: "/models", keyRequired: true, allowImages: true },
  ollama: { adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", modelPath: "/models", keyRequired: false, allowImages: true },
  vllm: { adapter: "openai-chat", baseUrl: "http://localhost:8000/v1", modelPath: "/models", keyRequired: false, allowImages: true },
  "lm-studio": { adapter: "openai-chat", baseUrl: "http://localhost:1234/v1", modelPath: "/models", keyRequired: false, allowImages: true },
};

export function apiProviderConfig(provider: ProviderId): ApiProviderConfig | undefined {
  return apiProviderConfigs[provider];
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function apiProviderUrl(provider: ProviderId, path: string): string {
  const config = apiProviderConfig(provider);
  if (!config) throw new Error(`지원하지 않는 Provider입니다: ${provider}`);
  return joinUrl(config.baseUrl, path);
}

export function capabilityFor(provider: ProviderId, model: string): ProviderModelCapability {
  if (provider === "codex") return {
    tools: "native",
    images: "native",
    webSearch: "native",
    diagnostics: "good",
    notes: ["Codex 모델은 Devil proxy를 타지 않고 app-server 직통 경로를 사용합니다."],
  };
  if (provider === "deepseek") return {
    tools: "limited",
    images: "sidecar",
    webSearch: "sidecar",
    diagnostics: "limited",
    notes: ["DeepSeek는 간단 대화/파일 작업 검증 완료. 복잡한 Codex 도구 호출은 제한될 수 있습니다.", "웹 검색은 외부 모델 전용 sidecar tool-loop로 처리됩니다.", "이미지는 vision sidecar가 텍스트 설명으로 변환해 전달합니다."],
  };
  if (provider === "ollama" || provider === "vllm" || provider === "lm-studio") return {
    tools: "limited",
    images: "sidecar",
    webSearch: "sidecar",
    diagnostics: "experimental",
    notes: ["로컬 OpenAI-compatible endpoint입니다. 모델 서버가 실행 중이어야 합니다.", "모델별 tool/image 지원은 로컬 서버 설정에 따라 달라집니다."],
  };
  if (provider === "groq") return {
    tools: "limited",
    images: "sidecar",
    webSearch: "sidecar",
    diagnostics: "experimental",
    notes: ["Groq on-demand TPM 제한을 피하기 위해 기본 요청에는 tool_search 중심의 최소 도구만 전송합니다.", "필요한 도구는 lazy loading으로 일부만 로드하며, 큰 파일 편집/명령 작업은 Codex/OpenAI/Anthropic 계열을 권장합니다."],
  };
  if (provider === "openrouter-free") return {
    tools: "limited",
    images: "native",
    webSearch: "sidecar",
    diagnostics: "experimental",
    notes: ["OpenRouter의 무료 모델만 노출하는 전용 목록입니다.", "무료 모델 availability/rate limit은 OpenRouter 정책과 각 모델 상태에 따라 바뀔 수 있습니다."],
  };
  if (provider === "openrouter" || provider === "mistral" || provider === "cerebras" || provider === "together" || provider === "fireworks" || provider === "moonshot" || provider === "huggingface" || provider === "nvidia" || provider === "xai") return {
    tools: "limited",
    images: apiProviderConfig(provider)?.allowImages ? "native" : "sidecar",
    webSearch: "sidecar",
    diagnostics: "experimental",
    notes: ["opencodex provider registry 기반 OpenAI-compatible API 경로입니다.", "Provider/모델별 tool, image, reasoning 지원은 계정과 모델에 따라 다를 수 있습니다."],
  };
  if (provider === "google") return {
    tools: "limited",
    images: model.toLowerCase().includes("vision") || model.toLowerCase().includes("gemini") ? "native" : "unknown",
    webSearch: "sidecar",
    diagnostics: "experimental",
    notes: ["Gemini 계열은 Gemini 호환 schema로 정규화합니다.", "모델/계정 조합에 따라 빈 응답이나 tool schema 거절이 날 수 있어 실패 진단 확인이 필요합니다."],
  };
  if (provider === "copilot") return {
    tools: "limited",
    images: "sidecar",
    webSearch: "sidecar",
    diagnostics: "experimental",
    notes: ["Copilot 모델 목록은 metadata 기반입니다. 일부 모델은 목록에 보여도 계정에서 응답하지 않을 수 있습니다.", "128개 초과 도구는 제한/정규화됩니다.", "이미지는 vision sidecar가 텍스트 설명으로 변환해 전달합니다."],
  };
  if (provider === "antigravity") return {
    tools: "limited",
    images: model.toLowerCase().includes("gemini") ? "native" : "sidecar",
    webSearch: "sidecar",
    diagnostics: "experimental",
    notes: ["Google Antigravity OAuth + Cloud Code Assist project 경로입니다.", "모델 id는 Antigravity CCA wire id를 그대로 사용합니다.", "Gemini tool-call 연속성은 upstream thoughtSignature 정책 영향을 받을 수 있습니다."],
  };
  if (provider === "claude-code") return {
    tools: "limited",
    images: "sidecar",
    webSearch: "sidecar",
    diagnostics: "limited",
    notes: ["Claude Code OAuth/구독 상태에 따라 401 또는 사용량 문제가 날 수 있습니다.", "이미지는 vision sidecar가 텍스트 설명으로 변환해 전달합니다."],
  };
  if (provider === "anthropic") return {
    tools: "native",
    images: "native",
    webSearch: "sidecar",
    diagnostics: "good",
    notes: ["Anthropic API-key 경로는 native tool/image 변환을 사용합니다.", "웹 검색은 외부 모델 전용 sidecar tool-loop로 처리됩니다."],
  };
  return {
    tools: "native",
    images: "native",
    webSearch: "sidecar",
    diagnostics: "good",
    notes: ["OpenAI-compatible/API-key 경로입니다. 웹 검색은 외부 모델 전용 sidecar tool-loop로 처리됩니다."],
  };
}

function withCapabilities(provider: ProviderId, models: ProviderModel[]): ProviderModel[] {
  return models.map((model) => ({ ...model, capability: model.capability ?? capabilityFor(provider, model.id) }));
}

function humanLabel(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function antigravityCatalogModels(): ProviderModel[] {
  return ANTIGRAVITY_MODELS.map((id) => ({ id, label: humanLabel(id) }));
}

const catalog: Array<Omit<ProviderInfo, "credentialSource" | "modelsLoaded" | "accounts">> = [
  { id: "codex", label: "Codex", kind: "login", authProvider: "codex", keyRequired: false, models: [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.4", label: "GPT-5.4" }, { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" }] },
  { id: "claude-code", label: "Claude Code", kind: "login", authProvider: "claude", keyRequired: false, models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" }, { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }] },
  { id: "copilot", label: "GitHub Copilot", kind: "login", authProvider: "copilot", keyRequired: false, models: [
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
  ] },
  { id: "antigravity", label: "Antigravity", kind: "login", authProvider: "antigravity", keyRequired: false, models: antigravityCatalogModels() },
  { id: "openai", label: "OpenAI", kind: "apikey", keyRequired: true, models: [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.4", label: "GPT-5.4" }, { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" }] },
  { id: "anthropic", label: "Anthropic", kind: "apikey", keyRequired: true, models: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" }, { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }] },
  { id: "google", label: "Google", kind: "apikey", keyRequired: true, models: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }, { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }] },
  { id: "deepseek", label: "DeepSeek", kind: "apikey", keyRequired: true, models: [{ id: "deepseek-chat", label: "DeepSeek Chat" }, { id: "deepseek-reasoner", label: "DeepSeek Reasoner" }] },
  { id: "xai", label: "xAI Grok", kind: "apikey", keyRequired: true, models: [{ id: "grok-4.3", label: "Grok 4.3" }, { id: "grok-code-fast-1", label: "Grok Code Fast 1" }] },
  { id: "openrouter", label: "OpenRouter", kind: "apikey", keyRequired: true, models: [{ id: "openai/gpt-5", label: "OpenAI GPT-5" }, { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" }] },
  { id: "openrouter-free", label: "OpenRouter Free", kind: "apikey", keyRequired: true, models: [{ id: "openrouter/free", label: "OpenRouter Free Router" }] },
  { id: "groq", label: "Groq", kind: "apikey", keyRequired: true, models: [{ id: "openai/gpt-oss-120b", label: "GPT OSS 120B" }, { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" }] },
  { id: "mistral", label: "Mistral", kind: "apikey", keyRequired: true, models: [{ id: "codestral-latest", label: "Codestral Latest" }, { id: "mistral-large-latest", label: "Mistral Large" }] },
  { id: "cerebras", label: "Cerebras", kind: "apikey", keyRequired: true, models: [{ id: "llama-3.3-70b", label: "Llama 3.3 70B" }] },
  { id: "together", label: "Together", kind: "apikey", keyRequired: true, models: [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo" }] },
  { id: "fireworks", label: "Fireworks", kind: "apikey", keyRequired: true, models: [{ id: "accounts/fireworks/models/kimi-k2-instruct", label: "Kimi K2 Instruct" }] },
  { id: "moonshot", label: "Moonshot Kimi", kind: "apikey", keyRequired: true, models: [{ id: "kimi-k2.7-code", label: "Kimi K2.7 Code" }, { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Highspeed" }] },
  { id: "huggingface", label: "Hugging Face", kind: "apikey", keyRequired: true, models: [{ id: "meta-llama/Llama-3.1-8B-Instruct", label: "Llama 3.1 8B" }] },
  { id: "nvidia", label: "NVIDIA NIM", kind: "apikey", keyRequired: true, models: [{ id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B" }] },
  { id: "ollama", label: "Ollama", kind: "apikey", keyRequired: false, models: [{ id: "llama3.1", label: "Llama 3.1" }, { id: "qwen2.5-coder", label: "Qwen 2.5 Coder" }] },
  { id: "vllm", label: "vLLM", kind: "apikey", keyRequired: false, models: [{ id: "default", label: "Default" }] },
  { id: "lm-studio", label: "LM Studio", kind: "apikey", keyRequired: false, models: [{ id: "local-model", label: "Local Model" }] },
];
const LOGIN_IDS = new Set<ProviderId>(["codex", "claude-code", "copilot", "antigravity"]);
const ENV_KEY_NAMES: Partial<Record<ProviderId, string[]>> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "openrouter-free": ["OPENROUTER_FREE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  huggingface: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
};

type StoredModelMap = Partial<Record<ProviderId, ProviderInfo["models"]>>;
type StoredAccountModelMap = Partial<Record<ProviderId, Record<string, ProviderInfo["models"]>>>;
type PersistedSettings = Pick<ProviderSettings, "provider" | "model"> & { accountId?: string; models?: StoredModelMap; accountModels?: StoredAccountModelMap };
const defaults: PersistedSettings = { provider: "codex", model: "gpt-5.4" };

export class ProviderSettingsStore {
  private root(): string { return join(app.getPath("userData"), "providers"); }
  private settingsPath(): string { return join(this.root(), "settings.json"); }

  async load(): Promise<ProviderSettings> {
    await this.migrateLegacySecrets();
    const stored = await this.readSettings();
    const provider = catalog.some((item) => item.id === stored.provider) ? stored.provider : defaults.provider;
    const providers = await Promise.all(catalog.map((item) => this.providerInfo(item, stored, provider)));
    const active = providers.find((item) => item.id === provider)!;
    const accountId = provider === "codex" ? undefined : this.resolveAccountId(active, stored.accountId);
    const activeAccount = accountId ? active.accounts.find((account) => account.id === accountId) : undefined;
    const candidateModels = activeAccount?.models?.length ? activeAccount.models : active.models;
    // Login providers list their models dynamically (OAuth/app-server), so the
    // static catalog can't validate them — keep whatever was stored.
    const model = LOGIN_IDS.has(active.id) ? (stored.model || candidateModels[0]!.id) : (candidateModels.some((item) => item.id === stored.model) ? stored.model : candidateModels[0]!.id);
    return { provider, model, ...(accountId ? { accountId } : {}), providers };
  }

  async select(input: { provider: ProviderId; model: string; accountId?: string }): Promise<ProviderSettings> {
    const provider = (await this.load()).providers.find((item) => item.id === input.provider);
    if (!provider) throw new Error("지원하지 않는 Provider입니다.");
    const requestedAccountId = input.provider === "codex" ? undefined : input.accountId;
    const accountId = requestedAccountId && provider.accounts.some((item) => item.id === requestedAccountId)
      ? requestedAccountId
      : input.provider === "codex" ? undefined : this.resolveAccountId(provider, undefined);
    const account = accountId ? provider.accounts.find((item) => item.id === accountId) : undefined;
    const models = account?.models?.length ? account.models : provider.models;
    // Login providers fetch their model list live, so don't validate against the
    // static catalog; only API providers are restricted to their known models.
    if (!LOGIN_IDS.has(provider.id) && !models.some((model) => model.id === input.model)) throw new Error("선택한 Provider에서 지원하지 않는 모델입니다.");
    return this.withLock(async () => {
      await this.writeSettings({ ...(await this.readSettings()), provider: input.provider, model: input.model, ...(accountId ? { accountId } : { accountId: undefined }) });
      return this.load();
    });
  }

  async saveKey(input: { provider: ProviderId; key: string; accountId?: string; label?: string }): Promise<ProviderSettings> {
    if (LOGIN_IDS.has(input.provider)) throw new Error("이 Provider는 로그인 세션을 사용합니다.");
    const key = input.key.trim();
    if (!key) throw new Error("API 키를 입력하세요.");
    const provider = catalog.find((item) => item.id === input.provider);
    const existingAccounts = await listStoredAccounts(input.provider);
    const existing = input.accountId ? existingAccounts.find((account) => account.id === input.accountId) : undefined;
    const accountId = input.accountId ?? (existingAccounts.length === 0 ? defaultAccountId() : await createAccountId(input.provider, input.label || provider?.label));
    const label = input.label?.trim() || existing?.label || (accountId === defaultAccountId() ? `${provider?.label ?? input.provider} 기본` : `${provider?.label ?? input.provider} ${accountId}`);
    await writeEncryptedText(input.provider, accountId, "credential", key);
    await upsertStoredAccount({ id: accountId, provider: input.provider, label, credentialSource: "keychain", credentialKind: "credential" });
    await this.clearStoredModels(input.provider, accountId, false);
    return this.select({ provider: input.provider, model: provider?.models[0]?.id ?? defaults.model, accountId });
  }

  async clearKey(provider: ProviderId, accountId?: string): Promise<ProviderSettings> {
    await deleteStoredAccount(provider, accountId);
    await this.clearStoredModels(provider, accountId);
    const current = await this.readSettings();
    if (current.provider === provider && (!current.accountId || current.accountId === (accountId ?? defaultAccountId()))) {
      const accounts = await listStoredAccounts(provider);
      await this.writeSettings({ ...current, accountId: accounts[0]?.id, model: current.model });
    }
    return this.load();
  }

  async clearModels(provider: ProviderId, accountId?: string): Promise<ProviderSettings> {
    await this.clearStoredModels(provider, accountId);
    return this.load();
  }

  async saveModels(provider: Exclude<ProviderId, "codex">, models: ProviderInfo["models"], accountId?: string): Promise<ProviderSettings> {
    if (!models.length) throw new Error("Provider에서 사용 가능한 모델을 찾지 못했습니다.");
    return this.withLock(async () => {
      const current = await this.readSettings();
      const id = accountId || current.accountId || defaultAccountId();
      const accountModels = { ...(current.accountModels ?? {}) };
      accountModels[provider] = { ...(accountModels[provider] ?? {}), [id]: withCapabilities(provider, models) };
      const model = current.provider === provider && (!current.accountId || current.accountId === id) && !models.some((item) => item.id === current.model) ? models[0]!.id : current.model;
      await this.writeSettings({ ...current, model, accountModels, models: { ...current.models, [provider]: withCapabilities(provider, models) } });
      return this.load();
    });
  }

  async readApiKey(provider: Exclude<ProviderId, "codex">, accountId?: string): Promise<string> {
    const config = apiProviderConfig(provider);
    const stored = await this.readSettings();
    const id = accountId ?? (stored.provider === provider ? stored.accountId : undefined) ?? (await getStoredAccount(provider))?.id;
    if (id && id !== envAccountId() && id !== localAccountId()) {
      const secret = await readEncryptedText(provider, id, "credential");
      if (secret != null) return secret;
    }
    const envKey = ENV_KEY_NAMES[provider]?.map((name) => process.env[name]?.trim()).find(Boolean);
    if (envKey) return envKey;
    if (config && !config.keyRequired) return "";
    throw new Error(`${catalog.find((item) => item.id === provider)?.label ?? provider} API 키가 설정되지 않았습니다. 설정에서 키를 입력하세요.`);
  }

  private async providerInfo(item: Omit<ProviderInfo, "credentialSource" | "modelsLoaded" | "accounts">, stored: PersistedSettings, activeProvider: ProviderId): Promise<ProviderInfo> {
    const baseModels = stored.models?.[item.id]?.length ? stored.models[item.id]! : item.models;
    const baseLoaded = item.id === "codex" || Boolean(stored.models?.[item.id]?.length);
    const accounts = await this.accountsFor(item, stored);
    const activeAccountId = item.id === activeProvider ? this.resolveAccountId({ ...item, credentialSource: "none", models: [], modelsLoaded: false, accounts }, stored.accountId) : this.resolveAccountId({ ...item, credentialSource: "none", models: [], modelsLoaded: false, accounts }, undefined);
    const activeAccount = activeAccountId ? accounts.find((account) => account.id === activeAccountId) : undefined;
    const models = activeAccount?.models?.length ? activeAccount.models : withCapabilities(item.id, baseModels);
    const modelsLoaded = item.id === "codex" || Boolean(activeAccount?.modelsLoaded || baseLoaded);
    return { ...item, models, modelsLoaded, credentialSource: this.aggregateSource(item.id, accounts), accounts };
  }

  private async accountsFor(item: Omit<ProviderInfo, "credentialSource" | "modelsLoaded" | "accounts">, stored: PersistedSettings): Promise<ProviderAccount[]> {
    const provider = item.id;
    const baseModels = withCapabilities(provider, stored.models?.[provider]?.length ? stored.models[provider]! : item.models);
    const baseLoaded = provider === "codex" || Boolean(stored.models?.[provider]?.length);
    if (provider === "codex") {
      const subject = codexAuthSubject(await readCurrentCodexAuth().catch(() => null) ?? {});
      const codex = virtualAccount({
        provider,
        id: defaultAccountId(),
        label: subject?.email || subject?.label || "Codex CLI",
        email: subject?.email,
        userId: subject?.userId,
        credentialSource: "desktop",
        credentialKind: "desktop",
      });
      return [this.withAccountModels(codex, stored, baseModels, true)];
    }
    const storedAccounts = await listStoredAccounts(provider);
    const accounts = storedAccounts.map((account) => this.withAccountModels(account, stored, baseModels, baseLoaded));
    if (item.kind === "apikey") {
      const env = ENV_KEY_NAMES[provider]?.some((name) => Boolean(process.env[name]?.trim()));
      if (env) accounts.push(this.withAccountModels(virtualAccount({ provider, id: envAccountId(), label: ".env.local", credentialSource: "environment", credentialKind: "environment" }), stored, baseModels, true));
      if (!item.keyRequired && !accounts.some((account) => account.id === localAccountId())) {
        accounts.push(this.withAccountModels(virtualAccount({ provider, id: localAccountId(), label: "로컬 endpoint", credentialSource: "none", credentialKind: "local" }), stored, baseModels, baseLoaded));
      }
    }
    return accounts;
  }

  private withAccountModels(account: ProviderAccount, stored: PersistedSettings, fallbackModels: ProviderInfo["models"], fallbackLoaded: boolean): ProviderAccount {
    const accountModels = stored.accountModels?.[account.provider]?.[account.id];
    const legacyModels = account.id === defaultAccountId() ? stored.models?.[account.provider] : undefined;
    const models = accountModels?.length ? accountModels : legacyModels?.length ? legacyModels : fallbackModels;
    return {
      ...account,
      models: withCapabilities(account.provider, models),
      modelsLoaded: account.provider === "codex" || Boolean(accountModels?.length || legacyModels?.length || account.modelsLoaded || fallbackLoaded),
    };
  }

  private aggregateSource(provider: ProviderId, accounts: ProviderAccount[]): ProviderInfo["credentialSource"] {
    if (provider === "codex") return "desktop";
    if (accounts.some((account) => account.credentialSource === "keychain")) return "keychain";
    if (accounts.some((account) => account.credentialSource === "environment")) return "environment";
    if (accounts.some((account) => account.credentialSource === "desktop")) return "desktop";
    return "none";
  }

  private resolveAccountId(provider: ProviderInfo, requested: string | undefined): string | undefined {
    if (requested && provider.accounts.some((account) => account.id === requested)) return requested;
    return provider.accounts[0]?.id;
  }

  private async migrateLegacySecrets(): Promise<void> {
    await Promise.all(catalog.map((item) => {
      if (item.kind === "apikey" && item.keyRequired) {
        return migrateLegacySecret({ provider: item.id, kind: "credential", label: `${item.label} 기본`, credentialKind: "credential" });
      }
      if (item.kind === "login" && item.id !== "codex") {
        return migrateLegacySecret({ provider: item.id, kind: "oauth", label: `${item.label} 기본`, credentialKind: "oauth" });
      }
      return Promise.resolve();
    }));
  }

  // Callers (saveKey/clearKey/clearModels) don't lock, so locking here is safe
  // (no nesting) and keeps the read-modify-write atomic against refresh writes.
  private async clearStoredModels(provider: ProviderId, accountId?: string, resetSelection = true): Promise<void> {
    await this.withLock(async () => {
      const current = await this.readSettings();
      const id = accountId || current.accountId || defaultAccountId();
      const models = { ...current.models };
      if (id === defaultAccountId()) delete models[provider];
      const accountModels = { ...(current.accountModels ?? {}) };
      if (accountModels[provider]) {
        const nextProviderModels = { ...accountModels[provider] };
        delete nextProviderModels[id];
        if (Object.keys(nextProviderModels).length) accountModels[provider] = nextProviderModels;
        else delete accountModels[provider];
      }
      const resetActive = resetSelection && current.provider === provider && (!current.accountId || current.accountId === id);
      const nextProvider = resetActive ? defaults.provider : current.provider;
      const nextModel = resetActive ? defaults.model : current.model;
      await this.writeSettings({ ...current, provider: nextProvider, model: nextModel, models, accountModels });
    });
  }

  // Serialize read-modify-write cycles. The model picker can fire several
  // refresh-models calls at once; without a lock their interleaved read→write
  // races, and a partial read can fall back to `defaults` and wipe every
  // provider's stored models. The lock turns each mutation atomic end-to-end.
  private writeChain: Promise<unknown> = Promise.resolve();
  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readSettings(): Promise<PersistedSettings> {
    try { return { ...defaults, ...(JSON.parse(await readFile(this.settingsPath(), "utf8")) as Partial<PersistedSettings>) }; }
    catch { return defaults; }
  }

  // Atomic on-disk write (temp file + rename) so a concurrent reader never sees
  // a half-written file and mis-parses it as empty.
  private async writeSettings(value: PersistedSettings): Promise<void> {
    await mkdir(this.root(), { recursive: true });
    const target = this.settingsPath();
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, target);
  }
}
