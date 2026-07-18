// Anthropic adapter: neutral request → Anthropic Messages call → AdapterEvent stream.
// Adapted from opencodex (MIT).
import { allowedToolNames, namespacedToolName, type AdapterEvent, type OcxAssistantMessage, type OcxMessage, type OcxParsedRequest, type OcxToolResultMessage, type OcxUsage } from "./types.cjs";
import { budgetTools, normalizeSchema, sanitizeName } from "./tool-sanitize.cjs";
import { providerErrorMessage } from "./errors.cjs";

const ANTHROPIC_API = "https://api.anthropic.com";
const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
const CLAUDE_CODE_SYSTEM = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_TOOL_PREFIX = "proxy_";
const ANTHROPIC_BUILTIN_TOOLS = new Set(["web_search", "code_execution", "text_editor", "computer"]);
const DEFAULT_MAX_TOKENS = 8192;
const REASONING_CEIL = 32_000;
const MIN_BUDGET = 1024;
const HEADROOM = 8192;
const FLOOR = 4096;

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
  const cache = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, ...(cache ? { cachedInputTokens: cache } : {}) };
}

function imageBlock(dataUrl: string): unknown {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m && /^https?:\/\//i.test(dataUrl)) return { type: "image", source: { type: "url", url: dataUrl } };
  if (!m) return { type: "text", text: "[image]" };
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

function contentParts(parts: { type: string; text?: string; dataUrl?: string }[]): unknown[] {
  return parts.map((p) => p.type === "image" && p.dataUrl ? imageBlock(p.dataUrl) : { type: "text", text: p.text ?? "" });
}

function toolResultBlock(tr: OcxToolResultMessage): Record<string, unknown> {
  const text = tr.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return { type: "tool_result", tool_use_id: tr.toolCallId, content: text, ...(tr.isError ? { is_error: true } : {}) };
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
      out.push({ role: "user", content: contentParts(msg.content) });
    } else if (msg.role === "assistant") {
      const a = msg as OcxAssistantMessage;
      const content: unknown[] = [];
      const toolIds: string[] = [];
      for (const part of a.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "thinking") content.push({ type: "thinking", thinking: part.text });
        else if (part.type === "toolCall") {
          let input: unknown = {};
          try { input = JSON.parse(part.arguments || "{}"); } catch { input = {}; }
          content.push({ type: "tool_use", id: part.id, name: toClaudeToolName(sanitizeName(namespacedToolName(part.namespace, part.name)), oauth), input });
          toolIds.push(part.id);
        }
      }
      out.push({ role: "assistant", content });
      if (toolIds.length) {
        const required = new Set(toolIds);
        const blocks: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        let j = i + 1;
        while (j < msgs.length && msgs[j].role === "toolResult") {
          const tr = msgs[j] as OcxToolResultMessage;
          if (required.has(tr.toolCallId) && !seen.has(tr.toolCallId)) { blocks.push(toolResultBlock(tr)); seen.add(tr.toolCallId); }
          j += 1;
        }
        for (const id of toolIds) if (!seen.has(id)) blocks.push({ type: "tool_result", tool_use_id: id, content: "[missing tool_result]", is_error: true });
        if (blocks.length) out.push({ role: "user", content: blocks });
        i = j - 1;
      }
    } else if (msg.role === "toolResult") {
      const text = (msg as OcxToolResultMessage).content.map((c) => (c.type === "text" ? c.text : "")).join("");
      out.push({ role: "user", content: text });
    }
  }
  return out;
}

