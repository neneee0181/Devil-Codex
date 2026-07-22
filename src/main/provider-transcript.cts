import { app } from "electron";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextUsage, ThreadActivityEntry, ThreadHistoryItem, ThreadSummary } from "./contracts.cjs";

type ProviderTurnMeta = {
  provider: string;
  model: string;
  accountId?: string;
  accountLabel?: string;
  startedAt: number;
  completedAt?: number;
  syncStatus?: "pending" | "synced" | "failed";
  syncError?: string;
};
type StoredShape = {
  items: Record<string, ThreadHistoryItem[]>;
  meta: Record<string, ThreadSummary>;
  providerTurns?: Record<string, ProviderTurnMeta[]>;
  deleted?: Record<string, number>;
  recovered?: boolean;
};
type RolloutLine = { type?: string; timestamp?: string; payload?: Record<string, unknown> };
function fileChangePathKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFileChangePath(left: string, right: string): boolean {
  if (left === right) return true;
  const leftAbsolute = /^(?:[A-Za-z]:\/|\/)/.test(left);
  const rightAbsolute = /^(?:[A-Za-z]:\/|\/)/.test(right);
  if (leftAbsolute === rightAbsolute) return false;
  const absolute = leftAbsolute ? left : right;
  const relativePath = leftAbsolute ? right : left;
  return Boolean(relativePath) && absolute.endsWith(`/${relativePath}`);
}

function dedupeFileChangeEntries(entries: ThreadActivityEntry[]): ThreadActivityEntry[] {
  const seenPaths: string[] = [];
  const kept: ThreadActivityEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "fileChange" || !entry.files?.length) {
      kept.push(entry);
      continue;
    }
    const files = entry.files.filter((file) => {
      const path = fileChangePathKey(file.path);
      if (!path || seenPaths.some((seen) => sameFileChangePath(path, seen))) return false;
      seenPaths.push(path);
      return true;
    });
    if (!files.length) continue;
    kept.push(files.length === entry.files.length ? entry : { ...entry, title: `파일 ${files.length}개 수정`, files });
  }
  return kept.reverse();
}

