import { allowedToolNames, namespacedToolName, type AdapterEvent, type OcxAssistantMessage, type OcxContentPart, type OcxParsedRequest, type OcxTool, type OcxToolResultMessage, type OcxUsage } from "./types.cjs";
import { providerErrorMessage } from "./errors.cjs";
import { buildToolCatalogNudge, budgetTools, normalizeGeminiSchema, normalizeSchema, sanitizeName } from "./tool-sanitize.cjs";
import type { ProviderId } from "../contracts.cjs";
import { apiProviderConfig, apiProviderUrl } from "../provider-settings.cjs";

type ApiKeyProvider = Exclude<ProviderId, "codex" | "claude-code" | "copilot" | "antigravity">;

function flatten(parts: { type: string; text?: string }[]): string {
  return parts.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

function parseDataUrl(url: string): { mimeType: string; base64: string } | undefined {
  const match = url.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return undefined;
  return { mimeType: match[1], base64: match[2] };
}

function chatContent(parts: OcxContentPart[], allowImages: boolean): string | Array<Record<string, unknown>> {
  // Text-only models (e.g. DeepSeek) reject `image_url` content — and a single
  // image anywhere in the history fails the whole request. Flatten images to a
  // text placeholder so browser/screenshot history doesn't break the turn.
  if (!allowImages) {
    return parts.map((part) => (part.type === "image" ? "[이미지 생략됨]" : part.text ?? "")).join("");
  }
  if (!parts.some((part) => part.type === "image")) return flatten(parts);
  return parts.map((part) => (
    part.type === "image"
      ? { type: "image_url", image_url: { url: part.dataUrl, ...(part.detail ? { detail: part.detail } : {}) } }
      : { type: "text", text: part.text }
  ));
}

function geminiParts(parts: OcxContentPart[]): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (part.type === "image") {
      const data = parseDataUrl(part.dataUrl);
      return data
        ? { inline_data: { mime_type: data.mimeType, data: data.base64 } }
        : { text: `[image: ${part.dataUrl}]` };
    }
    return { text: part.text };
  });
}

function toolResultWireName(tool: OcxToolResultMessage): string {
  return sanitizeName(namespacedToolName(tool.toolNamespace, tool.toolName || "tool_result"));
}

function wireToolName(tool: OcxTool): string {
  return sanitizeName(namespacedToolName(tool.namespace, tool.name));
}

function wireToolCallName(part: { name: string; namespace?: string }): string {
  return sanitizeName(namespacedToolName(part.namespace, part.name));
}

function selectedTools(parsed: OcxParsedRequest, max: number): OcxTool[] {
  const allowed = allowedToolNames(parsed.options.toolChoice);
  return budgetTools(
    parsed.tools.filter((tool) => !allowed || allowed.has(tool.name) || allowed.has(namespacedToolName(tool.namespace, tool.name))),
    max,
    requiredToolName(parsed),
  );
}

function openAiMessages(parsed: OcxParsedRequest, allowImages: boolean, provider: ApiKeyProvider): unknown[] {
  const out: unknown[] = [];
  let pendingToolCallIds = new Set<string>();
  const nudge = provider !== "openai"
    ? buildToolCatalogNudge(selectedTools(parsed, maxToolsForProvider(provider)).map(wireToolName), parsed.options.toolChoice)
    : undefined;
  const instructions = [parsed.context.instructions, nudge].filter(Boolean).join("\n\n");
  if (instructions) out.push({ role: "system", content: instructions });
  for (const msg of parsed.context.messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: chatContent(msg.content, allowImages) });
      pendingToolCallIds = new Set();
    } else if (msg.role === "developer") {
      out.push({ role: "system", content: flatten(msg.content) });
      pendingToolCallIds = new Set();
    } else if (msg.role === "assistant") {
      const assistant = msg as OcxAssistantMessage;
      const text = assistant.content.filter((part) => part.type === "text").map((part) => (part.type === "text" ? part.text : "")).join("");
      const reasoning = assistant.content.filter((part) => part.type === "thinking").map((part) => (part.type === "thinking" ? part.text : "")).join("");
      const toolCalls = assistant.content
        .filter((part) => part.type === "toolCall")
        .map((part) => part.type === "toolCall" ? { id: part.id, type: "function", function: { name: wireToolCallName(part), arguments: part.arguments || "{}" } } : null)
        .filter(Boolean);
      const preserveReasoning = reasoning.length > 0 && preservesReasoningContent(provider, parsed.model);
      if (text || toolCalls.length || preserveReasoning) {
        out.push({
          role: "assistant",
          content: text || (toolCalls.length || preserveReasoning ? "" : null),
          ...(preserveReasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
      }
      pendingToolCallIds = new Set(toolCalls.map((call) => typeof call === "object" && call ? String((call as { id?: unknown }).id ?? "") : "").filter(Boolean));
    } else if (msg.role === "toolResult") {
      const tool = msg as OcxToolResultMessage;
      const toolCallId = tool.toolCallId || `call_orphan_${out.length}`;
      if (!pendingToolCallIds.has(toolCallId)) {
        out.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: toolCallId, type: "function", function: { name: toolResultWireName(tool), arguments: "{}" } }],
        });
      }
      out.push({ role: "tool", tool_call_id: toolCallId, content: flatten(tool.content) });
      pendingToolCallIds.delete(toolCallId);
    }
  }
  return out;
}

