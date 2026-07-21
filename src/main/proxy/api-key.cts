import { allowedToolNames, namespacedToolName, type AdapterEvent, type OcxAssistantMessage, type OcxContentPart, type OcxParsedRequest, type OcxTool, type OcxToolResultMessage, type OcxUsage } from "./types.cjs";
import { createHash } from "node:crypto";
import { providerErrorMessage } from "./errors.cjs";
import { buildToolCatalogNudge, normalizeGeminiSchema, sanitizeName } from "./tool-sanitize.cjs";
import type { ProviderId } from "../contracts.cjs";
import { apiProviderConfig, apiProviderUrl } from "../provider-settings.cjs";
import { neutralizeIdentity } from "./identity.cjs";
import { mapProviderReasoningEffort, providerAutoToolChoiceOnly, providerLocksSampling, providerNativeImageInput, providerPreservesReasoning } from "./provider-policy.cjs";

type ApiKeyProvider = Exclude<ProviderId, "codex" | "claude-code" | "copilot" | "antigravity">;

const GOOGLE_BREVITY_INSTRUCTION = [
  "Output style for this session:",
  "- Before each meaningful new phase or tool batch, emit exactly one short user-facing progress line in the form DEVIL_PROGRESS: <what you will do next>; use a complete future-action sentence starting with I/We in English or a polite Korean sentence, end it with punctuation, and do not repeat unchanged progress or narrate at length.",
  "- Do detailed reasoning internally, not as visible intermediate output.",
  "- Never print raw tool arguments, patches, source files, shell commands, or tool schemas as intermediate text; send them only through the matching tool call.",
  "- Use DEVIL_PROGRESS only for plain-language status, never for commands, code, arguments, or patches. After that line, take the next tool action immediately; keep calling tools until the task is complete.",
  "- This applies only to intermediate progress text. Your final answer after the work is done is exempt: write it in full and at whatever length the task requires.",
].join("\n");

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
    return parts.map((part) => (part.type === "image" ? "[image]" : part.text ?? "")).join("");
  }
  if (!parts.some((part) => part.type === "image")) return flatten(parts);
  return parts.map((part) => (
    part.type === "image"
      ? { type: "image_url", image_url: { url: part.dataUrl, ...(part.detail ? { detail: part.detail } : {}) } }
      : { type: "text", text: part.text }
  ));
}

