// Copilot adapter: neutral request → GitHub Copilot chat/completions → AdapterEvent stream.
import { namespacedToolName, type AdapterEvent, type OcxAssistantMessage, type OcxContentPart, type OcxParsedRequest, type OcxToolResultMessage, type OcxUsage } from "./types.cjs";
import { budgetTools, normalizeSchema, sanitizeName } from "./tool-sanitize.cjs";
import { providerErrorMessage } from "./errors.cjs";
import { copilotChatHeaders } from "../provider-oauth.cjs";

const COPILOT_API = "https://api.githubcopilot.com";

function flatten(parts: { type: string; text?: string }[]): string {
  return parts.map((p) => (p.type === "text" ? p.text ?? "" : "")).join("");
}

function chatContent(parts: OcxContentPart[]): string | Array<Record<string, unknown>> {
  if (!parts.some((part) => part.type === "image")) return flatten(parts);
  return parts.map((part) => (
    part.type === "image"
      ? { type: "image_url", image_url: { url: part.dataUrl, ...(part.detail ? { detail: part.detail } : {}) } }
      : { type: "text", text: part.text }
  ));
}

function wireToolCallName(part: { name: string; namespace?: string }): string {
  return sanitizeName(namespacedToolName(part.namespace, part.name));
}

function toolResultWireName(result: OcxToolResultMessage): string {
  return sanitizeName(namespacedToolName(result.toolNamespace, result.toolName || "tool_result"));
}

function responsesContent(parts: OcxContentPart[], role: "user" | "developer" | "assistant"): Array<Record<string, unknown>> {
  return parts.map((part) => {
    if (part.type === "image") return { type: "input_image", image_url: part.dataUrl, ...(part.detail ? { detail: part.detail } : {}) };
    return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
  });
}

function toChatMessages(parsed: OcxParsedRequest): unknown[] {
  const out: unknown[] = [];
  let pendingToolCallIds = new Set<string>();
  if (parsed.context.instructions) out.push({ role: "system", content: parsed.context.instructions });
  for (const msg of parsed.context.messages) {
    if (msg.role === "user" || msg.role === "developer") {
      const role = msg.role === "developer" ? "system" : "user";
      out.push({ role, content: role === "user" ? chatContent(msg.content) : flatten(msg.content) });
      pendingToolCallIds = new Set();
    } else if (msg.role === "assistant") {
      const a = msg as OcxAssistantMessage;
      const text = a.content.filter((p) => p.type === "text").map((p) => (p.type === "text" ? p.text : "")).join("");
      const toolCalls = a.content.filter((p) => p.type === "toolCall").map((p) => p.type === "toolCall" ? ({ id: p.id, type: "function", function: { name: wireToolCallName(p), arguments: p.arguments || "{}" } }) : null).filter(Boolean);
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      pendingToolCallIds = new Set(toolCalls.map((call) => typeof call === "object" && call ? String((call as { id?: unknown }).id ?? "") : "").filter(Boolean));
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      const toolCallId = tr.toolCallId || `call_orphan_${out.length}`;
      if (!pendingToolCallIds.has(toolCallId)) {
        out.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: toolCallId, type: "function", function: { name: toolResultWireName(tr), arguments: "{}" } }],
        });
        pendingToolCallIds = new Set([toolCallId]);
      }
      out.push({ role: "tool", tool_call_id: toolCallId, content: flatten(tr.content) });
      pendingToolCallIds.delete(toolCallId);
    }
  }
  return out;
}

function toResponsesInput(parsed: OcxParsedRequest): unknown[] {
  const out: unknown[] = [];
  for (const msg of parsed.context.messages) {
    if (msg.role === "user" || msg.role === "developer") {
      out.push({ type: "message", role: msg.role, content: responsesContent(msg.content, msg.role) });
    } else if (msg.role === "assistant") {
      const a = msg as OcxAssistantMessage;
      const text = a.content.filter((p) => p.type === "text").map((p) => (p.type === "text" ? p.text : "")).join("");
      if (text) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const part of a.content) {
        if (part.type !== "toolCall") continue;
        out.push({ type: "function_call", call_id: part.id, name: wireToolCallName(part), arguments: part.arguments || "{}" });
      }
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      out.push({ type: "function_call_output", call_id: tr.toolCallId, output: flatten(tr.content) });
    }
  }
  return out.length ? out : [{ type: "message", role: "user", content: [{ type: "input_text", text: "" }] }];
}

