import { app } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadActivityEntry, ThreadHistoryItem } from "./contracts.cjs";

// Persist the renderer's live-built timeline per thread so a restart can restore
// the rich structure (work activities + final answer outside) even when the
// app-server's rollout reconstruction yields fewer activity entries.
export class ThreadHistoryCache {
  private dir(): string { return join(app.getPath("userData"), "history-cache"); }
  private file(id: string): string { return join(this.dir(), `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`); }

  async save(id: string, items: ThreadHistoryItem[]): Promise<void> {
    try {
      await mkdir(this.dir(), { recursive: true });
      await writeFile(this.file(id), JSON.stringify(items), "utf8");
    } catch { /* best-effort */ }
  }

  async load(id: string): Promise<ThreadHistoryItem[] | null> {
    try { return JSON.parse(await readFile(this.file(id), "utf8")) as ThreadHistoryItem[]; }
    catch { return null; }
  }
}

// Count activity entries so we can prefer the richer of (rollout, cache).
export function activityCount(items: ThreadHistoryItem[]): number {
  let n = 0;
  for (const item of items) n += item.activities?.length ?? 0;
  return n;
}

function hasCompactionActivity(item: ThreadHistoryItem): boolean {
  return item.activities?.some((activity) => activity.kind === "compaction") ?? false;
}

function mergeCompactionActivities(native: ThreadHistoryItem, cached: ThreadHistoryItem): ThreadHistoryItem {
  const activities = [...(native.activities ?? [])];
  for (const entry of cached.activities ?? []) {
    if (entry.kind !== "compaction") continue;
    const exists = activities.some((current) => current.kind === "compaction" && current.id === entry.id);
    if (!exists) activities.push(entry);
  }
  return { ...native, activities };
}

function mergeActivityEntriesPreferCached(nativeEntries: ThreadActivityEntry[], cachedEntries: ThreadActivityEntry[]): ThreadActivityEntry[] {
  const cachedById = new Map(cachedEntries.map((entry) => [entry.id, entry]));
  const nativeIds = new Set(nativeEntries.map((entry) => entry.id));
  return [
    ...nativeEntries.map((entry) => cachedById.get(entry.id) ?? entry),
    ...cachedEntries.filter((entry) => !nativeIds.has(entry.id)),
  ];
}

function isRuntimeShareItem(item: ThreadHistoryItem): boolean {
  return item.kind === "system" && (item.title === "런타임 공유" || item.title === "런타임 공유 컨텍스트");
}

