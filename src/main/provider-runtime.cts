import type { AppServerEvent, ProviderId } from "./contracts.cjs";
import { apiProviderConfig, apiProviderUrl, ProviderSettingsStore } from "./provider-settings.cjs";
import { claudeChat, copilotChat } from "./provider-oauth.cjs";
import { providerErrorMessage, providerRuntimeErrorMessage } from "./proxy/errors.cjs";

type ExternalProvider = Exclude<ProviderId, "codex">;
type ProviderTurn = {
  provider: ExternalProvider;
  model: string;
  accountId?: string;
  threadId: string;
  text: string;
  onDelta?: (delta: string) => void;
  onCompleted?: (text: string) => Promise<void> | void;
  onFailed?: (error: unknown) => Promise<void> | void;
};
type Emit = (event: AppServerEvent) => void;

function providerLabel(provider: ExternalProvider): string {
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
  if (provider === "moonshot") return "Moonshot Kimi";
  if (provider === "huggingface") return "Hugging Face";
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "ollama") return "Ollama";
  if (provider === "vllm") return "vLLM";
  if (provider === "lm-studio") return "LM Studio";
  return provider;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/(x-api-key\s*[:=]\s*)[^\s"']+/gi, "$1[redacted]")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted-api-key]")
    .replace(/\b([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g, "[redacted-token]");
}

async function readSse(response: Response, provider: string, onData: (payload: Record<string, unknown>) => void): Promise<void> {
  if (!response.ok) throw new Error(redactSensitiveText(providerErrorMessage(provider, response.status, await response.text())));
  if (!response.body) throw new Error("Provider가 스트리밍 응답을 반환하지 않았습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const records = buffer.split(/\r?\n\r?\n/);
    buffer = records.pop() ?? "";
    for (const record of records) {
      const data = record.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
      const error = parsed.error as Record<string, unknown> | undefined;
      if (error) throw new Error(redactSensitiveText(providerRuntimeErrorMessage(provider, String(error.message ?? error.code ?? error.type ?? "스트림 오류"))));
      onData(parsed);
    }
  }
}

function delta(provider: ExternalProvider, event: Record<string, unknown>): string {
  if (provider === "openai") return String(event.delta ?? "");
  if (provider === "anthropic" || provider === "claude-code") return String((event.delta as Record<string, unknown> | undefined)?.text ?? "");
  if (provider === "google" || provider === "antigravity") {
    const candidate = (event.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const parts = (candidate?.content as Record<string, unknown> | undefined)?.parts;
    return Array.isArray(parts) ? parts.map((part) => String((part as Record<string, unknown>).text ?? "")).join("") : "";
  }
  return String(((event.choices as Array<Record<string, unknown>> | undefined)?.[0]?.delta as Record<string, unknown> | undefined)?.content ?? "");
}

export class ProviderRuntime {
  private active = new Map<string, AbortController>();
  constructor(private readonly settings: ProviderSettingsStore, private readonly emit: Emit) {}

  async send(input: ProviderTurn): Promise<string> {
    if (this.active.has(input.threadId)) throw new Error("이 채팅은 이미 Provider 응답을 생성 중입니다.");
    const controller = new AbortController();
    this.active.set(input.threadId, controller);
    const turnId = `provider-${crypto.randomUUID()}`;
    const itemId = `provider-message-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    let text = "";
    this.emit({ method: "turn/started", params: { threadId: input.threadId, turnId, turn: { id: turnId, startedAt: startedAt / 1000 } } });
    try {
      const response = await this.dispatch(input, controller.signal);
      const label = providerLabel(input.provider);
      await readSse(response, label, (event) => {
        const next = delta(input.provider, event);
        if (!next) return;
        text += next;
        input.onDelta?.(next);
        this.emit({ method: "item/agentMessage/delta", params: { threadId: input.threadId, turnId, itemId, delta: next } });
      });
      if (!text.trim()) throw new Error("Provider가 빈 응답을 반환했습니다. 모델이 계정에서 지원되지 않거나, 로그인/권한/컨텍스트 호환성 문제가 있을 수 있습니다.");
      await Promise.resolve(input.onCompleted?.(text)).catch(() => undefined);
      this.emit({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: itemId, type: "agentMessage", text } } });
      this.emit({ method: "turn/completed", params: { threadId: input.threadId, turnId, turn: { id: turnId, status: "completed", durationMs: Date.now() - startedAt } } });
      return text;
    } catch (error) {
      await Promise.resolve(input.onFailed?.(error)).catch(() => undefined);
      const status = controller.signal.aborted ? "interrupted" : "failed";
      const errorText = controller.signal.aborted ? "Provider 응답을 중지했습니다." : redactSensitiveText(providerRuntimeErrorMessage(providerLabel(input.provider), error));
      this.emit({ method: "item/completed", params: { threadId: input.threadId, turnId, item: { id: `provider-error-${turnId}`, type: "error", message: errorText, status } } });
      this.emit({ method: "turn/completed", params: { threadId: input.threadId, turnId, turn: { id: turnId, status, durationMs: Date.now() - startedAt } } });
      throw new Error(errorText);
    } finally {
      this.active.delete(input.threadId);
    }
  }

  interrupt(threadId: string): boolean {
    const controller = this.active.get(threadId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async dispatch(input: ProviderTurn, signal: AbortSignal): Promise<Response> {
    if (input.provider === "copilot") return copilotChat(input.model, input.text, signal, input.accountId);
    if (input.provider === "claude-code") return claudeChat(input.model, input.text, signal, input.accountId);
    const key = await this.settings.readApiKey(input.provider, input.accountId);
    return this.request(input, key, signal);
  }

  private request(input: ProviderTurn, key: string, signal: AbortSignal): Promise<Response> {
    const config = apiProviderConfig(input.provider);
    if (!config) throw new Error(`지원하지 않는 Provider입니다: ${input.provider}`);
    if (config.adapter === "anthropic") return fetch(apiProviderUrl(input.provider, "/v1/messages"), { method: "POST", signal, headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: input.model, max_tokens: 4096, stream: true, messages: [{ role: "user", content: input.text }] }) });
    if (config.adapter === "google") return fetch(`${apiProviderUrl(input.provider, `/v1beta/models/${encodeURIComponent(input.model)}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(key)}`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: input.text }] }] }) });
    return fetch(apiProviderUrl(input.provider, "/chat/completions"), { method: "POST", signal, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify({ model: input.model, stream: true, messages: [{ role: "user", content: input.text }] }) });
  }
}
