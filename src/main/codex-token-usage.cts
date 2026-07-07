import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexHome } from "./codex-home.cjs";
import type { ContextUsage, ProviderTokenUsage, ThreadHistoryItem } from "./contracts.cjs";

const STATE_DB_PATH = join(codexHome(), "state_5.sqlite");

type RawItem = Record<string, unknown>;
type ThreadRow = { rollout_path: string };
type TokenSnapshot = {
  lastUsage?: ProviderTokenUsage;
  cumulativeUsage?: ProviderTokenUsage;
  contextUsage?: ContextUsage;
};
type RolloutFinalAnswer = { id: string; turnId: string; text: string };

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function positiveUsage(usage: ProviderTokenUsage): ProviderTokenUsage | undefined {
  const total = usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
  return total > 0 ? { ...usage, totalTokens: total } : undefined;
}

function tokenUsageFromRaw(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as RawItem;
  const inputTokens = finiteNumber(raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens) ?? 0;
  const outputTokens = finiteNumber(raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens) ?? 0;
  const totalTokens = finiteNumber(raw.totalTokens ?? raw.total_tokens) ?? inputTokens + outputTokens;
  const cachedInputTokens = finiteNumber(raw.cachedInputTokens ?? raw.cached_input_tokens);
  const cacheReadInputTokens = finiteNumber(raw.cacheReadInputTokens ?? raw.cache_read_input_tokens);
  const cacheCreationInputTokens = finiteNumber(raw.cacheCreationInputTokens ?? raw.cache_creation_input_tokens);
  const reasoningOutputTokens = finiteNumber(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens);
  const cacheMissReason = typeof (raw.cacheMissReason ?? raw.cache_miss_reason) === "string"
    ? String(raw.cacheMissReason ?? raw.cache_miss_reason)
    : undefined;
  const cacheMissedInputTokens = finiteNumber(raw.cacheMissedInputTokens ?? raw.cache_missed_input_tokens);
  return positiveUsage({
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(cacheMissReason ? { cacheMissReason } : {}),
    ...(cacheMissedInputTokens !== undefined ? { cacheMissedInputTokens } : {}),
    totalTokens,
  });
}

function tokenSnapshotFromPayload(payload: RawItem, fallbackMaxTokens?: number): TokenSnapshot | undefined {
  if (String(payload.type ?? "") !== "token_count") return undefined;
  const info = (payload.info ?? {}) as RawItem;
  const lastUsage = tokenUsageFromRaw(info.lastTokenUsage ?? info.last_token_usage);
  const cumulativeUsage = tokenUsageFromRaw(info.totalTokenUsage ?? info.total_token_usage);
  const maxTokens = finiteNumber(payload.modelContextWindow ?? payload.model_context_window) ?? fallbackMaxTokens;
  const usedTokens = lastUsage ? lastUsage.totalTokens ?? lastUsage.inputTokens + lastUsage.outputTokens : undefined;
  const contextUsage = usedTokens && maxTokens ? { usedTokens, maxTokens } : undefined;
  if (!lastUsage && !cumulativeUsage && !contextUsage) return undefined;
  return { ...(lastUsage ? { lastUsage } : {}), ...(cumulativeUsage ? { cumulativeUsage } : {}), ...(contextUsage ? { contextUsage } : {}) };
}

function messageText(payload: RawItem): string {
  if (typeof payload.message === "string") return payload.message.trim();
  if (typeof payload.text === "string") return payload.text.trim();
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is RawItem => Boolean(part) && typeof part === "object")
    .map((part) => String(part.text ?? part.output_text ?? ""))
    .join("")
    .trim();
}

function finalAnswerFromPayload(rowType: string, payload: RawItem, fallbackIndex: number): RolloutFinalAnswer | undefined {
  const type = String(payload.type ?? "");
  const phase = String(payload.phase ?? "");
  const role = String(payload.role ?? "");
  const isFinalMessage = rowType === "response_item" && type === "message" && phase === "final_answer" && (!role || role === "assistant");
  const isLegacyFinal = rowType === "event_msg" && type === "agent_message" && phase === "final_answer";
  if (!isFinalMessage && !isLegacyFinal) return undefined;
  const passthrough = (payload.internal_chat_message_metadata_passthrough ?? {}) as RawItem;
  const turnId = String(passthrough.turn_id ?? passthrough.turnId ?? payload.turn_id ?? payload.turnId ?? "");
  const text = messageText(payload);
  if (!turnId || !text) return undefined;
  return {
    id: String(payload.id ?? `rollout-final-${turnId}-${fallbackIndex}`),
    turnId,
    text,
  };
}

