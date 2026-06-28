import { namespacedToolName, type AdapterEvent, type OcxAssistantMessage, type OcxContentPart, type OcxParsedRequest, type OcxTool, type OcxToolResultMessage, type OcxUsage } from "./types.cjs";
import { providerErrorMessage } from "./errors.cjs";
import { budgetTools, normalizeGeminiSchema, normalizeSchema, sanitizeName } from "./tool-sanitize.cjs";
import type { ProviderId } from "../contracts.cjs";
import { apiProviderConfig, apiProviderUrl } from "../provider-settings.cjs";

type ApiKeyProvider = Exclude<ProviderId, "codex" | "claude-code" | "copilot">;

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

function openAiMessages(parsed: OcxParsedRequest, allowImages: boolean): unknown[] {
  const out: unknown[] = [];
  let pendingToolCallIds = new Set<string>();
  if (parsed.context.instructions) out.push({ role: "system", content: parsed.context.instructions });
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
      const toolCalls = assistant.content
        .filter((part) => part.type === "toolCall")
        .map((part) => part.type === "toolCall" ? { id: part.id, type: "function", function: { name: wireToolCallName(part), arguments: part.arguments || "{}" } } : null)
        .filter(Boolean);
      if (text || toolCalls.length) out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
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

function googleContents(parsed: OcxParsedRequest): unknown[] {
  const contents: unknown[] = [];
  for (const msg of parsed.context.messages) {
    if (msg.role === "assistant") {
      const assistant = msg as OcxAssistantMessage;
      const parts: Array<Record<string, unknown>> = assistant.content.flatMap((part): Array<Record<string, unknown>> => {
        if (part.type === "text") return [{ text: part.text }];
        if (part.type === "toolCall") {
          let args: unknown = {};
          try { args = JSON.parse(part.arguments || "{}"); } catch { args = {}; }
          return [{ functionCall: { name: wireToolCallName(part), args } }];
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

function googleTools(parsed: OcxParsedRequest): unknown[] | undefined {
  const selected = budgetTools(parsed.tools, 24, requiredToolName(parsed));
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
  const body: Record<string, unknown> = { model: parsed.model, messages: openAiMessages(parsed, allowImages), stream: parsed.stream };
  const toolLimit = maxToolsForProvider(provider);
  const selectedTools = budgetTools(parsed.tools, toolLimit, requiredToolName(parsed));
  if (selectedTools.length) {
    const tools = selectedTools.map((tool) => ({
      type: "function",
      function: {
        name: wireToolName(tool),
        description: tool.description ?? "",
        parameters: normalizeSchema(tool.parameters),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));
    if (tools.length) body.tools = tools;
    body.parallel_tool_calls = false;
    const choice = parsed.options.toolChoice;
    if (choice === "auto" || choice === "none" || choice === "required") body.tool_choice = choice;
    else if (choice && "name" in choice) body.tool_choice = { type: "function", function: { name: sanitizeName(choice.name) } };
  }
  if (parsed.options.maxOutputTokens !== undefined) body.max_tokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
  if (parsed.options.reasoning !== undefined && supportsReasoningEffort(provider, parsed.model)) body.reasoning_effort = parsed.options.reasoning === "xhigh" ? "high" : parsed.options.reasoning;
  if (parsed.options.serviceTier !== undefined && provider === "openai") body.service_tier = parsed.options.serviceTier;
  if (parsed.options.presencePenalty !== undefined) body.presence_penalty = parsed.options.presencePenalty;
  if (parsed.options.frequencyPenalty !== undefined) body.frequency_penalty = parsed.options.frequencyPenalty;
  return body;
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
  if (provider === "deepseek" || provider === "cerebras" || provider === "moonshot") return 12;
  if (provider === "openai") return 64;
  return 24;
}

export function buildApiKeyRequest(provider: ApiKeyProvider, parsed: OcxParsedRequest, key: string): { url: string; headers: Record<string, string>; body: string } {
  const config = apiProviderConfig(provider);
  if (!config) throw new Error(`지원하지 않는 Provider입니다: ${provider}`);
  if (config.adapter === "openai-chat") {
    return {
      url: apiProviderUrl(provider, "/chat/completions"),
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(openAiCompatibleBody(parsed, config.allowImages, provider)),
    };
  }
  if (config.adapter === "anthropic") throw new Error(`${provider}는 Anthropic adapter를 사용해야 합니다.`);
  const generationConfig: Record<string, unknown> = {};
  if (parsed.options.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined) generationConfig.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) generationConfig.topP = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) generationConfig.stopSequences = parsed.options.stopSequences;
  return {
    url: `${apiProviderUrl(provider, `/v1beta/models/${encodeURIComponent(parsed.model)}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(key)}`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: googleContents(parsed),
      ...(parsed.context.instructions ? { systemInstruction: { parts: [{ text: parsed.context.instructions }] } } : {}),
      ...(googleTools(parsed) ? { tools: googleTools(parsed) } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    }),
  };
}

function supportsReasoningEffort(provider: ApiKeyProvider, model: string): boolean {
  if (provider === "moonshot") return false;
  if (provider === "groq" || provider === "mistral" || provider === "cerebras" || provider === "together" || provider === "fireworks" || provider === "huggingface" || provider === "nvidia" || provider === "openrouter" || provider === "openrouter-free" || provider === "ollama" || provider === "vllm" || provider === "lm-studio") return false;
  if (provider === "xai") return !/grok-build|composer/i.test(model);
  return provider === "openai" || provider === "deepseek";
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
        if (u) usage = { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
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
  yield { type: "done", usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : undefined };
}

export async function* streamGoogle(response: Response): AsyncGenerator<AdapterEvent> {
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = await response.text(); } catch { /* ignore */ }
    yield { type: "error", status: response.status, errorType: "upstream_error", message: providerErrorMessage("Google Gemini", response.status, detail) };
    return;
  }
  if (!response.body) { yield { type: "error", status: 502, errorType: "upstream_empty_response", message: "Google Gemini가 응답 본문 없이 요청을 종료했습니다." }; return; }
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
        const error = data.error as { message?: string; code?: number; status?: string } | undefined;
        if (error) {
          yield { type: "error", status: error.code ?? 502, errorType: error.status ?? "upstream_error", message: providerErrorMessage("Google Gemini", error.code ?? 502, error.message ?? error.status ?? "스트림 오류") };
          return;
        }
        const candidate = (data.candidates as Array<Record<string, unknown>> | undefined)?.[0];
        const parts = (candidate?.content as Record<string, unknown> | undefined)?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const record = part as Record<string, unknown>;
            const fn = record.functionCall as Record<string, unknown> | undefined;
            if (fn?.name) {
              yield { type: "tool_call_start", id: `call_${crypto.randomUUID().replace(/-/g, "")}`, name: String(fn.name) };
              yield { type: "tool_call_delta", arguments: JSON.stringify(fn.args ?? {}) };
              yield { type: "tool_call_end" };
            }
            const text = String(record.text ?? "");
            if (text) yield { type: "text_delta", text };
          }
        }
        const u = data.usageMetadata as Record<string, number> | undefined;
        if (u) usage = { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0 };
      }
    }
    yield { type: "done", usage };
  } finally {
    reader.releaseLock();
  }
}
