import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { renameAtomicFile, renameAtomicFileSync } from "../atomic-file.cjs";
import { buildStockCatalog, selectConfiguredModelRows } from "../codex-stock-catalog.cjs";
import type { ProviderInfo } from "../contracts.cjs";
import { providerAccountReady } from "../provider-settings.cjs";
import { latestPluginVersionName } from "../plugin-cache.cjs";
import { buildMacStockProxyPlist, stockProxyTaskArgs } from "../stock-proxy-autostart.cjs";
import { buildAnthropicRequest, streamAnthropic } from "./anthropic.cjs";
import { filterAntigravityToolTurnText } from "./antigravity.cjs";
import { applyAntigravityReplay, observeAntigravityReplayCall, resetAntigravityReplayForTests } from "./antigravity-replay.cjs";
import { buildApiKeyRequest, buildGoogleGenerateContentBody, googleContents, streamOpenAiCompatible } from "./api-key.cjs";
import { bridgeToResponsesSSE } from "./bridge.cjs";
import { encodeCompactionSummary } from "./compaction.cjs";
import { buildCopilotRequest } from "./copilot.cjs";
import { rawMessage } from "./errors.cjs";
import { buildOpenAiResponsesApiKeyRequest, inspectResponsesPayload, prepareOpenAiResponsesBody } from "./openai-responses.cjs";
import { parseRequest } from "./parser.cjs";
import { mapProviderReasoningEffort, providerAutoToolChoiceOnly, providerContextWindow, providerNativeImageInput, providerReasoningEfforts } from "./provider-policy.cjs";
import { decodeRequestBody } from "./proxy-server.cjs";
import { clearResponseStateForTests, expandPreviousResponseInput, flushResponseState, rememberResponseState, resetResponseStateMemoryForTests } from "./response-state.cjs";
import type { AdapterEvent, OcxParsedRequest } from "./types.cjs";

function connectedProvider(id: ProviderInfo["id"], model: string): ProviderInfo {
  const row = { id: model, label: model };
  return {
    id,
    label: id,
    kind: "apikey",
    keyRequired: id !== "opencode-free",
    models: [row],
    modelsLoaded: true,
    credentialSource: id === "opencode-free" ? "none" : "keychain",
    accounts: [{
      id: "acct",
      provider: id,
      label: "Account",
      credentialSource: id === "opencode-free" ? "none" : "keychain",
      credentialKind: id === "opencode-free" ? "local" : "credential",
      models: [row],
      modelsLoaded: true,
    }],
  };
}

function parsedRequest(overrides: Record<string, unknown> = {}): OcxParsedRequest {
  return parseRequest({
    model: "model",
    stream: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "do the work" }] }],
    ...overrides,
  });
}

async function collect(stream: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function collectReadable(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

test("atomic replacement retries transient Windows file locks", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await renameAtomicFile("source", "destination", {
    platform: "win32",
    rename: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("locked"), { code: attempts === 1 ? "EPERM" : "EBUSY" });
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [25, 50]);

  attempts = 0;
  const syncSleeps: number[] = [];
  renameAtomicFileSync("source", "destination", {
    platform: "win32",
    rename: () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("locked"), { code: attempts === 1 ? "EACCES" : "EPERM" });
    },
    sleep: (milliseconds) => { syncSleeps.push(milliseconds); },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(syncSleeps, [25, 50]);
});

test("request decompression accepts both HTTP deflate wire formats", () => {
  const payload = Buffer.from(JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: [] }));
  assert.deepEqual(decodeRequestBody(deflateSync(payload), "deflate"), payload);
  assert.deepEqual(decodeRequestBody(deflateRawSync(payload), "deflate"), payload);
});

