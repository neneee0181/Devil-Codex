// Anthropic adapter: neutral request → Anthropic Messages call → AdapterEvent stream.
// Adapted from opencodex (MIT).
import { allowedToolNames, namespacedToolName, type AdapterEvent, type OcxAssistantMessage, type OcxMessage, type OcxParsedRequest, type OcxToolResultMessage, type OcxUsage } from "./types.cjs";
import { buildToolCatalogNudge, sanitizeName } from "./tool-sanitize.cjs";
import { providerErrorMessage } from "./errors.cjs";
import { createHash } from "node:crypto";
import { neutralizeIdentity } from "./identity.cjs";
import { normalizeAnthropicImages } from "./anthropic-images.cjs";

const ANTHROPIC_API = "https://api.anthropic.com";
const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
const CLAUDE_CODE_SYSTEM = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
// Claude Code OAuth accepts user-defined tools under the same namespace used by
// OpenCodex. Keeping this exact is also required when replaying tool_use blocks.
const CLAUDE_TOOL_PREFIX = "custom_";
const ANTHROPIC_BUILTIN_TOOLS = new Set(["web_search", "code_execution", "text_editor", "computer"]);
const DEFAULT_MAX_TOKENS = 8192;
const REASONING_CEIL = 32_000;
const MIN_BUDGET = 1024;
const HEADROOM = 8192;
const FLOOR = 4096;
const CLAUDE_SDK_VERSION = "0.74.0";

function claudeCodeSessionId(token: string): string {
  const hash = createHash("sha256").update(`claude-code-session:${token}`, "utf8").digest("hex");
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const CLAUDE_CODE_HEADERS: Record<string, string> = {
  "X-App": "cli",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Timeout": "600",
  "X-Stainless-Arch": process.arch,
  "X-Stainless-OS": process.platform,
  "X-Stainless-Package-Version": CLAUDE_SDK_VERSION,
  "X-Stainless-Runtime-Version": process.version.slice(1),
};

const ADAPTIVE_THINKING_MINIMUMS: Record<string, readonly [number, number]> = {
  sonnet: [5, 0],
  opus: [4, 7],
  fable: [0, 0],
};

function usesAdaptiveThinking(model: string): boolean {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model);
  if (!match) return false;
  const minimum = ADAPTIVE_THINKING_MINIMUMS[match[1].toLowerCase()];
  if (!minimum) return false;
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

function adaptiveEffort(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}

export interface AnthropicAuth { apiKey?: string; accessToken?: string }

function budget(effort: string): number {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "high": return 16384;
    case "xhigh": return 24576;
    case "max": return 32000;
    default: return 8192;
  }
}

function usageFrom(u: Record<string, number> | undefined): OcxUsage | undefined {
  if (!u) return undefined;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (u.input_tokens ?? 0) + read + write,
    outputTokens: u.output_tokens ?? 0,
    ...((read || write) ? { cachedInputTokens: read, cacheReadInputTokens: read, cacheCreationInputTokens: write } : {}),
  };
}

function mergeUsage(base: Record<string, number> | undefined, next: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!next) return base;
  return base ? { ...base, ...next } : { ...next };
}

function imageBlock(dataUrl: string): unknown {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m && /^https?:\/\//i.test(dataUrl)) return { type: "image", source: { type: "url", url: dataUrl } };
  if (!m) return { type: "text", text: "[image]" };
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

function contentParts(parts: { type: string; text?: string; dataUrl?: string }[]): unknown[] {
  return parts
    .map((p) => p.type === "image" && p.dataUrl ? imageBlock(p.dataUrl) : { type: "text", text: p.text ?? "" })
    .filter((part) => !(typeof part === "object" && part !== null && (part as { type?: string; text?: string }).type === "text" && !(part as { text?: string }).text));
}

const ANTHROPIC_SCHEMA_NAME_BAGS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const ANTHROPIC_SCHEMA_LITERAL_KEYS = new Set(["const", "default", "enum", "examples"]);

function stripEncryptedSchemaMarker(node: unknown, inNameBag = false): unknown {
  if (Array.isArray(node)) return node.map((item) => stripEncryptedSchemaMarker(item));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (inNameBag) out[key] = stripEncryptedSchemaMarker(value);
    else if (key !== "encrypted") out[key] = ANTHROPIC_SCHEMA_LITERAL_KEYS.has(key)
      ? value
      : stripEncryptedSchemaMarker(value, ANTHROPIC_SCHEMA_NAME_BAGS.has(key));
  }
  return out;
}

