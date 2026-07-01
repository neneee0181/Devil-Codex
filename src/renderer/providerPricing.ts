import type { ProviderId, ProviderTokenUsage } from "../shared/contracts";

export type UsagePricing = { input: number; output: number; cachedInput?: number; label: string };

const FREE_PRICING: UsagePricing = { input: 0, output: 0, cachedInput: 0, label: "Free/local" };

function has(id: string, ...patterns: string[]): boolean {
  return patterns.some((pattern) => id.includes(pattern));
}

function openAiPricing(id: string): UsagePricing | null {
  if (has(id, "gpt-oss-120b")) return { input: 0.15, output: 0.6, cachedInput: 0.075, label: "GPT-OSS 120B" };
  if (has(id, "gpt-oss-20b")) return { input: 0.075, output: 0.3, cachedInput: 0.0375, label: "GPT-OSS 20B" };
  if (has(id, "gpt-5.5-pro")) return { input: 15, output: 90, label: "OpenAI GPT-5.5 Pro" };
  if (has(id, "gpt-5.4-pro")) return { input: 15, output: 90, label: "OpenAI GPT-5.4 Pro" };
  if (has(id, "gpt-5.5")) return { input: 2.5, output: 15, cachedInput: 0.25, label: "OpenAI GPT-5.5" };
  if (has(id, "gpt-5.4-mini")) return { input: 0.375, output: 2.25, cachedInput: 0.0375, label: "OpenAI GPT-5.4 mini" };
  if (has(id, "gpt-5.4-nano")) return { input: 0.1, output: 0.625, cachedInput: 0.01, label: "OpenAI GPT-5.4 nano" };
  if (has(id, "gpt-5.4")) return { input: 1.25, output: 7.5, cachedInput: 0.13, label: "OpenAI GPT-5.4" };
  if (has(id, "gpt-5-mini")) return { input: 0.25, output: 2, cachedInput: 0.025, label: "OpenAI GPT-5 mini" };
  if (has(id, "gpt-5-nano")) return { input: 0.05, output: 0.4, cachedInput: 0.005, label: "OpenAI GPT-5 nano" };
  if (has(id, "gpt-5")) return { input: 1.25, output: 10, cachedInput: 0.125, label: "OpenAI GPT-5" };
  if (has(id, "gpt-4.1-mini")) return { input: 0.4, output: 1.6, cachedInput: 0.1, label: "OpenAI GPT-4.1 mini" };
  if (has(id, "gpt-4.1-nano")) return { input: 0.1, output: 0.4, cachedInput: 0.025, label: "OpenAI GPT-4.1 nano" };
  if (has(id, "gpt-4.1")) return { input: 2, output: 8, cachedInput: 0.5, label: "OpenAI GPT-4.1" };
  return null;
}

function anthropicPricing(id: string): UsagePricing | null {
  if (has(id, "fable", "mythos")) return { input: 10, output: 50, cachedInput: 1, label: "Claude Fable/Mythos" };
  if (has(id, "opus")) return { input: 5, output: 25, cachedInput: 0.5, label: "Claude Opus" };
  if (has(id, "sonnet-5")) return { input: 2, output: 10, cachedInput: 0.2, label: "Claude Sonnet 5 introductory" };
  if (has(id, "haiku")) return { input: 1, output: 5, cachedInput: 0.1, label: "Claude Haiku" };
  if (has(id, "sonnet", "claude")) return { input: 3, output: 15, cachedInput: 0.3, label: "Claude Sonnet" };
  return null;
}