test("platform bridge autostart commands preserve executable paths safely", () => {
  const windows = stockProxyTaskArgs("C:\\Program Files\\Devil Codex\\Devil Codex.exe");
  assert.equal(windows[windows.indexOf("/TR") + 1], '"C:\\Program Files\\Devil Codex\\Devil Codex.exe" --devil-stock-proxy');

  const mac = buildMacStockProxyPlist(
    "/Applications/Devil & Codex <Beta>.app/Contents/MacOS/Devil Codex",
    '/Users/dev/Library/Logs/Devil "Codex"/stock.log',
  );
  assert.match(mac, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(mac, /KeepAlive/);
  assert.match(mac, /Devil &amp; Codex &lt;Beta&gt;/);
  assert.match(mac, /Devil &quot;Codex&quot;/);
  assert.match(mac, /--devil-stock-proxy/);
});

test("plugin cache selects the latest version independently of directory order", () => {
  assert.equal(latestPluginVersionName(["0.1.30", "0.1.9", "0.1.10"]), "0.1.30");
  assert.equal(latestPluginVersionName(["0.1.30-beta.2", "0.1.30", "0.1.30-beta.10"]), "0.1.30");
  assert.equal(latestPluginVersionName(["0.1.7", "0.1.7+1"]), "0.1.7+1");
  assert.equal(latestPluginVersionName(["current", "0.1.30"]), "0.1.30");
});

test("Bridge discovery exposes only configured models in configured order", () => {
  const rows = [
    { id: "claude-code@a/claude-sonnet-5", owner: "anthropic" },
    { id: "antigravity@b/gemini-3.5-flash", owner: "google" },
    { id: "copilot@c/gpt-5.5", owner: "github" },
  ];
  const selected = selectConfiguredModelRows(rows, [
    "copilot@c/gpt-5.5",
    "antigravity@b/gemini-3.5-flash",
    "claude-code/claude-sonnet-5",
    "copilot@c/gpt-5.5",
    "missing/model",
  ]);
  assert.deepEqual(selected.map((row) => row.id), ["copilot@c/gpt-5.5", "antigravity@b/gemini-3.5-flash", "claude-code@a/claude-sonnet-5"]);
  assert.deepEqual(selectConfiguredModelRows([
    { id: "claude-code@a/claude-sonnet-5" },
    { id: "claude-code@b/claude-sonnet-5" },
  ], ["claude-code/claude-sonnet-5"]), []);
});

test("keyless local providers become available only after a successful model refresh", () => {
  const local = connectedProvider("ollama", "qwen2.5-coder");
  local.credentialSource = "none";
  local.accounts[0] = {
    ...local.accounts[0]!,
    credentialSource: "none",
    credentialKind: "local",
    modelsLoaded: false,
  };
  assert.equal(providerAccountReady(local, local.accounts[0]!), false);
  const route = "ollama@acct/qwen2.5-coder";
  const native = { models: [{ slug: "gpt-native", display_name: "GPT" }] };
  assert.equal(buildStockCatalog(native, [local], [route]).models?.some((model) => model.slug === route), false);
  local.accounts[0]!.modelsLoaded = true;
  assert.equal(providerAccountReady(local, local.accounts[0]!), true);
  assert.equal(buildStockCatalog(native, [local], [route]).models?.some((model) => model.slug === route), true);
});

test("routed catalog strips native-only metadata and advertises the real provider policy", () => {
  const native = { models: [{
    slug: "gpt-native",
    display_name: "GPT",
    base_instructions: "You are Codex, an agent based on GPT-5. Finish the work.",
    model_messages: { instructions_template: "GPT only" },
    availability_nux: { message: "native" },
    use_responses_lite: true,
    tool_mode: "code_mode_only",
    supports_websockets: true,
    prefer_websockets: true,
    service_tiers: [{ name: "fast" }],
    additional_speed_tiers: [{ name: "fast" }],
    default_service_tier: "fast",
    context_window: 372_000,
    input_modalities: ["text", "image"],
  }] };
  const route = "deepseek@acct/deepseek-v4-flash";
  const catalog = buildStockCatalog(native, [connectedProvider("deepseek", "deepseek-v4-flash")], [route], { webSearch: true, vision: true });
  const entry = catalog.models?.find((model) => model.slug === route);
  assert.ok(entry);
  assert.equal(entry.model_messages, undefined);
  assert.equal(entry.availability_nux, undefined);
  assert.equal(entry.use_responses_lite, undefined);
  assert.equal(entry.tool_mode, undefined);
  assert.equal(entry.supports_websockets, undefined);
  assert.equal(entry.service_tiers, undefined);
  assert.equal(entry.additional_speed_tiers, undefined);
  assert.equal(entry.default_service_tier, undefined);
  assert.equal(entry.supports_parallel_tool_calls, true);
  assert.equal(entry.supports_search_tool, true);
  assert.equal(entry.context_window, 1_000_000);
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
  assert.deepEqual((entry.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort), ["high", "xhigh", "max", "ultra"]);
  assert.doesNotMatch(String(entry.base_instructions), /You are Codex|coding agent based on GPT-5/i);
  assert.match(String(entry.base_instructions), /Do not claim to be GPT-5/);
});

test("reasoning and tool-choice policies match OpenCodex model-specific mappings", () => {
  assert.equal(mapProviderReasoningEffort("deepseek", "deepseek-v4-flash", "medium"), "high");
  assert.equal(mapProviderReasoningEffort("deepseek", "deepseek-v4-pro", "xhigh"), "max");
  assert.equal(mapProviderReasoningEffort("moonshot", "kimi-k2.7-code", "high"), undefined);
  assert.equal(mapProviderReasoningEffort("moonshot", "kimi-k3", "low"), "max");
  assert.equal(mapProviderReasoningEffort("xai", "grok-4.5", "max"), "high");
  assert.deepEqual(providerReasoningEfforts("nvidia", "moonshotai/kimi-k2.6"), []);
  assert.equal(providerAutoToolChoiceOnly("moonshot", "kimi-k2.7-code"), true);
  assert.equal(providerNativeImageInput("opencode-free", "deepseek-v4-flash-free"), false);
  assert.equal(providerNativeImageInput("opencode-free", "big-pickle"), true);
  assert.equal(providerNativeImageInput("copilot", "gpt-5.5"), true);
  assert.equal(providerNativeImageInput("moonshot", "kimi-k2.5"), false);
  assert.equal(providerContextWindow("anthropic", "claude-opus-4-6"), 1_000_000);
  assert.equal(providerContextWindow("openrouter", "openai/gpt-5.6-sol"), 1_050_000);
  assert.equal(providerContextWindow("openrouter-free", "openrouter/free"), 200_000);
});

test("additional_tools survive follow-up parsing and all active tools reach chat providers", () => {
  const tools = Array.from({ length: 35 }, (_, index) => ({
    type: "function",
    name: `tool_${index}`,
    description: `Tool ${index}`,
    parameters: { type: "object", properties: { value: { type: "string" } } },
  }));
  const parsed = parsedRequest({
    model: "deepseek-v4-flash",
    input: [
      { type: "additional_tools", tools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  });
  assert.equal(parsed.tools.length, 35);
  const body = JSON.parse(buildApiKeyRequest("deepseek", parsed, "secret").body) as Record<string, unknown>;
  assert.equal((body.tools as unknown[]).length, 35);
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.reasoning_effort, undefined);
});

test("OpenAI-compatible orphan and image tool results stay schema-valid", () => {
  const orphan = parsedRequest({
    model: "deepseek-v4-flash",
    input: [{ type: "function_call_output", call_id: "orphan_1", output: "done" }],
  });
  const orphanBody = JSON.parse(buildApiKeyRequest("deepseek", orphan, "secret").body) as { messages: Array<Record<string, unknown>> };
  const stub = orphanBody.messages.find((message) => message.role === "assistant");
  assert.equal(stub?.content, "");

  const withImage = parsedRequest({
    model: "deepseek-v4-flash",
    input: [
      { type: "function_call", call_id: "call_1", name: "view_image", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
    ],
  });
  const imageBody = JSON.parse(buildApiKeyRequest("deepseek", withImage, "secret").body) as { messages: Array<Record<string, unknown>> };
  const result = imageBody.messages.find((message) => message.role === "tool");
  assert.equal(result?.content, "[image]");

  const userImage = parsedRequest({
    model: "deepseek-v4-flash",
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  });
  const userImageBody = JSON.parse(buildApiKeyRequest("deepseek", userImage, "secret").body) as { messages: Array<Record<string, unknown>> };
  assert.equal(userImageBody.messages.find((message) => message.role === "user")?.content, "[image]");
});

test("Copilot uses strict-valid orphan stubs and preserves image tool-result markers", () => {
  const parsed = parsedRequest({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "assistant", content: [] },
      { type: "function_call_output", call_id: "orphan_1", output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
    ],
  });
  const body = JSON.parse(buildCopilotRequest(parsed, "copilot-token").body) as { messages: Array<Record<string, unknown>> };
  const assistants = body.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.content, "");
  const result = body.messages.find((message) => message.role === "tool");
  assert.equal(result?.content, "[image]");
});

test("provider errors surface FastAPI and RFC7807 details", () => {
  assert.equal(rawMessage(JSON.stringify({ detail: [{ msg: "single tool call only" }, { msg: "bad schema" }] })), "single tool call only; bad schema");
  assert.equal(rawMessage(JSON.stringify({ error: "quota exceeded" })), "quota exceeded");
  assert.equal(rawMessage(JSON.stringify({ title: "Invalid request" })), "Invalid request");
});

test("xAI tool schemas expand root unions into strict object variants", () => {
  const parsed = parsedRequest({
    model: "grok-4.5",
    tools: [{
      type: "function",
      name: "edit",
      parameters: {
        title: "Edit action",
        anyOf: [
          { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          { oneOf: [
            { type: "object", properties: { patch: { type: "string" } } },
            { type: "object", properties: { replace: { type: "string" } } },
          ] },
        ],
      },
    }],
  });
  const body = JSON.parse(buildApiKeyRequest("xai", parsed, "secret").body) as { tools: Array<{ function: { parameters: Record<string, unknown> } }> };
  const parameters = body.tools[0]!.function.parameters;
  assert.equal(parameters.type, undefined);
  assert.equal(parameters.title, "Edit action");
  assert.equal((parameters.oneOf as unknown[]).length, 3);
  assert.ok((parameters.oneOf as Array<Record<string, unknown>>).every((variant) => variant.type === "object"));
});

test("OpenAI API-key models preserve Responses semantics and sanitize replay-only fields", () => {
  const parsed = parsedRequest({
    model: "gpt-5.5",
    store: false,
    previous_response_id: "resp_previous",
    input: [
      {
        type: "reasoning",
        id: "invalid_reasoning_id",
        content: [{ type: "reasoning_text", text: "proxy-private raw reasoning" }],
        encrypted_content: "ocxr1:proxy-envelope",
      },
      { type: "context_compaction", id: "invalid_compaction_id", encrypted_content: encodeCompactionSummary("compact summary") },
      { type: "message", id: "invalid_message_id", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
    tools: [
      { type: "image_generation" },
      { type: "function", name: "image_gen.imagegen", parameters: { type: "object" } },
    ],
  });
  parsed._previousResponseInputExpanded = true;
  const request = buildOpenAiResponsesApiKeyRequest(parsed, "sk-test-secret");
  const body = JSON.parse(request.body) as Record<string, unknown>;
  const input = body.input as Array<Record<string, unknown>>;
  const tools = body.tools as Array<Record<string, unknown>>;

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.headers.Authorization, "Bearer sk-test-secret");
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.previous_response_id, undefined);
  assert.ok(input.every((item) => item.id === undefined));
  assert.deepEqual(input[0]?.content, []);
  assert.equal(input[0]?.encrypted_content, undefined);
  assert.match(JSON.stringify(input[1]), /compact summary/);
  assert.equal(tools.some((tool) => tool.type === "image_generation"), false);
  assert.equal(tools.some((tool) => tool.name === "image_gen.imagegen"), true);

  const completed = inspectResponsesPayload(JSON.stringify({
    type: "response.completed",
    response: { id: "resp_next", status: "completed", output: [] },
  }));
  assert.equal(completed.terminal, "completed");
  assert.equal(completed.response?.id, "resp_next");
});

test("native Responses passthrough repairs a continuation miss instead of losing the tool result", () => {
  const body = prepareOpenAiResponsesBody({
    model: "gpt-5.6",
    previous_response_id: "resp_missing",
    input: [
      { type: "reasoning", id: "rs_missing", content: [] },
      { type: "function_call_output", call_id: "call_missing", output: "repository status" },
    ],
  }, { forward: true, previousResponseInputExpanded: false }) as Record<string, unknown>;
  const input = body.input as Array<Record<string, unknown>>;
  assert.equal(body.previous_response_id, undefined);
  assert.equal(input.some((item) => item.type === "reasoning"), false);
  assert.equal(input.length, 1);
  assert.equal(input[0]?.type, "message");
  assert.match(JSON.stringify(input[0]), /repository status/);
});

test("Moonshot legacy requests lock sampling and downgrade forced tool choice, while K3 keeps images", () => {
  const tool = { type: "function", name: "exec", description: "run", parameters: { type: "object" } };
  const legacy = parsedRequest({
    model: "kimi-k2.7-code",
    temperature: 0.2,
    top_p: 0.8,
    tool_choice: { type: "function", name: "exec" },
    tools: [tool],
  });
  const legacyBody = JSON.parse(buildApiKeyRequest("moonshot", legacy, "secret").body) as Record<string, unknown>;
  assert.equal(legacyBody.tool_choice, "auto");
  assert.equal(legacyBody.temperature, undefined);
  assert.equal(legacyBody.top_p, undefined);

  const k3 = parsedRequest({
    model: "kimi-k3",
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  });
  const k3Body = JSON.parse(buildApiKeyRequest("moonshot", k3, "secret").body) as { messages: Array<{ role: string; content: unknown }> };
  const k3User = k3Body.messages.find((message) => message.role === "user");
  assert.ok(Array.isArray(k3User?.content));
  assert.equal(((k3User?.content as Array<{ type?: string }>)[0]?.type), "image_url");
});

test("Gemini schema removes Responses-only markers and resolves definitions", () => {
  const parsed = parsedRequest({
    tools: [{
      type: "function",
      name: "send_message",
      parameters: {
        type: "object",
        $defs: { Target: { type: "string", minLength: 1 } },
        properties: {
          target: { $ref: "#/$defs/Target" },
          message: { type: "string", encrypted: true },
          count: { type: "number", exclusiveMinimum: 0 },
        },
        required: ["target", "message"],
      },
    }],
  });
  const body = buildGoogleGenerateContentBody(parsed) as { systemInstruction: { parts: Array<{ text: string }> }; tools: Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }> };
  const schema = body.tools[0]!.functionDeclarations[0]!.parameters;
  assert.doesNotMatch(JSON.stringify(schema), /"encrypted"/);
  assert.equal(((schema.properties as Record<string, Record<string, unknown>>).target).type, "string");
  assert.equal(((schema.properties as Record<string, Record<string, unknown>>).count).minimum, 0);
  assert.match(body.systemInstruction.parts[0]!.text, /Prefer taking the next tool action/);
  assert.match(body.systemInstruction.parts[0]!.text, /never claim an external create, update, save, publish, or deployment succeeded/i);
  assert.match(body.systemInstruction.parts[0]!.text, /Never print raw tool arguments, patches, source files, shell commands, or tool schemas as intermediate text/);
});

test("Gemini schema preserves property names that collide with metadata keys", () => {
  const parsed = parsedRequest({
    tools: [{
      type: "function",
      name: "create_site",
      parameters: {
        type: "object",
        title: "Create site metadata",
        default: {},
        examples: [],
        properties: {
          title: {
            type: "string",
            title: "Site title metadata",
            default: "Portfolio",
            examples: ["Career Atlas"],
          },
          slug: { type: "string" },
          options: {
            type: "object",
            properties: {
              title: { type: "string" },
              default: { type: "string" },
              examples: { type: "array", items: { type: "string" } },
            },
            required: ["title", "default", "examples"],
          },
        },
        required: ["title", "slug", "options"],
      },
    }],
  });
  const body = buildGoogleGenerateContentBody(parsed) as { tools: Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }> };
  const schema = body.tools[0]!.functionDeclarations[0]!.parameters;
  assert.equal(schema.title, undefined);
  assert.equal(schema.default, undefined);
  assert.equal(schema.examples, undefined);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.ok(Object.hasOwn(properties, "title"));
  assert.ok(Object.hasOwn(properties, "slug"));
  assert.deepEqual(schema.required, ["title", "slug", "options"]);
  assert.equal(properties.title!.title, undefined);
  assert.equal(properties.title!.default, undefined);
  assert.equal(properties.title!.examples, undefined);

  const nested = properties.options!.properties as Record<string, unknown>;
  assert.ok(Object.hasOwn(nested, "title"));
  assert.ok(Object.hasOwn(nested, "default"));
  assert.ok(Object.hasOwn(nested, "examples"));
  assert.deepEqual(properties.options!.required, ["title", "default", "examples"]);
});