export function normalizeAnthropicInputSchema(schema: unknown): Record<string, unknown> {
  const stripped = stripEncryptedSchemaMarker(schema);
  const root = stripped && typeof stripped === "object" && !Array.isArray(stripped) ? stripped as Record<string, unknown> : {};
  const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;
  const hasComposition = compositionKeys.some((key) => Array.isArray(root[key]));
  if (!hasComposition) return {
    ...root,
    type: "object",
    properties: root.properties && typeof root.properties === "object" && !Array.isArray(root.properties) ? root.properties : {},
  };
  const properties: Record<string, unknown> = root.properties && typeof root.properties === "object" && !Array.isArray(root.properties) ? { ...root.properties as Record<string, unknown> } : {};
  const required = new Set<string>(Array.isArray(root.required) ? root.required.filter((item): item is string => typeof item === "string") : []);
  for (const key of compositionKeys) {
    const variants = root[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const child = variant as Record<string, unknown>;
      if (child.properties && typeof child.properties === "object" && !Array.isArray(child.properties)) Object.assign(properties, child.properties);
      if (key === "allOf" && Array.isArray(child.required)) for (const item of child.required) if (typeof item === "string") required.add(item);
    }
  }
  const normalized = Object.fromEntries(Object.entries(root).filter(([key]) => !compositionKeys.includes(key as typeof compositionKeys[number]) && key !== "type" && key !== "properties" && key !== "required"));
  return { ...normalized, type: "object", properties, ...(required.size ? { required: [...required] } : {}) };
}

function applyDefaultPromptCaching(body: Record<string, unknown>): void {
  const cacheControl = { type: "ephemeral" };
  body.cache_control = cacheControl;
  let remaining = 3;
  const markLast = (blocks: Array<Record<string, unknown>> | undefined): void => {
    if (!remaining || !blocks?.length) return;
    blocks[blocks.length - 1].cache_control = cacheControl;
    remaining--;
  };
  markLast(body.tools as Array<Record<string, unknown>> | undefined);
  markLast(body.system as Array<Record<string, unknown>> | undefined);
  if (!remaining) return;
  const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
  if (!messages) return;
  const users = messages.filter((message) => message.role === "user");
  const penultimate = users.at(-2);
  if (!penultimate) return;
  if (typeof penultimate.content === "string") penultimate.content = [{ type: "text", text: penultimate.content, cache_control: cacheControl }];
  else if (Array.isArray(penultimate.content)) {
    const blocks = penultimate.content as Array<Record<string, unknown>>;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index]?.type === "text") { blocks[index].cache_control = cacheControl; break; }
    }
  }
}

function toolResultBlock(tr: OcxToolResultMessage): Record<string, unknown> {
  const content = contentParts(tr.content).filter((part) => !(typeof part === "object" && part !== null && (part as { type?: string; text?: string }).type === "text" && !(part as { text?: string }).text));
  return { type: "tool_result", tool_use_id: tr.toolCallId, content: content.length ? content : "(empty tool output)", ...(tr.isError ? { is_error: true } : {}) };
}

