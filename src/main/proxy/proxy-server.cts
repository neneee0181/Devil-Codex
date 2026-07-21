// Local OpenAI-Responses proxy. Registered as a Codex model_provider so the
// app-server routes external-model turns here; this translates to Claude/Copilot
// and streams Codex Responses SSE back. Codex records the turn natively → syncs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { app } from "electron";
import { bridgeToResponsesSSE, type ResponsesTerminalStatus } from "./bridge.cjs";
import { parseRequest } from "./parser.cjs";
import { buildAnthropicRequest, streamAnthropic } from "./anthropic.cjs";
import { buildCopilotRequest, streamCopilot } from "./copilot.cjs";
import { buildApiKeyRequest, streamGoogle, streamOpenAiCompatible } from "./api-key.cjs";
import { buildAntigravityRequest, streamAntigravity } from "./antigravity.cjs";
import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxUsage } from "./types.cjs";
import { sanitizeName } from "./tool-sanitize.cjs";
import { buildWebSearchTool, runWithWebSearchLoop, shouldExposeWebSearchTool, type SidecarStats } from "./web-search-sidecar.cjs";
import { applyVisionSidecar } from "./vision-sidecar.cjs";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./response-state.cjs";
import { buildCompactV1Output, COMPACT_PROMPT, extractCompactUserMessages } from "./compaction.cjs";
import { sanitizeEncryptedContentInPlace } from "./encrypted-content.cjs";
import { providerNativeImageInput } from "./provider-policy.cjs";
import {
  buildOpenAiResponsesApiKeyRequest,
  FORWARDED_OPENAI_HEADERS,
  inspectResponsesPayload,
  nextSseBlock,
  prepareOpenAiResponsesBody,
  restoreStreamedResponseOutput,
  sanitizePassthroughHeaders,
  sseDataPayload,
} from "./openai-responses.cjs";
import { claudeAuth, copilotAuth, oauthModels } from "../provider-oauth.cjs";
import { antigravityAuth, antigravityModels } from "../provider-antigravity.cjs";
import { kimiAuth, kimiModels } from "../provider-kimi.cjs";
import { apiProviderConfig, apiProviderUrl, capabilityFor, providerAccountReady, ProviderSettingsStore } from "../provider-settings.cjs";
import { CodexSettingsStore } from "../codex-settings.cjs";
import type { ProviderId, ProviderRequestLogEntry, SidecarSettings } from "../contracts.cjs";
import { getStoredAccount } from "../provider-accounts.cjs";
import { selectConfiguredModelRows } from "../codex-stock-catalog.cjs";
import { diagnosticLog } from "../diagnostic-log.cjs";

const CHATGPT_CODEX_RESPONSES = "https://chatgpt.com/backend-api/codex/responses";
export const DEVIL_PROXY_PORT = 49873;

// Per-install secret embedded in the proxy URL path. The proxy only answers
// requests under /<secret>/v1/... so a local process or web page that doesn't
// know the token (written into ~/.codex/config.toml's base_url, perms 0600)
// can't drive the user's provider keys. Persisted so the provider URL stays
// stable across restarts (stock Codex sessions keep resolving the Bridge URL).
const PROXY_SECRET_PATH = join(process.env.DEVIL_CODEX_CODEX_HOME ?? join(homedir(), ".codex"), "devil-proxy-secret");
async function loadProxySecret(): Promise<string> {
  try {
    const existing = (await readFile(PROXY_SECRET_PATH, "utf8")).trim();
    if (/^[a-f0-9]{32,}$/.test(existing)) return existing;
  } catch { /* generate below */ }
  const secret = randomBytes(24).toString("hex");
  await mkdir(dirname(PROXY_SECRET_PATH), { recursive: true });
  await writeFile(PROXY_SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}
const providerSettings = new ProviderSettingsStore();
const stockSettingsStore = new CodexSettingsStore();
const stockProxyServiceMode = process.argv.includes("--devil-stock-proxy");
let reportProxyError: ((message: string) => void) | undefined;
let reportRequestLogChanged: ((event: { provider: ProviderRequestLogEntry["provider"]; completed: boolean }) => void) | undefined;
const sidecarSettingsByThread = new Map<string, SidecarSettings>();
const sidecarStatsByThread = new Map<string, SidecarStats>();
const requestLog: ProviderRequestLogEntry[] = [];
let requestLogLoaded = false;
let requestLogWrite = Promise.resolve();
const REQUEST_LOG_LIMIT = 120;
let nvidiaRateLimitQueue = Promise.resolve();
let nvidiaLastRequestAt = 0;

interface BridgeDiagnosticContext extends Record<string, unknown> {
  requestId: string;
  transport: "http" | "websocket";
  route: string;
  threadId?: string;
  provider?: string;
  model?: string;
  upstreamSequence?: number;
}

const bridgeDiagnosticContext = new AsyncLocalStorage<BridgeDiagnosticContext>();

function logBridgeDiagnostic(
  event: string,
  data: unknown = {},
  context = bridgeDiagnosticContext.getStore(),
  level: "debug" | "info" | "warn" | "error" = "info",
): void {
  if (!context) return;
  diagnosticLog("bridge", event, data, context, level);
}

function diagnosticRequestId(req: IncomingMessage): string {
  const value = req.headers["x-devil-diagnostic-id"];
  if (typeof value === "string" && /^[A-Za-z0-9._:-]{8,160}$/.test(value)) return value;
  return crypto.randomUUID();
}

function diagnosticTransport(req: IncomingMessage): BridgeDiagnosticContext["transport"] {
  return req.headers["x-devil-diagnostic-transport"] === "websocket" ? "websocket" : "http";
}

export function shouldUseEmptyWebSocketResponseId(
  provider: ProviderId,
  transport: BridgeDiagnosticContext["transport"],
): boolean {
  return transport === "websocket" && provider !== "codex" && provider !== "openai";
}

function diagnosticHeaders(headers: HeadersInit | undefined): Record<string, unknown> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

const MAX_DIAGNOSTIC_BODY_BYTES = 8 * 1024 * 1024;

function diagnosticChunk(chunk: Uint8Array): { bytes: number; sha256: string } {
  return { bytes: chunk.byteLength, sha256: createHash("sha256").update(chunk).digest("hex") };
}

function diagnosticBody(text: string, kind: string): unknown {
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_DIAGNOSTIC_BODY_BYTES) {
    try { return { kind, bytes, json: JSON.parse(text) as unknown }; }
    catch { return { kind, bytes, text }; }
  }
  return { kind, bytes, sha256: createHash("sha256").update(text).digest("hex"), omitted: true };
}

