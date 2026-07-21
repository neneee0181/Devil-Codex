import type { ProviderId } from "../contracts.cjs";

const DEEPSEEK_THINKING_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const OPENCODE_FREE_DEEPSEEK_MODELS = new Set(["deepseek-v4-flash-free"]);
const ZAI_GLM_52_MODELS = new Set(["glm-5.2", "glm-5.2[1m]"]);
const NVIDIA_KIMI_MODELS = new Set([
  "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.5",
  "moonshotai/kimi-k2-thinking",
  "moonshotai/kimi-k2-instruct",
  "moonshotai/kimi-k2-instruct-0905",
]);
const NVIDIA_KIMI_THINKING_MODELS = new Set([
  "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.5",
  "moonshotai/kimi-k2-thinking",
]);
const XAI_NO_REASONING_MODELS = new Set([
  "grok-4.20-0309-non-reasoning",
  "grok-build-0.1",
  "grok-composer-2.5-fast",
]);
const XAI_REASONING_HISTORY_MODELS = new Set([
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-multi-agent-0309",
  "grok-4.20-0309-reasoning",
]);
const MOONSHOT_LEGACY_MODELS = new Set([
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
]);
const MOONSHOT_AUTO_TOOL_MODELS = new Set(["kimi-k2.7-code", "kimi-k2.7-code-highspeed"]);
const KIMI_K3_MODELS = new Set(["k3", "k3[1m]"]);
const KIMI_LEGACY_MODELS = new Set([
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
  "kimi-for-coding",
]);
const KIMI_AUTO_TOOL_MODELS = new Set(["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-for-coding"]);

const DEFAULT_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];

function folded(model: string): string { return model.trim().toLowerCase(); }

/**
 * Codex-visible effort ladder. `undefined` means the provider/model is unknown and should use
 * the routed default ladder; `[]` intentionally disables the picker and wire parameter.
 */
export function providerReasoningEfforts(provider: ProviderId, model: string): string[] | undefined {
  const id = folded(model);
  if (provider === "deepseek" && DEEPSEEK_THINKING_MODELS.has(id)) return ["high", "xhigh", "max", "ultra"];
  if (provider === "opencode-free" && OPENCODE_FREE_DEEPSEEK_MODELS.has(id)) return ["high", "xhigh", "max", "ultra"];
  if (provider === "zai" && ZAI_GLM_52_MODELS.has(id)) return [...DEFAULT_REASONING_LEVELS];
  if (provider === "kimi") return KIMI_K3_MODELS.has(id) ? ["low", "high", "max", "ultra"] : KIMI_LEGACY_MODELS.has(id) ? [] : undefined;
  if (provider === "moonshot") return id === "kimi-k3" ? ["max", "ultra"] : MOONSHOT_LEGACY_MODELS.has(id) ? [] : undefined;
  if (provider === "nvidia" && NVIDIA_KIMI_MODELS.has(id)) return [];
  if (provider === "xai") {
    if (XAI_NO_REASONING_MODELS.has(id)) return [];
    if (id === "grok-4.5") return ["low", "medium", "high", "max", "ultra"];
  }
  if (provider === "google") {
    if (id === "gemini-3.5-flash") return ["low", "medium", "high", "max", "ultra"];
    if (id === "gemini-3.1-pro-preview") return ["low", "medium", "high", "max", "ultra"];
  }
  return undefined;
}

export function mapProviderReasoningEffort(provider: ProviderId, model: string, requested: string | undefined): string | undefined {
  if (!requested || requested === "none") return undefined;
  const id = folded(model);
  const supported = providerReasoningEfforts(provider, id);
  if (supported?.length === 0) return undefined;
  const boundary = requested === "ultra" ? "max" : requested === "minimal" ? "low" : requested;
  if ((provider === "deepseek" && DEEPSEEK_THINKING_MODELS.has(id))
    || (provider === "opencode-free" && OPENCODE_FREE_DEEPSEEK_MODELS.has(id))) {
    return boundary === "xhigh" || boundary === "max" ? "max" : "high";
  }
  if (provider === "xai" && id === "grok-4.5" && (boundary === "xhigh" || boundary === "max")) return "high";
  if (provider === "kimi" && KIMI_K3_MODELS.has(id)) {
    if (boundary === "medium" || boundary === "high") return "high";
    if (boundary === "xhigh" || boundary === "max") return "max";
    return "low";
  }
  if (supported?.length) {
    const wireLevels = supported.filter((effort) => effort !== "ultra");
    if (wireLevels.includes(boundary)) return boundary;
    const order = ["low", "medium", "high", "xhigh", "max"];
    const requestedRank = order.indexOf(boundary);
    const candidates = wireLevels.filter((effort) => order.indexOf(effort) <= requestedRank);
    return candidates.at(-1) ?? wireLevels[0];
  }
  return boundary;
}