export function buildAnthropicRequest(parsed: OcxParsedRequest, auth: AnthropicAuth): { url: string; headers: Record<string, string>; body: string } {
  const oauth = !auth.apiKey && Boolean(auth.accessToken);
  const messages = toMessages(parsed, oauth);
  const body: Record<string, unknown> = { model: parsed.model, messages, stream: parsed.stream, max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS };

  const sys = parsed.context.instructions;
  if (oauth) body.system = [{ type: "text", text: CLAUDE_CODE_SYSTEM }, ...(sys ? [{ type: "text", text: sys }] : [])];
  else if (sys) body.system = sys;

  const allowed = allowedToolNames(parsed.options.toolChoice);
  const selectedTools = budgetTools(parsed.tools.filter((tool) => !allowed || allowed.has(tool.name) || allowed.has(namespacedToolName(tool.namespace, tool.name))), 64, requiredToolName(parsed));
  if (selectedTools.length) {
    body.tools = selectedTools.map((tool) => ({
      name: toClaudeToolName(sanitizeName(namespacedToolName(tool.namespace, tool.name)), oauth),
      description: tool.description ?? "",
      input_schema: normalizeSchema(tool.parameters),
    }));
  }

  if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop_sequences = parsed.options.stopSequences;

  const tc = parsed.options.toolChoice;
  if (tc === "auto") body.tool_choice = { type: "auto" };
  else if (tc === "none") body.tool_choice = { type: "none" };
  else if (tc === "required" || (tc && "allowedTools" in tc && tc.mode === "required")) body.tool_choice = { type: "any" };
  else if (tc && "allowedTools" in tc) body.tool_choice = { type: "auto" };
  else if (tc && "name" in tc) body.tool_choice = { type: "tool", name: toClaudeToolName(sanitizeName(tc.name), oauth) };

  if (parsed.reasoningEffort && parsed.reasoningEffort !== "none" && parsed.reasoningEffort !== "minimal") {
    const want = budget(parsed.options.reasoning ?? parsed.reasoningEffort);
    const maxOut = parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    const maxTokens = Math.min(REASONING_CEIL, Math.max(maxOut, want + HEADROOM));
    body.max_tokens = maxTokens;
    body.thinking = { type: "enabled", budget_tokens: Math.max(MIN_BUDGET, Math.min(want, maxTokens - FLOOR)) };
    // Anthropic extended thinking rejects temperature != 1 and top_p. Match opencodex by
    // dropping sampling controls whenever thinking is enabled.
    delete body.temperature;
    delete body.top_p;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
  if (oauth) { headers.Authorization = `Bearer ${auth.accessToken}`; headers["anthropic-beta"] = OAUTH_BETA; }
  else if (auth.apiKey) headers["x-api-key"] = auth.apiKey;

  return { url: `${ANTHROPIC_API}/v1/messages`, headers, body: JSON.stringify(body) };
}

function requiredToolName(parsed: OcxParsedRequest): string | undefined {
  const choice = parsed.options.toolChoice;
  return choice && typeof choice === "object" && "name" in choice ? choice.name : undefined;
}

export async function* streamAnthropic(response: Response): AsyncGenerator<AdapterEvent> {
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = await response.text(); } catch { /* ignore */ }
    yield { type: "error", status: response.status, errorType: "upstream_error", message: providerErrorMessage("Claude", response.status, detail) };
    return;
  }
  if (!response.body) { yield { type: "error", status: 502, errorType: "upstream_empty_response", message: "Claude가 응답 본문 없이 요청을 종료했습니다." }; return; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let blockType = "";
  let emittedDone = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) { eventType = line.slice(7).trim(); continue; }
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload) continue;
        let data: Record<string, unknown>;
        try { data = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        switch (eventType || (data.type as string)) {
          case "content_block_start": {
            const block = data.content_block as { type: string; id?: string; name?: string } | undefined;
            if (!block) break;
            blockType = block.type;
            if (block.type === "tool_use") yield { type: "tool_call_start", id: block.id ?? "", name: fromClaudeToolName(block.name ?? "") };
            break;
          }
          case "content_block_delta": {
            const delta = data.delta as Record<string, unknown> | undefined;
            if (!delta) break;
            if (delta.type === "text_delta" && typeof delta.text === "string") yield { type: "text_delta", text: delta.text };
            else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") yield { type: "thinking_delta", thinking: delta.thinking };
            else if (delta.type === "signature_delta" && typeof delta.signature === "string") yield { type: "thinking_signature", signature: delta.signature };
            else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") yield { type: "tool_call_delta", arguments: delta.partial_json };
            break;
          }
          case "content_block_stop": {
            if (blockType === "tool_use") { yield { type: "tool_call_end" }; blockType = ""; }
            break;
          }
          case "message_delta": {
            const usage = data.usage as Record<string, number> | undefined;
            if (usage) { yield { type: "done", usage: usageFrom(usage) }; emittedDone = true; }
            break;
          }
          case "error": {
            const err = data.error as { message?: string } | undefined;
            yield { type: "error", status: 502, errorType: "upstream_error", message: `Claude 스트림 오류: ${err?.message ?? "알 수 없는 오류"}` };
            return;
          }
        }
        eventType = "";
      }
    }
    if (!emittedDone) yield { type: "done" };
  } finally {
    reader.releaseLock();
  }
}
