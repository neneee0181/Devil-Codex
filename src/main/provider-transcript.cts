import { app } from "electron";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ContextUsage, ThreadActivityEntry, ThreadAttachment, ThreadHistoryItem, ThreadSummary } from "./contracts.cjs";

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
  claudeImports?: Record<string, ClaudeImportState>;
};
type ClaudeImportState = { size: number; mtimeMs: number; sessionId: string; threadId: string; formatVersion?: number };
// Bump whenever historyFromClaudeLines() starts recovering data it used to
// drop (e.g. image attachments) - a file whose size/mtime haven't changed
// since its last import would otherwise be treated as "unchanged" forever
// and keep serving the stale, already-imported (pre-fix) history even after
// the app updates. Bumping this forces exactly one re-derive per thread.
const CLAUDE_IMPORT_FORMAT_VERSION = 3;
type ClaudeJsonlFileState = { path: string; size: number; mtimeMs: number; sessionId: string };
type RolloutLine = { type?: string; timestamp?: string; payload?: Record<string, unknown> };
type ClaudeJsonLine = {
  type?: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  error?: string;
  version?: string;
  promptSource?: string;
  origin?: { kind?: unknown };
  content?: unknown;
  compactMetadata?: Record<string, unknown>;
  compact_metadata?: Record<string, unknown>;
  attachment?: { content?: unknown; stdout?: unknown; command?: unknown };
  message?: { role?: string; content?: unknown };
};

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

// Pasted/dropped images ride a top-level user message as Anthropic-format
// `{type:"image", source:{type:"base64"|"url", ...}}` blocks (see
// userMessageContent()/imageContentBlock() in claude-runtime.cts). Reimporting
// a session from the raw jsonl (recoverClaudeProjects) previously only pulled
// `type:"text"` parts via claudeTextContent(), silently dropping every
// attachment on the user bubble on the next app restart even though the
// image data is sitting right there in the session file.
function claudeUserAttachments(content: unknown): ThreadAttachment[] {
  return claudeContentParts(content).flatMap((part, index): ThreadAttachment[] => {
    if (String(part.type ?? "") !== "image") return [];
    const source = part.source as Record<string, unknown> | undefined;
    if (!source) return [];
    const sourceType = String(source.type ?? "");
    if (sourceType === "base64" && typeof source.data === "string") {
      const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
      return [{ name: `image-${index + 1}`, kind: "image", url: `data:${mediaType};base64,${source.data}`, mime: mediaType }];
    }
    if (sourceType === "url" && typeof source.url === "string" && source.url) {
      return [{ name: `image-${index + 1}`, kind: "image", url: source.url }];
    }
    return [];
  });
}

function isClaudeApiErrorLine(line: ClaudeJsonLine): boolean {
  return Boolean(line.isApiErrorMessage || line.error || line.apiErrorStatus);
}

function claudeApiErrorTitle(line: ClaudeJsonLine): string {
  const status = typeof line.apiErrorStatus === "number" && line.apiErrorStatus > 0 ? ` ${line.apiErrorStatus}` : "";
  const code = typeof line.error === "string" && line.error ? ` (${line.error})` : "";
  return `Claude Code 오류${status}${code}`;
}

function isClaudeLocalCommandText(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("<local-command-caveat>")
    || normalized.startsWith("<command-name>")
    || normalized.startsWith("<command-message>")
    || normalized.startsWith("<local-command-stdout>")
    || normalized.startsWith("This session is being continued from a previous conversation that ran out of context.")
    || normalized.startsWith("<local-command-stderr>");
}

// True if `text` exactly repeats the most recent standalone agent reply in
// `items` with no user message in between. Claude Code's own session jsonl
// can log an internal/continuation "user" line that isn't caught by the
// noise filters above (e.g. around auto-compaction), which this importer
// then reads as a brand-new turn boundary — and if the model's reply for
// that phantom turn is a verbatim repeat of the previous real answer, it
// renders as a second, near-empty duplicate turn. A distinct item id or
// turnId doesn't matter here: identical trailing text with nothing new from
// the user is never a legitimate second reply.
function isRepeatOfLastClaudeAgentReply(items: ThreadHistoryItem[], text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const current = items[index]!;
    if (current.kind === "user") return false;
    if (current.kind === "agent") return current.text.trim() === trimmed;
  }
  return false;
}