function realThinkingSignature(signature: string | undefined): signature is string {
  if (!signature || signature.length < 16) return false;
  if (/^(fc|call|msg|rs|resp|reasoning|item|ws|tool|func|function)[-_]/i.test(signature)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(signature);
}

function orphanToolResult(tr: OcxToolResultMessage): string {
  const label = tr.toolName ? `${tr.toolName} (${tr.toolCallId})` : tr.toolCallId;
  return `[tool_result without adjacent tool_use: ${label}]\n${JSON.stringify(tr.content)}`;
}

function toClaudeToolName(name: string, oauth: boolean): string {
  if (!oauth) return name;
  const lower = name.toLowerCase();
  if (ANTHROPIC_BUILTIN_TOOLS.has(lower) || lower.startsWith(CLAUDE_TOOL_PREFIX)) return name;
  return `${CLAUDE_TOOL_PREFIX}${name}`;
}

function fromClaudeToolName(name: string): string {
  return name.startsWith(CLAUDE_TOOL_PREFIX) ? name.slice(CLAUDE_TOOL_PREFIX.length) : name;
}

function toMessages(parsed: OcxParsedRequest, oauth: boolean): unknown[] {
  const out: unknown[] = [];
  const msgs = parsed.context.messages;
  for (let i = 0; i < msgs.length; i += 1) {
    const msg = msgs[i];
    if (msg.role === "user" || msg.role === "developer") {
      const content = contentParts(msg.content);
      out.push({ role: "user", content: content.length ? content : "(empty)" });
    } else if (msg.role === "assistant") {
      const a = msg as OcxAssistantMessage;
      const content: unknown[] = [];
      const toolIds: string[] = [];
      for (const part of a.content) {
        if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
        else if (part.type === "thinking") {
          for (const data of part.redacted ?? []) content.push({ type: "redacted_thinking", data });
          if (realThinkingSignature(part.signature)) content.push({ type: "thinking", thinking: part.text, signature: part.signature });
        }
        else if (part.type === "toolCall") {
          let input: unknown = {};
          try { input = JSON.parse(part.arguments || "{}"); } catch { input = {}; }
          content.push({ type: "tool_use", id: part.id, name: toClaudeToolName(sanitizeName(namespacedToolName(part.namespace, part.name)), oauth), input });
          toolIds.push(part.id);
        }
      }
      if (content.length) out.push({ role: "assistant", content });
      if (toolIds.length) {
        const required = new Set(toolIds);
        const blocks: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        let j = i + 1;
        while (j < msgs.length && msgs[j].role === "toolResult") {
          const tr = msgs[j] as OcxToolResultMessage;
          if (required.has(tr.toolCallId) && !seen.has(tr.toolCallId)) { blocks.push(toolResultBlock(tr)); seen.add(tr.toolCallId); }
          else blocks.push({ type: "text", text: orphanToolResult(tr) });
          j += 1;
        }
        for (const id of toolIds) if (!seen.has(id)) blocks.push({ type: "tool_result", tool_use_id: id, content: "[missing tool_result]", is_error: true });
        if (blocks.length) out.push({ role: "user", content: blocks });
        i = j - 1;
      }
    } else if (msg.role === "toolResult") {
      out.push({ role: "user", content: orphanToolResult(msg as OcxToolResultMessage) });
    }
  }
  if (!out.length) out.push({ role: "user", content: "(continue)" });
  else if ((out[out.length - 1] as { role?: string }).role === "assistant") out.push({ role: "user", content: "(continue)" });
  return out;
}

export async function buildAnthropicRequest(parsed: OcxParsedRequest, auth: AnthropicAuth): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const oauth = !auth.apiKey && Boolean(auth.accessToken);
  if (oauth && !auth.accessToken?.trim()) throw new Error("Claude Code OAuth token이 없습니다.");
  if (!oauth && !auth.apiKey?.trim()) throw new Error("Anthropic API key가 없습니다.");
  const messages = toMessages(parsed, oauth);
  await normalizeAnthropicImages(messages);
  const body: Record<string, unknown> = { model: parsed.model, messages, stream: parsed.stream, max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS };

  const sys = parsed.context.instructions;
  if (oauth) body.system = [{ type: "text", text: CLAUDE_CODE_SYSTEM }, ...(sys ? [{ type: "text", text: sys }] : [])];
  else if (sys) body.system = [{ type: "text", text: sys }];

  const allowed = allowedToolNames(parsed.options.toolChoice);
  const selectedTools = parsed.tools.filter((tool) => !allowed || allowed.has(tool.name) || allowed.has(namespacedToolName(tool.namespace, tool.name)));
  if (selectedTools.length) {
    body.tools = selectedTools.map((tool) => ({
      name: toClaudeToolName(sanitizeName(namespacedToolName(tool.namespace, tool.name)), oauth),
      description: tool.description ?? "",
      input_schema: normalizeAnthropicInputSchema(tool.parameters),
    }));
  }

  if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop_sequences = parsed.options.stopSequences;

  const nudge = buildToolCatalogNudge(
    selectedTools.map((tool) => toClaudeToolName(sanitizeName(namespacedToolName(tool.namespace, tool.name)), oauth)),
    parsed.options.toolChoice,
  );
  const systemParts = [oauth ? CLAUDE_CODE_SYSTEM : undefined, sys ? neutralizeIdentity(sys) : undefined, nudge].filter(Boolean);
  if (systemParts.length) body.system = systemParts.map((text) => ({ type: "text", text }));

  const tc = parsed.options.toolChoice;
  if (tc && (selectedTools.length || tc === "none")) {
    if (tc === "auto") body.tool_choice = { type: "auto" };
    else if (tc === "none") body.tool_choice = { type: "none" };
    else if (tc === "required" || (typeof tc === "object" && "allowedTools" in tc && tc.mode === "required")) body.tool_choice = { type: "any" };
    else if (typeof tc === "object" && "allowedTools" in tc) body.tool_choice = { type: "auto" };
    else if (typeof tc === "object" && "name" in tc) body.tool_choice = { type: "tool", name: toClaudeToolName(sanitizeName(tc.name), oauth) };
  }

  if (typeof parsed.options.reasoning === "string" && parsed.options.reasoning !== "none") {
    const want = budget(parsed.options.reasoning);
    const maxOut = parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    if (usesAdaptiveThinking(parsed.model)) {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort: adaptiveEffort(parsed.options.reasoning) };
    } else {
      const maxTokens = Math.min(REASONING_CEIL, Math.max(maxOut, want + HEADROOM));
      body.max_tokens = maxTokens;
      body.thinking = { type: "enabled", budget_tokens: Math.max(MIN_BUDGET, Math.min(want, maxTokens - FLOOR)) };
    }
    // Anthropic extended thinking rejects temperature != 1 and top_p. Match opencodex by
    // dropping sampling controls whenever thinking is enabled.
    delete body.temperature;
    delete body.top_p;
  }

  applyDefaultPromptCaching(body);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": parsed.stream ? "text/event-stream" : "application/json",
    "User-Agent": `@anthropic-ai/sdk/${CLAUDE_SDK_VERSION}`,
    "anthropic-version": "2023-06-01",
  };
  if (oauth) {
    headers.Authorization = `Bearer ${auth.accessToken}`;
    headers["anthropic-beta"] = OAUTH_BETA;
    Object.assign(headers, CLAUDE_CODE_HEADERS);
    headers["X-Claude-Code-Session-Id"] = claudeCodeSessionId(auth.accessToken!);
    headers["x-client-request-id"] = crypto.randomUUID();
  }
  else if (auth.apiKey) headers["x-api-key"] = auth.apiKey;

  return { url: `${ANTHROPIC_API}/v1/messages`, headers, body: JSON.stringify(body) };
}