test("Antigravity hides ordinary text in tool turns but preserves final answers", async () => {
  async function* toolTurn(): AsyncGenerator<AdapterEvent> {
    yield { type: "thinking_delta", thinking: "private plan" };
    yield { type: "text_delta", text: "I will apply this raw patch: *** Begin Patch" };
    yield { type: "tool_call_start", id: "call_1", name: "apply_patch" };
    yield { type: "tool_call_delta", arguments: '{"input":"*** Begin Patch"}' };
    yield { type: "tool_call_end" };
    yield { type: "text_delta", text: "tool call sent" };
    yield { type: "done" };
  }
  const filteredToolTurn = await collect(filterAntigravityToolTurnText(toolTurn()));
  assert.equal(filteredToolTurn.some((event) => event.type === "text_delta"), false);
  assert.deepEqual(filteredToolTurn.map((event) => event.type), [
    "thinking_delta",
    "heartbeat",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_end",
    "heartbeat",
    "done",
  ]);

  async function* finalTurn(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "Deployment completed." };
    yield { type: "done" };
  }
  const filteredFinalTurn = await collect(filterAntigravityToolTurnText(finalTurn()));
  assert.deepEqual(filteredFinalTurn, [
    { type: "heartbeat" },
    { type: "text_delta", text: "Deployment completed." },
    { type: "done" },
  ]);
});