function rolloutPathForThread(threadId: string): string | undefined {
  if (!existsSync(STATE_DB_PATH)) return undefined;
  const db = new DatabaseSync(STATE_DB_PATH, { readOnly: true });
  try {
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
    return row?.rollout_path || undefined;
  } finally {
    db.close();
  }
}

export async function readCodexTokenSnapshot(threadId: string): Promise<TokenSnapshot | undefined> {
  const rolloutPath = rolloutPathForThread(threadId);
  if (!rolloutPath || !existsSync(rolloutPath)) return undefined;
  const source = await readFile(rolloutPath, "utf8").catch(() => "");
  let latest: TokenSnapshot | undefined;
  let latestMaxTokens: number | undefined;
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RawItem;
      if (parsed.type !== "event_msg") continue;
      const payload = parsed.payload;
      if (!payload || typeof payload !== "object") continue;
      const rawPayload = payload as RawItem;
      latestMaxTokens = finiteNumber(rawPayload.modelContextWindow ?? rawPayload.model_context_window) ?? latestMaxTokens;
      latest = tokenSnapshotFromPayload(rawPayload, latestMaxTokens) ?? latest;
    } catch {
      // Ignore partial or legacy rollout lines; token usage is best-effort.
    }
  }
  return latest;
}

export async function readRolloutFinalAnswers(threadId: string): Promise<RolloutFinalAnswer[]> {
  const rolloutPath = rolloutPathForThread(threadId);
  if (!rolloutPath || !existsSync(rolloutPath)) return [];
  const source = await readFile(rolloutPath, "utf8").catch(() => "");
  const answers: RolloutFinalAnswer[] = [];
  let index = 0;
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    index += 1;
    try {
      const parsed = JSON.parse(line) as RawItem;
      const payload = parsed.payload;
      if (!payload || typeof payload !== "object") continue;
      const answer = finalAnswerFromPayload(String(parsed.type ?? ""), payload as RawItem, index);
      if (answer) answers.push(answer);
    } catch {
      // Ignore partial rollout lines; final-answer recovery is best-effort.
    }
  }
  return answers;
}

export async function attachRolloutFinalAnswers(threadId: string, items: ThreadHistoryItem[]): Promise<ThreadHistoryItem[]> {
  const answers = await readRolloutFinalAnswers(threadId);
  if (!answers.length) return items;
  let next = [...items];
  for (const answer of answers) {
    const alreadyRendered = next.some((item) => item.kind === "agent" && item.turnId === answer.turnId && item.text.trim());
    if (alreadyRendered) continue;
    const agent: ThreadHistoryItem = { id: answer.id, kind: "agent", text: answer.text, turnId: answer.turnId };
    let insertAt = -1;
    for (let index = 0; index < next.length; index += 1) {
      if (next[index].turnId === answer.turnId) insertAt = index;
    }
    if (insertAt >= 0) next = [...next.slice(0, insertAt + 1), agent, ...next.slice(insertAt + 1)];
    else next = [...next, agent];
  }
  return next;
}

export function attachCodexTokenSnapshot(items: ThreadHistoryItem[], snapshot: TokenSnapshot | undefined): ThreadHistoryItem[] {
  if (!snapshot?.lastUsage && !snapshot?.cumulativeUsage && !snapshot?.contextUsage) return items;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== "activity") continue;
    return items.map((current, currentIndex) => currentIndex === index
      ? {
          ...current,
          ...(snapshot.contextUsage ? { contextUsage: snapshot.contextUsage } : {}),
          ...(snapshot.lastUsage ? { tokenUsage: snapshot.lastUsage } : {}),
          ...(snapshot.cumulativeUsage ? { cumulativeTokenUsage: snapshot.cumulativeUsage } : {}),
        }
      : current);
  }
  return items;
}