export async function* streamAnthropic(response: Response): AsyncGenerator<AdapterEvent> {
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = await response.text(); } catch { /* ignore */ }
    yield { type: "error", status: response.status, errorType: "upstream_error", message: providerErrorMessage("Claude", response.status, detail) };
    return;
  }
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    let data: Record<string, unknown>;
    try { data = await response.json() as Record<string, unknown>; }
    catch {
      yield { type: "error", status: 502, errorType: "upstream_invalid_json", message: "Claude가 JSON 응답을 반환하지 않았습니다." };
      return;
    }
    const error = data.error as { message?: string; type?: string } | undefined;
    if (error) {
      yield { type: "error", status: 502, errorType: error.type ?? "upstream_error", message: `Claude 응답 오류: ${error.message ?? "알 수 없는 오류"}` };
      return;
    }
    for (const block of data.content as Array<Record<string, unknown>> | undefined ?? []) {
      if (block.type === "text" && typeof block.text === "string") yield { type: "text_delta", text: block.text };
      else if (block.type === "thinking" && typeof block.thinking === "string") {
        yield { type: "thinking_delta", thinking: block.thinking };
        if (typeof block.signature === "string") yield { type: "thinking_signature", signature: block.signature };
      } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
        yield { type: "redacted_thinking", data: block.data };
      } else if (block.type === "tool_use") {
        yield { type: "tool_call_start", id: String(block.id ?? ""), name: fromClaudeToolName(String(block.name ?? "")) };
        yield { type: "tool_call_delta", arguments: JSON.stringify(block.input ?? {}) };
        yield { type: "tool_call_end" };
      }
    }
    yield { type: "done", usage: usageFrom(data.usage as Record<string, number> | undefined) };
    return;
  }
  if (!response.body) { yield { type: "error", status: 502, errorType: "upstream_empty_response", message: "Claude가 응답 본문 없이 요청을 종료했습니다." }; return; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let blockType = "";
  let emittedDone = false;
  let pendingUsage: Record<string, number> | undefined;
  let eventType = "";
  const handlePayload = function* (payload: string): Generator<AdapterEvent, "continue" | "terminate"> {
    if (!payload) return "continue";
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; }
    catch {
      yield { type: "error", status: 502, errorType: "upstream_invalid_sse", message: "Claude가 잘못된 SSE JSON 프레임을 반환했습니다." };
      return "terminate";
    }
    switch (eventType || (data.type as string)) {
      case "message_start": {
        pendingUsage = mergeUsage(pendingUsage, (data.message as { usage?: Record<string, number> } | undefined)?.usage);
        break;
      }
      case "content_block_start": {
        const block = data.content_block as { type: string; id?: string; name?: string; data?: string } | undefined;
        if (!block) break;
        blockType = block.type;
        if (block.type === "tool_use") yield { type: "tool_call_start", id: block.id ?? "", name: fromClaudeToolName(block.name ?? "") };
        if (block.type === "redacted_thinking" && typeof block.data === "string") yield { type: "redacted_thinking", data: block.data };
        break;
      }
      case "content_block_delta": {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (!delta) break;
        if (delta.type === "text_delta" && typeof delta.text === "string") yield { type: "text_delta", text: delta.text };
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") yield { type: "thinking_delta", thinking: delta.thinking };
        else if (delta.type === "signature_delta" && typeof delta.signature === "string" && blockType === "thinking") yield { type: "thinking_signature", signature: delta.signature };
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") yield { type: "tool_call_delta", arguments: delta.partial_json };
        break;
      }
      case "content_block_stop": {
        if (blockType === "tool_use") yield { type: "tool_call_end" };
        blockType = "";
        break;
      }
      case "message_delta": {
        pendingUsage = mergeUsage(pendingUsage, data.usage as Record<string, number> | undefined);
        break;
      }
      case "message_stop": {
        if (!emittedDone) {
          yield { type: "done", usage: usageFrom(pendingUsage) };
          emittedDone = true;
        }
        break;
      }
      case "error": {
        const err = data.error as { message?: string; type?: string } | undefined;
        yield { type: "error", status: 502, errorType: err?.type ?? "upstream_error", message: `Claude 스트림 오류: ${err?.message ?? "알 수 없는 오류"}` };
        return "terminate";
      }
    }
    eventType = "";
    return "continue";
  };
  const handleLine = function* (rawLine: string): Generator<AdapterEvent, "continue" | "terminate"> {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) { eventType = ""; return "continue"; }
    if (line.startsWith("event:")) { eventType = line.slice(6).trim(); return "continue"; }
    if (!line.startsWith("data:")) return "continue";
    return yield* handlePayload(line.slice(5).trim());
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if ((yield* handleLine(line)) === "terminate") return;
      }
    }
    buffer += decoder.decode();
    if (buffer && (yield* handleLine(buffer)) === "terminate") return;
    if (!emittedDone) {
      yield { type: "error", status: 502, errorType: "upstream_truncated_stream", message: "Claude 스트림이 message_stop 없이 종료되었습니다." };
    }
  } finally {
    reader.releaseLock();
  }
}