function mergeActivityEntriesPreferLocal(nativeEntries: ThreadActivityEntry[], localEntries: ThreadActivityEntry[]): ThreadActivityEntry[] {
  const localById = new Map(localEntries.map((entry) => [entry.id, entry]));
  const nativeIds = new Set(nativeEntries.map((entry) => entry.id));
  return dedupeFileChangeEntries([
    ...nativeEntries.map((entry) => localById.get(entry.id) ?? entry),
    ...localEntries.filter((entry) => !nativeIds.has(entry.id)),
  ]);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toUnixSeconds(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return nowSeconds();
  return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function mergeAttachmentMetadata(native: ThreadHistoryItem[], local: ThreadHistoryItem[]): ThreadHistoryItem[] {
  const localUsers = local.filter((item) => item.kind === "user" && item.attachments?.length);
  // Preserve activity entries (commands, file changes, MCP calls, etc.) from
  // the local transcript when native items lack them. The Codex app-server's
  // mapThreadHistory may drop or truncate activities; Devil saves them in full
  // on every turn through cacheThreadHistory. Always prefer local activities.
  const localActivityMap = new Map(
    local.filter((item) => item.kind === "activity" && item.turnId).map((item) => [item.turnId!, item])
  );
  const usedTurnIds = new Set<string>();
  let cursor = 0;
  let result = native.map((item) => {
    // Local activity entries carry Devil's latest same-id updates (including
    // reconciled final file diffs), regardless of the total entry count.
    if (item.kind === "activity" && item.turnId) {
      const localAct = localActivityMap.get(item.turnId);
      usedTurnIds.add(item.turnId);
      if (localAct?.activities?.length) return { ...item, activities: mergeActivityEntriesPreferLocal(item.activities ?? [], localAct.activities) };
      return item;
    }
    if (item.kind !== "user" || item.attachments?.length) return item;
    if (!localUsers.length) return item;
    // User messages: restore attachment metadata (image URLs, etc.).
    const matchIndex = localUsers.findIndex((candidate, index) => index >= cursor && candidate.text.trim() === item.text.trim());
    const match = matchIndex >= 0 ? localUsers[matchIndex] : localUsers[cursor];
    if (!match?.attachments?.length) return item;
    cursor = Math.max(cursor, matchIndex >= 0 ? matchIndex + 1 : cursor + 1);
    return { ...item, attachments: match.attachments };
  });
  // Add conversation/activity items that exist in local but not in native at all.
  // External-provider rollouts can be thinner than Devil's local transcript, and
  // dropping a local user item makes the completed work appear without the
  // prompt that started it.
  const hasEquivalent = (candidate: ThreadHistoryItem): boolean => result.some((item) => {
    if (item.id === candidate.id) return true;
    if (item.kind !== candidate.kind) return false;
    if (candidate.kind === "user") return item.text.trim() === candidate.text.trim() && (item.attachments?.length ?? 0) === (candidate.attachments?.length ?? 0);
    if (candidate.kind === "agent") return item.turnId === candidate.turnId && item.text.trim() === candidate.text.trim();
    if (candidate.kind === "system") return item.title === candidate.title && item.text.trim() === candidate.text.trim();
    return false;
  });
  for (const [localIndex, item] of local.entries()) {
    if (item.kind !== "user" && item.kind !== "agent" && item.kind !== "system") continue;
    if (hasEquivalent(item)) continue;
    let insertAt = result.length;
    for (let index = localIndex + 1; index < local.length; index += 1) {
      const next = local[index]!;
      const targetIndex = result.findIndex((current) => current.id === next.id || (
        current.kind === next.kind && current.text.trim() === next.text.trim() && current.turnId === next.turnId
      ));
      if (targetIndex >= 0) { insertAt = targetIndex; break; }
    }
    if (insertAt === result.length) {
      for (let index = localIndex - 1; index >= 0; index -= 1) {
        const previous = local[index]!;
        const targetIndex = result.findIndex((current) => current.id === previous.id || (
          current.kind === previous.kind && current.text.trim() === previous.text.trim() && current.turnId === previous.turnId
        ));
        if (targetIndex >= 0) { insertAt = targetIndex + 1; break; }
      }
    }
    result = [...result.slice(0, insertAt), item, ...result.slice(insertAt)];
  }
  for (const [turnId, act] of localActivityMap) {
    if (!usedTurnIds.has(turnId)) result.push(act);
  }
  return result;
}

// Keep a Devil-owned transcript copy for non-native providers. Proxy-backed
// threads use the app-server too, but its custom-provider history can be absent
// after restart while the local copy remains available for rendering.
export class ProviderTranscriptStore {
  private recovery?: Promise<void>;
  private writes = Promise.resolve();
  private cache: StoredShape | null = null;
  private dir(): string { return join(app.getPath("userData"), "providers"); }
  private path(): string { return join(this.dir(), "transcripts.json"); }

  async read(threadId: string): Promise<ThreadHistoryItem[]> {
    return (await this.load()).items[threadId] ?? [];
  }

  has(threadId: string, store?: StoredShape): boolean {
    return Boolean((store ?? null)?.meta?.[threadId]);
  }

  async isExternal(threadId: string): Promise<boolean> {
    const all = await this.load();
    const meta = all.meta[threadId] as (ThreadSummary & { provider?: string }) | undefined;
    return Boolean(meta?.provider || all.providerTurns?.[threadId]?.length);
  }

  async archive(threadId: string): Promise<void> {
    await this.mutate((all) => {
      const summary = all.meta[threadId];
      if (summary) all.meta[threadId] = { ...summary, archived: true, updatedAt: nowSeconds() };
    });
  }

  async unarchive(threadId: string): Promise<void> {
    await this.mutate((all) => {
      const summary = all.meta[threadId];
      if (summary) all.meta[threadId] = { ...summary, archived: false, updatedAt: nowSeconds() };
    });
  }

  async delete(threadId: string): Promise<void> {
    await this.mutate((all) => {
      all.deleted ??= {};
      all.deleted[threadId] = Date.now();
      delete all.meta[threadId];
      delete all.items[threadId];
      delete all.providerTurns?.[threadId];
    });
  }

  async append(threadId: string, item: ThreadHistoryItem): Promise<void> {
    await this.mutate((all) => { all.items[threadId] = [...(all.items[threadId] ?? []), item]; });
  }

  async upsertPartialAgent(threadId: string, itemId: string, partial: ThreadHistoryItem): Promise<void> {
    await this.mutate((all) => {
      const items = all.items[threadId] ?? [];
      const index = items.findIndex((item) => item.id === itemId);
      if (index >= 0) {
        const next = items.slice();
        next[index] = { ...items[index], ...partial, id: itemId };
        all.items[threadId] = next;
        return;
      }
      all.items[threadId] = [...items, partial];
    });
  }

  async setTurnContextUsage(threadId: string, turnId: string, contextUsage: ContextUsage): Promise<void> {
    await this.mutate((all) => {
      const items = all.items[threadId] ?? [];
      let updated = false;
      const next = items.map((item) => {
        if (!updated && item.turnId === turnId && item.kind === "agent") {
          updated = true;
          return { ...item, contextUsage };
        }
        return item;
      });
      if (updated) {
        all.items[threadId] = next;
        return;
      }
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const item = next[index];
        if (item?.turnId !== turnId) continue;
        next[index] = { ...item, contextUsage };
        all.items[threadId] = next;
        return;
      }
    });
  }

  async appendActivityEntry(threadId: string, turnId: string | undefined, entry: ThreadActivityEntry, status: ThreadHistoryItem["status"] = "completed"): Promise<void> {
    await this.mutate((all) => {
      const items = all.items[threadId] ?? [];
      let targetIndex = turnId ? items.findIndex((item) => item.kind === "activity" && item.turnId === turnId) : -1;
      if (targetIndex < 0 && !turnId) {
        for (let index = items.length - 1; index >= 0; index--) {
          if (items[index]?.kind === "activity") {
            targetIndex = index;
            break;
          }
        }
      }
      if (targetIndex >= 0) {
        const target = items[targetIndex]!;
        const activities = target.activities ?? [];
        const exists = activities.some((current) => current.id === entry.id);
        all.items[threadId] = items.map((item, index) => index === targetIndex
          ? { ...item, activities: dedupeFileChangeEntries(exists ? activities.map((current) => current.id === entry.id ? entry : current) : [...activities, entry]) }
          : item);
        return;
      }
      all.items[threadId] = [...items, { id: `activity-${turnId ?? entry.id}`, kind: "activity", text: "", ...(turnId ? { turnId } : {}), status, activities: [entry] }];
    });
  }

  async replaceHistory(threadId: string, items: ThreadHistoryItem[]): Promise<void> {
    await this.mutate((all) => { all.items[threadId] = items; });
  }

  async mergeHistoryPreservingAttachments(threadId: string, nativeItems: ThreadHistoryItem[]): Promise<ThreadHistoryItem[]> {
    let merged: ThreadHistoryItem[] = nativeItems;
    await this.mutate((all) => {
      merged = mergeAttachmentMetadata(nativeItems, all.items[threadId] ?? []);
      all.items[threadId] = merged;
    });
    return merged;
  }

  async saveMeta(summary: Partial<ThreadSummary> & { id: string }): Promise<void> {
    await this.mutate((all) => {
      if (all.deleted?.[summary.id]) return;
      const base: ThreadSummary = all.meta[summary.id] ?? { id: summary.id, cwd: "", model: "", title: "새 채팅", preview: "", updatedAt: nowSeconds(), archived: false };
      const next = { ...base, ...summary };
      next.updatedAt = toUnixSeconds(next.updatedAt);
      all.meta[summary.id] = next;
    });
  }

  async recordProviderTurn(input: { threadId: string; provider: string; model: string; accountId?: string; accountLabel?: string }): Promise<void> {
    await this.mutate((all) => {
      all.providerTurns ??= {};
      all.providerTurns[input.threadId] = [...(all.providerTurns[input.threadId] ?? []), {
        provider: input.provider,
        model: input.model,
        accountId: input.accountId,
        accountLabel: input.accountLabel,
        startedAt: Date.now(),
        syncStatus: "pending",
      }];
    });
  }

  async markLatestProviderTurnSync(threadId: string, status: "synced" | "failed", error?: string): Promise<void> {
    await this.mutate((all) => {
      const turns = all.providerTurns?.[threadId];
      const latest = turns?.at(-1);
      if (!latest) return;
      latest.completedAt = Date.now();
      latest.syncStatus = status;
      if (error) latest.syncError = error;
      else delete latest.syncError;
    });
  }

  async summaries(): Promise<ThreadSummary[]> {
    // The rollout directory can receive a new Devil thread after the stored
    // index was first created. Re-scan once per app launch, not once forever.
    this.recovery ??= this.mutate((all) => this.recoverDevilRollouts(all));
    await this.recovery;
    return this.readLatest((all) => Object.values(all.meta).sort((a, b) => b.updatedAt - a.updatedAt));
  }

  private async mutate(change: (all: StoredShape) => void | Promise<void>): Promise<void> {
    const run = this.writes.then(async () => {
      const all = await this.load();
      await change(all);
      await this.save(all);
    });
    this.writes = run.catch(() => undefined);
    await run;
  }

  private async readLatest<T>(read: (all: StoredShape) => T): Promise<T> {
    const run = this.writes.then(async () => read(await this.load()));
    this.writes = run.then(() => undefined, () => undefined);
    return run;
  }

  private async save(all: StoredShape): Promise<void> {
    this.cache = all;
    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.path(), JSON.stringify(all), { mode: 0o600 });
  }

  private async load(): Promise<StoredShape> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as StoredShape | Record<string, ThreadHistoryItem[]>;
      if (parsed && typeof parsed === "object" && "items" in parsed && "meta" in parsed) {
        const shaped = parsed as StoredShape;
        shaped.providerTurns ??= {};
        shaped.deleted ??= {};
        for (const summary of Object.values(shaped.meta ?? {})) summary.updatedAt = toUnixSeconds(summary.updatedAt);
        this.cache = shaped;
        return shaped;
      }
      this.cache = { items: parsed as Record<string, ThreadHistoryItem[]>, meta: {}, providerTurns: {}, deleted: {} };
      return this.cache; // migrate legacy flat shape
    } catch {
      this.cache = { items: {}, meta: {}, providerTurns: {}, deleted: {} };
      return this.cache;
    }
  }

  // Proxy-backed turns are written by Codex into ~/.codex/sessions. The native
  // thread/list API can omit those sessions after a restart, so import our own
  // rollouts once into Devil's durable sidebar index.
  private async recoverDevilRollouts(all: StoredShape): Promise<void> {
    const root = join(homedir(), ".codex", "sessions");
    try {
      const files = await this.rolloutFiles(root);
      for (const path of files) {
        let source = "";
        try { source = await readFile(path, "utf8"); } catch { continue; }
        const lines = source.split("\n").flatMap((line) => {
          try { return [JSON.parse(line) as RolloutLine]; } catch { return []; }
        });
        const meta = lines.find((line) => line.type === "session_meta")?.payload;
        if (meta?.originator !== "devil_codex" || meta.model_provider !== "devil") continue;
        const id = String(meta.id ?? "");
        const cwd = String(meta.cwd ?? "");
        if (all.deleted?.[id]) continue;
        if (!id || !cwd) continue;
        const history = this.historyFromRollout(lines, id);
        const firstUser = history.find((item) => item.kind === "user")?.text ?? "새 채팅";
        all.meta[id] = {
          id, cwd, model: String(meta.model ?? ""), title: all.meta[id]?.title || firstUser.slice(0, 60),
          preview: firstUser.slice(0, 80), updatedAt: toUnixSeconds(Date.parse(String(lines.at(-1)?.timestamp ?? ""))), archived: false,
        };
        if (history.length) all.items[id] = history;
      }
    } catch {
      // Session recovery is an optional compatibility bridge. New turns still
      // persist through saveMeta/replaceHistory even when Codex's folder is absent.
    }
    all.recovered = true;
  }

  private async rolloutFiles(dir: string, depth = 0): Promise<string[]> {
    if (depth > 4) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return this.rolloutFiles(path, depth + 1);
      return entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") ? [path] : [];
    }));
    return nested.flat();
  }

  private async jsonlFiles(dir: string, depth = 0): Promise<string[]> {
    if (depth > 5) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return this.jsonlFiles(path, depth + 1);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }));
    return nested.flat();
  }

  private historyFromRollout(lines: RolloutLine[], threadId: string): ThreadHistoryItem[] {
    return lines.flatMap((line, index) => {
      if (line.type !== "response_item") return [];
      const payload = line.payload ?? {};
      if (payload.type !== "message") return [];
      const role = String(payload.role ?? "");
      if (role !== "user" && role !== "assistant") return [];
      const text = ((payload.content as Array<Record<string, unknown>> | undefined) ?? [])
        .map((part) => String(part.text ?? part.text_value ?? "")).join("").trim();
      // Managed instruction payloads are not a user message in the conversation.
      if (!text || (role === "user" && text.startsWith("# AGENTS.md instructions"))) return [];
      return [{ id: `${threadId}-rollout-${index}`, kind: role === "user" ? "user" : "agent", text } satisfies ThreadHistoryItem];
    });
  }
}