export function providerPreservesReasoning(provider: ProviderId, model: string): boolean {
  const id = folded(model);
  if (provider === "deepseek") return DEEPSEEK_THINKING_MODELS.has(id);
  if (provider === "opencode-free") return OPENCODE_FREE_DEEPSEEK_MODELS.has(id);
  if (provider === "zai") return ZAI_GLM_52_MODELS.has(id);
  if (provider === "kimi") return KIMI_K3_MODELS.has(id) || KIMI_LEGACY_MODELS.has(id);
  if (provider === "moonshot") return id === "kimi-k3" || MOONSHOT_LEGACY_MODELS.has(id);
  if (provider === "nvidia") return NVIDIA_KIMI_THINKING_MODELS.has(id);
  if (provider === "xai") return XAI_REASONING_HISTORY_MODELS.has(id);
  return false;
}

export function providerLocksSampling(provider: ProviderId, model: string): boolean {
  if (provider !== "moonshot" && provider !== "kimi") return false;
  const id = folded(model);
  return provider === "kimi" ? KIMI_K3_MODELS.has(id) || KIMI_LEGACY_MODELS.has(id) : id === "kimi-k3" || MOONSHOT_LEGACY_MODELS.has(id);
}

export function providerAutoToolChoiceOnly(provider: ProviderId, model: string): boolean {
  return (provider === "moonshot" && MOONSHOT_AUTO_TOOL_MODELS.has(folded(model)))
    || (provider === "kimi" && KIMI_AUTO_TOOL_MODELS.has(folded(model)));
}

/** OpenCodex defaults OpenAI-chat transports on; NVIDIA NIM Kimi is the documented opt-out. */
export function providerParallelToolCalls(provider: ProviderId): boolean {
  if (provider === "nvidia") return false;
  return provider !== "anthropic" && provider !== "google" && provider !== "antigravity" && provider !== "claude-code";
}

/** `undefined` leaves discovery/config metadata authoritative. */
export function providerNativeImageInput(provider: ProviderId, model: string): boolean | undefined {
  const id = folded(model);
  if (provider === "anthropic" || provider === "claude-code" || provider === "google" || provider === "antigravity" || provider === "copilot") return true;
  if (provider === "deepseek" || provider === "zai") return false;
  // OpenCodex marks only its DeepSeek free route as no-vision; other live Zen
  // free models are allowed to receive native image_url parts.
  if (provider === "opencode-free") return !OPENCODE_FREE_DEEPSEEK_MODELS.has(id);
  if (provider === "kimi") return KIMI_K3_MODELS.has(id);
  if (provider === "moonshot") return id === "kimi-k3";
  if (provider === "xai") return id !== "grok-build-0.1" && id !== "grok-composer-2.5-fast";
  return undefined;
}

/** Known provider caps from the OpenCodex registry. Unknown models use a conservative catalog cap. */
export function providerContextWindow(provider: ProviderId, model: string): number | undefined {
  const id = folded(model);
  if (provider === "antigravity") {
    if (/gemini/.test(id)) return 1_048_576;
    if (id === "claude-opus-4-6-thinking") return 1_000_000;
    if (id === "claude-sonnet-4-6") return 200_000;
    if (id === "gpt-oss-120b-medium") return 131_072;
  }
  if (provider === "claude-code" || provider === "anthropic") {
    if (/claude-(?:sonnet-5|fable-5|opus-4-(?:8|7|6))/.test(id)) return 1_000_000;
    return 200_000;
  }
  if (provider === "google" && /gemini/.test(id)) return 1_000_000;
  if (provider === "deepseek" && DEEPSEEK_THINKING_MODELS.has(id)) return 1_000_000;
  if (provider === "opencode-free" && OPENCODE_FREE_DEEPSEEK_MODELS.has(id)) return 1_000_000;
  if (provider === "zai") {
    if (ZAI_GLM_52_MODELS.has(id)) return 1_000_000;
    if (/^glm-5(?:\.1)?$/.test(id)) return 202_752;
  }
  if (provider === "kimi") return id === "k3[1m]" ? 1_048_576 : KIMI_K3_MODELS.has(id) || KIMI_LEGACY_MODELS.has(id) ? 262_144 : undefined;
  if (provider === "moonshot") return id === "kimi-k3" ? 1_048_576 : MOONSHOT_LEGACY_MODELS.has(id) ? 262_144 : undefined;
  if (provider === "xai") {
    if (id === "grok-4.5") return 500_000;
    if (/^grok-4\.(?:3|20)/.test(id)) return 1_000_000;
    if (id === "grok-build-0.1") return 256_000;
  }
  if (provider === "openrouter") {
    if (id === "anthropic/claude-sonnet-5" || /^openai\/gpt-5\.6-(?:sol|terra|luna)$/.test(id)) return 1_050_000;
  }
  if (provider === "openrouter-free" && id === "openrouter/free") return 200_000;
  if (provider === "openai") {
    if (/^gpt-5\.6-(?:sol|terra|luna)$/.test(id)) return 372_000;
    if (id === "gpt-5.5" || id === "gpt-5.4") return 1_050_000;
    if (id === "gpt-5.4-mini") return 400_000;
  }
  return undefined;
}
