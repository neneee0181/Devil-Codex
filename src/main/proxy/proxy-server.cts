// Local OpenAI-Responses proxy. Registered as a Codex model_provider so the
// app-server routes external-model turns here; this translates to Claude/Copilot
// and streams Codex Responses SSE back. Codex records the turn natively → syncs.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { app } from "electron";
import { bridgeToResponsesSSE } from "./bridge.cjs";
import { parseRequest } from "./parser.cjs";
import { buildAnthropicRequest, streamAnthropic } from "./anthropic.cjs";
import { buildCopilotRequest, streamCopilot } from "./copilot.cjs";
import { buildApiKeyRequest, streamGoogle, streamOpenAiCompatible } from "./api-key.cjs";
import { buildAntigravityRequest, streamAntigravity } from "./antigravity.cjs";
import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxUsage } from "./types.cjs";
import { sanitizeName } from "./tool-sanitize.cjs";
import { buildWebSearchTool, replayEvents, runWithWebSearchLoop, shouldExposeWebSearchTool, type SidecarStats } from "./web-search-sidecar.cjs";
import { applyVisionSidecar } from "./vision-sidecar.cjs";
import { claudeAuth, copilotAuth, oauthModels } from "../provider-oauth.cjs";
import { antigravityAuth, antigravityModels } from "../provider-antigravity.cjs";
import { apiProviderConfig, capabilityFor, ProviderSettingsStore } from "../provider-settings.cjs";
import type { ProviderId, ProviderRequestLogEntry, SidecarSettings } from "../contracts.cjs";
import { getStoredAccount } from "../provider-accounts.cjs";

const CHATGPT_CODEX_RESPONSES = "https://chatgpt.com/backend-api/codex/responses";

// Per-install secret embedded in the proxy URL path. The proxy only answers
// requests under /<secret>/v1/... so a local process or web page that doesn't
// know the token (written into ~/.codex/config.toml's base_url, perms 0600)
// can't drive the user's provider keys. Persisted so the provider URL stays
// stable across restarts (saved Codex threads keep resolving model_providers.devil).
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
let reportProxyError: ((message: string) => void) | undefined;
let reportRequestLogChanged: ((event: { provider: ProviderRequestLogEntry["provider"]; completed: boolean }) => void) | undefined;
const sidecarSettingsByThread = new Map<string, SidecarSettings>();
const sidecarStatsByThread = new Map<string, SidecarStats>();
const antigravityToolSignaturesByThread = new Map<string, Map<string, string>>();
let antigravityToolSignaturesLoaded = false;
let antigravityToolSignaturesWrite = Promise.resolve();
const requestLog: ProviderRequestLogEntry[] = [];
let requestLogLoaded = false;
let requestLogWrite = Promise.resolve();
const REQUEST_LOG_LIMIT = 120;
const FORWARDED_OPENAI_HEADERS = [
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
  "x-responsesapi-include-timing-metrics",
];

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
  return provider;
}

function splitModel(id: string): { provider: ProxyProvider; accountId?: string; model: string } {
  const sep = id.indexOf(":");
  if (sep > 0) {
    const rawProvider = id.slice(0, sep);
    const accountSep = rawProvider.indexOf("@");
    const p = accountSep >= 0 ? rawProvider.slice(0, accountSep) : rawProvider;
    const accountId = accountSep >= 0 ? decodeURIComponent(rawProvider.slice(accountSep + 1)) : undefined;
    if (p === "claude-code" || p === "copilot" || p === "antigravity" || p === "openai" || p === "anthropic" || p === "google" || p === "deepseek" || p === "xai" || p === "openrouter" || p === "openrouter-free" || p === "groq" || p === "mistral" || p === "cerebras" || p === "together" || p === "fireworks" || p === "zai" || p === "moonshot" || p === "huggingface" || p === "nvidia" || p === "ollama" || p === "vllm" || p === "lm-studio") return { provider: p, accountId, model: id.slice(sep + 1) };
  }
  // Fallback by name shape.
  return { provider: /claude/i.test(id) ? "claude-code" : "copilot", model: id };
}

async function readBody(req: IncomingMessage): Promise<{ raw: string; body: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return { raw, body: raw ? JSON.parse(raw) : {} };
}

function modelId(body: unknown): string {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? String((body as Record<string, unknown>).model ?? "") : "";
}

