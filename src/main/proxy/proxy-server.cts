// Local OpenAI-Responses proxy. Registered as a Codex model_provider so the
// app-server routes external-model turns here; this translates to Claude/Copilot
// and streams Codex Responses SSE back. Codex records the turn natively → syncs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
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
  sanitizePassthroughHeaders,
  sseDataPayload,
} from "./openai-responses.cjs";
import { claudeAuth, copilotAuth, oauthModels } from "../provider-oauth.cjs";
import { antigravityAuth, antigravityModels } from "../provider-antigravity.cjs";
import { apiProviderConfig, apiProviderUrl, capabilityFor, ProviderSettingsStore } from "../provider-settings.cjs";
import { CodexSettingsStore } from "../codex-settings.cjs";
import type { ProviderId, ProviderRequestLogEntry, SidecarSettings } from "../contracts.cjs";
import { getStoredAccount } from "../provider-accounts.cjs";
import { selectConfiguredModelRows } from "../codex-stock-catalog.cjs";

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

function sendWsProtocolError(ws: WebSocket, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "error", status: 502, error: { type: "protocol_error", code: "websocket_protocol_error", message } }));
}

async function pumpResponsesSseToWebSocket(
  ws: WebSocket,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  isCurrent: () => boolean,
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
          sendWsProtocolError(ws, "Invalid JSON payload in upstream SSE frame");
          terminalSeen = true;
          break;
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(payload);
        if (terminalResponseType(payload)) { terminalSeen = true; break; }
      }
    }
    buffer += decoder.decode();
    if (!terminalSeen && buffer.trim() && !signal.aborted && isCurrent()) {
      const parsed = ssePayloads(`${buffer}\n\n`);
      for (const payload of parsed.payloads) {
        try { JSON.parse(payload); } catch { sendWsProtocolError(ws, "Invalid JSON payload in upstream SSE frame"); terminalSeen = true; break; }
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
        if (terminalResponseType(payload)) { terminalSeen = true; break; }
      }
    }
    if (!terminalSeen && !signal.aborted && isCurrent()) sendWsProtocolError(ws, "Upstream stream ended before response terminal event");
  } finally {
    if (terminalSeen || signal.aborted || !isCurrent()) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}
type ProxyProvider = Exclude<ProviderId, "codex">;

