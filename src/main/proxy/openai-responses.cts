// OpenAI Responses passthrough compatibility, adapted from OpenCodex (MIT).
// Used by both the ChatGPT-forward Bridge route and OpenAI API-key external models.
import type { OcxParsedRequest } from "./types.cjs";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "./compaction.cjs";
import { OCX_REASONING_PREFIX } from "./reasoning-envelope.cjs";
import { apiProviderUrl } from "../provider-settings.cjs";

export const FORWARDED_OPENAI_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function repairExecTool(tool: unknown): unknown {
  if (!isPlainObject(tool) || tool.type !== "custom" || tool.name !== "exec" || typeof tool.description !== "string") return tool;
  const description = tool.description;
  const hasStaleExample = description.includes("tools.exec_command");
  const exposesShellCommand = /###\s+`shell_command`|\btools\.shell_command\b|\bshell_command\s*\(/.test(description);
  const exposesExecCommand = /###\s+`exec_command`|\bexec_command\s*\([^)]*\)\s*:\s*Promise/.test(description);
  if (!hasStaleExample || !exposesShellCommand || exposesExecCommand) return tool;
  const repaired = description
    .replace(/await\s+tools\.exec_command\([^\n]*?\)/g, "await tools.shell_command({ command: \"git status\" })")
    .replaceAll("tools.exec_command", "tools.shell_command");
  return { ...tool, description: repaired };
}

function repairForwardedExecToolDescriptions(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  let changed = false;
  const repairTools = (tools: unknown[]): unknown[] => tools.map((tool) => {
    const repaired = repairExecTool(tool);
    if (repaired !== tool) changed = true;
    return repaired;
  });
  const tools = Array.isArray(body.tools) ? repairTools(body.tools) : body.tools;
  const input = Array.isArray(body.input) ? body.input.map((item) => {
    if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
    const originalTools = item.tools;
    const repaired = repairTools(originalTools);
    return repaired.some((tool, index) => tool !== originalTools[index]) ? { ...item, tools: repaired } : item;
  }) : body.input;
  return changed ? { ...body, ...(tools !== body.tools ? { tools } : {}), ...(input !== body.input ? { input } : {}) } : body;
}

function sanitizeReasoningInputContent(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map((item) => {
    if (!isPlainObject(item) || item.type !== "reasoning") return item;
    const hasRawContent = Array.isArray(item.content) && item.content.length > 0;
    const hasDevilEnvelope = typeof item.encrypted_content === "string" && item.encrypted_content.startsWith(OCX_REASONING_PREFIX);
    if (!hasRawContent && !hasDevilEnvelope) return item;
    changed = true;
    const next: Record<string, unknown> = { ...item, content: [] };
    if (hasDevilEnvelope) delete next.encrypted_content;
    return next;
  });
  return changed ? { ...body, input } : body;
}

function stripInvalidItemIds(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const prefixes: Record<string, string> = {
    message: "msg_",
    reasoning: "rs_",
    function_call: "fc_",
    custom_tool_call: "ctc_",
    tool_search_call: "tsc_",
    web_search_call: "ws_",
  };
  let changed = false;
  const input = body.input.map((item) => {
    if (!isPlainObject(item) || typeof item.type !== "string" || !("id" in item)) return item;
    const prefix = prefixes[item.type];
    if (!prefix || (typeof item.id === "string" && item.id.startsWith(prefix))) return item;
    changed = true;
    const next = { ...item };
    delete next.id;
    return next;
  });
  return changed ? { ...body, input } : body;
}

function stripItemIdsWhenUnstored(body: unknown): unknown {
  if (!isPlainObject(body) || body.store !== false || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map((item) => {
    if (!isPlainObject(item) || !("id" in item)) return item;
    changed = true;
    const next = { ...item };
    delete next.id;
    return next;
  });
  return changed ? { ...body, input } : body;
}

function scrubDevilCompactionItems(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map((item) => {
    if (!isPlainObject(item) || !["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) return item;
    const summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    if (summary === null) return item;
    changed = true;
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }],
    };
  });
  return changed ? { ...body, input } : body;
}

