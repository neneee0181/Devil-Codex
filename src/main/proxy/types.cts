// Neutral request/event model for the local Codex Responses proxy.
// Ported/adapted from opencodex (MIT) — translation core only, no zod/catalog/sidecars.

export interface OcxTextContent { type: "text"; text: string }
export interface OcxImageContent { type: "image"; dataUrl: string; detail?: string }
export type OcxContentPart = OcxTextContent | OcxImageContent;

export interface OcxToolCall { type: "toolCall"; id: string; name: string; arguments: string; namespace?: string; thoughtSignature?: string }
export interface OcxThinkingContent { type: "thinking"; text: string; signature?: string; redacted?: string[]; itemId?: string }
export type OcxAssistantContentPart = OcxTextContent | OcxThinkingContent | OcxToolCall;

export interface OcxUserMessage { role: "user"; content: OcxContentPart[] }
export interface OcxAssistantMessage { role: "assistant"; content: OcxAssistantContentPart[] }
export interface OcxDeveloperMessage { role: "developer"; content: OcxContentPart[] }
export interface OcxToolResultMessage { role: "toolResult"; toolCallId: string; toolName?: string; toolNamespace?: string; content: OcxContentPart[]; isError?: boolean }
export type OcxMessage = OcxUserMessage | OcxAssistantMessage | OcxDeveloperMessage | OcxToolResultMessage;

export interface OcxTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  namespace?: string;
  freeform?: boolean;
  toolSearch?: boolean;
  webSearch?: boolean;
  loaded?: boolean;
}

export function namespacedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

export interface OcxContext { instructions?: string; messages: OcxMessage[] }

export interface OcxParsedRequest {
  model: string;
  previousResponseId?: string;
  _rawBody?: unknown;
  _previousResponseInputExpanded?: boolean;
  _compactionRequest?: boolean;
  context: OcxContext;
  tools: OcxTool[];
  hostedWebSearch?: Record<string, unknown>;
  structuredOutput?: boolean;
  reasoningEffort: string;
  options: OcxRequestOptions;
  stream: boolean;
}

export interface OcxRequestOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: "auto" | "none" | "required" | { name: string } | { allowedTools: string[]; mode: "auto" | "required" };
  parallelToolCalls?: boolean;
  reasoning?: string;
  hideThinkingSummary?: boolean;
  serviceTier?: string;
  promptCacheKey?: string;
  presencePenalty?: number;
  frequencyPenalty?: number;
}

export function allowedToolNames(choice: OcxRequestOptions["toolChoice"]): Set<string> | undefined {
  return choice && typeof choice === "object" && "allowedTools" in choice ? new Set(choice.allowedTools) : undefined;
}

export type AdapterEvent =
  | { type: "heartbeat" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "reasoning_raw_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; thoughtSignature?: string }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end" }
  | { type: "web_search_call_begin"; id: string }
  | { type: "web_search_call_end"; id: string; queries: string[]; status?: "completed" | "failed"; sources?: Array<{ url: string; title?: string }> }
  | { type: "done"; usage?: OcxUsage }
  | { type: "error"; message: string; status?: number; errorType?: string; usage?: OcxUsage };

export interface OcxUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated?: boolean;
}
