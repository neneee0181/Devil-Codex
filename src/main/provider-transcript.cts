import { app } from "electron";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThreadActivityEntry, ThreadHistoryItem, ThreadSummary } from "./contracts.cjs";

type ProviderTurnMeta = {
  provider: string;
  model: string;
  startedAt: number;
  completedAt?: number;
  syncStatus?: "pending" | "synced" | "failed";
  syncError?: string;
};
type StoredShape = { items: Record<string, ThreadHistoryItem[]>; meta: Record<string, ThreadSummary>; providerTurns?: Record<string, ProviderTurnMeta[]>; recovered?: boolean };
type RolloutLine = { type?: string; timestamp?: string; payload?: Record<string, unknown> };

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
  const result = native.map((item) => {
    // Activity items: prefer local entries when they are richer.
    if (item.kind === "activity" && item.turnId) {
      const localAct = localActivityMap.get(item.turnId);
      usedTurnIds.add(item.turnId);
      if (localAct && localAct.activities && localAct.activities.length > 0) {
        if (!item.activities || item.activities.length < localAct.activities.length) {
          return { ...item, activities: localAct.activities };
        }
      }
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
  // Add activity items that exist in local but not in native at all.
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

  async append(threadId: string, item: ThreadHistoryItem): Promise<void> {
    await this.mutate((all) => { all.items[threadId] = [...(all.items[threadId] ?? []), item]; });
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
          ? { ...item, activities: exists ? activities.map((current) => current.id === entry.id ? entry : current) : [...activities, entry] }
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
      const base: ThreadSummary = all.meta[summary.id] ?? { id: summary.id, cwd: "", model: "", title: "새 채팅", preview: "", updatedAt: nowSeconds(), archived: false };
      const next = { ...base, ...summary };
      next.updatedAt = toUnixSeconds(next.updatedAt);
      all.meta[summary.id] = next;
    });
  }

  async recordProviderTurn(input: { threadId: string; provider: string; model: string }): Promise<void> {
    await this.mutate((all) => {
      all.providerTurns ??= {};
      all.providerTurns[input.threadId] = [...(all.providerTurns[input.threadId] ?? []), {
        provider: input.provider,
        model: input.model,
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
    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.path(), JSON.stringify(all), { mode: 0o600 });
  }

  private async load(): Promise<StoredShape> {
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as StoredShape | Record<string, ThreadHistoryItem[]>;
      if (parsed && typeof parsed === "object" && "items" in parsed && "meta" in parsed) {
        const shaped = parsed as StoredShape;
        shaped.providerTurns ??= {};
        for (const summary of Object.values(shaped.meta ?? {})) summary.updatedAt = toUnixSeconds(summary.updatedAt);
        return shaped;
      }
      return { items: parsed as Record<string, ThreadHistoryItem[]>, meta: {} }; // migrate legacy flat shape
    } catch {
      return { items: {}, meta: {}, providerTurns: {} };
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
