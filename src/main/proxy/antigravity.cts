import { createHash } from "node:crypto";
import type { AdapterEvent, OcxParsedRequest } from "./types.cjs";
import { buildGoogleGenerateContentBody, streamGoogle } from "./api-key.cjs";
import {
  antigravityUsesReplayCache,
  applyAntigravityReplay,
  clearAntigravityReplay,
  observeAntigravityReplayCall,
  sanitizeAntigravityClaudeSignatures,
} from "./antigravity-replay.cjs";
import { antigravityUserAgent, resolveAntigravityWireModelId } from "../provider-antigravity.cjs";

const ANTIGRAVITY_API = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_GOOG_API_CLIENT_UA = "google-api-nodejs-client/10.3.0";
const ANTIGRAVITY_PROGRESS_PREFIX = "DEVIL_PROGRESS:";

function isUserFacingProgressSentence(text: string): boolean {
  const english = /^(?:(?:Next|Now|Then),?\s+)?(?:I|We)(?:\s+will|['’]ll|\s+(?:am|are)\s+going\s+to)\s+\p{L}[\s\S]*[.!?…]$/iu;
  const korean = /[\p{Script=Hangul}]/u.test(text)
    && /(?:겠습니다|할게요|합니다|입니다|보겠습니다|드리겠습니다)[.!?…]$/u.test(text);
  return english.test(text) || korean;
}

function firstUserText(parsed: OcxParsedRequest): string | undefined {
  for (const msg of parsed.context.messages) {
    if (msg.role !== "user") continue;
    const first = msg.content.find((part) => part.type === "text" && typeof part.text === "string");
    if (first?.type === "text") return first.text;
  }
  return undefined;
}

export function antigravitySessionId(parsed: OcxParsedRequest): string {
  const text = firstUserText(parsed);
  if (!text) return `-${Math.floor(Math.random() * 9e18).toString()}`;
  const digest = createHash("sha256").update(text, "utf8").digest();
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
}

function antigravityRequestBody(parsed: OcxParsedRequest, projectId: string): Record<string, unknown> {
  const wireModel = resolveAntigravityWireModelId(parsed.model);
  const sessionId = antigravitySessionId(parsed);
  const body = buildGoogleGenerateContentBody({ ...parsed, model: wireModel });
  if (Array.isArray(body.contents)) {
    if (antigravityUsesReplayCache(wireModel)) applyAntigravityReplay(wireModel, sessionId, body.contents);
    else sanitizeAntigravityClaudeSignatures(body.contents);
  }
  const request: Record<string, unknown> = { ...body, sessionId };
  if (/claude/i.test(wireModel)) {
    const existing = (request.toolConfig ?? {}) as Record<string, unknown>;
    const calling = (existing.functionCallingConfig ?? {}) as Record<string, unknown>;
    request.toolConfig = { ...existing, functionCallingConfig: { ...calling, mode: "VALIDATED" } };
  }
  return {
    model: wireModel,
    userAgent: "antigravity",
    requestType: "agent",
    project: projectId,
    requestId: `agent-${crypto.randomUUID()}`,
    request,
  };
}

export function buildAntigravityRequest(
  parsed: OcxParsedRequest,
  auth: { accessToken: string; projectId: string },
): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: `${ANTIGRAVITY_API}/v1internal:streamGenerateContent?alt=sse`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.accessToken}`,
      "User-Agent": antigravityUserAgent(),
      "x-goog-api-client": ANTIGRAVITY_GOOG_API_CLIENT_UA,
    },
    body: JSON.stringify(antigravityRequestBody(parsed, auth.projectId)),
  };
}

// Gemini can emit work narration or raw patch text as ordinary text in the
// same response that later contains a function call. Responses streaming
// cannot retract text after it reaches the client, so hold the response once
// text begins until we know whether it is a final answer or a tool turn.
function safeAntigravityProgressText(events: AdapterEvent[]): string | undefined {
  const raw = events
    .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
    .map((event) => event.text)
    .join("")
    .trim();
  if (!raw.startsWith(ANTIGRAVITY_PROGRESS_PREFIX)) return undefined;
  const text = raw.slice(ANTIGRAVITY_PROGRESS_PREFIX.length).trim();
  if (!text || text.length > 240 || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return undefined;
  if (!/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}\p{Zs}.,!?…:'’“”()/_-]*$/u.test(text)) return undefined;
  if (!isUserFacingProgressSentence(text)) return undefined;
  if (/(?:^|\s)(?:--?[A-Za-z0-9]|\.{1,2}\/|\/(?:\S|$))/.test(text)) return undefined;
  if (/```|~~~|\*\*\*\s+(?:Begin|End|Add|Update|Delete)\b|diff --git|(?:^|\s)@@\s|(?:^|\s)(?:---|\+\+\+|[+-]\s)/i.test(text)) return undefined;
  if (/[`{};]/.test(text) || /^(?:\[[\s\S]*\])$/.test(text) || /"[^"\r\n]+"\s*:/.test(text)) return undefined;
  if (/\b(?:api[_ -]?key|authorization|bearer|token|secret|password|cookie|credential)\b|\bsk-[a-z0-9_-]{8,}\b/i.test(text)) return undefined;
  if (/(?:^|\s)(?:const|let|var|function|class|interface|type|import|export|return|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s|=>|<\/?[a-z][^>]*>|(?:&&|\|\|)/i.test(text)) return undefined;
  if (/(?:^|\s)(?:npm|npx|pnpm|yarn|git|node|python|powershell|bash|sh|cmd|curl|rg|grep|sed|awk|apply_patch|cat|ls|dir|find|findstr|cargo|dotnet|rm|cmake|go)(?:\.exe)?(?=\s|$)|\b(?:Get|Set|New|Remove|Copy|Move|Select|Where|ForEach|Write|Invoke|Start|Stop|Test|Resolve|Join|Split|Out|Add|Clear|Rename|Expand|Compress|ConvertTo|ConvertFrom)-[A-Za-z]+\b|(?:^|\s)[$>]\s|\b[\w.$-]+\s*=\s*[^=]/i.test(text)) return undefined;
  if (/(?:^|\b(?:run|execute|invoke|use|using|via)\s+)(?:make|gmake|nmake|mingw32-make)(?:\.exe)?(?=\s|$)/i.test(text)) return undefined;
  return text;
}

function* safeBufferedAntigravityEvents(events: AdapterEvent[]): Generator<AdapterEvent> {
  const progress = safeAntigravityProgressText(events);
  let emittedProgress = false;
  for (const event of events) {
    if (event.type === "text_delta") {
      if (progress && !emittedProgress) yield { type: "text_delta", text: progress };
      emittedProgress = true;
    } else {
      yield event;
    }
  }
}

export async function* filterAntigravityToolTurnText(events: AsyncIterable<AdapterEvent>): AsyncGenerator<AdapterEvent> {
  let buffered: AdapterEvent[] | undefined;
  let toolTurn = false;
  for await (const event of events) {
    if (toolTurn) {
      if (event.type === "text_delta") yield { type: "heartbeat" };
      else yield event;
      continue;
    }
    if (event.type === "tool_call_start") {
      if (buffered) {
        yield* safeBufferedAntigravityEvents(buffered);
        buffered = undefined;
      }
      toolTurn = true;
      yield event;
      continue;
    }
    if (!buffered && event.type !== "text_delta") {
      yield event;
      continue;
    }
    buffered ??= [];
    buffered.push(event);
    if (event.type === "done") {
      for (const pending of buffered) yield pending;
      buffered = undefined;
    } else if (event.type === "error") {
      yield* safeBufferedAntigravityEvents(buffered);
      buffered = undefined;
    } else {
      // The Responses bridge treats AdapterEvents as upstream activity. Keep
      // its stall timer alive while final text is intentionally buffered.
      yield { type: "heartbeat" };
    }
  }
  if (buffered) yield* safeBufferedAntigravityEvents(buffered);
}

export async function* streamAntigravity(response: Response, parsed: OcxParsedRequest): AsyncGenerator<AdapterEvent> {
  const model = resolveAntigravityWireModelId(parsed.model);
  const sessionId = antigravitySessionId(parsed);
  let currentCall: { name: string; args: string; signature?: string } | undefined;
  const upstream = streamGoogle(response, { label: "Antigravity", unwrapResponse: true });
  for await (const event of filterAntigravityToolTurnText(upstream)) {
    if (event.type === "tool_call_start") {
      currentCall = { name: event.name, args: "", ...(event.thoughtSignature ? { signature: event.thoughtSignature } : {}) };
    } else if (event.type === "tool_call_delta" && currentCall) {
      currentCall.args += event.arguments;
    } else if (event.type === "tool_call_end" && currentCall) {
      let args: unknown = {};
      try { args = JSON.parse(currentCall.args || "{}"); } catch { /* malformed calls fail elsewhere */ }
      observeAntigravityReplayCall(model, sessionId, currentCall.name, args, currentCall.signature);
      currentCall = undefined;
    } else if (event.type === "error" && /signature|invalid_argument|invalid argument/i.test(event.message)) {
      clearAntigravityReplay(model, sessionId);
    }
    yield event;
  }
}
