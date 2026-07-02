import { app } from "electron";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ThreadActivityEntry, ThreadHistoryItem, ThreadSummary } from "./contracts.cjs";

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
type ClaudeJsonLine = {
  type?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  version?: string;
  content?: unknown;
  attachment?: { content?: unknown; stdout?: unknown; command?: unknown };
  message?: { role?: string; content?: unknown };
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toUnixSeconds(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return nowSeconds();
  return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function compactText(text: string, fallback: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, maxLength);
}

function claudeTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    .filter((part) => String(part.type ?? "") === "text")
    .map((part) => String(part.text ?? ""))
    .join("")
    .trim();
}

function claudeContentParts(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object");
}

function claudeHasToolUse(content: unknown): boolean {
  return claudeContentParts(content).some((part) => String(part.type ?? "") === "tool_use");
}

function isClaudeLocalCommandText(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("<local-command-caveat>")
    || normalized.startsWith("<command-name>")
    || normalized.startsWith("<command-message>")
    || normalized.startsWith("<local-command-stdout>")
    || normalized.startsWith("<local-command-stderr>");
}

function isClaudeHookNoiseText(text: string): boolean {
  const normalized = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return normalized.startsWith("CAVEMAN MODE ACTIVE")
    || normalized.startsWith("STATUSLINE SETUP NEEDED:")
    || /Loading caveman mode/i.test(normalized);
}

function isClaudeToolResultOnly(content: unknown): boolean {
  const parts = claudeContentParts(content);
  return parts.length > 0 && parts.every((part) => String(part.type ?? "") === "tool_result");
}

function hasClaudeImportNoise(items: ThreadHistoryItem[]): boolean {
  return items.some((item) => {
    if (item.kind === "user" && isClaudeLocalCommandText(item.text)) return true;
    if (item.kind === "activity" && item.id.startsWith("activity-") && !item.turnId?.startsWith("claude-")) return true;
    return false;
  });
}

function claudeLineTime(line: ClaudeJsonLine): number {
  const parsed = Date.parse(String(line.timestamp ?? ""));
  return Number.isFinite(parsed) ? toUnixSeconds(parsed) : 0;
}

function claudeLineText(line: ClaudeJsonLine): string {
  const messageText = claudeTextContent(line.message?.content);
  if (messageText) return messageText;
  if (typeof line.content === "string") return line.content.trim();
  const attachment = line.attachment;
  const attachmentText = typeof attachment?.content === "string" ? attachment.content : typeof attachment?.stdout === "string" ? attachment.stdout : "";
  return attachmentText.trim();
}

function claudeSessionFallbackText(lines: ClaudeJsonLine[]): string {
  const leafUuid = String((lines.find((line) => line.type === "last-prompt") as Record<string, unknown> | undefined)?.leafUuid ?? "");
  const leafText = leafUuid ? claudeLineText(lines.find((line) => line.uuid === leafUuid) ?? {}) : "";
  if (leafText && !isClaudeLocalCommandText(leafText) && !isClaudeHookNoiseText(leafText)) return leafText;
  for (const line of lines) {
    const text = claudeLineText(line);
    if (!text) continue;
    if (/resume cancelled/i.test(text)) continue;
    if (/^(Kept model as|Set model to)/i.test(text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim())) continue;
    if (isClaudeLocalCommandText(text)) continue;
    if (isClaudeHookNoiseText(text)) continue;
    return text;
  }
  return "";
}

async function normalizeClaudeEntrypointFile(path: string, source: string): Promise<string> {
  if (!source.includes('"entrypoint":"sdk-cli"')) return source;
  const next = source.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    try {
      const parsed = JSON.parse(line) as { entrypoint?: unknown };
      if (parsed.entrypoint === "sdk-cli") parsed.entrypoint = "cli";
      return JSON.stringify(parsed);
    } catch {
      return line;
    }
  }).join("\n");
  if (next !== source) await writeFile(path, next, "utf8").catch(() => undefined);
  return next;
}