function providerLabel(provider: ProxyProvider): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "antigravity") return "Antigravity";
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
    if (p === "claude-code" || p === "copilot" || p === "antigravity" || p === "openai" || p === "anthropic" || p === "google" || p === "deepseek" || p === "xai" || p === "openrouter" || p === "openrouter-free" || p === "opencode-free" || p === "groq" || p === "mistral" || p === "cerebras" || p === "together" || p === "fireworks" || p === "zai" || p === "moonshot" || p === "huggingface" || p === "nvidia" || p === "ollama" || p === "vllm" || p === "lm-studio") return { provider: p, accountId, model: id.slice(sep + 1) };
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (parentSignal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), UPSTREAM_TIMEOUT_MS);
    const abort = () => timeout.abort();
    parentSignal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: timeout.signal });
      if (!retryableStatus(response.status) || attempt === 2) return response;
      try { await response.arrayBuffer(); } catch { /* body drain is best effort */ }
      await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMs(response) || Math.min(2_000, 250 * (2 ** attempt))));
    } catch (error) {
      lastError = error;
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
  return /^(claude-code|copilot|antigravity|openai|anthropic|google|deepseek|xai|openrouter|openrouter-free|opencode-free|groq|mistral|cerebras|together|fireworks|zai|moonshot|huggingface|nvidia|ollama|vllm|lm-studio)(@[^/:]+)?[/:]/.test(model);
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
  const headers = sanitizePassthroughHeaders(upstream.headers);
  const contentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
  const contentType = contentTypeKey ? headers[contentTypeKey]!.toLowerCase() : "";
  const isEventStream = contentType.includes("text/event-stream")
    || (upstream.ok && Boolean(upstream.body) && !contentType && options.expectStream);
  if (isEventStream && !contentTypeKey) headers["content-type"] = "text/event-stream";
  if (isEventStream && !Object.keys(headers).some((key) => key.toLowerCase() === "cache-control")) headers["cache-control"] = "no-cache";
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
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
  const inspect = (payload: string | null) => {
    if (!payload) return;
    const result = inspectResponsesPayload(payload);
    if (result.terminal) terminal = result.terminal;
    if (result.response) {
      completedResponse = result.response;
      if (!remembered) {
        remembered = true;
        try { options.onCompletedResponse?.(result.response); } catch { /* continuation storage is best effort */ }
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
      res.write(Buffer.from(value));
      buffer += decoder.decode(value, { stream: true });
      let next: { block: string; rest: string } | null;
      while ((next = nextSseBlock(buffer))) {
        buffer = next.rest;
        inspect(sseDataPayload(next.block));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) inspect(sseDataPayload(buffer));
    terminal ??= upstream.ok ? "incomplete" : "failed";
  } catch (caught) {
    terminal = "failed";
    errorType = "upstream_reset";
    error = `Upstream stream terminated unexpectedly: ${redactSensitiveText(caught instanceof Error ? caught.message : String(caught))}`;
    if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) {
      const failure = { type: "upstream_error", code: "upstream_reset", message: error };
      const payload = JSON.stringify({ type: "response.failed", response: { status: "failed", error: failure, last_error: failure } });
      res.write(`\n\nevent: response.failed\ndata: ${payload}\n\ndata: [DONE]\n\n`);
    }
  } finally {
    reader.releaseLock();
    if (!res.writableEnded) res.end();
  }
  const usage = completedResponse ? responsesUsage(completedResponse) : undefined;
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
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.end(`event: response.failed\ndata: ${payload}\n\ndata: [DONE]\n\n`);
    return;
  }
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
    while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
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
    const stream = await providerEventStream(provider, accountId, parsed, controller.signal);
    for await (const event of stream) {
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "reasoning_raw_delta") summary += event.type === "text_delta" ? event.text : event.type === "thinking_delta" ? event.thinking : event.text;
      if (event.type === "error") failure = event.message;
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  if (failure) throw new ProxyRequestError(502, redactSensitiveText(failure));
  const messages = extractCompactUserMessages((body as Record<string, unknown>).input);
  const output = buildCompactV1Output(messages, summary.trim());
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
  const sidecars = routedCompaction || provider === "openai"
    ? { stats: { webSearchRequests: 0, webSearchEvents: [], visionRequests: 0, failures: [] } as SidecarStats }
    : await sidecarState(threadId);
  const stats = requestPartStats(parsed);
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
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
    return;
  }

  let stream: AsyncGenerator<AdapterEvent>;
  let failureMessage = "";
  let failureType = "";
  let terminalStatus: ResponsesTerminalStatus | undefined;
  let usage: ProviderRequestLogEntry["usage"] | undefined;
  try {
    stream = await streamForProvider({ provider, accountId, parsed, req, sidecars, signal: controller.signal });
  } catch (error) {
    failureMessage = redactSensitiveText(error instanceof Error ? error.message : String(error));
    stream = (async function* () { yield { type: "error", message: failureMessage } as AdapterEvent; })();
  }
  stream = tapProxyEvents(stream, {
    onError: (message, type) => { failureMessage = message; failureType = type ?? ""; },
    onUsage: (value) => { usage = logUsage(value); },
  });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const toolMaps = bridgeToolMaps(parsed);
  const responseStateEligible = !routedCompaction && (!parsed.previousResponseId || previousResponseInputExpanded);
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
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      onTerminal: (status) => { terminalStatus = status; },
      ...(routedCompaction ? { compaction: true } : {}),
      ...(responseStateEligible ? { onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response) } : {}),
    },
  );
  const reader = sse.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    const completedAt = Date.now();
    const incomplete = terminalStatus === "incomplete";
    const failed = Boolean(failureMessage) || terminalStatus === "failed" || incomplete;
    finishRequestLog(requestId, {
      status: failed ? "failed" : "completed",
      completedAt,
      durationMs: completedAt - startedAt,
      ...(failureMessage ? { error: failureMessage } : incomplete ? { error: "프록시 응답이 완료 전에 종료되었습니다." } : {}),
      ...(failureType ? { errorType: failureType } : incomplete ? { errorType: "upstream_incomplete" } : {}),
      ...(usage ? { usage } : {}),
      sidecar: sidecarSnapshot(sidecars.stats),
    });
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