export function googleContents(parsed: OcxParsedRequest): unknown[] {
  const contents: unknown[] = [];
  for (const msg of parsed.context.messages) {
    if (msg.role === "assistant") {
      const assistant = msg as OcxAssistantMessage;
      const parts: Array<Record<string, unknown>> = assistant.content.flatMap((part): Array<Record<string, unknown>> => {
        if (part.type === "text") return [{ text: part.text }];
        if (part.type === "toolCall") {
          let args: unknown = {};
          try { args = JSON.parse(part.arguments || "{}"); } catch { args = {}; }
          return [{ functionCall: { name: wireToolCallName(part), args }, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) }];
        }
        return [];
      });
      if (parts.length) contents.push({ role: "model", parts });
    } else if (msg.role === "toolResult") {
      const tool = msg as OcxToolResultMessage;
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: sanitizeName(namespacedToolName(tool.toolNamespace, tool.toolName || "tool_result")),
            response: { result: flatten(tool.content) },
          },
        }],
      });
    } else {
      contents.push({ role: "user", parts: geminiParts(msg.content) });
    }
  }
  return contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }];
}

export function googleTools(parsed: OcxParsedRequest): unknown[] | undefined {
  const selected = selectedTools(parsed, 24);
  if (!selected.length) return undefined;
  return [{
    functionDeclarations: selected.map((tool) => ({
      name: wireToolName(tool),
      description: tool.description ?? "",
      parameters: normalizeGeminiSchema(tool.parameters),
    })),
  }];
}

function openAiCompatibleBody(parsed: OcxParsedRequest, allowImages: boolean, provider: ApiKeyProvider): Record<string, unknown> {
  const body: Record<string, unknown> = { model: wireModelForProvider(provider, parsed.model), messages: openAiMessages(parsed, allowImages, provider), stream: parsed.stream };
  const toolLimit = maxToolsForProvider(provider);
  const allowed = allowedToolNames(parsed.options.toolChoice);
  const selectedTools = budgetTools(parsed.tools.filter((tool) => !allowed || allowed.has(tool.name) || allowed.has(namespacedToolName(tool.namespace, tool.name))), toolLimit, requiredToolName(parsed));
  if (selectedTools.length) {
    const tools = selectedTools.map((tool) => ({
      type: "function",
      function: {
        name: wireToolName(tool),
        description: tool.description ?? "",
        parameters: toolParametersForProvider(provider, tool.parameters),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));
    if (tools.length) body.tools = tools;
    body.parallel_tool_calls = false;
    const choice = parsed.options.toolChoice;
    if (choice === "auto" || choice === "none" || choice === "required") body.tool_choice = choice === "required" && provider === "moonshot" ? "auto" : choice;
    else if (choice && "name" in choice) body.tool_choice = { type: "function", function: { name: sanitizeName(choice.name) } };
    else if (choice && "allowedTools" in choice) body.tool_choice = choice.mode === "required" ? "required" : "auto";
  }
  if (parsed.options.maxOutputTokens !== undefined) body.max_tokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined && !locksSamplingParameters(provider, parsed.model)) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined && !locksSamplingParameters(provider, parsed.model)) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
  if (parsed.options.reasoning !== undefined && supportsReasoningEffort(provider, parsed.model)) body.reasoning_effort = parsed.options.reasoning === "xhigh" ? "high" : parsed.options.reasoning;
  if (parsed.options.serviceTier !== undefined && provider === "openai") body.service_tier = parsed.options.serviceTier;
  if (parsed.options.presencePenalty !== undefined && !locksSamplingParameters(provider, parsed.model)) body.presence_penalty = parsed.options.presencePenalty;
  if (parsed.options.frequencyPenalty !== undefined && !locksSamplingParameters(provider, parsed.model)) body.frequency_penalty = parsed.options.frequencyPenalty;
  return body;
}