function buildResponsesBody(parsed: OcxParsedRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: parsed.model, input: toResponsesInput(parsed), stream: true };
  if (parsed.context.instructions) body.instructions = parsed.context.instructions;
  const selectedTools = budgetTools(parsed.tools, 24, requiredToolName(parsed));
  if (selectedTools.length) {
    body.tools = selectedTools.map((tool) => ({
      type: "function",
      name: sanitizeName(namespacedToolName(tool.namespace, tool.name)),
      description: tool.description ?? "",
      parameters: normalizeSchema(tool.parameters),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    }));
    const choice = parsed.options.toolChoice;
    if (choice === "auto" || choice === "none" || choice === "required") body.tool_choice = choice;
    else if (choice && "name" in choice) body.tool_choice = { type: "function", name: sanitizeName(choice.name) };
  }
  if (parsed.options.maxOutputTokens !== undefined) body.max_output_tokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
  if (parsed.options.reasoning !== undefined) body.reasoning = { effort: parsed.options.reasoning === "xhigh" ? "high" : parsed.options.reasoning };
  if (parsed.options.serviceTier !== undefined) body.service_tier = parsed.options.serviceTier;
  return body;
}

export function buildCopilotRequest(parsed: OcxParsedRequest, auth: string | { bearer: string; apiUrl?: string }): { url: string; headers: Record<string, string>; body: string } {
  const bearer = typeof auth === "string" ? auth : auth.bearer;
  const apiUrl = typeof auth === "string" ? COPILOT_API : auth.apiUrl ?? COPILOT_API;
  const body: Record<string, unknown> = { model: parsed.model, messages: toChatMessages(parsed), stream: true };
  const selectedTools = budgetTools(parsed.tools, 24, requiredToolName(parsed));
  if (selectedTools.length) {
    const tools = selectedTools.map((tool) => ({
      type: "function",
      function: {
        name: sanitizeName(namespacedToolName(tool.namespace, tool.name)),
        description: tool.description ?? "",
        parameters: normalizeSchema(tool.parameters),
      },
    }));
    if (tools.length) body.tools = tools;
    const choice = parsed.options.toolChoice;
    if (choice === "auto" || choice === "none" || choice === "required") body.tool_choice = choice;
    else if (choice && "name" in choice) body.tool_choice = { type: "function", function: { name: sanitizeName(choice.name) } };
  }
  if (parsed.options.maxOutputTokens !== undefined) body.max_tokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
  if (parsed.options.presencePenalty !== undefined) body.presence_penalty = parsed.options.presencePenalty;
  if (parsed.options.frequencyPenalty !== undefined) body.frequency_penalty = parsed.options.frequencyPenalty;
  return { url: `${apiUrl}/chat/completions`, headers: copilotChatHeaders(bearer), body: JSON.stringify(body) };
}

function requiredToolName(parsed: OcxParsedRequest): string | undefined {
  const choice = parsed.options.toolChoice;
  return choice && typeof choice === "object" && "name" in choice ? choice.name : undefined;
}