function normalizedText(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedUserText(value: string | undefined): string {
  return normalizedText(String(value ?? "").replace(/\n+첨부 파일:\s*(?:\n- [^\n]+)+\s*$/m, ""));
}

function itemMergeKey(item: ThreadHistoryItem): string {
  if (item.kind === "user") return `user:${normalizedUserText(item.text)}`;
  if (item.kind === "agent") return `agent:${item.turnId ?? ""}:${normalizedText(item.text)}`;
  if (item.kind === "system") return `system:${item.title ?? ""}:${normalizedText(item.text)}`;
  if (item.kind === "activity" && item.turnId) return `activity:${item.turnId}`;
  return item.id;
}

function containsEquivalent(items: ThreadHistoryItem[], item: ThreadHistoryItem): boolean {
  const key = itemMergeKey(item);
  return items.some((current) => current.id === item.id || itemMergeKey(current) === key);
}

function insertMissingCachedItems(native: ThreadHistoryItem[], cached: ThreadHistoryItem[]): ThreadHistoryItem[] {
  let merged = [...native];
  const cacheKey = (item: ThreadHistoryItem): string => `${item.id}:${itemMergeKey(item)}`;
  for (const item of cached) {
    if (item.kind !== "user" && item.kind !== "agent" && item.kind !== "system") continue;
    if (containsEquivalent(merged, item)) continue;
    const cachedIndex = cached.indexOf(item);
    let insertAt = merged.length;
    for (let index = cachedIndex + 1; index < cached.length; index += 1) {
      const next = cached[index]!;
      const targetIndex = merged.findIndex((current) => current.id === next.id || itemMergeKey(current) === itemMergeKey(next));
      if (targetIndex >= 0) { insertAt = targetIndex; break; }
    }
    if (insertAt === merged.length) {
      for (let index = cachedIndex - 1; index >= 0; index -= 1) {
        const previous = cached[index]!;
        const targetIndex = merged.findIndex((current) => current.id === previous.id || itemMergeKey(current) === itemMergeKey(previous));
        if (targetIndex >= 0) { insertAt = targetIndex + 1; break; }
      }
    }
    merged = [...merged.slice(0, insertAt), { ...item, id: item.id || cacheKey(item) }, ...merged.slice(insertAt)];
  }
  return merged;
}

// Exported: provider-transcript-backed threads (Claude Code runtime, external
// providers) reuse this on read so previously cached raw delegate cards render
// as subagent activities there too.
export function normalizeCachedDelegateSubagents(items: ThreadHistoryItem[]): ThreadHistoryItem[] {
  return items.map((item) => {
    if (item.kind !== "activity" || !item.activities?.length) return item;
    const activities = item.activities.map((entry) => {
      const agentThreadId = entry.detail?.match(/^threadId:\s*([^\s]+)/m)?.[1] ?? "";
      const provider = entry.detail?.match(/^provider:\s*([^\n]+)/m)?.[1]?.trim();
      const model = entry.detail?.match(/^model:\s*([^\n]+)/m)?.[1]?.trim();
      if (entry.kind === "subagent" && entry.subagent?.agentThreadId) {
        return {
          ...entry,
          subagent: {
            ...entry.subagent,
            role: entry.subagent.role ?? provider ?? "subagent",
            nickname: entry.subagent.nickname ?? provider,
            model: entry.subagent.model ?? model,
          },
        };
      }
      // Codex titles the raw card "delegate_subagent 실행"; the Claude Agent SDK
      // prefixes MCP tools, yielding "mcp__devil_subagent__delegate_subagent 실행".
      if (entry.kind !== "mcp" || !/(?:^|__)delegate_subagent 실행$/.test(entry.title ?? "") || !agentThreadId) return entry;
      return {
        ...entry,
        kind: "subagent" as const,
        title: provider || model ? `하위 에이전트: ${[provider, model].filter(Boolean).join(" · ")}` : "하위 에이전트",
        subagent: { agentThreadId, source: "thread_spawn" as const, role: provider || "subagent", nickname: provider || undefined, model },
      };
    });
    return { ...item, activities };
  });
}

export function mergeCachedActivities(native: ThreadHistoryItem[], cached: ThreadHistoryItem[] | null): ThreadHistoryItem[] {
  if (!cached?.length) return native;
  cached = normalizeCachedDelegateSubagents(cached);
  const cachedByTurnId = new Map<string, ThreadHistoryItem>();
  const standaloneCompactions: ThreadHistoryItem[] = [];
  const runtimeShareItems = cached.filter(isRuntimeShareItem);
  for (const item of cached) {
    if (item.kind === "activity" && item.turnId) cachedByTurnId.set(item.turnId, item);
    else if (item.kind === "activity" && hasCompactionActivity(item)) standaloneCompactions.push(item);
  }
  const hasCachedConversationItems = cached.some((item) => item.kind === "user" || item.kind === "agent" || item.kind === "system");
  if (!cachedByTurnId.size && !standaloneCompactions.length && !runtimeShareItems.length && !hasCachedConversationItems) return native;
  const nativeHasConversationItems = native.some((item) => item.kind === "user" || item.kind === "agent" || item.kind === "system");

  const nativeTurnIds = new Set<string>();
  const merged = native.map((item) => {
    if (item.kind !== "activity" || !item.turnId) return item;
    nativeTurnIds.add(item.turnId);
    const richer = cachedByTurnId.get(item.turnId);
    if (!richer) return item;
    if (!richer.activities?.length) return item;
    return { ...richer, ...item, activities: mergeActivityEntriesPreferCached(item.activities ?? [], richer.activities) };
  });

  for (const item of cachedByTurnId.values()) {
    if (item.turnId && !nativeTurnIds.has(item.turnId)) merged.push(item);
  }
  for (const item of standaloneCompactions) {
    const exists = merged.some((current) => current.id === item.id || current.activities?.some((activity) => item.activities?.some((entry) => entry.kind === "compaction" && activity.kind === "compaction" && activity.id === entry.id)));
    if (!exists) merged.push(item);
  }
  for (let index = runtimeShareItems.length - 1; index >= 0; index -= 1) {
    const item = runtimeShareItems[index]!;
    if (!merged.some((current) => current.id === item.id || (current.kind === "system" && current.title === item.title && current.text === item.text))) {
      merged.unshift(item);
    }
  }
  return nativeHasConversationItems ? merged : insertMissingCachedItems(merged, cached);
}