function isExternalModel(model: string): boolean {
  return /^(claude-code|copilot|antigravity|openai|anthropic|google|deepseek|xai|openrouter|openrouter-free|groq|mistral|cerebras|together|fireworks|zai|moonshot|huggingface|nvidia|ollama|vllm|lm-studio)(@[^:]+)?:/.test(model);
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

function sidecarState(threadId: string): { settings?: SidecarSettings; stats: SidecarStats } {
  const stats = sidecarStatsByThread.get(threadId) ?? { webSearchRequests: 0, webSearchEvents: [], visionRequests: 0, failures: [] };
  if (threadId) sidecarStatsByThread.set(threadId, stats);
  return { settings: threadId ? sidecarSettingsByThread.get(threadId) : undefined, stats };
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

function usesNativeImages(provider: ProxyProvider): boolean {
  if (provider === "openai" || provider === "anthropic" || provider === "google" || provider === "antigravity") return true;
  return Boolean(apiProviderConfig(provider)?.allowImages);
}

function antigravityToolSignaturesPath(): string {
  return join(app.getPath("userData"), "providers", "antigravity-tool-signatures.json");
}

async function loadAntigravityToolSignatures(): Promise<void> {
  if (antigravityToolSignaturesLoaded) return;
  antigravityToolSignaturesLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(antigravityToolSignaturesPath(), "utf8")) as Record<string, Record<string, string>>;
    for (const [threadId, signatures] of Object.entries(parsed)) {
      const entries = Object.entries(signatures).filter((entry): entry is [string, string] => typeof entry[1] === "string");
      if (entries.length) antigravityToolSignaturesByThread.set(threadId, new Map(entries.slice(-200)));
    }
  } catch {
    // Missing cache is normal; signatures are relearned from future Antigravity streams.
  }
}

function persistAntigravityToolSignatures(): void {
  if (!antigravityToolSignaturesLoaded) return;
  antigravityToolSignaturesWrite = antigravityToolSignaturesWrite.then(async () => {
    const threads = Array.from(antigravityToolSignaturesByThread.entries()).slice(-100);
    const out: Record<string, Record<string, string>> = {};
    for (const [threadId, signatures] of threads) {
      out[threadId] = Object.fromEntries(Array.from(signatures.entries()).slice(-200));
    }
    const path = antigravityToolSignaturesPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(out, null, 2), { mode: 0o600 });
  }).catch(() => undefined);
}

function applyAntigravityToolSignatures(threadId: string, parsed: OcxParsedRequest): void {
  if (!threadId) return;
  const signatures = antigravityToolSignaturesByThread.get(threadId);
  if (!signatures?.size) return;
  for (const message of parsed.context.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "toolCall" && !part.thoughtSignature) {
        const signature = signatures.get(part.id);
        if (signature) part.thoughtSignature = signature;
      }
    }
  }
}

async function* rememberAntigravityToolSignatures(threadId: string, stream: AsyncGenerator<AdapterEvent>): AsyncGenerator<AdapterEvent> {
  for await (const event of stream) {
    if (threadId && event.type === "tool_call_start" && event.thoughtSignature) {
      let signatures = antigravityToolSignaturesByThread.get(threadId);
      if (!signatures) {
        signatures = new Map<string, string>();
        antigravityToolSignaturesByThread.set(threadId, signatures);
      }
      signatures.set(event.id, event.thoughtSignature);
      if (signatures.size > 200) signatures.delete(signatures.keys().next().value as string);
      persistAntigravityToolSignatures();
    }
    yield event;
  }
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

async function handleNativeResponses(req: IncomingMessage, raw: string, res: ServerResponse): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const upstream = await fetch(CHATGPT_CODEX_RESPONSES, {
    method: "POST",
    headers: forwardedHeaders(req),
    body: raw,
    signal: controller.signal,
  });
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    "Cache-Control": upstream.headers.get("cache-control") ?? "no-cache",
    Connection: "keep-alive",
  });
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

async function providerEventStream(
  provider: ProxyProvider,
  accountId: string | undefined,
  parsed: OcxParsedRequest,
  signal: AbortSignal,
): Promise<AsyncGenerator<AdapterEvent>> {
  let upstream: Response;
  if (provider === "claude-code") {
    const auth = await claudeAuth(accountId);
    if (!auth) throw new Error("Claude Code 로그인이 필요합니다.");
    const reqInit = buildAnthropicRequest(parsed, auth);
    upstream = await fetch(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body, signal });
    return streamAnthropic(upstream);
  }
  if (provider === "copilot") {
    const auth = await copilotAuth(accountId);
    if (!auth) throw new Error("GitHub Copilot 로그인이 필요합니다.");
    const reqInit = buildCopilotRequest(parsed, auth);
    upstream = await fetch(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body, signal });
    return streamCopilot(upstream);
  }
  if (provider === "antigravity") {
    const auth = await antigravityAuth(accountId);
    if (!auth) throw new Error("Antigravity 로그인이 필요합니다.");
    const reqInit = buildAntigravityRequest(parsed, auth);
    upstream = await fetch(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body, signal });
    return streamAntigravity(upstream);
  }
  const key = await providerSettings.readApiKey(provider, accountId);
  const reqInit = provider === "anthropic" ? buildAnthropicRequest(parsed, { apiKey: key }) : buildApiKeyRequest(provider, parsed, key);
  upstream = await fetch(reqInit.url, { method: "POST", headers: reqInit.headers, body: reqInit.body, signal });
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
  const invoke = (next: OcxParsedRequest) => providerEventStream(provider, accountId, next, signal);
  if (sidecars.settings?.vision && (sidecars.settings.visionLimit || 0) > 0 && !usesNativeImages(provider)) {
    await applyVisionSidecar({ parsed, req, sidecars: sidecars.settings, stats: sidecars.stats, signal });
  }
  if (sidecars.settings?.webSearch && (sidecars.settings.webSearchLimit || 0) > 0 && shouldExposeWebSearchTool(parsed)) {
    if (!parsed.tools.some((tool) => tool.webSearch || tool.name === "web_search")) {
      parsed.tools = [...parsed.tools, buildWebSearchTool()];
    }
    const events = await runWithWebSearchLoop({ parsed, req, sidecars: sidecars.settings, stats: sidecars.stats, signal, invoke });
    return replayEvents(events);
  }
  return invoke(parsed);
}

