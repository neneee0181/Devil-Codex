// Copilot adapter: neutral request → GitHub Copilot chat/completions → AdapterEvent stream.
import { allowedToolNames, namespacedToolName, type AdapterEvent, type OcxAssistantMessage, type OcxContentPart, type OcxParsedRequest, type OcxToolResultMessage } from "./types.cjs";
import { buildToolCatalogNudge, sanitizeName } from "./tool-sanitize.cjs";
import { copilotChatHeaders } from "../provider-oauth.cjs";
import { neutralizeIdentity } from "./identity.cjs";
import { streamOpenAiCompatible } from "./api-key.cjs";

const COPILOT_API = "https://api.githubcopilot.com";

function flatten(parts: { type: string; text?: string }[]): string {
  return parts.map((p) => (p.type === "text" ? p.text ?? "" : p.type === "image" ? "[image]" : "")).join("");
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

function toChatMessages(parsed: OcxParsedRequest, visibleToolNames: string[]): unknown[] {
  const out: unknown[] = [];
  let pendingToolCallIds = new Set<string>();
  const nudge = buildToolCatalogNudge(visibleToolNames, parsed.options.toolChoice);
  const instructions = neutralizeIdentity([parsed.context.instructions, nudge].filter(Boolean).join("\n\n"));
  if (instructions) out.push({ role: "system", content: instructions });
  for (const msg of parsed.context.messages) {
    if (msg.role === "user" || msg.role === "developer") {
      const role = msg.role === "developer" ? "system" : "user";
      out.push({ role, content: role === "user" ? chatContent(msg.content) : flatten(msg.content) });
      pendingToolCallIds = new Set();
    } else if (msg.role === "assistant") {
      const a = msg as OcxAssistantMessage;
      const text = a.content.filter((p) => p.type === "text").map((p) => (p.type === "text" ? p.text : "")).join("");
      const toolCalls = a.content.filter((p) => p.type === "toolCall").map((p) => p.type === "toolCall" ? ({ id: p.id, type: "function", function: { name: wireToolCallName(p), arguments: p.arguments || "{}" } }) : null).filter(Boolean);
      // Strict OpenAI-compatible validators reject null content on an assistant
      // tool-call message and reject fully empty assistant history entries.
      if (!text && !toolCalls.length) continue;
      out.push({ role: "assistant", content: text || "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      pendingToolCallIds = new Set(toolCalls.map((call) => typeof call === "object" && call ? String((call as { id?: unknown }).id ?? "") : "").filter(Boolean));
    } else if (msg.role === "toolResult") {
      const tr = msg as OcxToolResultMessage;
      const toolCallId = tr.toolCallId || `call_orphan_${out.length}`;
      if (!pendingToolCallIds.has(toolCallId)) {
        out.push({
          role: "assistant",
          content: "",
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

export function buildCopilotRequest(parsed: OcxParsedRequest, auth: string | { bearer: string; apiUrl?: string }): { url: string; headers: Record<string, string>; body: string } {
  const bearer = typeof auth === "string" ? auth : auth.bearer;
  const apiUrl = typeof auth === "string" ? COPILOT_API : auth.apiUrl ?? COPILOT_API;
  const allowed = allowedToolNames(parsed.options.toolChoice);
  const selectedTools = parsed.tools.filter((tool) => !allowed || allowed.has(tool.name) || allowed.has(namespacedToolName(tool.namespace, tool.name)));
  const visibleToolNames = selectedTools.map((tool) => sanitizeName(namespacedToolName(tool.namespace, tool.name)));
  const body: Record<string, unknown> = { model: parsed.model, messages: toChatMessages(parsed, visibleToolNames), stream: true };
  if (selectedTools.length) {
    const tools = selectedTools.map((tool) => ({
      type: "function",
      function: {
        name: sanitizeName(namespacedToolName(tool.namespace, tool.name)),
        description: tool.description ?? "",
        parameters: tool.parameters,
      },
    }));
    if (tools.length) body.tools = tools;
    body.parallel_tool_calls = parsed.options.parallelToolCalls !== false;
    const choice = parsed.options.toolChoice;
    if (choice === "auto" || choice === "none" || choice === "required") body.tool_choice = choice;
    else if (choice && "name" in choice) body.tool_choice = { type: "function", function: { name: sanitizeName(choice.name) } };
    else if (choice && "allowedTools" in choice) body.tool_choice = choice.mode === "required" ? "required" : "auto";
  }
  if (parsed.options.maxOutputTokens !== undefined) body.max_tokens = parsed.options.maxOutputTokens;
  if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
  if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
  if (parsed.options.stopSequences !== undefined) body.stop = parsed.options.stopSequences;
  if (parsed.options.presencePenalty !== undefined) body.presence_penalty = parsed.options.presencePenalty;
  if (parsed.options.frequencyPenalty !== undefined) body.frequency_penalty = parsed.options.frequencyPenalty;
  body.stream_options = { include_usage: true };
  return { url: `${apiUrl}/chat/completions`, headers: copilotChatHeaders(bearer), body: JSON.stringify(body) };
}

export async function* streamCopilot(response: Response): AsyncGenerator<AdapterEvent> {
  yield* streamOpenAiCompatible("GitHub Copilot", response);
}
