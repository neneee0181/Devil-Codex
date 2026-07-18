// Slim Codex Responses request parser → neutral OcxParsedRequest.
// Adapted from opencodex (MIT), minus zod / web-search / structured-output.
import { Buffer } from "node:buffer";
import { compactionItemToText } from "./compaction.cjs";
import { decodeReasoningEnvelope } from "./reasoning-envelope.cjs";
import { namespacedToolName, type OcxAssistantMessage, type OcxContentPart, type OcxMessage, type OcxParsedRequest, type OcxRequestOptions, type OcxTextContent, type OcxThinkingContent, type OcxTool } from "./types.cjs";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hostedWebSearch(tools: unknown[] | undefined): Record<string, unknown> | undefined {
  if (!tools) return undefined;
  for (const tool of tools) {
    if (isObj(tool) && (tool.type === "web_search" || tool.type === "web_search_preview")) return tool;
  }
  return undefined;
}

function structuredOutput(text: unknown): boolean {
  if (!isObj(text)) return false;
  const format = text.format;
  if (!isObj(format)) return false;
  return format.type === "json_schema" || format.type === "json_object";
}

function dataUrlText(url: string): string | undefined {
  const match = url.match(/^data:([^;,]+)(;base64)?,(.*)$/);
  if (!match) return undefined;
  const mime = match[1].toLowerCase();
  if (!mime.startsWith("text/") && !mime.includes("json") && !mime.includes("xml") && !mime.includes("csv")) return undefined;
  try {
    const body = match[3] ?? "";
    return match[2] ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
  } catch {
    return undefined;
  }
}

function fileText(raw: Record<string, unknown>): string {
  const name = String(raw.filename ?? raw.file_id ?? "?");
  const data = typeof raw.file_data === "string" ? dataUrlText(raw.file_data) : undefined;
  if (!data) return `[file: ${name}]`;
  return `[file: ${name}]\n${data}`;
}

function inputContentParts(blocks: unknown[] | string | undefined): OcxContentPart[] {
  if (typeof blocks === "string") return blocks ? [{ type: "text", text: blocks }] : [];
  if (!blocks) return [];
  const parts: OcxContentPart[] = [];
  for (const raw of blocks) {
    if (!isObj(raw)) continue;
    if (raw.type === "input_text" || raw.type === "text") parts.push({ type: "text", text: String(raw.text ?? "") });
    else if (raw.type === "input_image" && typeof raw.image_url === "string") {
      parts.push({ type: "image", dataUrl: raw.image_url, ...(typeof raw.detail === "string" ? { detail: raw.detail === "original" ? "high" : raw.detail } : {}) });
    } else if (raw.type === "input_image" && typeof raw.file_id === "string") {
      parts.push({ type: "text", text: `[image: ${raw.file_id}]` });
    } else if (raw.type === "input_file") {
      parts.push({ type: "text", text: fileText(raw) });
    }
  }
  return parts;
}

function outputTextOf(blocks: unknown[] | string | undefined): OcxTextContent[] {
  if (typeof blocks === "string") return blocks ? [{ type: "text", text: blocks }] : [];
  if (!blocks) return [];
  const out: OcxTextContent[] = [];
  for (const raw of blocks) {
    if (!isObj(raw)) continue;
    if (raw.type === "output_text" || raw.type === "text") out.push({ type: "text", text: String(raw.text ?? "") });
    else if (raw.type === "refusal") out.push({ type: "text", text: `[refusal: ${String(raw.refusal ?? "")}]` });
  }
  return out;
}

function outputToToolResultContent(output: unknown): OcxContentPart[] {
  if (typeof output === "string") return output ? [{ type: "text", text: output }] : [];
  if (!Array.isArray(output)) return [];
  const parts: OcxContentPart[] = [];
  for (const raw of output) {
    if (!isObj(raw)) continue;
    if ((raw.type === "output_text" || raw.type === "text" || raw.type === "input_text") && typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text });
    } else if (raw.type === "refusal" && typeof raw.refusal === "string") {
      parts.push({ type: "text", text: `[refusal: ${raw.refusal}]` });
    } else if (raw.type === "input_image" && typeof raw.image_url === "string") {
      parts.push({ type: "image", dataUrl: raw.image_url, ...(typeof raw.detail === "string" ? { detail: raw.detail === "original" ? "high" : raw.detail } : {}) });
    } else if (raw.type === "encrypted_content") {
      parts.push({ type: "text", text: "[encrypted content omitted]" });
    }
  }
  return parts;
}