export async function* streamCopilot(response: Response): AsyncGenerator<AdapterEvent> {
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = await response.text(); } catch { /* ignore */ }
    yield { type: "error", status: response.status, errorType: "upstream_error", message: providerErrorMessage("GitHub Copilot", response.status, detail) };
    return;
  }
  if (!response.body) { yield { type: "error", status: 502, errorType: "upstream_empty_response", message: "GitHub Copilot가 응답 본문 없이 요청을 종료했습니다." }; return; }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const tools = new Map<number, { started: boolean }>();
  const responseTools = new Map<string, { callId: string; name: string; args: string; started: boolean }>();
  let usage: OcxUsage | undefined;
  let sawResponsesTextDelta = false;
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
          yield { type: "error", status: 502, errorType: err.type ?? "upstream_error", message: `GitHub Copilot 스트림 오류: ${err.message ?? err.code ?? "알 수 없는 오류"}` };
          return;
        }
        const u = data.usage as Record<string, unknown> | undefined;
        if (u) {
          const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
          const cached = typeof details?.cached_tokens === "number" && details.cached_tokens > 0 ? details.cached_tokens : undefined;
          usage = {
            inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
            outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
            ...(cached ? { cachedInputTokens: cached } : {}),
          };
        }
        if (data.type === "response.output_text.delta" && typeof data.delta === "string" && data.delta) {
          sawResponsesTextDelta = true;
          yield { type: "text_delta", text: data.delta };
          continue;
        }
        if (data.type === "response.function_call_arguments.delta") {
          const itemId = String(data.item_id ?? data.output_item_id ?? data.call_id ?? "");
          const existing = responseTools.get(itemId);
          if (existing && typeof data.delta === "string") {
            if (!existing.started) {
              yield { type: "tool_call_start", id: existing.callId, name: existing.name };
              existing.started = true;
            }
            existing.args += data.delta;
            yield { type: "tool_call_delta", arguments: data.delta };
          }
          continue;
        }
        if (data.type === "response.function_call_arguments.done") {
          const itemId = String(data.item_id ?? data.output_item_id ?? data.call_id ?? "");
          const existing = responseTools.get(itemId);
          if (existing) {
            if (!existing.started) yield { type: "tool_call_start", id: existing.callId, name: existing.name };
            if (typeof data.arguments === "string" && data.arguments && !existing.args) yield { type: "tool_call_delta", arguments: data.arguments };
            yield { type: "tool_call_end" };
            responseTools.delete(itemId);
          }
          continue;
        }
        if (data.type === "response.output_item.added" || data.type === "response.output_item.done") {
          const item = data.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            const itemId = String(item.id ?? item.call_id ?? "");
            const callId = String(item.call_id ?? itemId);
            const name = String(item.name ?? "");
            const args = typeof item.arguments === "string" ? item.arguments : "";
            const existing = responseTools.get(itemId) ?? { callId, name, args: "", started: false };
            existing.callId = callId || existing.callId;
            existing.name = name || existing.name;
            responseTools.set(itemId, existing);
            if (data.type === "response.output_item.done") {
              if (!existing.started) yield { type: "tool_call_start", id: existing.callId, name: existing.name };
              if (args && !existing.args) yield { type: "tool_call_delta", arguments: args };
              yield { type: "tool_call_end" };
              responseTools.delete(itemId);
            }
          }
          continue;
        }
        if (data.type === "response.completed") {
          const responsePayload = data.response as Record<string, unknown> | undefined;
          const output = responsePayload?.output as Array<Record<string, unknown>> | undefined;
          if (output && !sawResponsesTextDelta) {
            for (const item of output) {
              if (item.type !== "message") continue;
              const content = item.content as Array<Record<string, unknown>> | undefined;
              for (const part of content ?? []) {
                if (part.type === "output_text" && typeof part.text === "string" && part.text) yield { type: "text_delta", text: part.text };
              }
            }
          }
          const u = responsePayload?.usage as Record<string, unknown> | undefined;
          if (u) usage = responsesUsage(u);
          yield { type: "done", usage };
          return;
        }
        const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
        if (!choice) continue;
        const delta = choice.delta as Record<string, unknown> | undefined;
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
        if (choice.finish_reason && tools.size) { yield { type: "tool_call_end" }; }
      }
    }
    yield { type: "done", usage };
  } finally {
    reader.releaseLock();
  }
}

function responsesUsage(u: Record<string, unknown>): OcxUsage {
  const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const inputDetails = u.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = u.output_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    ...(num(inputDetails?.cached_tokens) ? { cachedInputTokens: num(inputDetails?.cached_tokens) } : {}),
    ...(num(outputDetails?.reasoning_tokens) ? { reasoningOutputTokens: num(outputDetails?.reasoning_tokens) } : {}),
  };
}