function toolResultText(parts: OcxContentPart[]): string {
  const text = parts.map((part) => part.type === "text" ? part.text : "[image]").join("");
  return text || "[image]";
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

function geminiToolCallId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned === raw ? cleaned : `${cleaned}_${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

function realThoughtSignature(signature: string | undefined): signature is string {
  if (!signature || signature.length < 16) return false;
  if (/^(fc|ctc|tsc|call|msg|rs|resp|reasoning|item|ws|tool|func|function)[-_]/i.test(signature)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(signature);
}

function selectedTools(parsed: OcxParsedRequest): OcxTool[] {
  const allowed = allowedToolNames(parsed.options.toolChoice);
  return parsed.tools.filter((tool) => !allowed || allowed.has(tool.name) || allowed.has(namespacedToolName(tool.namespace, tool.name)));
}

function openAiMessages(parsed: OcxParsedRequest, allowImages: boolean, provider: ApiKeyProvider): unknown[] {
  const out: unknown[] = [];
  let pendingToolCallIds = new Set<string>();
  const nudge = provider !== "openai"
    ? buildToolCatalogNudge(selectedTools(parsed).map(wireToolName), parsed.options.toolChoice)
    : undefined;
  const instructions = neutralizeIdentity([parsed.context.instructions, nudge].filter(Boolean).join("\n\n"));
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
          content: "",
          tool_calls: [{ id: toolCallId, type: "function", function: { name: toolResultWireName(tool), arguments: "{}" } }],
        });
      }
      out.push({ role: "tool", tool_call_id: toolCallId, content: toolResultText(tool.content) });
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
          const id = geminiToolCallId(part.id);
          return [{ functionCall: { name: wireToolCallName(part), args, ...(id ? { id } : {}) }, ...(realThoughtSignature(part.thoughtSignature) ? { thoughtSignature: part.thoughtSignature } : {}) }];
        }
        return [];
      });
      if (parts.length) contents.push({ role: "model", parts });
    } else if (msg.role === "toolResult") {
      const tool = msg as OcxToolResultMessage;
      const id = geminiToolCallId(tool.toolCallId);
      const parts: Array<Record<string, unknown>> = [{
        functionResponse: {
          name: sanitizeName(namespacedToolName(tool.toolNamespace, tool.toolName || "tool_result")),
          response: { result: flatten(tool.content) },
          ...(id ? { id } : {}),
        },
      }];
      for (const part of tool.content) {
        if (part.type !== "image") continue;
        const parsed = parseDataUrl(part.dataUrl);
        if (parsed) parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.base64 } });
      }
      contents.push({
        role: "user",
        parts,
      });
    } else {
      contents.push({ role: "user", parts: geminiParts(msg.content) });
    }
  }
  return contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }];
}

export function googleTools(parsed: OcxParsedRequest): unknown[] | undefined {
  const selected = selectedTools(parsed);
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
  const nativeImages = providerNativeImageInput(provider, parsed.model) ?? allowImages;
  const body: Record<string, unknown> = { model: wireModelForProvider(provider, parsed.model), messages: openAiMessages(parsed, nativeImages, provider), stream: parsed.stream };
  const selected = selectedTools(parsed);
  if (selected.length) {
    const tools = selected.flatMap((tool) => {
      const parameters = toolParametersForProvider(provider, tool.parameters);
      return parameters ? [{
        type: "function",
        function: {
          name: wireToolName(tool),
          description: tool.description ?? "",
          parameters,
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      }] : [];
    });
    if (tools.length) body.tools = tools;
    body.parallel_tool_calls = provider === "nvidia" ? false : parsed.options.parallelToolCalls !== false;
    const choice = parsed.options.toolChoice;
    const autoOnly = providerAutoToolChoiceOnly(provider, parsed.model);
    if (choice === "auto" || choice === "none" || choice === "required") body.tool_choice = autoOnly && choice !== "none" ? "auto" : choice;
    else if (choice && "name" in choice) {
      const selected = parsed.tools.find((tool) => tool.name === choice.name || namespacedToolName(tool.namespace, tool.name) === choice.name);
      body.tool_choice = autoOnly ? "auto" : { type: "function", function: { name: selected ? wireToolName(selected) : sanitizeName(choice.name) } };
    }
    else if (choice && "allowedTools" in choice) body.tool_choice = autoOnly ? "auto" : choice.mode === "required" ? "required" : "auto";
  }
  if (parsed.options.maxOutputTokens !== undefined) body.max_tokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined && !providerLocksSampling(provider, parsed.model)) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined && !providerLocksSampling(provider, parsed.model)) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
  const reasoningEffort = mapProviderReasoningEffort(provider, parsed.model, parsed.options.reasoning);
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;
  if (parsed.options.serviceTier !== undefined && provider === "openai") body.service_tier = parsed.options.serviceTier;
  if (parsed.options.presencePenalty !== undefined && !providerLocksSampling(provider, parsed.model)) body.presence_penalty = parsed.options.presencePenalty;
  if (parsed.options.frequencyPenalty !== undefined && !providerLocksSampling(provider, parsed.model)) body.frequency_penalty = parsed.options.frequencyPenalty;
  if (parsed.stream) body.stream_options = { include_usage: true };
  return body;
}

function wireModelForProvider(provider: ApiKeyProvider, model: string): string {
  // Z.AI accepts the context suffix in the catalog but rejects it on the wire.
  return provider === "zai" ? model.replace(/\[[^\]]*\]\s*$/, "") : model;
}

function preservesReasoningContent(provider: ApiKeyProvider, model: string): boolean {
  return providerPreservesReasoning(provider, model);
}

function expandXaiRootObjectSchemas(schema: unknown): Record<string, unknown>[] | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const root = schema as Record<string, unknown>;
  const composition = ["oneOf", "anyOf"].find((key) => Array.isArray(root[key]));
  if (!composition) return root.type !== undefined && root.type !== "object" ? undefined : [{ ...root, type: "object" }];
  const siblings = Object.fromEntries(Object.entries(root).filter(([key]) => key !== composition));
  const branches = root[composition];
  if (!Array.isArray(branches)) return undefined;
  const variants: Record<string, unknown>[] = [];
  for (const branch of branches) {
    const expanded = expandXaiRootObjectSchemas(branch);
    if (!expanded) return undefined;
    for (const variant of expanded) variants.push({ ...siblings, ...variant });
  }
  return variants.length ? variants : undefined;
}

function normalizeXaiSchema(schema: unknown): Record<string, unknown> | undefined {
  const variants = expandXaiRootObjectSchemas(schema);
  if (!variants) return undefined;
  if (variants.length === 1) return variants[0];
  const root = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : {};
  const metadata = Object.fromEntries(Object.entries(root).filter(([key]) => key !== "oneOf" && key !== "anyOf" && key !== "type"));
  return { ...metadata, oneOf: variants };
}

const ZEN_SCHEMA_NAME_BAGS = new Set(["properties", "$defs", "definitions"]);

function sanitizeZenSchema(value: unknown, inNameBag = false): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeZenSchema(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!inNameBag && key === "encrypted") continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    if (key === "type" && Array.isArray(child)) {
      const nonNull = child.filter((entry) => entry !== "null");
      if (child.includes("null")) out.nullable = true;
      if (nonNull.length) out.type = nonNull[0];
      continue;
    }
    out[key] = sanitizeZenSchema(child, ZEN_SCHEMA_NAME_BAGS.has(key));
  }
  return out;
}

function normalizeZenSchema(schema: unknown): Record<string, unknown> {
  const root = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : {};
  const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;
  const hasComposition = compositionKeys.some((key) => Array.isArray(root[key]));
  if (!hasComposition) {
    const base = sanitizeZenSchema(root) as Record<string, unknown>;
    return { ...base, type: "object" };
  }
  const properties: Record<string, unknown> = root.properties && typeof root.properties === "object" && !Array.isArray(root.properties)
    ? sanitizeZenSchema(root.properties, true) as Record<string, unknown>
    : {};
  const required = new Set<string>(Array.isArray(root.required) ? root.required.filter((entry): entry is string => typeof entry === "string") : []);
  for (const key of compositionKeys) {
    const variants = root[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const child = variant as Record<string, unknown>;
      if (child.properties && typeof child.properties === "object" && !Array.isArray(child.properties)) {
        Object.assign(properties, sanitizeZenSchema(child.properties, true));
      }
      if (key === "allOf" && Array.isArray(child.required)) {
        for (const entry of child.required) if (typeof entry === "string") required.add(entry);
      }
    }
  }
  const merged = sanitizeZenSchema(root) as Record<string, unknown>;
  delete merged.oneOf;
  delete merged.anyOf;
  delete merged.allOf;
  merged.type = "object";
  if (Object.keys(properties).length) merged.properties = properties;
  if (required.size) merged.required = [...required];
  return merged;
}

function toolParametersForProvider(provider: ApiKeyProvider, schema: unknown): Record<string, unknown> | undefined {
  if (provider === "xai") return normalizeXaiSchema(schema);
  if (provider === "opencode-free") return normalizeZenSchema(schema);
  return schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : { type: "object", properties: {} };
}

export function buildApiKeyRequest(provider: ApiKeyProvider, parsed: OcxParsedRequest, key: string): { url: string; headers: Record<string, string>; body: string } {
  const config = apiProviderConfig(provider);
  if (!config) throw new Error(`지원하지 않는 Provider입니다: ${provider}`);
  if (config.adapter === "openai-responses") throw new Error(`${provider}는 Responses passthrough adapter를 사용해야 합니다.`);
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
    selectedTools(parsed).map(wireToolName),
    parsed.options.toolChoice,
  );
  const instructions = neutralizeIdentity([parsed.context.instructions, nudge, GOOGLE_BREVITY_INSTRUCTION].filter(Boolean).join("\n\n"));
  return {
    contents: googleContents(parsed),
    ...(instructions ? { systemInstruction: { parts: [{ text: instructions }] } } : {}),
    ...(tools ? { tools } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
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
  let pendingUsage: OcxUsage | undefined;
  let sawFinish = false;
  let lastFinishReason: string | undefined;
  interface PendingToolCall { key: string; id: string; name: string; args: string }
  const pendingToolCalls: PendingToolCall[] = [];
  let callSequence = 0;
  const flushToolCalls = function* (): Generator<AdapterEvent> {
    for (const call of pendingToolCalls) {
      yield { type: "tool_call_start", id: call.id || `call_${++callSequence}`, name: call.name };
      if (call.args) yield { type: "tool_call_delta", arguments: call.args };
      yield { type: "tool_call_end" };
    }
    pendingToolCalls.length = 0;
  };
  const handleDataLine = function* (line: string): Generator<AdapterEvent, "continue" | "terminate"> {
    if (!line.startsWith("data:")) return "continue";
    const payload = line.slice(5).trim();
    if (!payload) return "continue";
    if (payload === "[DONE]") {
      yield* flushToolCalls();
      yield { type: "done", usage: pendingUsage, ...(lastFinishReason ? { finishReason: lastFinishReason } : {}) };
      return "terminate";
    }
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; }
    catch {
      yield { type: "error", status: 502, errorType: "upstream_invalid_sse", message: `${providerLabel}가 잘못된 SSE JSON 프레임을 반환했습니다.` };
      return "terminate";
    }
    const err = data.error as { message?: string; code?: string; type?: string } | undefined;
    if (err) {
      yield* flushToolCalls();
      yield { type: "error", status: 502, errorType: err.type ?? "upstream_error", message: `${providerLabel} 스트림 오류: ${err.message ?? err.code ?? "알 수 없는 오류"}` };
      return "terminate";
    }
    if (data.usage) pendingUsage = openAiCompatibleUsage(data.usage as Record<string, unknown>);
    const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const finishReason = choice?.finish_reason;
    if (typeof finishReason === "string" && finishReason) {
      sawFinish = true;
      lastFinishReason = finishReason;
    }
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", text: delta.content };
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) yield { type: "reasoning_raw_delta", text: delta.reasoning_content };
      const toolCalls = delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined;
      for (const tool of toolCalls ?? []) {
        const key = typeof tool.index === "number" ? `i:${tool.index}` : tool.id ? `id:${tool.id}` : pendingToolCalls[pendingToolCalls.length - 1]?.key;
        let call = key ? pendingToolCalls.find((candidate) => candidate.key === key) : undefined;
        if (!call && tool.id) call = pendingToolCalls.find((candidate) => candidate.id === tool.id);
        if (!call) {
          call = { key: key ?? `seq:${pendingToolCalls.length}`, id: "", name: "", args: "" };
          pendingToolCalls.push(call);
        }
        if (tool.id && !call.id) call.id = tool.id;
        if (tool.function?.name && !call.name) call.name = tool.function.name;
        if (tool.function?.arguments) call.args += tool.function.arguments;
      }
    }
    if (typeof finishReason === "string" && finishReason) yield* flushToolCalls();
    return "continue";
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if ((yield* handleDataLine(line)) === "terminate") return;
    }
    buffer += decoder.decode();
    if (buffer.trim() && (yield* handleDataLine(buffer)) === "terminate") return;
    yield* flushToolCalls();
    if (!sawFinish && pendingUsage === undefined) {
      yield { type: "error", status: 502, errorType: "upstream_truncated_stream", message: `${providerLabel} 스트림이 완료 신호 없이 종료되었습니다.` };
      return;
    }
    yield { type: "done", usage: pendingUsage, ...(lastFinishReason ? { finishReason: lastFinishReason } : {}) };
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
  if (!choice) {
    yield { type: "error", status: 502, errorType: "upstream_invalid_response", message: `${providerLabel} 응답에 choices가 없습니다.` };
    return;
  }
  const message = choice?.message as Record<string, unknown> | undefined;
  if (!message) {
    yield { type: "error", status: 502, errorType: "upstream_invalid_response", message: `${providerLabel} 응답 choice에 message가 없습니다.` };
    return;
  }
  if (typeof message.content === "string" && message.content) yield { type: "text_delta", text: message.content };
  if (typeof message.reasoning_content === "string" && message.reasoning_content) yield { type: "reasoning_raw_delta", text: message.reasoning_content };
  const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCalls) for (const [index, tc] of toolCalls.entries()) {
    const fn = tc.function as { name?: string; arguments?: string } | undefined;
    yield { type: "tool_call_start", id: String(tc.id ?? `call_${index}`), name: fn?.name ?? "" };
    if (fn?.arguments) yield { type: "tool_call_delta", arguments: fn.arguments };
    yield { type: "tool_call_end" };
  }
  const usage = data.usage as Record<string, number> | undefined;
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
  yield { type: "done", usage: usage ? openAiCompatibleUsage(usage) : undefined, ...(finishReason ? { finishReason } : {}) };
}

// OpenAI-compatible providers report cache hits in different fields:
// prompt_tokens_details.cached_tokens (OpenAI-style) or prompt_cache_hit_tokens
// (DeepSeek). Without this, proxied turns show cached=0 and Devil's usage/cost
// summaries price the whole prompt at the uncached input rate.
function openAiCompatibleUsage(u: Record<string, unknown>): OcxUsage {
  const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = u.completion_tokens_details as Record<string, unknown> | undefined;
  const cached = num(details?.cached_tokens) || num(u.prompt_cache_hit_tokens);
  const reasoning = num(completionDetails?.reasoning_tokens);
  return {
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    ...(typeof u.total_tokens === "number" ? { totalTokens: u.total_tokens } : {}),
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoning ? { reasoningOutputTokens: reasoning } : {}),
  };
}

function googleUsage(u: Record<string, number> | undefined): OcxUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    ...(u.cachedContentTokenCount !== undefined ? { cachedInputTokens: u.cachedContentTokenCount } : {}),
    ...(u.thoughtsTokenCount !== undefined ? { reasoningOutputTokens: u.thoughtsTokenCount } : {}),
  };
}

const GOOGLE_TRUNCATION_REASONS = new Set(["MAX_TOKENS", "MALFORMED_FUNCTION_CALL"]);

function googleTruncationMessage(reason: string): string {
  return `Google 응답이 도구 호출을 완료하기 전에 잘렸습니다. (${reason})`;
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
  let lastFinishReason: string | undefined;
  let toolCallsStarted = 0;
  const parsePayload = function* (payload: string): Generator<AdapterEvent, "continue" | "terminate"> {
    if (!payload) return "continue";
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; }
    catch {
      yield { type: "error", status: 502, errorType: "upstream_invalid_sse", message: `${label}가 잘못된 SSE JSON 프레임을 반환했습니다.` };
      return "terminate";
    }
    const root = options.unwrapResponse ? (data.response as Record<string, unknown> | undefined) : data;
    if (!root) {
      yield { type: "error", status: 502, errorType: "upstream_invalid_response", message: `${label} 응답에 response wrapper가 없습니다.` };
      return "terminate";
    }
    const error = (data.error ?? root.error) as { message?: string; code?: number; status?: string } | undefined;
    if (error) {
      yield { type: "error", status: error.code ?? 502, errorType: error.status ?? "upstream_error", message: providerErrorMessage(label, error.code ?? 502, error.message ?? error.status ?? "스트림 오류") };
      return "terminate";
    }
    const candidate = (root.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    if (typeof candidate?.finishReason === "string") lastFinishReason = candidate.finishReason;
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
          const upstreamId = typeof fn.id === "string" ? geminiToolCallId(fn.id) : undefined;
          const id = upstreamId ?? `call_${crypto.randomUUID().replace(/-/g, "")}`;
          toolCallsStarted++;
          yield { type: "tool_call_start", id, name: String(fn.name), ...(realThoughtSignature(thoughtSignature) ? { thoughtSignature } : {}) };
          yield { type: "tool_call_delta", arguments: JSON.stringify(fn.args ?? {}) };
          yield { type: "tool_call_end" };
        }
        const text = String(record.text ?? "");
        if (text) yield record.thought === true ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text };
      }
    }
    const nextUsage = googleUsage(root.usageMetadata as Record<string, number> | undefined);
    if (nextUsage) usage = nextUsage;
    return "continue";
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const result = yield* parsePayload(line.slice(5).trim());
        if (result === "terminate") return;
      }
    }
    buffer += decoder.decode();
    const residual = buffer.trim();
    if (residual.startsWith("data:")) {
      const result = yield* parsePayload(residual.slice(5).trim());
      if (result === "terminate") return;
    }
    if (toolCallsStarted > 0 && lastFinishReason && GOOGLE_TRUNCATION_REASONS.has(lastFinishReason)) {
      yield { type: "error", status: 502, errorType: "upstream_truncated_tool_call", message: googleTruncationMessage(lastFinishReason), usage, finishReason: lastFinishReason };
      return;
    }
    yield { type: "done", usage, ...(lastFinishReason ? { finishReason: lastFinishReason } : {}) };
  } finally {
    reader.releaseLock();
  }
}