async function* tapProxyEvents(stream: AsyncGenerator<AdapterEvent>, handlers: { onError?: (message: string, type?: string) => void; onUsage?: (usage: OcxUsage | undefined) => void }): AsyncGenerator<AdapterEvent> {
  for await (const event of stream) {
    if (event.type === "error") {
      const message = redactSensitiveText(event.message);
      handlers.onError?.(message, event.errorType);
      reportProxyError?.(message);
      yield { ...event, message };
      continue;
    }
    if (event.type === "done") handlers.onUsage?.(event.usage);
    yield event;
  }
}

async function handleModels(res: ServerResponse, selectedOnly: boolean): Promise<void> {
  const settings = await providerSettings.load();
  const routedId = (provider: ProviderId, accountId: string | undefined, model: string): string => `${provider}${accountId ? `@${encodeURIComponent(accountId)}` : ""}/${model}`;
  const connected = (account: { credentialSource?: string }): boolean => account.credentialSource === "keychain" || account.credentialSource === "environment" || account.credentialSource === "desktop";
  const loginRows = (await Promise.all(settings.providers
    .filter((provider) => provider.kind === "login" && provider.id !== "codex")
    .flatMap((provider) => provider.accounts.filter(connected).map(async (account) => {
      const liveModels = provider.id === "antigravity"
        ? await antigravityModels(account.id).catch(() => [])
        : await oauthModels(provider.id as "copilot" | "claude-code", account.id).catch(() => []);
      // Login model refreshes can lag behind the account/provider cache. Keep
      // connected saved models in the catalog so Bridge activation does not
      // reject a valid selected model during that staggered refresh window.
      const models = [...new Set([
        ...liveModels.map((model) => model.id),
        ...(account.models ?? []).map((model) => model.id),
        ...(provider.models ?? []).map((model) => model.id),
      ])];
      const owner = provider.id === "copilot" ? "github" : provider.id === "antigravity" ? "google" : "anthropic";
      return models.map((model) => ({ id: routedId(provider.id, account.id, model), object: "model", owned_by: owner }));
    })))).flat();
  const apiProviders = settings.providers.filter((provider) => provider.kind === "apikey" && (provider.id === "opencode-free" || provider.accounts.some(connected)));
  const apiRows = apiProviders.flatMap((provider) => {
    const accounts = provider.accounts.filter((account) => provider.id === "opencode-free" || connected(account));
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
          if (req.method === "GET" && url.startsWith("/v1/models")) { await handleModels(res, stockRoute); return; }
          if (req.method === "POST" && (url === "/v1/responses" || url === "/v1/responses/compact")) {
            const { raw, body } = await readBody(req);
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
        } catch (error) {
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
      let turnSequence = 0;
      ws.on("message", (raw: RawData) => {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
        if (frame.type === "response.processed") return;
        if (frame.type !== "response.create") return;
        activeAbort?.abort();
        const turnId = ++turnSequence;
        const isCurrent = () => turnSequence === turnId;
        const turnAbort = new AbortController();
        activeAbort = turnAbort;
        const payload = { ...frame };
        delete payload.type;
        if (payload.generate === false) {
          const model = typeof payload.model === "string" ? payload.model : "";
          ws.send(JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "", object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [] } }));
          ws.send(JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "", object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "completed", output: [] } }));
          return;
        }
        void (async () => {
          try {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            for (const name of FORWARDED_OPENAI_HEADERS) {
              const value = req.headers[name];
              if (typeof value === "string") headers[name] = value;
            }
            const response = await fetch(`http://127.0.0.1:${DEVIL_PROXY_PORT}/${this.secret}/v1/responses`, {
              method: "POST", headers, body: JSON.stringify({ ...payload, stream: true }), signal: turnAbort.signal,
            });
            if (!response.ok || !response.body) {
              if (isCurrent() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", status: response.status, error: { message: redactSensitiveText(await response.text()) } }));
              return;
            }
            await pumpResponsesSseToWebSocket(ws, response.body, turnAbort.signal, isCurrent);
          } catch (error) {
            if (!turnAbort.signal.aborted && isCurrent() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", status: 502, error: { message: redactSensitiveText(error instanceof Error ? error.message : String(error)) } }));
          }
        })();
      });
      ws.on("close", () => { turnSequence += 1; activeAbort?.abort(); });
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
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    flushResponseState();
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
