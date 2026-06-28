// Copilot adapter: neutral request → GitHub Copilot chat/completions → AdapterEvent stream.
import { namespacedToolName, type AdapterEvent, type OcxAssistantMessage, type OcxContentPart, type OcxParsedRequest, type OcxToolResultMessage, type OcxUsage } from "./types.cjs";
import { budgetTools, normalizeSchema, sanitizeName } from "./tool-sanitize.cjs";
import { providerErrorMessage } from "./errors.cjs";

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

export function buildCopilotRequest(parsed: OcxParsedRequest, bearer: string): { url: string; headers: Record<string, string>; body: string } {
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
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`, "Content-Type": "application/json",
    // Copilot gates newer models (gpt-5.x, claude) behind an integration id; the
    // chat endpoint returns "model not supported" without it even when /models
    // lists the model. vscode-chat is the editor-chat integration.
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": "vscode/1.90.2", "Editor-Plugin-Version": "copilot-chat/0.17.2",
    "Openai-Intent": "conversation-panel", "X-Initiator": "user", "User-Agent": "GithubCopilot/1.155.0",
  };
  return { url: `${COPILOT_API}/chat/completions`, headers, body: JSON.stringify(body) };
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
        if (!payload || payload === "[DONE]") continue;
        let data: Record<string, unknown>;
        try { data = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        const err = data.error as { message?: string; code?: string; type?: string } | undefined;
        if (err) {
          yield { type: "error", status: 502, errorType: err.type ?? "upstream_error", message: `GitHub Copilot 스트림 오류: ${err.message ?? err.code ?? "알 수 없는 오류"}` };
          return;
        }
        const u = data.usage as Record<string, number> | undefined;
        if (u) usage = { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
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