function isClaudeHookNoiseText(text: string): boolean {
  const normalized = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return normalized.startsWith("CAVEMAN MODE ACTIVE")
    || normalized.startsWith("STATUSLINE SETUP NEEDED:")
    || /Loading caveman mode/i.test(normalized);
}

function stripClaudeRuntimePrefix(text: string): string {
  return text
    .replace(/^\[Devil Claude Code runtime tool instructions\][\s\S]*?\n\n/, "")
    .replace(/^Base directory for this skill:[\s\S]*?\n\n## User Request\n\n/, "")
    .trim();
}

function isClaudeAutoContinuationText(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("<task-notification")
    || normalized.startsWith("<scheduled-wakeup")
    || normalized.startsWith("<background-task");
}

function isClaudeInternalUserLine(line: ClaudeJsonLine, text: string): boolean {
  if (line.isMeta) return true;
  if (String(line.origin?.kind ?? "") === "task-notification") return true;
  if (String(line.promptSource ?? "") === "system" && isClaudeAutoContinuationText(text)) return true;
  return isClaudeAutoContinuationText(text);
}

function isClaudeToolResultOnly(content: unknown): boolean {
  const parts = claudeContentParts(content);
  return parts.length > 0 && parts.every((part) => String(part.type ?? "") === "tool_result");
}

function xmlTagValue(text: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
  return match?.[1]?.trim() ?? "";
}

function claudeTaskNotificationEntry(id: string, text: string): ThreadActivityEntry {
  const status = xmlTagValue(text, "status");
  const summary = xmlTagValue(text, "summary");
  const taskId = xmlTagValue(text, "task-id");
  const outputFile = xmlTagValue(text, "output-file");
  const detail = [
    summary,
    taskId ? `task: ${taskId}` : "",
    outputFile ? `output: ${outputFile}` : "",
  ].filter(Boolean).join("\n");
  return {
    id,
    kind: "diagnostic",
    title: "Claude 백그라운드 작업 알림",
    detail: detail || text,
    status: status === "failed" || status === "stopped" ? "failed" : "completed",
  };
}

function hasClaudeImportNoise(items: ThreadHistoryItem[]): boolean {
  return items.some((item) => {
    if (item.kind === "user" && isClaudeLocalCommandText(item.text)) return true;
    if (item.kind === "user" && isClaudeAutoContinuationText(item.text)) return true;
    if (item.kind === "user" && stripClaudeRuntimePrefix(item.text) !== item.text.trim()) return true;
    if (item.kind === "user" && item.text.trimStart().startsWith("Base directory for this skill:")) return true;
    if (item.kind === "activity" && item.id.startsWith("activity-") && !item.turnId?.startsWith("claude-")) return true;
    return false;
  });
}

function latestVisibleClaudeTime(lines: ClaudeJsonLine[]): number {
  let latest = 0;
  for (const line of lines) {
    if (line.type !== "user" && line.type !== "assistant") continue;
    const role = String(line.message?.role ?? line.type);
    const text = stripClaudeRuntimePrefix(claudeTextContent(line.message?.content));
    if (role === "user") {
      if (!text || isClaudeLocalCommandText(text) || isClaudeHookNoiseText(text) || isClaudeToolResultOnly(line.message?.content) || isClaudeInternalUserLine(line, text)) continue;
    } else if (role === "assistant") {
      if (!text || isClaudeHookNoiseText(text)) continue;
    } else {
      continue;
    }
    latest = Math.max(latest, claudeLineTime(line));
  }
  return latest;
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

function claudeCompactMetadata(line: ClaudeJsonLine): Record<string, unknown> {
  return line.compactMetadata ?? line.compact_metadata ?? {};
}

function claudeCompactNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function claudeCompactDetail(line: ClaudeJsonLine): string {
  const meta = claudeCompactMetadata(line);
  const pre = claudeCompactNumber(meta.preTokens ?? meta.pre_tokens);
  const post = claudeCompactNumber(meta.postTokens ?? meta.post_tokens);
  const duration = claudeCompactNumber(meta.durationMs ?? meta.duration_ms);
  const parts = [
    pre ? `압축 전 ${Math.round(pre).toLocaleString()} tokens` : "",
    post ? `압축 후 ${Math.round(post).toLocaleString()} tokens` : "",
    duration ? `${Math.round(duration)}ms` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function claudeCompactTitle(line: ClaudeJsonLine): string {
  const trigger = String(claudeCompactMetadata(line).trigger ?? "");
  return trigger === "manual" ? "컨텍스트가 수동으로 압축됨" : "컨텍스트가 자동으로 압축됨";
}

function claudeSessionFallbackText(lines: ClaudeJsonLine[]): string {
  const leafUuid = String((lines.find((line) => line.type === "last-prompt") as Record<string, unknown> | undefined)?.leafUuid ?? "");
  const leafLine = leafUuid ? lines.find((line) => line.uuid === leafUuid) : undefined;
  const leafText = leafLine ? stripClaudeRuntimePrefix(claudeLineText(leafLine)) : "";
  if (leafText && !isClaudeLocalCommandText(leafText) && !isClaudeHookNoiseText(leafText) && !isClaudeInternalUserLine(leafLine ?? {}, leafText)) return leafText;
  for (const line of lines) {
    const text = stripClaudeRuntimePrefix(claudeLineText(line));
    if (!text) continue;
    if (/resume cancelled/i.test(text)) continue;
    if (/^(Kept model as|Set model to)/i.test(text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim())) continue;
    if (isClaudeLocalCommandText(text)) continue;
    if (isClaudeHookNoiseText(text)) continue;
    if (isClaudeInternalUserLine(line, text)) continue;
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
  private claudeImportSignature = "";
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
    await this.importClaudeProjects();
    return this.readLatest((all) => Object.values(all.meta).sort((a, b) => b.updatedAt - a.updatedAt));
  }

  private async importClaudeProjects(): Promise<void> {
    const files = await this.claudeJsonlFileStates().catch(() => [] as ClaudeJsonlFileState[]);
    const signature = files.map((file) => `${file.path}:${file.size}:${file.mtimeMs}`).join("|");
    if (signature && signature === this.claudeImportSignature) return;
    const imports = await this.readLatest((all) => all.claudeImports ?? {});
    const currentPaths = new Set(files.map((file) => file.path));
    const unchanged = files.length > 0
      && files.every((file) => {
        const imported = imports[file.path];
        return imported && imported.size === file.size && imported.mtimeMs === file.mtimeMs && imported.formatVersion === CLAUDE_IMPORT_FORMAT_VERSION;
      })
      && Object.keys(imports).every((path) => currentPaths.has(path));
    if (unchanged) {
      this.claudeImportSignature = signature;
      return;
    }
    await this.mutate((all) => this.recoverClaudeProjects(all, files));
    this.claudeImportSignature = signature;
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
        shaped.claudeImports ??= {};
        for (const summary of Object.values(shaped.meta ?? {})) summary.updatedAt = toUnixSeconds(summary.updatedAt);
        this.cache = shaped;
        return shaped;
      }
      this.cache = { items: parsed as Record<string, ThreadHistoryItem[]>, meta: {}, providerTurns: {}, deleted: {}, claudeImports: {} };
      return this.cache; // migrate legacy flat shape
    } catch {
      this.cache = { items: {}, meta: {}, providerTurns: {}, deleted: {}, claudeImports: {} };
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

  private async recoverClaudeProjects(all: StoredShape, files: ClaudeJsonlFileState[]): Promise<void> {
    all.claudeImports ??= {};
    const nativeSessionToThreadId = new Map<string, string>();
    for (const [id, summary] of Object.entries(all.meta)) {
      if (summary.claudeSessionId) nativeSessionToThreadId.set(summary.claudeSessionId, id);
    }
    const currentPaths = new Set(files.map((file) => file.path));
    for (const path of Object.keys(all.claudeImports)) {
      if (!currentPaths.has(path)) delete all.claudeImports[path];
    }
    for (const file of files) {
      const { path, sessionId } = file;
      const threadId = nativeSessionToThreadId.get(sessionId) ?? sessionId;
      if (all.deleted?.[threadId]) continue;
      const imported = all.claudeImports[path];
      if (imported && imported.size === file.size && imported.mtimeMs === file.mtimeMs && imported.formatVersion === CLAUDE_IMPORT_FORMAT_VERSION && all.meta[threadId]) continue;
      if (!imported && all.meta[threadId] && all.items[threadId]) {
        all.claudeImports[path] = { size: file.size, mtimeMs: file.mtimeMs, sessionId, threadId, formatVersion: CLAUDE_IMPORT_FORMAT_VERSION };
        continue;
      }
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
      const nativeUpdatedAt = latestVisibleClaudeTime(lines);
      const localUpdatedAt = all.meta[threadId]?.updatedAt ?? 0;
      if (history.length && (history.length >= existing.length || nativeUpdatedAt > localUpdatedAt || hasClaudeImportNoise(existing))) all.items[threadId] = history;
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
      all.claudeImports[path] = { size: file.size, mtimeMs: file.mtimeMs, sessionId, threadId, formatVersion: CLAUDE_IMPORT_FORMAT_VERSION };
    }
  }

  private historyFromClaudeLines(lines: ClaudeJsonLine[], threadId: string): ThreadHistoryItem[] {
    const items: ThreadHistoryItem[] = [];
    let turnIndex = 0;
    let currentTurnId = "";

    // tool_use_id → tool_result text. Needed to rebuild delegate_subagent cards
    // as subagent activities: the child threadId/provider/model live in the MCP
    // result text, which arrives in later tool_result-only user lines.
    const toolResults = new Map<string, string>();
    // tool_use_id → screenshot(s) from the same tool_result. claudeTextContent
    // above only keeps type:"text" parts, so a screenshot-only result (browser_
    // screenshot, computer_screenshot) left mcp activity cards image-less.
    const toolResultImages = new Map<string, string[]>();
    for (const line of lines) {
      if (line.type !== "user" && line.type !== "assistant") continue;
      for (const part of claudeContentParts(line.message?.content)) {
        if (String(part.type ?? "") !== "tool_result") continue;
        const useId = String(part.tool_use_id ?? "");
        if (!useId) continue;
        if (!toolResults.has(useId)) toolResults.set(useId, claudeTextContent(part.content));
        if (!toolResultImages.has(useId)) {
          const images = claudeContentParts(part.content).flatMap((entry) => {
            if (String(entry.type ?? "") === "image" && typeof entry.data === "string") {
              return [`data:${typeof entry.mimeType === "string" ? entry.mimeType : "image/png"};base64,${entry.data}`];
            }
            return [];
          });
          if (images.length) toolResultImages.set(useId, images);
        }
      }
    }

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

    // First pass: assign each line the turnId the main pass will also assign,
    // and record — per turn — the index of the LAST assistant text line (the
    // true final answer). A trailing housekeeping tool call after that line
    // (TodoWrite, hooks, etc.) must not demote the real final answer into a
    // "작업 메모" activity, which is what a "does a tool run later?" check did
    // before: it punished the final answer whenever anything (even an
    // invisible follow-up tool call) happened afterward. Mirrors the
    // Codex-side isFinalAssistantMessage "last text wins" rule in
    // thread-history.cts.
    const turnIdByIndex: string[] = [];
    const lastTextIndexByTurn = new Map<string, number>();
    {
      let index_ = 0;
      let turnId_ = "";
      lines.forEach((line, index) => {
        if (line.type !== "user" && line.type !== "assistant") { turnIdByIndex[index] = turnId_; return; }
        const role = String(line.message?.role ?? line.type);
        const content = line.message?.content;
        if (role === "user") {
          const text = stripClaudeRuntimePrefix(claudeTextContent(content));
          if (text && !isClaudeLocalCommandText(text) && !isClaudeHookNoiseText(text) && !isClaudeToolResultOnly(content) && !isClaudeInternalUserLine(line, text)) {
            turnId_ = `${threadId}-claude-turn-${index_++}`;
          }
          turnIdByIndex[index] = turnId_;
          return;
        }
        if (role !== "assistant") { turnIdByIndex[index] = turnId_; return; }
        const turnId = turnId_ || `${threadId}-claude-turn-${index_}`;
        turnIdByIndex[index] = turnId;
        const text = claudeTextContent(content);
        if (text && !isClaudeHookNoiseText(text) && !isClaudeApiErrorLine(line)) lastTextIndexByTurn.set(turnId, index);
      });
    }

    lines.forEach((line, index) => {
      if (line.type === "system" && line.subtype === "compact_boundary") {
        const turnId = turnIdByIndex[index] || currentTurnId || `${threadId}-claude-turn-${turnIndex}`;
        ensureActivity(turnId, {
          id: String(line.uuid ?? `${threadId}-claude-compact-${index}`),
          kind: "compaction",
          title: claudeCompactTitle(line),
          detail: claudeCompactDetail(line),
          status: "completed",
        });
        return;
      }
      if (line.type !== "user" && line.type !== "assistant") return;
      const role = String(line.message?.role ?? line.type);
      const content = line.message?.content;
      const id = String(line.uuid ?? `${threadId}-claude-${index}`);
      if (role === "user") {
        const text = stripClaudeRuntimePrefix(claudeTextContent(content));
        if (text && isClaudeInternalUserLine(line, text)) {
          const turnId = turnIdByIndex[index] || currentTurnId;
          if (turnId && isClaudeAutoContinuationText(text)) ensureActivity(turnId, claudeTaskNotificationEntry(id, text));
          return;
        }
        if (!text || isClaudeLocalCommandText(text) || isClaudeHookNoiseText(text) || isClaudeToolResultOnly(content)) return;
        currentTurnId = `${threadId}-claude-turn-${turnIndex++}`;
        const attachments = claudeUserAttachments(content);
        items.push({ id, kind: "user", text, turnId: currentTurnId, ...(attachments.length ? { attachments } : {}) });
        return;
      }
      if (role !== "assistant") return;
      const turnId = turnIdByIndex[index] || currentTurnId || `${threadId}-claude-turn-${turnIndex}`;
      const text = claudeTextContent(content);
      if (text && !isClaudeHookNoiseText(text)) {
        if (isClaudeApiErrorLine(line)) {
          items.push({ id, kind: "system", title: claudeApiErrorTitle(line), text, turnId, status: "failed", runtime: "claude-code", provider: "claude-code" });
        } else if (index === lastTextIndexByTurn.get(turnId)) {
          if (!isRepeatOfLastClaudeAgentReply(items, text)) items.push({ id, kind: "agent", text, turnId, runtime: "claude-code", provider: "claude-code" });
        } else {
          ensureActivity(turnId, { id, kind: "message", title: "작업 메모", detail: text, status: "completed" });
        }
      }
      for (const part of claudeContentParts(content).filter((part) => String(part.type ?? "") === "tool_use")) {
        const toolId = String(part.id ?? `${id}-tool`);
        const name = String(part.name ?? "Claude 도구");
        // Rebuild delegated subagent calls as subagent activities so the right
        // tab/model lock survive a reimport (Claude SDK prefixes MCP tools as
        // "mcp__devil_subagent__delegate_subagent").
        if (name === "delegate_subagent" || name.endsWith("__delegate_subagent")) {
          const resultText = toolResults.get(toolId) ?? "";
          const agentThreadId = resultText.match(/^threadId:\s*([^\s]+)/m)?.[1] ?? "";
          if (agentThreadId) {
            const provider = resultText.match(/^provider:\s*([^\n]+)/m)?.[1]?.trim();
            const model = resultText.match(/^model:\s*([^\n]+)/m)?.[1]?.trim();
            ensureActivity(turnId, {
              id: toolId,
              kind: "subagent",
              title: provider || model ? `하위 에이전트: ${[provider, model].filter(Boolean).join(" · ")}` : "하위 에이전트",
              detail: resultText,
              status: "completed",
              subagent: { agentThreadId, source: "thread_spawn", role: provider || "subagent", nickname: provider || undefined, model },
            });
            continue;
          }
        }
        // detail is the tool RESULT (rendered under the "결과" header in
        // TurnActivity.tsx), not the call's input params - this used to
        // stuff JSON.stringify(part.input) in here instead, so a no-arg
        // screenshot tool (input === {}) rendered its "결과" as literally
        // "{}" even though toolResults already had the real result text
        // (or was empty because the only payload was an image, handled by
        // resultImages below). Mirrors the live path's mcpResultContent()
        // split between `input` and `detail` in threadTimeline.ts.
        const resultImages = toolResultImages.get(toolId);
        const resultText = toolResults.get(toolId) ?? "";
        const inputKeys = part.input && typeof part.input === "object" ? Object.keys(part.input as Record<string, unknown>) : [];
        ensureActivity(turnId, {
          id: toolId,
          kind: "mcp",
          title: `${name} 실행`,
          ...(inputKeys.length ? { input: JSON.stringify(part.input, null, 2) } : {}),
          detail: resultText || undefined,
          status: "completed",
          ...(resultImages?.length ? { images: resultImages } : {}),
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

  private async claudeJsonlFileStates(): Promise<ClaudeJsonlFileState[]> {
    const root = join(homedir(), ".claude", "projects");
    const files = await this.jsonlFiles(root);
    const states = await Promise.all(files.map(async (path) => {
      const info = await stat(path);
      return { path, size: info.size, mtimeMs: Math.trunc(info.mtimeMs), sessionId: basename(path).replace(/\.jsonl$/i, "") };
    }));
    return states.sort((a, b) => a.path.localeCompare(b.path));
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