test("native Codex identity is neutralized before an external provider sees it", () => {
  const parsed = parsedRequest({
    model: "deepseek-v4-flash",
    instructions: "You are Codex, an agent based on GPT-5. You and the user share a workspace.",
  });
  const body = JSON.parse(buildApiKeyRequest("deepseek", parsed, "secret").body) as { messages: Array<{ role: string; content: string }> };
  const system = body.messages.find((message) => message.role === "system")?.content ?? "";
  assert.doesNotMatch(system, /You are Codex|based on GPT-5/);
  assert.match(system, /coding agent/);
});

test("Anthropic forwards the complete active tool catalog", async () => {
  const tools = Array.from({ length: 70 }, (_, index) => ({ type: "function", name: `tool_${index}`, parameters: { type: "object" } }));
  const parsed = parsedRequest({ model: "claude-sonnet-5", tools });
  const body = JSON.parse((await buildAnthropicRequest(parsed, { apiKey: "secret" })).body) as { tools: unknown[] };
  assert.equal(body.tools.length, 70);
  const oauthBody = JSON.parse((await buildAnthropicRequest(parsed, { accessToken: "token" })).body) as { tools: Array<{ name: string }> };
  assert.equal(oauthBody.tools[0]!.name, "custom_tool_0");
});

test("Responses continuation survives a process restart and preserves prior tool-loop output", async () => {
  const previousDataDir = process.env.DEVIL_CODEX_USER_DATA;
  const dataDir = await mkdtemp(join(tmpdir(), "devil-response-state-"));
  process.env.DEVIL_CODEX_USER_DATA = dataDir;
  try {
    clearResponseStateForTests();
    const request = {
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first turn" }] }],
    };
    async function* events(): AsyncGenerator<AdapterEvent> {
      yield { type: "text_delta", text: "worked" };
      yield { type: "done" };
    }
    let completed: Record<string, unknown> | undefined;
    const output = await collectReadable(bridgeToResponsesSSE(events(), request.model, undefined, undefined, undefined, undefined, 2_000, {
      responseId: "resp_continuation_test",
      onCompletedResponse: (response) => {
        completed = response;
        rememberResponseState(request, response);
      },
    }));
    assert.ok(completed);
    assert.ok(output.indexOf("response.output_text.done") < output.indexOf("response.completed"));
    assert.match(output, /event: response\.completed/);
    assert.match(output, /data: \[DONE\]/);

    flushResponseState();
    resetResponseStateMemoryForTests();
    const expanded = expandPreviousResponseInput({
      model: request.model,
      previous_response_id: "resp_continuation_test",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "second turn" }] }],
    }) as { input: Array<Record<string, unknown>> };
    assert.equal(expanded.input.length, 3);
    assert.equal(expanded.input[0]?.role, "user");
    assert.equal(expanded.input[1]?.role, "assistant");
    assert.equal(expanded.input[2]?.role, "user");
  } finally {
    clearResponseStateForTests();
    if (previousDataDir === undefined) delete process.env.DEVIL_CODEX_USER_DATA;
    else process.env.DEVIL_CODEX_USER_DATA = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a restarted second-turn tool result restores its call and active additional_tools catalog", async () => {
  const previousDataDir = process.env.DEVIL_CODEX_USER_DATA;
  const dataDir = await mkdtemp(join(tmpdir(), "devil-tool-loop-state-"));
  process.env.DEVIL_CODEX_USER_DATA = dataDir;
  try {
    clearResponseStateForTests();
    const firstRequest = {
      model: "deepseek-v4-flash",
      store: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "inspect the repo" }] }],
    };
    async function* firstEvents(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_read_1", name: "read_file" };
      yield { type: "tool_call_delta", arguments: '{"path":"README.md"}' };
      yield { type: "tool_call_end" };
      yield { type: "done" };
    }
    await collectReadable(bridgeToResponsesSSE(firstEvents(), firstRequest.model, undefined, undefined, undefined, undefined, 2_000, {
      responseId: "resp_tool_loop_test",
      onCompletedResponse: (response) => rememberResponseState(firstRequest, response),
    }));
    flushResponseState();
    resetResponseStateMemoryForTests();

    const expanded = expandPreviousResponseInput({
      model: firstRequest.model,
      previous_response_id: "resp_tool_loop_test",
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }] },
        { type: "function_call_output", call_id: "call_read_1", output: "contents" },
      ],
    });
    const parsed = parseRequest(expanded);
    assert.deepEqual(parsed.tools.map((tool) => tool.name), ["read_file"]);
    const body = JSON.parse(buildApiKeyRequest("deepseek", parsed, "secret").body) as { messages: Array<Record<string, unknown>>; tools: unknown[] };
    assert.equal(body.tools.length, 1);
    assert.ok(body.messages.some((message) => Array.isArray(message.tool_calls)));
    assert.ok(body.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_read_1"));
  } finally {
    clearResponseStateForTests();
    if (previousDataDir === undefined) delete process.env.DEVIL_CODEX_USER_DATA;
    else process.env.DEVIL_CODEX_USER_DATA = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Anthropic parses a residual message_stop and fails closed on a truncated stream", async () => {
  const complete = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop"}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n");
  const completeEvents = await collect(streamAnthropic(new Response(complete, { headers: { "content-type": "text/event-stream" } })));
  assert.deepEqual(completeEvents.map((event) => event.type), ["text_delta", "done"]);

  const truncated = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n';
  const truncatedEvents = await collect(streamAnthropic(new Response(truncated, { headers: { "content-type": "text/event-stream" } })));
  const lastTruncated = truncatedEvents.at(-1);
  assert.equal(lastTruncated?.type, "error");
  assert.equal(lastTruncated?.type === "error" ? lastTruncated.errorType : undefined, "upstream_truncated_stream");
});