function wireModelForProvider(provider: ApiKeyProvider, model: string): string {
  // Z.AI accepts the context suffix in the catalog but rejects it on the wire.
  return provider === "zai" ? model.replace(/\[[^\]]*\]\s*$/, "") : model;
}

function locksSamplingParameters(provider: ApiKeyProvider, model: string): boolean {
  return provider === "moonshot" || (provider === "opencode-free" && /kimi|deepseek/i.test(model));
}

function preservesReasoningContent(provider: ApiKeyProvider, model: string): boolean {
  if (provider === "deepseek") return !/^deepseek-chat$/i.test(model);
  if (provider === "zai") return /^glm-5(?:\.1|\.2)?/i.test(model);
  if (provider === "moonshot") return /kimi/i.test(model);
  if (provider === "opencode-free") return /deepseek|glm|kimi/i.test(model);
  return false;
}

function stripSchemaMarker(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaMarker);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "encrypted")
    .map(([key, child]) => [key, stripSchemaMarker(child)]));
}

function normalizeXaiSchema(schema: unknown): Record<string, unknown> {
  const input = stripSchemaMarker(schema);
  if (!input || typeof input !== "object" || Array.isArray(input)) return { type: "object", properties: {} };
  const root = input as Record<string, unknown>;
  const composition = Array.isArray(root.oneOf) ? "oneOf" : Array.isArray(root.anyOf) ? "anyOf" : undefined;
  if (!composition) return { ...root, type: "object" };
  const siblings = Object.fromEntries(Object.entries(root).filter(([key]) => key !== composition && key !== "type"));
  const variants = (root[composition] as unknown[]).flatMap((branch) => {
    if (!branch || typeof branch !== "object" || Array.isArray(branch)) return [];
    return [{ ...siblings, ...(branch as Record<string, unknown>), type: "object" }];
  });
  return variants.length ? { ...siblings, [composition]: variants, type: "object" } : { type: "object", properties: {} };
}

function normalizeZenSchema(schema: unknown): Record<string, unknown> {
  const input = stripSchemaMarker(schema);
  const out = normalizeSchema(input) as Record<string, unknown>;
  if (out.type === "object") return out;
  return { ...out, type: "object" };
}

function toolParametersForProvider(provider: ApiKeyProvider, schema: unknown): Record<string, unknown> {
  if (provider === "xai") return normalizeXaiSchema(schema);
  if (provider === "opencode-free") return normalizeZenSchema(schema);
  return normalizeSchema(schema);
}

function requiredToolName(parsed: OcxParsedRequest): string | undefined {
  const choice = parsed.options.toolChoice;
  return choice && typeof choice === "object" && "name" in choice ? choice.name : undefined;
}

function maxToolsForProvider(provider: ApiKeyProvider): number {
  // Keep external provider prompts lean: expose tool_search first, then loaded
  // tools, then a small core set. Full catalog forwarding is too expensive for
  // low-TPM providers and makes fresh chats fail before user text matters.
  if (provider === "groq") return 2;
  if (provider === "deepseek" || provider === "cerebras" || provider === "moonshot" || provider === "zai") return 12;
  if (provider === "openai") return 64;
  return 24;
}