function ensureAssistant(messages: OcxMessage[]): OcxAssistantMessage {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") return last;
  const placeholder: OcxAssistantMessage = { role: "assistant", content: [] };
  messages.push(placeholder);
  return placeholder;
}

function buildTools(tools: unknown[] | undefined, loaded = false): OcxTool[] {
  if (!tools) return [];
  const out: OcxTool[] = [];
  const pushFunctionTool = (tool: Record<string, unknown>, namespace?: string): void => {
    out.push({
      name: String(tool.name),
      description: String(tool.description ?? ""),
      parameters: isObj(tool.parameters) ? tool.parameters : {},
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      ...(namespace ? { namespace } : {}),
      ...(loaded ? { loaded: true } : {}),
    });
  };
  for (const t of tools) {
    if (!isObj(t)) continue;
    if (t.type === "function" && typeof t.name === "string") {
      pushFunctionTool(t);
    } else if (t.type === "namespace" && Array.isArray(t.tools)) {
      const namespace = typeof t.name === "string" ? t.name : undefined;
      for (const inner of t.tools) if (isObj(inner) && inner.type === "function" && typeof inner.name === "string") {
        pushFunctionTool(inner, namespace);
      }
    } else if (t.type === "custom" && typeof t.name === "string") {
      out.push({
        name: t.name,
        description: String(t.description ?? ""),
        parameters: { type: "object", properties: { input: { type: "string", description: "Raw tool input body." } }, required: ["input"] },
        freeform: true,
        ...(loaded ? { loaded: true } : {}),
      });
    } else if (t.type === "tool_search") {
      out.push({
        name: "tool_search",
        description: String(t.description ?? "Search for additional tools to load for the next turn."),
        parameters: isObj(t.parameters) ? t.parameters : {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query for tools to load." },
            limit: { type: "number", description: "Maximum number of tools to return." },
          },
          required: ["query"],
        },
        toolSearch: true,
        ...(loaded ? { loaded: true } : {}),
      });
    } else if (typeof t.name === "string" && t.type !== "web_search" && t.type !== "image_generation") {
      pushFunctionTool(t);
    }
  }
  return out;
}

function findTool(messages: OcxMessage[], callId: string): { name: string; namespace?: string } {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const part of m.content) if (part.type === "toolCall" && part.id === callId) return { name: part.name, namespace: part.namespace };
  }
  return { name: "" };
}

function toolSearchWireNames(specs: Record<string, unknown>[]): string[] {
  const names: string[] = [];
  for (const spec of specs) {
    if (spec.type === "namespace" && typeof spec.name === "string" && Array.isArray(spec.tools)) {
      for (const inner of spec.tools) {
        if (isObj(inner) && typeof inner.name === "string") {
          names.push(namespacedToolName(spec.name, inner.name));
        }
      }
    } else if (typeof spec.name === "string") {
      names.push(spec.name);
    }
  }
  return names;
}

function mergeTools(declared: OcxTool[], loaded: OcxTool[]): OcxTool[] {
  const seen = new Set<string>();
  const out: OcxTool[] = [];
  for (const tool of [...declared, ...loaded]) {
    const key = namespacedToolName(tool.namespace, tool.name);
    if (seen.has(key)) {
      const existing = out.find((candidate) => namespacedToolName(candidate.namespace, candidate.name) === key);
      if (existing && tool.loaded) existing.loaded = true;
      continue;
    }
    seen.add(key);
    out.push(tool);
  }
  return out;
}

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function mapToolChoice(choice: unknown): OcxRequestOptions["toolChoice"] | undefined {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (!isObj(choice)) return undefined;
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    const allowedTools = choice.tools.flatMap((entry) => {
      if (!isObj(entry)) return [];
      if (typeof entry.name === "string") return [entry.name];
      if (entry.type === "web_search" || entry.type === "web_search_preview") return ["web_search"];
      if (entry.type === "tool_search") return ["tool_search"];
      return [];
    });
    return allowedTools.length ? { allowedTools: [...new Set(allowedTools)], mode: choice.mode === "required" ? "required" : "auto" } : "none";
  }
  if (choice.type === "function" && isObj(choice.function) && typeof choice.function.name === "string") {
    return { name: choice.function.name };
  }
  if (choice.type === "tool" && typeof choice.name === "string") return { name: choice.name };
  if (typeof choice.name === "string") return { name: choice.name };
  return undefined;
}