async function handleExternalResponses(req: IncomingMessage, body: unknown, res: ServerResponse): Promise<void> {
  const parsed = parseRequest(body);
  const { provider, accountId, model } = splitModel(parsed.model);
  parsed.model = model;
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const threadId = threadIdFromRequest(req, body);
  if (provider === "antigravity") {
    await loadAntigravityToolSignatures();
    applyAntigravityToolSignatures(threadId, parsed);
  }
  const sidecars = sidecarState(threadId);
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

  let stream: AsyncGenerator<AdapterEvent>;
  let failureMessage = "";
  let failureType = "";
  let usage: ProviderRequestLogEntry["usage"] | undefined;
  try {
    stream = await streamForProvider({ provider, accountId, parsed, req, sidecars, signal: controller.signal });
    if (provider === "antigravity") stream = rememberAntigravityToolSignatures(threadId, stream);
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
  const sse = bridgeToResponsesSSE(stream, parsed.model, toolMaps.toolNsMap, toolMaps.freeformToolNames, toolMaps.toolSearchToolNames, () => controller.abort());
  const reader = sse.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    const completedAt = Date.now();
    finishRequestLog(requestId, {
      status: failureMessage ? "failed" : "completed",
      completedAt,
      durationMs: completedAt - startedAt,
      ...(failureMessage ? { error: failureMessage } : {}),
      ...(failureType ? { errorType: failureType } : {}),
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

async function handleModels(res: ServerResponse): Promise<void> {
  const settings = await providerSettings.load();
  const routedId = (provider: ProviderId, accountId: string | undefined, model: string): string => `${provider}${accountId ? `@${encodeURIComponent(accountId)}` : ""}:${model}`;
  const loginRows = (await Promise.all(settings.providers
    .filter((provider) => provider.kind === "login" && provider.id !== "codex")
    .flatMap((provider) => provider.accounts.map(async (account) => {
      const models = provider.id === "antigravity"
        ? await antigravityModels(account.id).catch(() => [])
        : await oauthModels(provider.id as "copilot" | "claude-code", account.id).catch(() => []);
      const owner = provider.id === "copilot" ? "github" : provider.id === "antigravity" ? "google" : "anthropic";
      return models.map((model) => ({ id: routedId(provider.id, account.id, model.id), object: "model", owned_by: owner }));
    })))).flat();
  const apiProviders = settings.providers.filter((provider) => provider.kind === "apikey" && (provider.keyRequired ? provider.accounts.length > 0 : provider.modelsLoaded));
  const apiRows = apiProviders.flatMap((provider) => {
    const accounts = provider.accounts.length ? provider.accounts : [{ id: undefined, models: provider.models }] as Array<{ id?: string; models?: typeof provider.models }>;
    return accounts.flatMap((account) => (account.models?.length ? account.models : provider.models).map((model) => ({ id: routedId(provider.id, account.id, model.id), object: "model", owned_by: provider.id })));
  });
  const data = [...loginRows, ...apiRows];
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
          const url = rawUrl.slice(prefix.length) || "/";
          if (req.method === "GET" && url.startsWith("/v1/models")) { await handleModels(res); return; }
          if (req.method === "POST" && url.startsWith("/v1/responses")) {
            const { raw, body } = await readBody(req);
            if (isExternalModel(modelId(body))) await handleExternalResponses(req, body, res);
            else await handleNativeResponses(req, raw, res);
            return;
          }
          res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"not found"}');
        } catch (error) {
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: redactSensitiveText(error instanceof Error ? error.message : String(error)) } }));
        }
      })();
    });
    // Keep the provider URL stable across Devil restarts. Codex stores the
    // provider name in a rollout, and a fixed URL lets stock Codex recognise
    // those saved threads after Devil has closed.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(49873, "127.0.0.1", () => {
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
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