function googlePricing(id: string): UsagePricing | null {
  if (has(id, "gemini-3.5-flash")) return { input: 1.5, output: 9, cachedInput: 0.15, label: "Gemini 3.5 Flash" };
  if (has(id, "gemini-3.1-pro", "gemini-pro-agent")) return { input: 2, output: 12, cachedInput: 0.2, label: "Gemini 3.1 Pro" };
  if (has(id, "gemini-3.1-flash-lite")) return { input: 0.25, output: 1.5, cachedInput: 0.025, label: "Gemini 3.1 Flash-Lite" };
  if (has(id, "gemini-3-flash")) return { input: 0.5, output: 3, cachedInput: 0.05, label: "Gemini 3 Flash" };
  if (has(id, "gemini-2.5-pro")) return { input: 1.25, output: 10, cachedInput: 0.125, label: "Gemini 2.5 Pro" };
  if (has(id, "flash-lite")) return { input: 0.1, output: 0.4, cachedInput: 0.01, label: "Gemini Flash-Lite" };
  if (has(id, "flash")) return { input: 0.3, output: 2.5, cachedInput: 0.03, label: "Gemini Flash" };
  if (has(id, "pro")) return { input: 1.25, output: 10, cachedInput: 0.125, label: "Gemini Pro" };
  return null;
}

function deepSeekPricing(id: string): UsagePricing | null {
  if (has(id, "v4-pro")) return { input: 0.435, output: 0.87, cachedInput: 0.003625, label: "DeepSeek V4 Pro" };
  if (has(id, "deepseek", "v4-flash")) return { input: 0.14, output: 0.28, cachedInput: 0.0028, label: "DeepSeek V4 Flash" };
  return null;
}

function xaiPricing(id: string): UsagePricing | null {
  if (has(id, "grok-code-fast", "grok-build")) return { input: 1, output: 2, label: "xAI Grok coding" };
  if (has(id, "grok")) return { input: 1.25, output: 2.5, label: "xAI Grok" };
  return null;
}

function groqPricing(id: string): UsagePricing | null {
  if (has(id, "gpt-oss-120b")) return { input: 0.15, output: 0.6, cachedInput: 0.075, label: "Groq GPT-OSS 120B" };
  if (has(id, "gpt-oss-20b")) return { input: 0.075, output: 0.3, cachedInput: 0.0375, label: "Groq GPT-OSS 20B" };
  if (has(id, "llama-3.3-70b")) return { input: 0.59, output: 0.79, label: "Groq Llama 3.3 70B" };
  if (has(id, "llama-3.1-8b")) return { input: 0.05, output: 0.08, label: "Groq Llama 3.1 8B" };
  return null;
}

function mistralPricing(id: string): UsagePricing | null {
  if (has(id, "codestral")) return { input: 0.3, output: 0.9, label: "Mistral Codestral" };
  if (has(id, "devstral-small")) return { input: 0.1, output: 0.3, label: "Mistral Devstral Small" };
  if (has(id, "devstral")) return { input: 0.4, output: 2, label: "Mistral Devstral" };
  if (has(id, "mistral-medium")) return { input: 1.5, output: 7.5, label: "Mistral Medium" };
  if (has(id, "mistral-large")) return { input: 0.5, output: 1.5, label: "Mistral Large" };
  if (has(id, "mistral-small")) return { input: 0.15, output: 0.6, label: "Mistral Small" };
  if (has(id, "magistral-medium")) return { input: 2, output: 5, label: "Mistral Magistral Medium" };
  if (has(id, "magistral-small")) return { input: 0.5, output: 1.5, label: "Mistral Magistral Small" };
  return null;
}

function togetherPricing(id: string): UsagePricing | null {
  if (has(id, "kimi-k2.7-code")) return { input: 0.95, output: 4, cachedInput: 0.19, label: "Together Kimi K2.7 Code" };
  if (has(id, "kimi-k2.6")) return { input: 1.2, output: 4.5, cachedInput: 0.2, label: "Together Kimi K2.6" };
  if (has(id, "deepseek-v4-pro")) return { input: 1.74, output: 3.48, cachedInput: 0.2, label: "Together DeepSeek V4 Pro" };
  if (has(id, "gpt-oss-120b")) return { input: 0.15, output: 0.6, label: "Together GPT-OSS 120B" };
  if (has(id, "gpt-oss-20b")) return { input: 0.05, output: 0.2, label: "Together GPT-OSS 20B" };
  if (has(id, "llama-3.3-70b")) return { input: 1.04, output: 1.04, label: "Together Llama 3.3 70B" };
  if (has(id, "llama-3-8b", "llama-3.1-8b")) return { input: 0.14, output: 0.14, label: "Together Llama 8B" };
  return null;
}

