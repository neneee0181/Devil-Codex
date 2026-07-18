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
        for (const pending of buffered) if (pending.type !== "text_delta") yield pending;
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
    if (event.type === "done" || event.type === "error") {
      for (const pending of buffered) yield pending;
      buffered = undefined;
    } else {
      // The Responses bridge treats AdapterEvents as upstream activity. Keep
      // its stall timer alive while final text is intentionally buffered.
      yield { type: "heartbeat" };
    }
  }
  if (buffered) for (const pending of buffered) yield pending;
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