export function parseRequest(body: unknown): OcxParsedRequest {
  const data = (isObj(body) ? body : {}) as Record<string, unknown>;
  const messages: OcxMessage[] = [];
  const system: string[] = [];
  const loadedToolSpecs: unknown[] = [];
  const pendingReasoning: OcxThinkingContent[] = [];
  let compactionRequest = false;
  const assistantWithReasoning = (): OcxAssistantMessage => {
    const assistant = ensureAssistant(messages);
    if (pendingReasoning.length) assistant.content.push(...pendingReasoning.splice(0));
    return assistant;
  };
  if (typeof data.instructions === "string" && data.instructions) system.push(data.instructions);

  const input = data.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: input }] });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!isObj(item)) continue;
      const type = (item.type as string) ?? ("role" in item ? "message" : "");
      if (type === "compaction_trigger") {
        compactionRequest = true;
      } else if (type === "additional_tools") {
        // Codex Desktop's Responses WebSocket-lite transport places the active
        // tool catalog in input instead of the top-level `tools` field. Losing
        // this item leaves external models with no exec/read tools, so they
        // answer with a preamble and finish without doing the requested work.
        if (Array.isArray(item.tools)) loadedToolSpecs.push(...item.tools);
      } else if (type === "compaction" || type === "compaction_summary" || type === "context_compaction") {
        const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
        if (type === "context_compaction" && !encrypted) continue;
        pendingReasoning.length = 0;
        messages.push({ role: "user", content: [{ type: "text", text: compactionItemToText(encrypted) }] });
      } else if (type === "agent_message") {
        pendingReasoning.length = 0;
        const content = inputContentParts(item.content as unknown[] | string | undefined);
        messages.push({ role: "user", content: content.length ? content : [{ type: "text", text: "(sub-agent message received)" }] });
      } else if (type === "message") {
        const role = item.role as string;
        if (role === "system") {
          pendingReasoning.length = 0;
          const flat = inputContentParts(item.content as unknown[] | string | undefined).map((p) => (p.type === "text" ? p.text : "")).join("");
          if (flat) system.push(flat);
        } else if (role === "user" || role === "developer") {
          pendingReasoning.length = 0;
          messages.push({ role, content: inputContentParts(item.content as unknown[] | string | undefined) });
        } else if (role === "assistant") {
          messages.push({ role: "assistant", content: [...pendingReasoning.splice(0), ...outputTextOf(item.content as unknown[] | string | undefined)] });
        }
      } else if (type === "reasoning") {
        const summary = Array.isArray(item.summary) ? (item.summary as Array<{ text?: string }>).map((c) => c.text ?? "").join("") : "";
        const content = Array.isArray(item.content) ? (item.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("") : "";
        const text = summary || content;
        const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
        const envelope = encrypted ? decodeReasoningEnvelope(encrypted) : null;
        const thinkingText = envelope?.txt || text;
        if (thinkingText || envelope?.sig || envelope?.red?.length) {
          const part: OcxThinkingContent = {
            type: "thinking",
            text: thinkingText,
            ...(envelope?.sig ? { signature: envelope.sig } : thinkingText && encrypted ? { signature: JSON.stringify(item) } : {}),
            ...(envelope?.red ? { redacted: envelope.red } : {}),
            ...(typeof item.id === "string" ? { itemId: item.id } : {}),
          };
          const previous = pendingReasoning[pendingReasoning.length - 1];
          if (!envelope?.sig && previous && !previous.signature) previous.text += `\n${part.text}`;
          else pendingReasoning.push(part);
        }
      } else if (type === "function_call") {
        let args = "{}";
        const rawArgs = typeof item.arguments === "string" ? item.arguments.trim() : "";
        if (rawArgs) {
          try {
            const decoded = JSON.parse(rawArgs) as unknown;
            if (isObj(decoded)) args = JSON.stringify(decoded);
          } catch {
            console.warn(`[parser] function_call ${String(item.call_id ?? item.id ?? "")} has non-JSON arguments; defaulting to {}`);
          }
        }
        assistantWithReasoning().content.push({ type: "toolCall", id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: args, ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}) });
      } else if (type === "custom_tool_call") {
        assistantWithReasoning().content.push({ type: "toolCall", id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: JSON.stringify({ input: item.input ?? "" }), ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}) });
      } else if (type === "local_shell_call") {
        const callId = String(item.call_id ?? item.id ?? "");
        const action = isObj(item.action) ? item.action : undefined;
        const command = Array.isArray(action?.command) ? action.command.filter((part): part is string => typeof part === "string") : [];
        if (callId) assistantWithReasoning().content.push({
          type: "toolCall",
          id: callId,
          name: "shell",
          arguments: JSON.stringify(command.length ? { command } : {}),
        });
      } else if (type === "tool_search_call") {
        const callId = String(item.call_id ?? item.id ?? "");
        const args = isObj(item.arguments) ? JSON.stringify(item.arguments) : "{}";
        assistantWithReasoning().content.push({ type: "toolCall", id: callId, name: "tool_search", arguments: args });
      } else if (type === "tool_search_output") {
        pendingReasoning.length = 0;
        const callId = String(item.call_id ?? "");
        const specs = Array.isArray(item.tools) ? (item.tools as unknown[]).filter(isObj) : [];
        loadedToolSpecs.push(...specs);
        const wireNames = toolSearchWireNames(specs);
        const failed = typeof item.status === "string" && item.status !== "completed" && item.status !== "success";
        messages.push({
          role: "toolResult",
          toolCallId: callId,
          toolName: "tool_search",
          content: [{
            type: "text",
            text: failed && !wireNames.length
              ? `Tool search failed (status: ${String(item.status)}).`
              : wireNames.length
              ? `Tool search loaded these tools. They are now available. Call one by its exact name: ${wireNames.join(", ")}.`
              : "Tool search returned no tools.",
          }],
          isError: failed && !wireNames.length,
        });
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        pendingReasoning.length = 0;
        const callId = String(item.call_id ?? "");
        const content = outputToToolResultContent(item.output);
        const tool = findTool(messages, callId);
        messages.push({ role: "toolResult", toolCallId: callId, toolName: tool.name, toolNamespace: tool.namespace, content });
      } else if (type === "web_search_call") {
        const action = isObj(item.action) && typeof item.action.query === "string" ? ` (${item.action.query})` : "";
        assistantWithReasoning().content.push({ type: "text", text: `[web search completed${action}]` });
      }
    }
  }

  const reasoning = isObj(data.reasoning) ? data.reasoning : undefined;
  const requestedEffort = reasoning?.effort === "ultra" ? "max" : reasoning?.effort;
  const effort = typeof requestedEffort === "string" && EFFORTS.has(requestedEffort) ? requestedEffort : "medium";
  const declaredTools = buildTools(data.tools as unknown[] | undefined);
  const loadedTools = buildTools(loadedToolSpecs, true);
  const webSearch = hostedWebSearch(data.tools as unknown[] | undefined);
  const isStructured = structuredOutput(data.text);
  const options: OcxRequestOptions = {};
  const maxOutputTokens = finiteNumber(data.max_output_tokens);
  const temperature = finiteNumber(data.temperature);
  const topP = finiteNumber(data.top_p);
  const presencePenalty = finiteNumber(data.presence_penalty);
  const frequencyPenalty = finiteNumber(data.frequency_penalty);
  const serviceTier = typeof data.service_tier === "string" ? data.service_tier : typeof data.serviceTier === "string" ? data.serviceTier : undefined;
  if (maxOutputTokens !== undefined) options.maxOutputTokens = maxOutputTokens;
  if (temperature !== undefined) options.temperature = temperature;
  if (topP !== undefined) options.topP = topP;
  if (presencePenalty !== undefined) options.presencePenalty = presencePenalty;
  if (frequencyPenalty !== undefined) options.frequencyPenalty = frequencyPenalty;
  if (typeof data.stop === "string") options.stopSequences = [data.stop];
  else if (Array.isArray(data.stop)) options.stopSequences = data.stop.filter((s): s is string => typeof s === "string");
  const toolChoice = mapToolChoice(data.tool_choice);
  if (toolChoice !== undefined) options.toolChoice = toolChoice;
  if (typeof requestedEffort === "string" && EFFORTS.has(requestedEffort)) options.reasoning = requestedEffort;
  if (!reasoning?.summary || reasoning.summary === "none") options.hideThinkingSummary = true;
  if (typeof data.parallel_tool_calls === "boolean") options.parallelToolCalls = data.parallel_tool_calls;
  if (typeof data.prompt_cache_key === "string") options.promptCacheKey = data.prompt_cache_key;
  if (serviceTier) options.serviceTier = serviceTier;

  return {
    model: String(data.model ?? ""),
    ...(typeof data.previous_response_id === "string" ? { previousResponseId: data.previous_response_id } : {}),
    _rawBody: body,
    ...(compactionRequest ? { _compactionRequest: true } : {}),
    context: { ...(system.length ? { instructions: system.join("\n\n") } : {}), messages },
    tools: mergeTools(declaredTools, loadedTools),
    ...(webSearch ? { hostedWebSearch: webSearch } : {}),
    ...(isStructured ? { structuredOutput: true } : {}),
    reasoningEffort: effort,
    options,
    stream: data.stream === true,
  };
}