function stripPreviousResponseId(body: unknown, strip: boolean): unknown {
  if (!strip || !isPlainObject(body) || !("previous_response_id" in body)) return body;
  const { previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? "");
  return output.map((part) => {
    if (!isPlainObject(part)) return "";
    if (typeof part.text === "string") return part.text;
    if (part.type === "refusal" && typeof part.refusal === "string") return `[refusal] ${part.refusal}`;
    return "";
  }).filter(Boolean).join("\n");
}

function repairOrphanedInputItems(body: unknown, dropReasoning: boolean): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const functionCalls = new Set<string>();
  const customCalls = new Set<string>();
  for (const item of body.input) {
    if (!isPlainObject(item) || typeof item.call_id !== "string") continue;
    if (item.type === "function_call" || item.type === "local_shell_call") functionCalls.add(item.call_id);
    else if (item.type === "custom_tool_call") customCalls.add(item.call_id);
  }
  let changed = false;
  const input: unknown[] = [];
  for (const item of body.input) {
    if (!isPlainObject(item)) { input.push(item); continue; }
    if (dropReasoning && item.type === "reasoning") { changed = true; continue; }
    const functionOutput = item.type === "function_call_output";
    const customOutput = item.type === "custom_tool_call_output";
    if (functionOutput || customOutput) {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const paired = functionOutput ? functionCalls.has(callId) : customCalls.has(callId);
      if (!paired) {
        changed = true;
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[tool output for ${callId || "unknown call"}]\n${toolOutputText(item.output)}` }],
        });
        continue;
      }
    }
    input.push(item);
  }
  return changed ? { ...body, input } : body;
}

const UNSUPPORTED_HOSTED_TOOLS = new Set(["image_generation", "tool_search"]);

function stripUnsupportedHostedTools(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.tools) || !String(body.model ?? "").includes("codex-spark")) return body;
  const tools = body.tools.filter((tool) => !isPlainObject(tool) || typeof tool.type !== "string" || !UNSUPPORTED_HOSTED_TOOLS.has(tool.type));
  return tools.length === body.tools.length ? body : { ...body, tools };
}

function stripUnsupportedReasoningParams(body: unknown): unknown {
  if (!isPlainObject(body) || !String(body.model ?? "").includes("codex-spark") || !isPlainObject(body.reasoning)) return body;
  const { context: _context, summary: _summary, generate_summary: _generateSummary, ...reasoning } = body.reasoning;
  if (_context === undefined && _summary === undefined && _generateSummary === undefined) return body;
  return { ...body, reasoning: Object.keys(reasoning).length ? reasoning : undefined };
}

function stripSparkCompatibility(body: unknown): unknown {
  if (!isPlainObject(body) || !String(body.model ?? "").includes("codex-spark")) return body;
  const safeTypes = new Set(["function", "web_search", "web_search_preview"]);
  let changed = false;
  const cleanTools = (raw: unknown[]): unknown[] => {
    const flat: unknown[] = [];
    for (const tool of raw) {
      if (isPlainObject(tool) && tool.type === "namespace") {
        changed = true;
        if (Array.isArray(tool.tools)) flat.push(...tool.tools);
      } else if (isPlainObject(tool) && typeof tool.type === "string" && !safeTypes.has(tool.type)) {
        changed = true;
      } else flat.push(tool);
    }
    return flat.map((tool) => {
      if (!isPlainObject(tool) || tool.type !== "function" || !("defer_loading" in tool)) return tool;
      changed = true;
      const { defer_loading: _deferLoading, ...rest } = tool;
      return rest;
    });
  };
  const tools = Array.isArray(body.tools) ? cleanTools(body.tools) : body.tools;
  const unsupportedItems = new Set(["tool_search_call", "tool_search_output", "custom_tool_call", "custom_tool_call_output"]);
  const input = Array.isArray(body.input) ? body.input.flatMap((item): unknown[] => {
    if (!isPlainObject(item)) return [item];
    if (typeof item.type === "string" && unsupportedItems.has(item.type)) { changed = true; return []; }
    if (item.type === "additional_tools" && Array.isArray(item.tools)) return [{ ...item, tools: cleanTools(item.tools) }];
    if ("namespace" in item) {
      changed = true;
      const { namespace: _namespace, ...rest } = item;
      return [rest];
    }
    return [item];
  }) : body.input;
  const parallel = body.parallel_tool_calls === true ? false : body.parallel_tool_calls;
  if (body.parallel_tool_calls === true) changed = true;
  return changed ? { ...body, ...(tools !== body.tools ? { tools } : {}), ...(input !== body.input ? { input } : {}), parallel_tool_calls: parallel } : body;
}

function stripConflictingHostedTools(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.tools)) return body;
  const hasImageFunction = body.tools.some((tool) => isPlainObject(tool) && typeof tool.name === "string"
    && (tool.name === "image_gen" || tool.name.startsWith("image_gen.") || (tool.type === "namespace" && tool.name === "image_gen")));
  if (!hasImageFunction) return body;
  const tools = body.tools.filter((tool) => !isPlainObject(tool) || tool.type !== "image_generation");
  return tools.length === body.tools.length ? body : { ...body, tools };
}

export function prepareOpenAiResponsesBody(
  body: unknown,
  options: { model?: string; forward: boolean; previousResponseInputExpanded?: boolean },
): unknown {
  let output: unknown = isPlainObject(body) && options.model ? { ...body, model: options.model } : body;
  const previousId = isPlainObject(output) && typeof output.previous_response_id === "string";
  output = stripPreviousResponseId(output, options.forward || options.previousResponseInputExpanded === true);
  if (options.forward) {
    output = repairForwardedExecToolDescriptions(output);
    output = repairOrphanedInputItems(output, previousId && options.previousResponseInputExpanded !== true);
  }
  else output = stripConflictingHostedTools(output);
  output = scrubDevilCompactionItems(output);
  output = sanitizeReasoningInputContent(output);
  output = stripUnsupportedHostedTools(output);
  output = stripInvalidItemIds(output);
  output = stripItemIdsWhenUnstored(output);
  output = stripUnsupportedReasoningParams(output);
  return stripSparkCompatibility(output);
}

export function buildOpenAiResponsesApiKeyRequest(
  parsed: OcxParsedRequest,
  apiKey: string,
): { url: string; headers: Record<string, string>; body: string } {
  if (!apiKey.trim()) throw new Error("OpenAI API key가 없습니다.");
  const body = prepareOpenAiResponsesBody(parsed._rawBody, {
    model: parsed.model,
    forward: false,
    previousResponseInputExpanded: parsed._previousResponseInputExpanded,
  });
  return {
    url: apiProviderUrl("openai", "/responses"),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function nextSseBlock(buffer: string): { block: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  return { block: buffer.slice(0, match.index), rest: buffer.slice(match.index + match[0].length) };
}

export function sseDataPayload(block: string): string | null {
  const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (!lines.length) return null;
  return lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
}

export function inspectResponsesPayload(payload: string): {
  terminal?: "completed" | "failed" | "incomplete";
  response?: Record<string, unknown>;
  outputItem?: { outputIndex: number; item: Record<string, unknown> };
} {
  if (!payload || payload === "[DONE]") return {};
  try {
    const event = JSON.parse(payload) as { type?: unknown; response?: unknown; output_index?: unknown; item?: unknown };
    const terminal = event.type === "response.completed" ? "completed"
      : event.type === "response.failed" ? "failed"
      : event.type === "response.incomplete" ? "incomplete"
      : undefined;
    return {
      ...(terminal ? { terminal } : {}),
      ...(event.type === "response.completed" && isPlainObject(event.response) ? { response: event.response } : {}),
      ...(event.type === "response.output_item.done" && Number.isInteger(event.output_index) && Number(event.output_index) >= 0 && isPlainObject(event.item)
        ? { outputItem: { outputIndex: Number(event.output_index), item: event.item } }
        : {}),
    };
  } catch {
    return {};
  }
}

export function restoreStreamedResponseOutput(
  response: Record<string, unknown>,
  streamed: Array<{ outputIndex: number; item: Record<string, unknown> }>,
): Record<string, unknown> {
  if (Array.isArray(response.output) && response.output.length > 0) return response;
  const output = [...streamed]
    .sort((left, right) => left.outputIndex - right.outputIndex)
    .map(({ item }) => item);
  return output.length ? { ...response, output } : response;
}

export function sanitizePassthroughHeaders(headers: Headers): Record<string, string> {
  const drop = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "set-cookie2", "te", "trailer", "upgrade"]);
  const output: Record<string, string> = {};
  headers.forEach((value, key) => { if (!drop.has(key.toLowerCase())) output[key] = value; });
  return output;
}
