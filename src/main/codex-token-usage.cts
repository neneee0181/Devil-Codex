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
  const reasoningOutputTokens = finiteNumber(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens);
  return positiveUsage({
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    totalTokens,
  });
}

function tokenSnapshotFromPayload(payload: RawItem): TokenSnapshot | undefined {
  if (String(payload.type ?? "") !== "token_count") return undefined;
  const info = (payload.info ?? {}) as RawItem;
  const lastUsage = tokenUsageFromRaw(info.lastTokenUsage ?? info.last_token_usage);
  const cumulativeUsage = tokenUsageFromRaw(info.totalTokenUsage ?? info.total_token_usage);
  const maxTokens = finiteNumber(payload.modelContextWindow ?? payload.model_context_window);
  const usedTokens = lastUsage ? lastUsage.totalTokens ?? lastUsage.inputTokens + lastUsage.outputTokens : undefined;
  const contextUsage = usedTokens && maxTokens ? { usedTokens, maxTokens } : undefined;
  if (!lastUsage && !cumulativeUsage && !contextUsage) return undefined;
  return { ...(lastUsage ? { lastUsage } : {}), ...(cumulativeUsage ? { cumulativeUsage } : {}), ...(contextUsage ? { contextUsage } : {}) };
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
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RawItem;
      if (parsed.type !== "event_msg") continue;
      const payload = parsed.payload;
      if (!payload || typeof payload !== "object") continue;
      latest = tokenSnapshotFromPayload(payload as RawItem) ?? latest;
    } catch {
      // Ignore partial or legacy rollout lines; token usage is best-effort.
    }
  }
  return latest;
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