test("OpenAI-compatible streams buffer interleaved parallel calls and reject malformed EOF", async () => {
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"p":' } }, { index: 1, id: "b", function: { name: "list", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: "tool_calls" }] },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  const events = await collect(streamOpenAiCompatible("Provider", new Response(frames, { headers: { "content-type": "text/event-stream" } })));
  assert.deepEqual(events.filter((event) => event.type === "tool_call_start").map((event) => event.type === "tool_call_start" ? event.id : ""), ["a", "b"]);
  assert.equal(events.at(-1)?.type, "done");

  const malformed = await collect(streamOpenAiCompatible("Provider", new Response("data: {bad", { headers: { "content-type": "text/event-stream" } })));
  assert.equal(malformed.at(-1)?.type, "error");
});

test("Antigravity replay keys function calls by canonical arguments", () => {
  resetAntigravityReplayForTests();
  observeAntigravityReplayCall("gemini-3.5-flash-low", "session", "exec", { b: 2, a: 1 }, "ValidSignature1234567890==");
  const contents = [{ role: "model", parts: [{ functionCall: { name: "exec", args: { a: 1, b: 2 } } }] }];
  applyAntigravityReplay("gemini-3.5-flash-low", "session", contents);
  assert.equal((contents[0]!.parts[0] as Record<string, unknown>).thoughtSignature, "ValidSignature1234567890==");
});