export function buildApiKeyRequest(provider: ApiKeyProvider, parsed: OcxParsedRequest, key: string): { url: string; headers: Record<string, string>; body: string } {
  const config = apiProviderConfig(provider);
  if (!config) throw new Error(`지원하지 않는 Provider입니다: ${provider}`);
  if (config.adapter === "openai-chat") {
    return {
      url: apiProviderUrl(provider, "/chat/completions"),
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(config.headers ?? {}), "Content-Type": "application/json" },
      body: JSON.stringify(openAiCompatibleBody(parsed, config.allowImages, provider)),
    };
  }
  if (config.adapter === "anthropic") throw new Error(`${provider}는 Anthropic adapter를 사용해야 합니다.`);
  return {
    url: `${apiProviderUrl(provider, `/v1beta/models/${encodeURIComponent(parsed.model)}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(key)}`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildGoogleGenerateContentBody(parsed)),
  };
}

export function buildGoogleGenerateContentBody(parsed: OcxParsedRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};
  if (parsed.options.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined) generationConfig.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) generationConfig.topP = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) generationConfig.stopSequences = parsed.options.stopSequences;
  const tools = googleTools(parsed);
  const nudge = buildToolCatalogNudge(
    selectedTools(parsed, 24).map(wireToolName),
    parsed.options.toolChoice,
  );
  const instructions = [parsed.context.instructions, nudge].filter(Boolean).join("\n\n");
  return {
    contents: googleContents(parsed),
    ...(instructions ? { systemInstruction: { parts: [{ text: instructions }] } } : {}),
    ...(tools ? { tools } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

function supportsReasoningEffort(provider: ApiKeyProvider, model: string): boolean {
  if (provider === "deepseek" && /^deepseek-chat$/i.test(model)) return false;
  if (provider === "moonshot") return false;
  if (provider === "groq" || provider === "mistral" || provider === "cerebras" || provider === "together" || provider === "fireworks" || provider === "huggingface" || provider === "nvidia" || provider === "openrouter" || provider === "openrouter-free" || provider === "ollama" || provider === "vllm" || provider === "lm-studio") return false;
  if (provider === "xai") return !/grok-build|composer/i.test(model);
  return provider === "openai" || provider === "deepseek" || provider === "zai";
}

export async function* streamOpenAiCompatible(providerLabel: string, response: Response): AsyncGenerator<AdapterEvent> {
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = await response.text(); } catch { /* ignore */ }
    yield { type: "error", status: response.status, errorType: "upstream_error", message: providerErrorMessage(providerLabel, response.status, detail) };
    return;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    yield* parseOpenAiCompatibleJson(providerLabel, response);
    return;
  }
  if (!response.body) { yield { type: "error", status: 502, errorType: "upstream_empty_response", message: `${providerLabel}가 응답 본문 없이 요청을 종료했습니다.` }; return; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: OcxUsage | undefined;
  const tools = new Map<number, { started: boolean }>();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let data: Record<string, unknown>;
        try { data = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        const err = data.error as { message?: string; code?: string; type?: string } | undefined;
        if (err) {
          yield { type: "error", status: 502, errorType: err.type ?? "upstream_error", message: `${providerLabel} 스트림 오류: ${err.message ?? err.code ?? "알 수 없는 오류"}` };
          return;
        }
        const u = data.usage as Record<string, number> | undefined;
        if (u) usage = openAiCompatibleUsage(u);
        const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
        const delta = choice?.delta as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", text: delta.content };
          const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          if (tcs) for (const tc of tcs) {
            const idx = Number(tc.index ?? 0);
            const fn = tc.function as { name?: string; arguments?: string } | undefined;
            if (!tools.get(idx)?.started) {
              tools.set(idx, { started: true });
              yield { type: "tool_call_start", id: String(tc.id ?? `call_${idx}`), name: fn?.name ?? "" };
            }
            if (fn?.arguments) yield { type: "tool_call_delta", arguments: fn.arguments };
          }
        }
        if (choice?.finish_reason && tools.size) yield { type: "tool_call_end" };
      }
    }
    yield { type: "done", usage };
  } finally {
    reader.releaseLock();
  }
}

async function* parseOpenAiCompatibleJson(providerLabel: string, response: Response): AsyncGenerator<AdapterEvent> {
  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch (error) {
    yield { type: "error", status: 502, errorType: "upstream_invalid_json", message: `${providerLabel}가 JSON 응답을 반환하지 않았습니다: ${error instanceof Error ? error.message : String(error)}` };
    return;
  }
  const err = data.error as { message?: string; code?: string; type?: string } | undefined;
  if (err) {
    yield { type: "error", status: 502, errorType: err.type ?? "upstream_error", message: `${providerLabel} 응답 오류: ${err.message ?? err.code ?? "알 수 없는 오류"}` };
    return;
  }
  const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (message) {
    if (typeof message.content === "string" && message.content) yield { type: "text_delta", text: message.content };
    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) for (const [index, tc] of toolCalls.entries()) {
      const fn = tc.function as { name?: string; arguments?: string } | undefined;
      yield { type: "tool_call_start", id: String(tc.id ?? `call_${index}`), name: fn?.name ?? "" };
      if (fn?.arguments) yield { type: "tool_call_delta", arguments: fn.arguments };
      yield { type: "tool_call_end" };
    }
  }
  const usage = data.usage as Record<string, number> | undefined;
  yield { type: "done", usage: usage ? openAiCompatibleUsage(usage) : undefined };
}

// OpenAI-compatible providers report cache hits in different fields:
// prompt_tokens_details.cached_tokens (OpenAI-style) or prompt_cache_hit_tokens
// (DeepSeek). Without this, proxied turns show cached=0 and Devil's usage/cost
// summaries price the whole prompt at the uncached input rate.
function openAiCompatibleUsage(u: Record<string, unknown>): { inputTokens: number; outputTokens: number; cachedInputTokens?: number } {
  const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = num(details?.cached_tokens) || num(u.prompt_cache_hit_tokens);
  return {
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    ...(cached ? { cachedInputTokens: cached } : {}),
  };
}

export async function* streamGoogle(response: Response, options: { label?: string; unwrapResponse?: boolean } = {}): AsyncGenerator<AdapterEvent> {
  const label = options.label ?? "Google Gemini";
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = await response.text(); } catch { /* ignore */ }
    yield { type: "error", status: response.status, errorType: "upstream_error", message: providerErrorMessage(label, response.status, detail) };
    return;
  }
  if (!response.body) { yield { type: "error", status: 502, errorType: "upstream_empty_response", message: `${label}가 응답 본문 없이 요청을 종료했습니다.` }; return; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: OcxUsage | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload) continue;
        let data: Record<string, unknown>;
        try { data = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        const root = options.unwrapResponse ? (data.response as Record<string, unknown> | undefined) ?? data : data;
        const error = (data.error ?? root.error) as { message?: string; code?: number; status?: string } | undefined;
        if (error) {
          yield { type: "error", status: error.code ?? 502, errorType: error.status ?? "upstream_error", message: providerErrorMessage(label, error.code ?? 502, error.message ?? error.status ?? "스트림 오류") };
          return;
        }
        const candidate = (root.candidates as Array<Record<string, unknown>> | undefined)?.[0];
        const parts = (candidate?.content as Record<string, unknown> | undefined)?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const record = part as Record<string, unknown>;
            const fn = record.functionCall as Record<string, unknown> | undefined;
            if (fn?.name) {
              const thoughtSignature = typeof record.thoughtSignature === "string"
                ? record.thoughtSignature
                : typeof record.thought_signature === "string"
                  ? record.thought_signature
                  : typeof fn.thoughtSignature === "string"
                    ? fn.thoughtSignature
                    : typeof fn.thought_signature === "string"
                      ? fn.thought_signature
                      : undefined;
              yield { type: "tool_call_start", id: `call_${crypto.randomUUID().replace(/-/g, "")}`, name: String(fn.name), ...(thoughtSignature ? { thoughtSignature } : {}) };
              yield { type: "tool_call_delta", arguments: JSON.stringify(fn.args ?? {}) };
              yield { type: "tool_call_end" };
            }
            const text = record.thought === true ? "" : String(record.text ?? "");
            if (text) yield { type: "text_delta", text };
          }
        }
        const u = root.usageMetadata as Record<string, number> | undefined;
        if (u) usage = { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0 };
      }
    }
    yield { type: "done", usage };
  } finally {
    reader.releaseLock();
  }
}