function cwdFromClaudeProjectPath(path: string): string {
  const projectKey = basename(dirname(path));
  const windows = /^([A-Za-z])--(.+)$/.exec(projectKey);
  if (windows) return `${windows[1]}:\\${windows[2]!.split("-").filter(Boolean).join("\\")}`;
  if (projectKey.startsWith("-")) return `/${projectKey.slice(1).split("-").filter(Boolean).join("/")}`;
  return "";
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
  private dir(): string { return join(app.getPath("userData"), "providers"); }
  private path(): string { return join(this.dir(), "transcripts.json"); }

  async read(threadId: string): Promise<ThreadHistoryItem[]> {
    await this.importClaudeProjects();
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
    await this.importClaudeProjects();
    return this.readLatest((all) => Object.values(all.meta).sort((a, b) => b.updatedAt - a.updatedAt));
  }

  private async importClaudeProjects(): Promise<void> {
    await this.mutate((all) => this.recoverClaudeProjects(all));
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
        shaped.deleted ??= {};
        for (const summary of Object.values(shaped.meta ?? {})) summary.updatedAt = toUnixSeconds(summary.updatedAt);
        return shaped;
      }
      return { items: parsed as Record<string, ThreadHistoryItem[]>, meta: {}, providerTurns: {}, deleted: {} }; // migrate legacy flat shape
    } catch {
      return { items: {}, meta: {}, providerTurns: {}, deleted: {} };
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

  private async recoverClaudeProjects(all: StoredShape): Promise<void> {
    const root = join(homedir(), ".claude", "projects");
    let files: string[] = [];
    try { files = await this.jsonlFiles(root); }
    catch { return; }
    const nativeSessionToThreadId = new Map<string, string>();
    for (const [id, summary] of Object.entries(all.meta)) {
      if (summary.claudeSessionId) nativeSessionToThreadId.set(summary.claudeSessionId, id);
    }
    for (const path of files) {
      const sessionId = basename(path).replace(/\.jsonl$/i, "");
      const threadId = nativeSessionToThreadId.get(sessionId) ?? sessionId;
      if (all.deleted?.[threadId]) continue;
      let source = "";
      try { source = await readFile(path, "utf8"); } catch { continue; }
      source = await normalizeClaudeEntrypointFile(path, source);
      const lines = source.split(/\r?\n/).flatMap((line) => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line) as ClaudeJsonLine]; } catch { return []; }
      }).filter((line) => line.sessionId === sessionId && !line.isSidechain);
      const history = this.historyFromClaudeLines(lines, threadId);
      if (!history.length && all.deleted?.[threadId]) continue;
      const cwd = lines.find((line) => typeof line.cwd === "string" && line.cwd)?.cwd ?? all.meta[threadId]?.cwd ?? cwdFromClaudeProjectPath(path);
      if (!cwd) continue;
      const fallbackText = claudeSessionFallbackText(lines);
      const firstUser = history.find((item) => item.kind === "user")?.text || fallbackText || "새 Claude Code 채팅";
      const lastUser = [...history].reverse().find((item) => item.kind === "user")?.text || fallbackText || firstUser;
      const updatedAt = Math.max(...lines.map(claudeLineTime), all.meta[threadId]?.updatedAt ?? 0) || nowSeconds();
      const existing = all.items[threadId] ?? [];
      if (history.length && (history.length >= existing.length || hasClaudeImportNoise(existing))) all.items[threadId] = history;
      else all.items[threadId] ??= [];
      all.meta[threadId] = {
        ...all.meta[threadId],
        id: threadId,
        cwd,
        model: all.meta[threadId]?.model || "sonnet",
        runtime: "claude-code",
        provider: "claude-code",
        claudeSessionId: sessionId,
        title: all.meta[threadId]?.title && all.meta[threadId]?.title !== "새 Claude Code 채팅" && !isClaudeHookNoiseText(all.meta[threadId]!.title) ? all.meta[threadId]!.title : compactText(firstUser, "새 Claude Code 채팅", 60),
        preview: compactText(lastUser, "", 80),
        updatedAt,
        archived: all.meta[threadId]?.archived ?? false,
      };
    }
  }

  private historyFromClaudeLines(lines: ClaudeJsonLine[], threadId: string): ThreadHistoryItem[] {
    const items: ThreadHistoryItem[] = [];
    let turnIndex = 0;
    let currentTurnId = "";

    const ensureActivity = (turnId: string, entry: ThreadActivityEntry): void => {
      const index = items.findIndex((item) => item.kind === "activity" && item.turnId === turnId);
      if (index >= 0) {
        const current = items[index]!;
        const activities = current.activities ?? [];
        if (activities.some((activity) => activity.id === entry.id)) return;
        items[index] = { ...current, activities: [...activities, entry] };
        return;
      }
      items.push({ id: `activity-${turnId}`, kind: "activity", text: "", turnId, status: "completed", activities: [entry] });
    };

    const nextRealUserIndex = (start: number): number => {
      for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        const role = String(line.message?.role ?? line.type);
        if (role !== "user") continue;
        const text = claudeTextContent(line.message?.content);
        if (text && !isClaudeLocalCommandText(text) && !isClaudeHookNoiseText(text) && !isClaudeToolResultOnly(line.message?.content)) return index;
      }
      return lines.length;
    };

    const hasLaterToolBeforeNextUser = (start: number): boolean => {
      const end = nextRealUserIndex(start);
      for (let index = start + 1; index < end; index += 1) {
        const line = lines[index]!;
        const role = String(line.message?.role ?? line.type);
        if (role === "assistant" && claudeHasToolUse(line.message?.content)) return true;
        if (role === "user" && isClaudeToolResultOnly(line.message?.content)) return true;
      }
      return false;
    };

    lines.forEach((line, index) => {
      if (line.type !== "user" && line.type !== "assistant") return;
      const role = String(line.message?.role ?? line.type);
      const content = line.message?.content;
      const id = String(line.uuid ?? `${threadId}-claude-${index}`);
      if (role === "user") {
        const text = claudeTextContent(content);
        if (!text || isClaudeLocalCommandText(text) || isClaudeHookNoiseText(text) || isClaudeToolResultOnly(content)) return;
        currentTurnId = `${threadId}-claude-turn-${turnIndex++}`;
        items.push({ id, kind: "user", text, turnId: currentTurnId });
        return;
      }
      if (role !== "assistant") return;
      const turnId = currentTurnId || `${threadId}-claude-turn-${turnIndex}`;
      const text = claudeTextContent(content);
      const hasTool = claudeHasToolUse(content);
      if (text && !isClaudeHookNoiseText(text)) {
        if (hasTool || hasLaterToolBeforeNextUser(index)) {
          ensureActivity(turnId, { id, kind: "message", title: "작업 메모", detail: text, status: "completed" });
        } else {
          items.push({ id, kind: "agent", text, turnId, runtime: "claude-code", provider: "claude-code" });
        }
      }
      for (const part of claudeContentParts(content).filter((part) => String(part.type ?? "") === "tool_use")) {
        const toolId = String(part.id ?? `${id}-tool`);
        const name = String(part.name ?? "Claude 도구");
        ensureActivity(turnId, {
          id: toolId,
          kind: "mcp",
          title: `${name} 실행`,
          detail: JSON.stringify(part.input ?? {}, null, 2),
          status: "completed",
        });
      }
    });
    return items;
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