function tracedUpstreamResponse(response: Response, context: BridgeDiagnosticContext, upstreamRequestId: string): Response {
  if (!response.body) return response;
  const isSse = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  const decoder = new TextDecoder();
  let sequence = 0;
  let totalBytes = 0;
  let textBuffer = "";
  let bodyOmitted = false;
  let oversizedSseFrame = false;
  let oversizedSseTail = "";
  let sseSequence = 0;
  const bodyHash = createHash("sha256");
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sequence += 1;
      totalBytes += chunk.byteLength;
      bodyHash.update(chunk);
      logBridgeDiagnostic("upstream.raw_chunk", {
        upstreamRequestId,
        sequence,
        ...diagnosticChunk(chunk),
      }, context, "debug");
      const decoded = decoder.decode(chunk, { stream: true });
      if (isSse) {
        let nextText = decoded;
        if (oversizedSseFrame) {
          const combined = oversizedSseTail + nextText;
          const boundary = combined.match(/\r?\n\r?\n/);
          if (!boundary || boundary.index === undefined) {
            oversizedSseTail = combined.slice(-3);
            controller.enqueue(chunk);
            return;
          }
          logBridgeDiagnostic("upstream.sse_frame", { upstreamRequestId, sequence: ++sseSequence, omitted: true, reason: "frame exceeds diagnostic limit" }, context, "warn");
          nextText = combined.slice(boundary.index + boundary[0].length);
          oversizedSseFrame = false;
          oversizedSseTail = "";
        }
        textBuffer += nextText;
        let next: { block: string; rest: string } | null;
        while ((next = nextSseBlock(textBuffer))) {
          textBuffer = next.rest;
          logBridgeDiagnostic("upstream.sse_frame", { upstreamRequestId, sequence: ++sseSequence, block: next.block }, context, "debug");
        }
        if (Buffer.byteLength(textBuffer) > MAX_DIAGNOSTIC_BODY_BYTES) {
          oversizedSseTail = textBuffer.slice(-3);
          textBuffer = "";
          oversizedSseFrame = true;
        }
      } else if (!bodyOmitted) {
        textBuffer += decoded;
        if (Buffer.byteLength(textBuffer) > MAX_DIAGNOSTIC_BODY_BYTES) {
          textBuffer = "";
          bodyOmitted = true;
        }
      }
      controller.enqueue(chunk);
    },
    flush() {
      const residual = decoder.decode();
      if (isSse) {
        if (oversizedSseFrame) {
          logBridgeDiagnostic("upstream.sse_residual", { upstreamRequestId, sequence: ++sseSequence, omitted: true, reason: "frame exceeds diagnostic limit" }, context, "warn");
        } else {
          textBuffer += residual;
          if (textBuffer.trim()) logBridgeDiagnostic("upstream.sse_residual", { upstreamRequestId, sequence: ++sseSequence, text: textBuffer }, context, "debug");
        }
      } else if (!bodyOmitted) {
        textBuffer += residual;
        logBridgeDiagnostic("upstream.body", diagnosticBody(textBuffer, "upstream"), context, "debug");
      }
      logBridgeDiagnostic("upstream.stream_end", { upstreamRequestId, chunks: sequence, bytes: totalBytes, sha256: bodyHash.digest("hex"), bodyOmitted }, context);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function rejectWebSocketUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: { message } });
  socket.write([
    `HTTP/1.1 ${status} ${status === 426 ? "Upgrade Required" : "Forbidden"}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n"));
  socket.destroy();
}

function ssePayloads(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  while (true) {
    const match = rest.match(/\r?\n\r?\n/);
    if (!match || match.index === undefined) break;
    const block = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data && data !== "[DONE]") payloads.push(data);
  }
  return { payloads, rest };
}

function terminalResponseType(payload: string): "completed" | "failed" | "incomplete" | undefined {
  try {
    const type = (JSON.parse(payload) as { type?: unknown }).type;
    if (type === "response.completed") return "completed";
    if (type === "response.failed") return "failed";
    if (type === "response.incomplete") return "incomplete";
  } catch { /* caller reports malformed frames */ }
  return undefined;
}

function sendWsProtocolError(ws: WebSocket, message: string, context?: BridgeDiagnosticContext): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify({ type: "error", status: 502, error: { type: "protocol_error", code: "websocket_protocol_error", message } });
  ws.send(payload);
  if (context) logBridgeDiagnostic("websocket.protocol_error_sent", { message, payload }, context, "error");
}

async function pumpResponsesSseToWebSocket(
  ws: WebSocket,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  isCurrent: () => boolean,
  context?: BridgeDiagnosticContext,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalSeen = false;
  try {
    while (!signal.aborted && isCurrent() && !terminalSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = ssePayloads(buffer);
      buffer = parsed.rest;
      for (const payload of parsed.payloads) {
        if (signal.aborted || !isCurrent()) break;
        let valid = true;
        try { JSON.parse(payload); } catch { valid = false; }
        if (!valid) {
          sendWsProtocolError(ws, "Invalid JSON payload in upstream SSE frame", context);
          terminalSeen = true;
          break;
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(payload);
        const terminal = terminalResponseType(payload);
        if (context) logBridgeDiagnostic("websocket.frame_sent", { payload, terminal }, context, terminal && terminal !== "completed" ? "warn" : "debug");
        if (terminal) { terminalSeen = true; break; }
      }
    }
    buffer += decoder.decode();
    if (!terminalSeen && buffer.trim() && !signal.aborted && isCurrent()) {
      const parsed = ssePayloads(`${buffer}\n\n`);
      for (const payload of parsed.payloads) {
        try { JSON.parse(payload); } catch { sendWsProtocolError(ws, "Invalid JSON payload in upstream SSE frame", context); terminalSeen = true; break; }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
          const terminal = terminalResponseType(payload);
          if (context) logBridgeDiagnostic("websocket.frame_sent", { payload, terminal, residual: true }, context, terminal && terminal !== "completed" ? "warn" : "debug");
          if (terminal) { terminalSeen = true; break; }
        }
      }
    }
    if (!terminalSeen && !signal.aborted && isCurrent()) sendWsProtocolError(ws, "Upstream stream ended before response terminal event", context);
  } finally {
    if (context) logBridgeDiagnostic("websocket.pump_end", { terminalSeen, aborted: signal.aborted, current: isCurrent(), readyState: ws.readyState }, context, terminalSeen ? "info" : "warn");
    if (terminalSeen || signal.aborted || !isCurrent()) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}
type ProxyProvider = Exclude<ProviderId, "codex">;

function providerLabel(provider: ProxyProvider): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "antigravity") return "Antigravity";
  if (provider === "kimi") return "Kimi Code";
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google Gemini";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "xai") return "xAI Grok";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "openrouter-free") return "OpenRouter Free";
  if (provider === "groq") return "Groq";
  if (provider === "mistral") return "Mistral";
  if (provider === "cerebras") return "Cerebras";
  if (provider === "together") return "Together";
  if (provider === "fireworks") return "Fireworks";
  if (provider === "zai") return "Z.AI GLM";
  if (provider === "moonshot") return "Moonshot Kimi";
  if (provider === "huggingface") return "Hugging Face";
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "ollama") return "Ollama";
  if (provider === "vllm") return "vLLM";
  if (provider === "lm-studio") return "LM Studio";
  if (provider === "opencode-free") return "OpenCode Free";
  return provider;
}

function splitModel(id: string): { provider: ProxyProvider; accountId?: string; model: string } {
  const slash = id.indexOf("/");
  const colon = id.indexOf(":");
  const separators = [slash, colon].filter((position) => position > 0).sort((left, right) => left - right);
  for (const sep of separators) {
    const rawProvider = id.slice(0, sep);
    const accountSep = rawProvider.indexOf("@");
    const p = accountSep >= 0 ? rawProvider.slice(0, accountSep) : rawProvider;
    const accountId = accountSep >= 0 ? decodeURIComponent(rawProvider.slice(accountSep + 1)) : undefined;
    if (p === "claude-code" || p === "copilot" || p === "antigravity" || p === "kimi" || p === "openai" || p === "anthropic" || p === "google" || p === "deepseek" || p === "xai" || p === "openrouter" || p === "openrouter-free" || p === "opencode-free" || p === "groq" || p === "mistral" || p === "cerebras" || p === "together" || p === "fireworks" || p === "zai" || p === "moonshot" || p === "huggingface" || p === "nvidia" || p === "ollama" || p === "vllm" || p === "lm-studio") return { provider: p, accountId, model: id.slice(sep + 1) };
  }
  // Fallback by name shape.
  return { provider: /claude/i.test(id) ? "claude-code" : "copilot", model: id };
}

const MAX_COMPRESSED_BODY_BYTES = 256 * 1024 * 1024;
const MAX_DECOMPRESSED_BODY_BYTES = 256 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 200_000;

class ProxyRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ProxyRequestError"; }
}

function inflateDeflateBody(raw: Buffer): Buffer {
  const options = { maxOutputLength: MAX_DECOMPRESSED_BODY_BYTES };
  try {
    return inflateSync(raw, options);
  } catch (error) {
    // HTTP `deflate` is used for both zlib-wrapped and raw streams. Preserve
    // the size guard, but retry format errors with the raw decoder.
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw error;
    return inflateRawSync(raw, options);
  }
}

export function decodeRequestBody(raw: Buffer, encoding: string | string[] | undefined): Buffer {
  const value = Array.isArray(encoding) ? encoding.join(",") : encoding ?? "";
  const encodings = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (encodings.length > 1) throw new ProxyRequestError(415, "다중 Content-Encoding 요청은 지원하지 않습니다.");
  let decoded = raw;
  for (const item of encodings.reverse()) {
    if (item === "identity") continue;
    try {
      if (item === "zstd") decoded = zstdDecompressSync(decoded, { maxOutputLength: MAX_DECOMPRESSED_BODY_BYTES });
      else if (item === "gzip" || item === "x-gzip") decoded = gunzipSync(decoded, { maxOutputLength: MAX_DECOMPRESSED_BODY_BYTES });
      else if (item === "deflate") decoded = inflateDeflateBody(decoded);
      else throw new ProxyRequestError(415, `지원하지 않는 요청 Content-Encoding입니다: ${item}`);
    } catch (error) {
      if (error instanceof ProxyRequestError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new ProxyRequestError(413, "요청 본문이 너무 큽니다.");
      }
      throw new ProxyRequestError(400, "요청 본문의 압축을 해제할 수 없습니다.");
    }
  }
  if (decoded.byteLength > MAX_DECOMPRESSED_BODY_BYTES) throw new ProxyRequestError(413, "요청 본문이 너무 큽니다.");
  return decoded;
}

async function readBody(req: IncomingMessage): Promise<{ raw: string; body: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = chunk as Buffer;
    size += value.byteLength;
    if (size > MAX_COMPRESSED_BODY_BYTES) throw new ProxyRequestError(413, "압축된 요청 본문이 너무 큽니다.");
    chunks.push(value);
  }
  const raw = decodeRequestBody(Buffer.concat(chunks), req.headers["content-encoding"]).toString("utf8");
  try { return { raw, body: raw ? JSON.parse(raw) : {} }; }
  catch { throw new ProxyRequestError(400, "요청 본문이 올바른 JSON이 아닙니다."); }
}

function retryableStatus(status: number): boolean { return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504; }

function retryAfterMs(response: Response): number {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(10_000, Math.max(0, date - Date.now())) : 0;
}

async function fetchUpstream(url: string, init: RequestInit, parentSignal: AbortSignal): Promise<Response> {
  let lastError: unknown;
  const diagnosticContext = bridgeDiagnosticContext.getStore();
  const upstreamSequence = diagnosticContext ? (diagnosticContext.upstreamSequence = (diagnosticContext.upstreamSequence ?? 0) + 1) : 0;
  const upstreamOperationId = diagnosticContext ? `${diagnosticContext.requestId}:upstream:${upstreamSequence}` : "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (parentSignal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const upstreamRequestId = diagnosticContext ? `${upstreamOperationId}:attempt:${attempt + 1}` : "";
    const attemptStartedAt = Date.now();
    if (diagnosticContext) {
      logBridgeDiagnostic("upstream.attempt", {
        upstreamRequestId,
        upstreamOperationId,
        attempt: attempt + 1,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        url,
        method: init.method ?? "GET",
        headers: diagnosticHeaders(init.headers),
        body: typeof init.body === "string" ? diagnosticBody(init.body, "upstream_request") : init.body,
      }, diagnosticContext);
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), UPSTREAM_TIMEOUT_MS);
    const abort = () => timeout.abort();
    parentSignal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: timeout.signal });
      const shouldRetry = retryableStatus(response.status) && attempt < 2;
      const retryDelayMs = shouldRetry ? retryAfterMs(response) || Math.min(2_000, 250 * (2 ** attempt)) : 0;
      if (diagnosticContext) {
        logBridgeDiagnostic("upstream.response", {
          upstreamRequestId,
          upstreamOperationId,
          attempt: attempt + 1,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          elapsedMs: Date.now() - attemptStartedAt,
          retry: shouldRetry,
          retryDelayMs,
        }, diagnosticContext, response.ok ? "info" : "warn");
      }
      if (!shouldRetry) return diagnosticContext ? tracedUpstreamResponse(response, diagnosticContext, upstreamRequestId) : response;
      try {
        const retryBody = await response.text();
        if (diagnosticContext) logBridgeDiagnostic("upstream.retry_body", { upstreamRequestId, text: retryBody }, diagnosticContext, "warn");
      } catch (error) {
        if (diagnosticContext) logBridgeDiagnostic("upstream.retry_body_error", { upstreamRequestId, error }, diagnosticContext, "warn");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    } catch (error) {
      lastError = error;
      if (diagnosticContext) {
        logBridgeDiagnostic("upstream.error", {
          upstreamRequestId,
          upstreamOperationId,
          attempt: attempt + 1,
          elapsedMs: Date.now() - attemptStartedAt,
          parentAborted: parentSignal.aborted,
          timeoutAborted: timeout.signal.aborted,
          error,
        }, diagnosticContext, "error");
      }
      if (parentSignal.aborted) throw error;
      if (attempt === 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2_000, 250 * (2 ** attempt))));
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("upstream request failed");
}

function modelId(body: unknown): string {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? String((body as Record<string, unknown>).model ?? "") : "";
}

function isExternalModel(model: string): boolean {
  return /^(claude-code|copilot|antigravity|kimi|openai|anthropic|google|deepseek|xai|openrouter|openrouter-free|opencode-free|groq|mistral|cerebras|together|fireworks|zai|moonshot|huggingface|nvidia|ollama|vllm|lm-studio)(@[^/:]+)?[/:]/.test(model);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/(x-api-key\s*[:=]\s*)[^\s"']+/gi, "$1[redacted]")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted-api-key]")
    .replace(/\b([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g, "[redacted-token]");
}

function threadIdFromRequest(req: IncomingMessage, body: unknown): string {
  const header = req.headers["thread-id"] ?? req.headers["x-codex-parent-thread-id"];
  if (typeof header === "string" && header) return header;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    return String(record.thread_id ?? record.threadId ?? "");
  }
  return "";
}

async function sidecarState(threadId: string): Promise<{ settings?: SidecarSettings; stats: SidecarStats }> {
  const stats = sidecarStatsByThread.get(threadId) ?? { webSearchRequests: 0, webSearchEvents: [], visionRequests: 0, failures: [] };
  if (threadId) sidecarStatsByThread.set(threadId, stats);
  const explicit = threadId ? sidecarSettingsByThread.get(threadId) : undefined;
  if (explicit || !stockProxyServiceMode) return { settings: explicit, stats };
  const settings = await stockSettingsStore.load();
  return {
    settings: {
      webSearch: settings.stockBridgeWebSearch,
      vision: settings.stockBridgeVision,
      webSearchLimit: 3,
      visionLimit: 3,
      nvidiaRateLimitRpm: 40,
    },
    stats,
  };
}

function sidecarSnapshot(stats: SidecarStats): ProviderRequestLogEntry["sidecar"] {
  return {
    webSearchRequests: stats.webSearchRequests,
    ...(stats.webSearchToolCalls !== undefined ? { webSearchToolCalls: stats.webSearchToolCalls } : {}),
    ...(stats.webSearchLoops !== undefined ? { webSearchLoops: stats.webSearchLoops } : {}),
    visionRequests: stats.visionRequests,
    failures: [...stats.failures],
  };
}

function requestPartStats(parsed: OcxParsedRequest): { tools: number; images: number; files: number } {
  let images = 0;
  let files = 0;
  for (const message of parsed.context.messages) {
    for (const part of message.content) {
      if (part.type === "image") images += 1;
      if (part.type === "text" && /^\[file: /m.test(part.text)) files += 1;
    }
  }
  return { tools: parsed.tools.length, images, files };
}

function usesNativeImages(provider: ProxyProvider, model: string): boolean {
  return providerNativeImageInput(provider, model) ?? Boolean(apiProviderConfig(provider)?.allowImages);
}
export async function readDevilProxySecret(): Promise<string> { return loadProxySecret(); }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("request aborted while waiting for provider rate limit"));
    }, { once: true });
  });
}

async function waitForNvidiaRateLimit(rpm: number | undefined, signal?: AbortSignal): Promise<void> {
  const limit = Math.floor(Number(rpm ?? 40));
  if (!Number.isFinite(limit) || limit <= 0) return;
  const minIntervalMs = Math.ceil(60_000 / Math.max(1, limit));
  const previous = nvidiaRateLimitQueue;
  const task = previous.catch(() => undefined).then(async () => {
    const waitMs = Math.max(0, nvidiaLastRequestAt + minIntervalMs - Date.now());
    await sleep(waitMs, signal);
    nvidiaLastRequestAt = Date.now();
  });
  nvidiaRateLimitQueue = task.catch(() => undefined);
  await task;
}

function startRequestLog(entry: ProviderRequestLogEntry): void {
  requestLog.unshift(entry);
  requestLog.splice(REQUEST_LOG_LIMIT);
  persistRequestLog();
  reportRequestLogChanged?.({ provider: entry.provider, completed: false });
}

function finishRequestLog(id: string, patch: Partial<ProviderRequestLogEntry>): void {
  const index = requestLog.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  const next = { ...requestLog[index]!, ...patch };
  requestLog[index] = next;
  persistRequestLog();
  reportRequestLogChanged?.({ provider: next.provider, completed: true });
}

function logUsage(usage: OcxUsage | undefined): ProviderRequestLogEntry["usage"] | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
  };
}

function requestLogPath(): string {
  return join(app.getPath("userData"), "providers", "request-log.json");
}

async function loadRequestLog(): Promise<void> {
  if (requestLogLoaded) return;
  requestLogLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(requestLogPath(), "utf8")) as ProviderRequestLogEntry[];
    if (Array.isArray(parsed)) {
      requestLog.splice(0, requestLog.length, ...parsed.slice(0, REQUEST_LOG_LIMIT));
    }
  } catch {
    // Fresh installs simply start with an empty live request log.
  }
}

function persistRequestLog(): void {
  if (!requestLogLoaded) return;
  requestLogWrite = requestLogWrite.then(async () => {
    const path = requestLogPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(requestLog.slice(0, REQUEST_LOG_LIMIT), null, 2), { mode: 0o600 });
  }).catch(() => undefined);
}

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const name of FORWARDED_OPENAI_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function responsesUsage(response: Record<string, unknown>): ProviderRequestLogEntry["usage"] | undefined {
  if (!isPlainObject(response.usage)) return undefined;
  const inputTokens = finiteToken(response.usage.input_tokens);
  const outputTokens = finiteToken(response.usage.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const inputDetails = isPlainObject(response.usage.input_tokens_details) ? response.usage.input_tokens_details : undefined;
  const outputDetails = isPlainObject(response.usage.output_tokens_details) ? response.usage.output_tokens_details : undefined;
  const cachedInputTokens = finiteToken(inputDetails?.cached_tokens);
  const reasoningOutputTokens = finiteToken(outputDetails?.reasoning_tokens);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

function responsesError(value: unknown): { message?: string; type?: string } {
  if (!isPlainObject(value)) return {};
  const error = isPlainObject(value.error) ? value.error : isPlainObject(value.last_error) ? value.last_error : undefined;
  const message = typeof error?.message === "string" ? error.message
    : typeof value.message === "string" ? value.message
    : undefined;
  const type = typeof error?.type === "string" ? error.type
    : typeof error?.code === "string" ? error.code
    : typeof value.type === "string" ? value.type
    : undefined;
  return {
    ...(message ? { message: redactSensitiveText(message) } : {}),
    ...(type ? { type } : {}),
  };
}

interface PassthroughRelayResult {
  terminal: ResponsesTerminalStatus;
  upstreamStatus: number;
  response?: Record<string, unknown>;
  usage?: ProviderRequestLogEntry["usage"];
  error?: string;
  errorType?: string;
}

async function relayResponsesPassthrough(
  upstream: Response,
  res: ServerResponse,
  controller: AbortController,
  options: { expectStream: boolean; onCompletedResponse?: (response: Record<string, unknown>) => void },
): Promise<PassthroughRelayResult> {
  const diagnosticContext = bridgeDiagnosticContext.getStore();
  let downstreamSequence = 0;
  const logDownstream = (body: string | Uint8Array, kind: string) => {
    if (!diagnosticContext) return;
    const value = typeof body === "string" ? Buffer.from(body) : body;
    logBridgeDiagnostic("responses.raw_chunk", { sequence: ++downstreamSequence, kind, ...diagnosticChunk(value) }, diagnosticContext, "debug");
  };
  const headers = sanitizePassthroughHeaders(upstream.headers);
  const contentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
  const contentType = contentTypeKey ? headers[contentTypeKey]!.toLowerCase() : "";
  const isEventStream = contentType.includes("text/event-stream")
    || (upstream.ok && Boolean(upstream.body) && !contentType && options.expectStream);
  if (isEventStream && !contentTypeKey) headers["content-type"] = "text/event-stream";
  if (isEventStream && !Object.keys(headers).some((key) => key.toLowerCase() === "cache-control")) headers["cache-control"] = "no-cache";
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    if (diagnosticContext) logBridgeDiagnostic("responses.empty_body", { upstreamStatus: upstream.status }, diagnosticContext, upstream.ok ? "warn" : "error");
    res.end();
    return {
      terminal: upstream.ok ? "incomplete" : "failed",
      upstreamStatus: upstream.status,
      ...(!upstream.ok ? { error: `OpenAI upstream returned HTTP ${upstream.status}`, errorType: "upstream_http_error" } : {}),
    };
  }

  if (!isEventStream) {
    let text: string;
    try {
      text = await upstream.text();
    } catch (caught) {
      if (!res.writableEnded) res.end();
      return {
        terminal: "failed",
        upstreamStatus: upstream.status,
        errorType: "upstream_reset",
        error: `Upstream response terminated unexpectedly: ${redactSensitiveText(caught instanceof Error ? caught.message : String(caught))}`,
      };
    }
    logDownstream(text, "json");
    if (diagnosticContext) logBridgeDiagnostic("responses.body", diagnosticBody(text, "json"), diagnosticContext, "debug");
    res.end(text);
    let response: Record<string, unknown> | undefined;
    let terminal: ResponsesTerminalStatus = upstream.ok ? "incomplete" : "failed";
    let error: string | undefined;
    let errorType: string | undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isPlainObject(parsed)) {
        response = parsed;
        if (parsed.status === "completed") terminal = "completed";
        else if (parsed.status === "failed") terminal = "failed";
        else if (parsed.status === "incomplete") terminal = "incomplete";
        const detail = responsesError(parsed);
        error = detail.message;
        errorType = detail.type;
      }
    } catch {
      if (!upstream.ok) error = redactSensitiveText(text.slice(0, 4_096));
    }
    if (terminal === "completed" && response) {
      try { options.onCompletedResponse?.(response); } catch { /* continuation storage is best effort */ }
    }
    const usage = response ? responsesUsage(response) : undefined;
    return {
      terminal,
      upstreamStatus: upstream.status,
      ...(response ? { response } : {}),
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
      ...(errorType ? { errorType } : {}),
    };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: ResponsesTerminalStatus | undefined;
  let completedResponse: Record<string, unknown> | undefined;
  let error: string | undefined;
  let errorType: string | undefined;
  let remembered = false;
  const streamedOutput = new Map<number, Record<string, unknown>>();
  const inspect = (payload: string | null) => {
    if (!payload) return;
    const result = inspectResponsesPayload(payload);
    if (result.terminal) terminal = result.terminal;
    if (result.outputItem) streamedOutput.set(result.outputItem.outputIndex, result.outputItem.item);
    if (result.response) {
      completedResponse = restoreStreamedResponseOutput(result.response, [...streamedOutput].map(([outputIndex, item]) => ({ outputIndex, item })));
      if (!remembered) {
        remembered = true;
        try { options.onCompletedResponse?.(completedResponse); } catch { /* continuation storage is best effort */ }
      }
    }
    if (payload === "[DONE]") return;
    try {
      const event = JSON.parse(payload) as unknown;
      if (!isPlainObject(event)) return;
      const detail = responsesError(isPlainObject(event.response) ? event.response : event);
      if (detail.message) error = detail.message;
      if (detail.type) errorType = detail.type;
    } catch { /* malformed inspection data must not alter the relayed stream */ }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      logDownstream(value, "sse");
      res.write(Buffer.from(value));
      buffer += decoder.decode(value, { stream: true });
      let next: { block: string; rest: string } | null;
      while ((next = nextSseBlock(buffer))) {
        buffer = next.rest;
        if (diagnosticContext) logBridgeDiagnostic("responses.sse_frame", { sequence: downstreamSequence, block: next.block }, diagnosticContext, "debug");
        inspect(sseDataPayload(next.block));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      if (diagnosticContext) logBridgeDiagnostic("responses.sse_residual", { sequence: downstreamSequence, block: buffer }, diagnosticContext, "debug");
      inspect(sseDataPayload(buffer));
    }
    terminal ??= upstream.ok ? "incomplete" : "failed";
  } catch (caught) {
    terminal = "failed";
    errorType = "upstream_reset";
    error = `Upstream stream terminated unexpectedly: ${redactSensitiveText(caught instanceof Error ? caught.message : String(caught))}`;
    if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) {
      const failure = { type: "upstream_error", code: "upstream_reset", message: error };
      const payload = JSON.stringify({ type: "response.failed", response: { status: "failed", error: failure, last_error: failure } });
      const failureSse = `\n\nevent: response.failed\ndata: ${payload}\n\ndata: [DONE]\n\n`;
      logDownstream(failureSse, "synthetic_failure_sse");
      res.write(failureSse);
    }
  } finally {
    reader.releaseLock();
    if (!res.writableEnded) res.end();
  }
  const usage = completedResponse ? responsesUsage(completedResponse) : undefined;
  if (diagnosticContext) {
    logBridgeDiagnostic("responses.passthrough_terminal", {
      terminal: terminal ?? "incomplete",
      upstreamStatus: upstream.status,
      usage,
      error,
      errorType,
      completedResponse,
    }, diagnosticContext, terminal === "completed" ? "info" : "warn");
  }
  return {
    terminal: terminal ?? "incomplete",
    upstreamStatus: upstream.status,
    ...(completedResponse ? { response: completedResponse } : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    ...(errorType ? { errorType } : {}),
  };
}

function sendResponsesFailure(res: ServerResponse, stream: boolean, status: number, message: string): void {
  const safe = redactSensitiveText(message);
  if (stream) {
    const failure = { type: "upstream_error", code: "upstream_error", message: safe };
    const payload = JSON.stringify({ type: "response.failed", response: { status: "failed", error: failure, last_error: failure } });
    logBridgeDiagnostic("responses.synthetic_failure", { stream, status, payload }, undefined, "error");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.end(`event: response.failed\ndata: ${payload}\n\ndata: [DONE]\n\n`);
    return;
  }
  logBridgeDiagnostic("responses.synthetic_failure", { stream, status, message: safe }, undefined, "error");
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { type: "upstream_error", message: safe } }));
}

async function handleNativeResponses(req: IncomingMessage, body: unknown, res: ServerResponse, previousResponseInputExpanded: boolean): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const previousId = isPlainObject(body) && typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  const responseStateEligible = !previousId || previousResponseInputExpanded;
  if (previousId && !previousResponseInputExpanded) {
    console.warn(`[devil-proxy] previous_response_id ${previousId} was not found; forwarding native GPT turn without earlier replay state`);
  }
  const requestBody = prepareOpenAiResponsesBody(body, { forward: true, previousResponseInputExpanded });
  const upstream = await fetchUpstream(CHATGPT_CODEX_RESPONSES, {
    method: "POST",
    headers: forwardedHeaders(req),
    body: JSON.stringify(requestBody),
  }, controller.signal);
  await relayResponsesPassthrough(upstream, res, controller, {
    expectStream: isPlainObject(body) && body.stream === true,
    ...(responseStateEligible ? { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(body, response) } : {}),
  });
}

async function handleNativeCompact(req: IncomingMessage, raw: string, res: ServerResponse): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const upstream = await fetchUpstream(`${CHATGPT_CODEX_RESPONSES}/compact`, { method: "POST", headers: forwardedHeaders(req), body: raw }, controller.signal);
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
  if (upstream.body) {
    const reader = upstream.body.getReader();
    let sequence = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      logBridgeDiagnostic("responses.raw_chunk", { sequence: ++sequence, kind: "compact", ...diagnosticChunk(value) }, undefined, "debug");
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

async function handleCompactResponses(req: IncomingMessage, body: unknown, res: ServerResponse): Promise<void> {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).model !== "string") {
    throw new ProxyRequestError(400, "compact 요청에는 model이 필요합니다.");
  }
  const parsed = parseRequest(body);
  const { provider, accountId, model } = splitModel(parsed.model);
  parsed.model = model;
  const diagnosticContext = bridgeDiagnosticContext.getStore();
  if (diagnosticContext) Object.assign(diagnosticContext, { provider, model, threadId: threadIdFromRequest(req, body) || undefined });
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  if (provider === "openai") {
    const key = await providerSettings.readApiKey(provider, accountId);
    const upstream = await fetchUpstream(apiProviderUrl(provider, "/responses/compact"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...(body as Record<string, unknown>), model }),
    }, controller.signal);
    await relayResponsesPassthrough(upstream, res, controller, { expectStream: false });
    return;
  }
  parsed.tools = [];
  // Adapters are streaming transports; compact consumes the stream internally and
  // returns a unary Responses replacement to Codex.
  parsed.stream = true;
  parsed.context.messages.push({ role: "user", content: [{ type: "text", text: COMPACT_PROMPT }] });
  let summary = "";
  let failure = "";
  try {
    const stream = tapProxyEvents(await providerEventStream(provider, accountId, parsed, controller.signal), {});
    for await (const event of stream) {
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "reasoning_raw_delta") summary += event.type === "text_delta" ? event.text : event.type === "thinking_delta" ? event.thinking : event.text;
      if (event.type === "error") failure = event.message;
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  if (failure) throw new ProxyRequestError(502, redactSensitiveText(failure));
  const messages = extractCompactUserMessages((body as Record<string, unknown>).input);
  const output = buildCompactV1Output(messages, summary.trim());
  logBridgeDiagnostic("responses.compact_output", { output });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ output }));
}

async function providerEventStream(
  provider: ProxyProvider,
  accountId: string | undefined,
  parsed: OcxParsedRequest,
  signal: AbortSignal,
  nvidiaRateLimitRpm?: number,
): Promise<AsyncGenerator<AdapterEvent>> {
  let upstream: Response;
  if (provider === "openai") throw new Error("OpenAI 모델은 Responses passthrough 경로로 요청해야 합니다.");
  if (provider === "nvidia") await waitForNvidiaRateLimit(nvidiaRateLimitRpm, signal);
  if (provider === "claude-code") {
    const auth = await claudeAuth(accountId);
    if (!auth) throw new Error("Claude Code 로그인이 필요합니다.");
    const reqInit = await buildAnthropicRequest(parsed, auth);
    upstream = await fetchUpstream(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body }, signal);
    return streamAnthropic(upstream);
  }
  if (provider === "copilot") {
    const auth = await copilotAuth(accountId);
    if (!auth) throw new Error("GitHub Copilot 로그인이 필요합니다.");
    const reqInit = buildCopilotRequest(parsed, auth);
    upstream = await fetchUpstream(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body }, signal);
    return streamCopilot(upstream);
  }
  if (provider === "antigravity") {
    const auth = await antigravityAuth(accountId);
    if (!auth) throw new Error("Antigravity 로그인이 필요합니다.");
    const reqInit = buildAntigravityRequest(parsed, auth);
    upstream = await fetchUpstream(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body }, signal);
    return streamAntigravity(upstream, parsed);
  }
  if (provider === "kimi") {
    const auth = await kimiAuth(accountId);
    if (!auth) throw new Error("Kimi Code 로그인이 필요합니다.");
    const reqInit = buildApiKeyRequest(provider, parsed, auth.accessToken);
    upstream = await fetchUpstream(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body }, signal);
    return streamOpenAiCompatible(providerLabel(provider), upstream);
  }
  const key = await providerSettings.readApiKey(provider, accountId);
  const reqInit = provider === "anthropic" ? await buildAnthropicRequest(parsed, { apiKey: key }) : buildApiKeyRequest(provider, parsed, key);
  upstream = await fetchUpstream(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body }, signal);
  return provider === "google" ? streamGoogle(upstream) : provider === "anthropic" ? streamAnthropic(upstream) : streamOpenAiCompatible(providerLabel(provider), upstream);
}

async function streamForProvider(input: {
  provider: ProxyProvider;
  accountId?: string;
  parsed: OcxParsedRequest;
  req: IncomingMessage;
  sidecars: { settings?: SidecarSettings; stats: SidecarStats };
  signal: AbortSignal;
}): Promise<AsyncGenerator<AdapterEvent>> {
  const { provider, accountId, parsed, req, sidecars, signal } = input;
  const invoke = (next: OcxParsedRequest) => providerEventStream(provider, accountId, next, signal, sidecars.settings?.nvidiaRateLimitRpm);
  if (sidecars.settings?.vision && (sidecars.settings.visionLimit || 0) > 0 && !usesNativeImages(provider, parsed.model)) {
    await applyVisionSidecar({ parsed, req, sidecars: sidecars.settings, stats: sidecars.stats, signal });
  }
  if (sidecars.settings?.webSearch && (sidecars.settings.webSearchLimit || 0) > 0 && shouldExposeWebSearchTool(parsed)) {
    if (!parsed.tools.some((tool) => tool.webSearch || tool.name === "web_search")) {
      parsed.tools = [...parsed.tools, buildWebSearchTool()];
    }
    return runWithWebSearchLoop({ parsed, req, sidecars: sidecars.settings, stats: sidecars.stats, signal, invoke });
  }
  return invoke(parsed);
}

async function handleExternalResponses(req: IncomingMessage, body: unknown, res: ServerResponse, previousResponseInputExpanded = false): Promise<void> {
  const parsed = parseRequest(body);
  parsed._previousResponseInputExpanded = previousResponseInputExpanded;
  const { provider, accountId, model } = splitModel(parsed.model);
  const emptyWebSocketResponseId = shouldUseEmptyWebSocketResponseId(provider, diagnosticTransport(req));
  parsed.model = model;
  const routedCompaction = parsed._compactionRequest === true && provider !== "openai";
  if (routedCompaction) {
    parsed.tools = [];
    delete parsed.hostedWebSearch;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: [{ type: "text", text: COMPACT_PROMPT }] });
  }
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const threadId = threadIdFromRequest(req, body);
  const diagnosticContext = bridgeDiagnosticContext.getStore();
  if (diagnosticContext) Object.assign(diagnosticContext, { provider, model, ...(threadId ? { threadId } : {}) });
  const sidecars = routedCompaction || provider === "openai"
    ? { stats: { webSearchRequests: 0, webSearchEvents: [], visionRequests: 0, failures: [] } as SidecarStats }
    : await sidecarState(threadId);
  const stats = requestPartStats(parsed);
  const startedAt = Date.now();
  const requestId = diagnosticContext?.requestId ?? crypto.randomUUID();
  const account = accountId ? await getStoredAccount(provider, accountId).catch(() => null) : null;
  startRequestLog({
    id: requestId,
    provider,
    model,
    ...(accountId ? { accountId } : {}),
    ...(account?.label ? { accountLabel: account.label } : {}),
    ...(threadId ? { threadId } : {}),
    route: "devil proxy + reconcile",
    status: "started",
    startedAt,
    tools: stats.tools,
    images: stats.images,
    files: stats.files,
    capability: capabilityFor(provider as ProviderId, model),
    sidecar: sidecarSnapshot(sidecars.stats),
  });
  logBridgeDiagnostic("request.summary", {
    accountId,
    previousResponseId: parsed.previousResponseId,
    previousResponseInputExpanded,
    routedCompaction,
    stream: parsed.stream,
    reasoningEffort: parsed.reasoningEffort,
    options: parsed.options,
    stats,
    sidecar: { settings: sidecars.settings, stats: sidecarSnapshot(sidecars.stats) },
  }, diagnosticContext);

  if (provider === "openai") {
    const responseStateEligible = parsed._compactionRequest !== true && (!parsed.previousResponseId || previousResponseInputExpanded);
    if (parsed.previousResponseId && !previousResponseInputExpanded) {
      console.warn(`[devil-proxy] previous_response_id ${parsed.previousResponseId} was not found; forwarding OpenAI API turn without earlier replay state`);
    }
    let result: PassthroughRelayResult | undefined;
    let failureMessage = "";
    let failureType = "";
    try {
      const key = await providerSettings.readApiKey(provider, accountId);
      const request = buildOpenAiResponsesApiKeyRequest(parsed, key);
      const upstream = await fetchUpstream(request.url, { method: "POST", headers: request.headers, body: request.body }, controller.signal);
      result = await relayResponsesPassthrough(upstream, res, controller, {
        expectStream: parsed.stream,
        ...(responseStateEligible ? { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response) } : {}),
      });
      failureMessage = result.error ?? (result.terminal === "incomplete" ? "OpenAI Responses 응답이 완료 전에 종료되었습니다." : "");
      failureType = result.errorType ?? (result.terminal === "incomplete" ? "upstream_incomplete" : "");
    } catch (error) {
      failureMessage = redactSensitiveText(error instanceof Error ? error.message : String(error));
      failureType = controller.signal.aborted ? "request_aborted" : "upstream_connect_error";
      if (!res.headersSent) sendResponsesFailure(res, parsed.stream, 502, failureMessage);
      else if (!res.writableEnded) res.end();
    }
    if (failureMessage) reportProxyError?.(failureMessage);
    const completedAt = Date.now();
    const failed = !result || result.terminal !== "completed" || result.upstreamStatus < 200 || result.upstreamStatus >= 300;
    finishRequestLog(requestId, {
      status: failed ? "failed" : "completed",
      completedAt,
      durationMs: completedAt - startedAt,
      ...(failureMessage ? { error: failureMessage } : {}),
      ...(failureType ? { errorType: failureType } : {}),
      ...(result?.usage ? { usage: result.usage } : {}),
      sidecar: sidecarSnapshot(sidecars.stats),
    });
    logBridgeDiagnostic("request.terminal", {
      status: failed ? "failed" : "completed",
      terminal: result?.terminal ?? "failed",
      upstreamStatus: result?.upstreamStatus,
      durationMs: completedAt - startedAt,
      usage: result?.usage,
      error: failureMessage,
      errorType: failureType,
    }, diagnosticContext, failed ? "error" : "info");
    return;
  }

  let stream: AsyncGenerator<AdapterEvent>;
  let failureMessage = "";
  let failureType = "";
  let terminalStatus: ResponsesTerminalStatus | undefined;
  let usage: ProviderRequestLogEntry["usage"] | undefined;
  let finishReason: string | undefined;
  try {
    stream = await streamForProvider({ provider, accountId, parsed, req, sidecars, signal: controller.signal });
  } catch (error) {
    failureMessage = redactSensitiveText(error instanceof Error ? error.message : String(error));
    stream = (async function* () { yield { type: "error", message: failureMessage } as AdapterEvent; })();
  }
  stream = tapProxyEvents(stream, {
    onError: (message, type) => { failureMessage = message; failureType = type ?? ""; },
    onUsage: (value) => { usage = logUsage(value); },
    onFinishReason: (value) => { finishReason = value; },
  });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const toolMaps = bridgeToolMaps(parsed);
  const responseStateEligible = !routedCompaction && !emptyWebSocketResponseId && (!parsed.previousResponseId || previousResponseInputExpanded);
  if (parsed.previousResponseId && !previousResponseInputExpanded) {
    console.warn(`[devil-proxy] previous_response_id ${parsed.previousResponseId} was not found; skipping continuation-state storage for this truncated turn`);
  }
  const sse = bridgeToResponsesSSE(
    stream,
    parsed.model,
    toolMaps.toolNsMap,
    toolMaps.freeformToolNames,
    toolMaps.toolSearchToolNames,
    () => controller.abort(),
    2_000,
    {
      ...(emptyWebSocketResponseId ? { responseId: "" } : {}),
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      onTerminal: (status) => { terminalStatus = status; },
      ...(routedCompaction ? { compaction: true } : {}),
      ...(responseStateEligible ? { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response) } : {}),
    },
  );
  const reader = sse.getReader();
  const downstreamDecoder = new TextDecoder();
  let downstreamSequence = 0;
  let downstreamBuffer = "";
  let downstreamFrameOmitted = false;
  let downstreamBoundaryTail = "";
  const traceDownstreamText = (decoded: string) => {
    let nextText = decoded;
    if (downstreamFrameOmitted) {
      const combined = downstreamBoundaryTail + nextText;
      const boundary = combined.match(/\r?\n\r?\n/);
      if (!boundary || boundary.index === undefined) {
        downstreamBoundaryTail = combined.slice(-3);
        return;
      }
      logBridgeDiagnostic("responses.sse_frame", { sequence: downstreamSequence, omitted: true, reason: "frame exceeds diagnostic limit" }, diagnosticContext, "warn");
      nextText = combined.slice(boundary.index + boundary[0].length);
      downstreamFrameOmitted = false;
      downstreamBoundaryTail = "";
    }
    downstreamBuffer += nextText;
    let next: { block: string; rest: string } | null;
    while ((next = nextSseBlock(downstreamBuffer))) {
      downstreamBuffer = next.rest;
      logBridgeDiagnostic("responses.sse_frame", { sequence: downstreamSequence, block: next.block }, diagnosticContext, "debug");
    }
    if (Buffer.byteLength(downstreamBuffer) > MAX_DIAGNOSTIC_BODY_BYTES) {
      downstreamBoundaryTail = downstreamBuffer.slice(-3);
      downstreamBuffer = "";
      downstreamFrameOmitted = true;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      logBridgeDiagnostic("responses.raw_chunk", {
        sequence: ++downstreamSequence,
        kind: "translated_sse",
        ...diagnosticChunk(value),
      }, diagnosticContext, "debug");
      traceDownstreamText(downstreamDecoder.decode(value, { stream: true }));
      res.write(Buffer.from(value));
    }
    traceDownstreamText(downstreamDecoder.decode());
    if (downstreamFrameOmitted) logBridgeDiagnostic("responses.sse_residual", { sequence: downstreamSequence, omitted: true, reason: "frame exceeds diagnostic limit" }, diagnosticContext, "warn");
    else if (downstreamBuffer.trim()) logBridgeDiagnostic("responses.sse_residual", { sequence: downstreamSequence, block: downstreamBuffer }, diagnosticContext, "debug");
  } finally {
    const completedAt = Date.now();
    const incomplete = terminalStatus === "incomplete";
    const aborted = controller.signal.aborted;
    const terminalMissing = terminalStatus === undefined;
    const failed = Boolean(failureMessage) || terminalStatus !== "completed";
    const terminalError = failureMessage
      || (aborted ? "클라이언트 연결이 응답 완료 전에 종료되었습니다." : terminalMissing ? "프록시 terminal 이벤트 없이 응답이 종료되었습니다." : incomplete ? "프록시 응답이 완료 전에 종료되었습니다." : terminalStatus === "failed" ? "프록시가 실패 terminal 이벤트로 응답을 종료했습니다." : "");
    const terminalErrorType = failureType
      || (aborted ? "request_aborted" : terminalMissing ? "bridge_terminal_missing" : incomplete ? "upstream_incomplete" : terminalStatus === "failed" ? "bridge_failed" : "");
    finishRequestLog(requestId, {
      status: failed ? "failed" : "completed",
      completedAt,
      durationMs: completedAt - startedAt,
      ...(terminalError ? { error: terminalError } : {}),
      ...(terminalErrorType ? { errorType: terminalErrorType } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
      sidecar: sidecarSnapshot(sidecars.stats),
    });
    logBridgeDiagnostic("request.terminal", {
      status: failed ? "failed" : "completed",
      bridgeTerminal: terminalStatus ?? "missing",
      finishReason,
      durationMs: completedAt - startedAt,
      usage,
      aborted,
      terminalMissing,
      error: terminalError || undefined,
      errorType: terminalErrorType || undefined,
      sidecar: sidecarSnapshot(sidecars.stats),
    }, diagnosticContext, failed ? "error" : "info");
    res.end();
  }
}

function bridgeToolMaps(parsed: OcxParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.tools) {
    if (tool.webSearch) continue;
    const wire = sanitizeName(namespacedToolName(tool.namespace, tool.name));
    if (tool.namespace) toolNsMap.set(wire, { namespace: tool.namespace, name: tool.name });
    else toolNsMap.set(wire, { namespace: "", name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

async function* tapProxyEvents(stream: AsyncGenerator<AdapterEvent>, handlers: { onError?: (message: string, type?: string) => void; onUsage?: (usage: OcxUsage | undefined) => void; onFinishReason?: (finishReason: string) => void }): AsyncGenerator<AdapterEvent> {
  const diagnosticContext = bridgeDiagnosticContext.getStore();
  let sequence = 0;
  let terminalSeen = false;
  try {
    for await (const event of stream) {
      logBridgeDiagnostic("adapter.event", { sequence: ++sequence, event }, diagnosticContext, event.type === "error" ? "error" : "debug");
      if (event.type === "error") {
        terminalSeen = true;
        const message = redactSensitiveText(event.message);
        handlers.onError?.(message, event.errorType);
        if (event.usage) handlers.onUsage?.(event.usage);
        if (event.finishReason) handlers.onFinishReason?.(event.finishReason);
        reportProxyError?.(message);
        yield { ...event, message };
        continue;
      }
      if (event.type === "done") {
        terminalSeen = true;
        handlers.onUsage?.(event.usage);
        if (event.finishReason) handlers.onFinishReason?.(event.finishReason);
      }
      yield event;
    }
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    handlers.onError?.(message, "adapter_stream_error");
    reportProxyError?.(message);
    logBridgeDiagnostic("adapter.stream_error", { sequence, error }, diagnosticContext, "error");
    throw error;
  } finally {
    logBridgeDiagnostic("adapter.stream_end", { events: sequence, terminalSeen }, diagnosticContext, terminalSeen ? "debug" : "warn");
  }
}

async function handleModels(res: ServerResponse, selectedOnly: boolean): Promise<void> {
  const settings = await providerSettings.load();
  const routedId = (provider: ProviderId, accountId: string | undefined, model: string): string => `${provider}${accountId ? `@${encodeURIComponent(accountId)}` : ""}/${model}`;
  const loginRows = (await Promise.all(settings.providers
    .filter((provider) => provider.kind === "login" && provider.id !== "codex")
    .flatMap((provider) => provider.accounts.filter((account) => providerAccountReady(provider, account)).map(async (account) => {
      const liveModels = provider.id === "antigravity"
        ? await antigravityModels(account.id).catch(() => [])
        : provider.id === "kimi"
          ? await kimiModels(account.id).catch(() => [])
        : await oauthModels(provider.id as "copilot" | "claude-code", account.id).catch(() => []);
      // Login model refreshes can lag behind the account/provider cache. Keep
      // connected saved models in the catalog so Bridge activation does not
      // reject a valid selected model during that staggered refresh window.
      const models = [...new Set([
        ...liveModels.map((model) => model.id),
        ...(account.models ?? []).map((model) => model.id),
        ...(provider.models ?? []).map((model) => model.id),
      ])];
      const owner = provider.id === "copilot" ? "github" : provider.id === "antigravity" ? "google" : provider.id === "kimi" ? "moonshot" : "anthropic";
      return models.map((model) => ({ id: routedId(provider.id, account.id, model), object: "model", owned_by: owner }));
    })))).flat();
  const apiProviders = settings.providers.filter((provider) => provider.kind === "apikey" && provider.accounts.some((account) => providerAccountReady(provider, account)));
  const apiRows = apiProviders.flatMap((provider) => {
    const accounts = provider.accounts.filter((account) => providerAccountReady(provider, account));
    return accounts.flatMap((account) => (account.models?.length ? account.models : provider.models).map((model) => ({ id: routedId(provider.id, account.id, model.id), object: "model", owned_by: provider.id })));
  });
  const availableRows = [...loginRows, ...apiRows];
  // The stock catalog is already selected-only. Filtering its dedicated
  // discovery route as well prevents Codex from merging every connected model
  // back into the picker, without constraining Devil's internal app-server.
  const data = selectedOnly
    ? selectConfiguredModelRows(availableRows, (await stockSettingsStore.load()).stockBridgeModels)
    : availableRows;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data }));
}

export class CodexProxyServer {
  private server?: Server;
  private port = 0;
  private secret = "";

  constructor(onProxyError?: (message: string) => void, onRequestLogChanged?: (event: { provider: ProviderRequestLogEntry["provider"]; completed: boolean }) => void) {
    reportProxyError = onProxyError;
    reportRequestLogChanged = onRequestLogChanged;
  }

  secretToken(): string { return this.secret; }

  setSidecarSettings(threadId: string, settings?: SidecarSettings): void {
    if (!threadId) return;
    if (settings) sidecarSettingsByThread.set(threadId, settings);
    else sidecarSettingsByThread.delete(threadId);
    sidecarStatsByThread.set(threadId, { webSearchRequests: 0, webSearchEvents: [], visionRequests: 0, failures: [] });
  }

  consumeSidecarStats(threadId: string): SidecarStats | undefined {
    const stats = sidecarStatsByThread.get(threadId);
    sidecarStatsByThread.delete(threadId);
    sidecarSettingsByThread.delete(threadId);
    return stats;
  }

  async requestLog(): Promise<ProviderRequestLogEntry[]> {
    await loadRequestLog();
    return requestLog.map((entry) => ({ ...entry, sidecar: entry.sidecar ? { ...entry.sidecar, failures: [...entry.sidecar.failures] } : undefined }));
  }

  // Non-proxy runtimes (Claude Code SDK turns) share the same request log so
  // Settings → 연결 and the environment usage card cover every route.
  async recordRuntimeRequest(entry: ProviderRequestLogEntry): Promise<void> {
    await loadRequestLog();
    startRequestLog(entry);
  }

  async finishRuntimeRequest(id: string, patch: Partial<ProviderRequestLogEntry>): Promise<void> {
    await loadRequestLog();
    finishRequestLog(id, patch);
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    await loadRequestLog();
    this.secret = await loadProxySecret();
    const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_DECOMPRESSED_BODY_BYTES });
    const server = createServer((req, res) => {
      void (async () => {
        let requestDiagnosticContext: BridgeDiagnosticContext | undefined;
        try {
          // Reject browser-originated requests: stock Codex (a native HTTP
          // client) never sends these, only a web page would. Closes the CSRF /
          // DNS-rebinding vector against the localhost proxy.
          if (req.headers.origin || req.headers["sec-fetch-site"]) {
            res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"forbidden"}'); return;
          }
          // Require the secret path prefix; strip it before routing so the rest
          // of the handlers see the original /v1/... paths.
          const prefix = `/${this.secret}`;
          const rawUrl = req.url ?? "/";
          if (!this.secret || !(rawUrl === prefix || rawUrl.startsWith(`${prefix}/`))) {
            res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"not found"}'); return;
          }
          const requestedUrl = rawUrl.slice(prefix.length) || "/";
          const stockRoute = requestedUrl === "/stock/v1" || requestedUrl.startsWith("/stock/v1/");
          const url = stockRoute ? requestedUrl.slice("/stock".length) : requestedUrl;
          const diagnosticContext: BridgeDiagnosticContext | undefined = stockRoute ? {
            requestId: diagnosticRequestId(req),
            transport: diagnosticTransport(req),
            route: url,
          } : undefined;
          requestDiagnosticContext = diagnosticContext;
          const routeRequest = async () => {
            if (req.method === "GET" && url.startsWith("/v1/models")) {
              const startedAt = Date.now();
              if (diagnosticContext) logBridgeDiagnostic("models.request_received", { method: req.method, route: url, headers: req.headers }, diagnosticContext);
              await handleModels(res, stockRoute);
              if (diagnosticContext) logBridgeDiagnostic("models.request_completed", { statusCode: res.statusCode, durationMs: Date.now() - startedAt }, diagnosticContext);
              return;
            }
            if (req.method === "POST" && (url === "/v1/responses" || url === "/v1/responses/compact")) {
              const requestStartedAt = Date.now();
              if (diagnosticContext) {
                res.once("finish", () => logBridgeDiagnostic("request.http_finish", {
                  statusCode: res.statusCode,
                  durationMs: Date.now() - requestStartedAt,
                  writableFinished: res.writableFinished,
                }, diagnosticContext));
                res.once("close", () => {
                  if (!res.writableFinished) logBridgeDiagnostic("request.client_close", {
                    statusCode: res.statusCode,
                    durationMs: Date.now() - requestStartedAt,
                    destroyed: res.destroyed,
                  }, diagnosticContext, "warn");
                });
              }
              const { raw, body } = await readBody(req);
              if (diagnosticContext) {
                diagnosticContext.model = modelId(body);
                diagnosticContext.threadId = threadIdFromRequest(req, body) || undefined;
                logBridgeDiagnostic("request.received", {
                  method: req.method,
                  route: url,
                  headers: req.headers,
                  compressedBytes: Number(req.headers["content-length"] ?? 0) || undefined,
                  decodedBytes: Buffer.byteLength(raw),
                  body: diagnosticBody(raw, "request_json"),
                }, diagnosticContext);
              }
              // Both native ChatGPT passthrough and routed providers need the local replay cache:
              // stock Codex chains WS turns with previous_response_id, while ChatGPT's Codex REST
              // endpoint rejects that parameter. Expanding every normal Responses turn preserves the
              // second/third-turn context before either route strips the id for its upstream.
              const routedBody = url === "/v1/responses" ? expandPreviousResponseInput(body) : body;
              const previousResponseInputExpanded = routedBody !== body;
              const rewritten = routedBody && typeof routedBody === "object" && !Array.isArray(routedBody)
                ? sanitizeEncryptedContentInPlace((routedBody as { input?: unknown }).input)
                : 0;
              const routedRaw = previousResponseInputExpanded || rewritten > 0 ? JSON.stringify(routedBody) : raw;
              if (url === "/v1/responses/compact" && isExternalModel(modelId(body))) await handleCompactResponses(req, routedBody, res);
              else if (url === "/v1/responses/compact") await handleNativeCompact(req, routedRaw, res);
              else if (isExternalModel(modelId(body))) await handleExternalResponses(req, routedBody, res, previousResponseInputExpanded);
              else await handleNativeResponses(req, routedBody, res, previousResponseInputExpanded);
              return;
            }
            res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"not found"}');
          };
          if (diagnosticContext) await bridgeDiagnosticContext.run(diagnosticContext, routeRequest);
          else await routeRequest();
        } catch (error) {
          if (requestDiagnosticContext) logBridgeDiagnostic("request.handler_error", { error }, requestDiagnosticContext, "error");
          const status = error instanceof ProxyRequestError ? error.status : (error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500);
          if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: redactSensitiveText(error instanceof Error ? error.message : String(error)) } }));
        }
      })();
    });
    server.on("upgrade", (req, socket, head) => {
      const prefix = `/${this.secret}`;
      const rawUrl = req.url ?? "/";
      const requestedPath = rawUrl.slice(prefix.length).split("?", 1)[0];
      const path = requestedPath.startsWith("/stock/v1/") ? requestedPath.slice("/stock".length) : requestedPath;
      if (!this.secret || !(rawUrl === prefix || rawUrl.startsWith(`${prefix}/`))) {
        rejectWebSocketUpgrade(socket, 403, "forbidden");
        return;
      }
      if (req.headers.origin || req.headers["sec-fetch-site"]) {
        rejectWebSocketUpgrade(socket, 403, "forbidden");
        return;
      }
      if (path === "/v1/responses") {
        websocketServer.handleUpgrade(req, socket, head, (ws) => websocketServer.emit("connection", ws, req));
        return;
      }
      rejectWebSocketUpgrade(socket, 403, "forbidden");
    });
    websocketServer.on("connection", (ws, req) => {
      let activeAbort: AbortController | undefined;
      let activeDiagnosticContext: BridgeDiagnosticContext | undefined;
      let turnSequence = 0;
      const requestedPath = (req.url ?? "").slice(`/${this.secret}`.length).split("?", 1)[0];
      const stockConnection = requestedPath.startsWith("/stock/v1/");
      const connectionId = crypto.randomUUID();
      ws.on("message", (raw: RawData) => {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
        if (frame.type === "response.processed") {
          if (activeDiagnosticContext) logBridgeDiagnostic("websocket.response_processed", { frame }, activeDiagnosticContext);
          return;
        }
        if (frame.type !== "response.create") return;
        activeAbort?.abort();
        const turnId = ++turnSequence;
        const requestId = `${connectionId}:${turnId}`;
        const wsDiagnosticContext: BridgeDiagnosticContext | undefined = stockConnection ? {
          requestId,
          transport: "websocket",
          route: "/v1/responses",
          model: typeof frame.model === "string" ? frame.model : undefined,
        } : undefined;
        activeDiagnosticContext = wsDiagnosticContext;
        if (wsDiagnosticContext) logBridgeDiagnostic("websocket.request_received", { connectionId, turnId, frame: diagnosticBody(raw.toString(), "websocket_frame") }, wsDiagnosticContext);
        const isCurrent = () => turnSequence === turnId;
        const turnAbort = new AbortController();
        activeAbort = turnAbort;
        const payload = { ...frame };
        delete payload.type;
        if (payload.generate === false) {
          const model = typeof payload.model === "string" ? payload.model : "";
          const created = JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "", object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [] } });
          const completed = JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "", object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "completed", output: [] } });
          ws.send(created);
          ws.send(completed);
          if (wsDiagnosticContext) logBridgeDiagnostic("websocket.generate_false_completed", { frames: [created, completed] }, wsDiagnosticContext);
          return;
        }
        void (async () => {
          try {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            for (const name of FORWARDED_OPENAI_HEADERS) {
              const value = req.headers[name];
              if (typeof value === "string") headers[name] = value;
            }
            // Routed WS responses use an empty response id so stock Codex sends full history on
            // the next turn. Native Codex and OpenAI passthrough retain their upstream ids.
            headers["x-devil-diagnostic-transport"] = "websocket";
            if (wsDiagnosticContext) {
              headers["x-devil-diagnostic-id"] = requestId;
            }
            const stockPrefix = stockConnection ? "/stock" : "";
            const response = await fetch(`http://127.0.0.1:${DEVIL_PROXY_PORT}/${this.secret}${stockPrefix}/v1/responses`, {
              method: "POST", headers, body: JSON.stringify({ ...payload, stream: true }), signal: turnAbort.signal,
            });
            if (!response.ok || !response.body) {
              const detail = redactSensitiveText(await response.text());
              if (wsDiagnosticContext) logBridgeDiagnostic("websocket.http_error", { status: response.status, detail }, wsDiagnosticContext, "error");
              if (isCurrent() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", status: response.status, error: { message: detail } }));
              return;
            }
            await pumpResponsesSseToWebSocket(ws, response.body, turnAbort.signal, isCurrent, wsDiagnosticContext);
          } catch (error) {
            if (wsDiagnosticContext) logBridgeDiagnostic("websocket.request_error", { connectionId, turnId, error }, wsDiagnosticContext, "error");
            if (!turnAbort.signal.aborted && isCurrent() && ws.readyState === WebSocket.OPEN) {
              const payload = JSON.stringify({ type: "error", status: 502, error: { message: redactSensitiveText(error instanceof Error ? error.message : String(error)) } });
              ws.send(payload);
              if (wsDiagnosticContext) logBridgeDiagnostic("websocket.error_sent", { payload }, wsDiagnosticContext, "error");
            }
          }
        })();
      });
      ws.on("close", (code, reason) => {
        turnSequence += 1;
        activeAbort?.abort();
        if (stockConnection) logBridgeDiagnostic("websocket.closed", { connectionId, code, reason: reason.toString() }, {
          requestId: connectionId,
          transport: "websocket",
          route: "/v1/responses",
        }, code === 1000 ? "info" : "warn");
      });
    });
    // Keep the provider URL stable across Devil restarts. Codex stores the
    // provider name in a rollout, and a fixed URL lets stock Codex recognise
    // those saved threads after Devil has closed.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(DEVIL_PROXY_PORT, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    this.server = server;
    diagnosticLog("bridge", "server.started", { port: this.port, stockProxyServiceMode }, { processRole: stockProxyServiceMode ? "stock-bridge" : "desktop-main" });
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    flushResponseState();
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    diagnosticLog("bridge", "server.stopped", { port: this.port }, { processRole: stockProxyServiceMode ? "stock-bridge" : "desktop-main" });
  }
}