function parsedCustomToolReplay(): OcxParsedRequest {
  return parsedRequest({
    model: "gemini-3.5-flash-low",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "apply the patch" }] },
      {
        type: "custom_tool_call",
        id: "ctc_74c2c8ff4a1b4a55a52358ebbe38f6a3",
        call_id: "qvv9vt5s",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch",
      },
      { type: "custom_tool_call_output", call_id: "qvv9vt5s", output: "invalid patch" },
    ],
  });
}

function parsedCustomToolCall(parsed: OcxParsedRequest) {
  const assistant = parsed.context.messages.find((message) => message.role === "assistant");
  return assistant?.content.find((part) => part.type === "toolCall");
}

function firstGoogleModelPart(parsed: OcxParsedRequest): Record<string, unknown> | undefined {
  const contents = googleContents(parsed) as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>;
  return contents.find((content) => content.role === "model")?.parts?.[0];
}

test("Responses item ids stay out of parsed custom tool signatures", () => {
  const call = parsedCustomToolCall(parsedCustomToolReplay());

  assert.equal(call?.type, "toolCall");
  if (call?.type === "toolCall") assert.equal(call.thoughtSignature, undefined);
});

test("Google contents reject synthetic Responses item ids as thought signatures", () => {
  for (const syntheticId of ["ctc_74c2c8ff4a1b4a55a52358ebbe38f6a3", "tsc_74c2c8ff4a1b4a55a52358ebbe38f6a3"]) {
    const parsed = parsedCustomToolReplay();
    const call = parsedCustomToolCall(parsed);
    if (call?.type === "toolCall") call.thoughtSignature = syntheticId;

    assert.equal(firstGoogleModelPart(parsed)?.thoughtSignature, undefined);
  }
});

test("Antigravity replay replaces synthetic Responses item ids with the cached signature", () => {
  resetAntigravityReplayForTests();
  observeAntigravityReplayCall(
    "gemini-3.5-flash-low",
    "session",
    "apply_patch",
    { input: "*** Begin Patch\n*** End Patch" },
    "ValidCustomToolSignature1234567890==",
  );
  for (const syntheticId of ["ctc_74c2c8ff4a1b4a55a52358ebbe38f6a3", "tsc_74c2c8ff4a1b4a55a52358ebbe38f6a3"]) {
    const contents = [{
      role: "model",
      parts: [{
        functionCall: { name: "apply_patch", args: { input: "*** Begin Patch\n*** End Patch" } },
        thoughtSignature: syntheticId,
      }],
    }];
    applyAntigravityReplay("gemini-3.5-flash-low", "session", contents);

    assert.equal(contents[0]!.parts[0]!.thoughtSignature, "ValidCustomToolSignature1234567890==");
  }
});