function fireworksPricing(id: string): UsagePricing | null {
  if (has(id, "kimi")) return { input: 0.95, output: 4, cachedInput: 0.475, label: "Fireworks Kimi" };
  if (has(id, "deepseek-v4-pro")) return { input: 1.74, output: 3.48, label: "Fireworks DeepSeek V4 Pro" };
  if (has(id, "deepseek-v4-flash")) return { input: 0.14, output: 0.28, label: "Fireworks DeepSeek V4 Flash" };
  if (has(id, "gpt-oss-120b")) return { input: 0.15, output: 0.6, cachedInput: 0.075, label: "Fireworks GPT-OSS 120B" };
  if (has(id, "gpt-oss-20b")) return { input: 0.07, output: 0.3, cachedInput: 0.035, label: "Fireworks GPT-OSS 20B" };
  return null;
}

function moonshotPricing(id: string): UsagePricing | null {
  if (has(id, "kimi-k2.7-code")) return { input: 0.95, output: 4, cachedInput: 0.19, label: "Kimi K2.7 Code" };
  if (has(id, "kimi-k2.6")) return { input: 1.2, output: 4.5, cachedInput: 0.2, label: "Kimi K2.6" };
  if (has(id, "kimi")) return { input: 0.95, output: 4, cachedInput: 0.19, label: "Kimi" };
  return null;
}

function nvidiaPricing(id: string): UsagePricing | null {
  if (has(id, "llama-3.3-70b")) return { input: 0.71, output: 0.71, label: "NVIDIA NIM Llama 3.3 70B" };
  return null;
}

function routedPricing(id: string): UsagePricing | null {
  return anthropicPricing(id)
    ?? googlePricing(id)
    ?? deepSeekPricing(id)
    ?? xaiPricing(id)
    ?? mistralPricing(id)
    ?? moonshotPricing(id)
    ?? openAiPricing(id)
    ?? togetherPricing(id)
    ?? groqPricing(id);
}

export function pricingForProviderModel(provider: ProviderId | "unknown", model: string): UsagePricing | null {
  const id = model.toLowerCase().trim();
  if (!id) return null;
  if (provider === "openrouter-free" || id === "openrouter/free" || id.endsWith(":free")) return FREE_PRICING;
  if (provider === "ollama" || provider === "vllm" || provider === "lm-studio" || provider === "cerebras") return FREE_PRICING;
  if (provider === "openai" || provider === "codex" || provider === "copilot") return routedPricing(id) ?? openAiPricing(id);
  if (provider === "anthropic" || provider === "claude-code") return anthropicPricing(id);
  if (provider === "google" || provider === "antigravity") return routedPricing(id) ?? googlePricing(id);
  if (provider === "deepseek") return deepSeekPricing(id);
  if (provider === "xai") return xaiPricing(id);
  if (provider === "groq") return groqPricing(id);
  if (provider === "mistral") return mistralPricing(id);
  if (provider === "together") return togetherPricing(id);
  if (provider === "fireworks") return fireworksPricing(id);
  if (provider === "moonshot") return moonshotPricing(id);
  if (provider === "nvidia") return nvidiaPricing(id);
  if (provider === "openrouter" || provider === "huggingface") return routedPricing(id);
  return routedPricing(id);
}

export function estimateProviderUsageCost(provider: ProviderId | "unknown", model: string, usage: ProviderTokenUsage): { cost: number; pricedTokens: number } {
  const pricing = pricingForProviderModel(provider, model);
  if (!pricing) return { cost: 0, pricedTokens: 0 };
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const inputCost = uncachedInput * pricing.input / 1_000_000;
  const cachedCost = cached * (pricing.cachedInput ?? pricing.input) / 1_000_000;
  const outputCost = usage.outputTokens * pricing.output / 1_000_000;
  return { cost: inputCost + cachedCost + outputCost, pricedTokens: usage.inputTokens + usage.outputTokens };
}
