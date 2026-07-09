import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexHome } from "./codex-home.cjs";
import { pruneBackups } from "./codex-config.cjs";

const CODEX_HOME = codexHome();
const STATE_DB_PATH = join(CODEX_HOME, "state_5.sqlite");
const CONFIG_PATH = join(CODEX_HOME, "config.toml");
const TARGET_PROVIDER = "openai";
const EXTERNAL_TURN_PROVIDER = "devil";
const FALLBACK_CODEX_MODEL = "gpt-5.4";

type ReconcileStatus = "pending" | "done" | "failed";

export interface PendingReconcileItem {
  threadId: string;
  targetProvider: "openai";
  actualProvider: string;
  actualModel: string;
  restoreModel?: string;
  status: ReconcileStatus;
  attempts: number;
  startedAt: number;
  updatedAt: number;
  lastError: string | null;
}

interface JournalShape {
  version: 1;
  items: Record<string, PendingReconcileItem>;
}

interface ThreadRow {
  id: string;
  model_provider: string;
  model: string | null;
  rollout_path: string;
}

interface SessionMetaLine {
  type?: string;
  payload?: Record<string, unknown>;
}

export interface ReconcileResult {
  ok: boolean;
  threadId: string;
  error?: string;
}

export interface ReconcileSweepResult {
  attempted: number;
  recovered: number;
  failed: number;
}

// A freshly created thread has no state_5.sqlite row / rollout until its first
// turn starts. That is not an error — the provider patch is simply skipped and
// reconciled after the turn. Distinguished by type so callers never string-match.
export class ThreadNotPersistedError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Recursively collect base64 image data URLs (input_image.image_url / image.url)
// in document order from a parsed rollout line.
function collectImageUrls(node: unknown, out: string[]): void {
  if (Array.isArray(node)) { for (const child of node) collectImageUrls(child, out); return; }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const url = obj.image_url ?? obj.url;
  if ((obj.type === "input_image" || obj.type === "image") && typeof url === "string" && url.startsWith("data:image")) out.push(url);
  for (const value of Object.values(obj)) if (value && typeof value === "object") collectImageUrls(value, out);
}

function ensureColumns(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>;
  const columns = new Set(rows.map((row) => String(row.name ?? "")));
  for (const required of ["id", "model_provider", "model", "rollout_path"]) {
    if (!columns.has(required)) throw new Error(`Codex state schema guard failed: missing threads.${required}`);
  }
}

function ensureTitleColumn(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>;
  const columns = new Set(rows.map((row) => String(row.name ?? "")));
  for (const required of ["id", "title"]) {
    if (!columns.has(required)) throw new Error(`Codex state schema guard failed: missing threads.${required}`);
  }
}

function readThreadRow(db: DatabaseSync, threadId: string): ThreadRow {
  const row = db.prepare("SELECT id, model_provider, model, rollout_path FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
  if (!row) throw new ThreadNotPersistedError(`thread not yet persisted (${threadId})`);
  if (!row.rollout_path) throw new ThreadNotPersistedError(`rollout_path not yet set (${threadId})`);
  return row;
}

function isExternalModel(model: string | null | undefined): boolean {
  return Boolean(model && /^(copilot|claude-code|antigravity|openai|anthropic|google|deepseek|xai|openrouter|openrouter-free|groq|mistral|cerebras|together|fireworks|moonshot|huggingface|nvidia|ollama|vllm|lm-studio)(@[^:]+)?:/.test(model));
}

async function readDefaultCodexModel(): Promise<string> {
  try {
    const source = await readFile(CONFIG_PATH, "utf8");
    return source.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] ?? FALLBACK_CODEX_MODEL;
  } catch {
    return FALLBACK_CODEX_MODEL;
  }
}

async function readSessionMeta(path: string, threadId: string): Promise<{ lines: string[]; meta: SessionMetaLine; statMtime: Date; statAtime: Date }> {
  if (!existsSync(path)) throw new ThreadNotPersistedError(`rollout not yet written (${path})`);
  const fileStat = await stat(path);
  const source = await readFile(path, "utf8");
  const lines = source.split("\n");
  if (!lines[0]?.trim()) throw new Error(`Codex rollout schema guard failed: empty first line (${path})`);
  const meta = JSON.parse(lines[0]) as SessionMetaLine;
  if (meta.type !== "session_meta") throw new Error(`Codex rollout schema guard failed: first line is not session_meta (${path})`);
  if (!meta.payload || typeof meta.payload !== "object") throw new Error(`Codex rollout schema guard failed: missing payload (${path})`);
  if (String(meta.payload.id ?? "") !== threadId) throw new Error(`Codex rollout schema guard failed: payload id mismatch (${path})`);
  if (typeof meta.payload.model_provider !== "string") throw new Error(`Codex rollout schema guard failed: missing model_provider (${path})`);
  return { lines, meta, statMtime: fileStat.mtime, statAtime: fileStat.atime };
}

export class CodexProviderReconciler {
  private writes = Promise.resolve();

  async recoverLingeringDevilThreads(): Promise<ReconcileSweepResult> {
    if (!existsSync(STATE_DB_PATH)) return { attempted: 0, recovered: 0, failed: 0 };
    const db = new DatabaseSync(STATE_DB_PATH);
    let rows: Array<{ id?: string }> = [];
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      ensureColumns(db);
      rows = db.prepare("SELECT id FROM threads WHERE model_provider = ?").all(EXTERNAL_TURN_PROVIDER) as Array<{ id?: string }>;
    } finally {
      db.close();
    }

    let recovered = 0;
    let failed = 0;
    for (const row of rows) {
      const threadId = String(row.id ?? "");
      if (!threadId) continue;
      try {
        // Preserve the stored model; only the temporary provider flip should be undone.
        await this.patchThreadProvider(threadId, TARGET_PROVIDER);
        recovered += 1;
      } catch {
        failed += 1;
      }
    }
    return { attempted: rows.length, recovered, failed };
  }

  // Read a subagent thread's Codex-assigned nickname (e.g. "Laplace") and its
  // model from the state DB + rollout session_meta. Used by the side-chat to
  // label and resume the subagent thread. Returns nulls if not persisted yet.
  async getSubagentInfo(threadId: string): Promise<{ nickname: string | null; model: string | null }> {
    if (!existsSync(STATE_DB_PATH)) return { nickname: null, model: null };
    const db = new DatabaseSync(STATE_DB_PATH);
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const row = readThreadRow(db, threadId);
      let nickname: string | null = null;
      try {
        const rollout = await readSessionMeta(row.rollout_path, threadId);
        const payload = rollout.meta.payload as Record<string, unknown> | undefined;
        const raw = payload?.agent_nickname ?? payload?.nickname;
        nickname = typeof raw === "string" && raw ? raw : null;
      } catch { /* rollout may not be readable yet */ }
      const model = row.model && !isExternalModel(row.model) ? row.model : null;
      return { nickname, model };
    } catch {
      return { nickname: null, model: null };
    } finally {
      db.close();
    }
  }

  // app-server thread/read returns pasted images as localImage temp paths that
  // are deleted after the session, but the rollout keeps the base64. Return the
  // thread's image data URLs in message order so the UI can restore them.
  async getRolloutImageUrls(threadId: string): Promise<string[]> {
    if (!existsSync(STATE_DB_PATH)) return [];
    const db = new DatabaseSync(STATE_DB_PATH);
    let rolloutPath = "";
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      rolloutPath = String(readThreadRow(db, threadId).rollout_path || "");
    } catch { return []; }
    finally { db.close(); }
    if (!rolloutPath || !existsSync(rolloutPath)) return [];
    const urls: string[] = [];
    try {
      const source = await readFile(rolloutPath, "utf8");
      for (const line of source.split("\n")) {
        if (!line.includes("data:image")) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        collectImageUrls(parsed, urls);
      }
    } catch { return []; }
    return urls;
  }

  async renameThreadTitle(input: { threadId: string; title: string }): Promise<void> {
    const title = input.title.trim();
    if (!title) throw new Error("채팅 이름을 입력하세요.");
    if (!existsSync(STATE_DB_PATH)) throw new ThreadNotPersistedError(`state DB not present: ${STATE_DB_PATH}`);
    const db = new DatabaseSync(STATE_DB_PATH);
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      ensureTitleColumn(db);
      const result = db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, input.threadId);
      if (result.changes !== 1) throw new ThreadNotPersistedError(`thread not found (${input.threadId})`);
    } finally {
      db.close();
    }
  }

  async markPending(input: { threadId: string; actualProvider: string; actualModel: string }): Promise<void> {
    const restoreModel = await this.restoreModelFor(input.threadId);
    await this.mutateJournal((journal) => {
      const now = Date.now();
      const current = journal.items[input.threadId];
      journal.items[input.threadId] = {
        threadId: input.threadId,
        targetProvider: TARGET_PROVIDER,
        actualProvider: input.actualProvider,
        actualModel: input.actualModel,
        restoreModel: current?.restoreModel ?? restoreModel,
        status: "pending",
        attempts: current?.attempts ?? 0,
        startedAt: current?.startedAt ?? now,
        updatedAt: now,
        lastError: null,
      };
    });
  }

  async hasPending(threadId: string): Promise<boolean> {
    return this.readJournal((journal) => Boolean(journal.items[threadId]));
  }

  async discardPending(threadId: string): Promise<void> {
    await this.mutateJournal((journal) => { delete journal.items[threadId]; });
  }

  // Returns true if an existing thread's provider was switched to "devil"
  // (the app-server must then be restarted + resumed so it routes the turn to
  // the proxy). Returns false when the thread isn't persisted yet (a brand-new
  // thread already created with modelProvider:"devil") — nothing to do. Works
  // the same for every external provider; no per-provider/string handling.
  async prepareExternalTurn(threadId: string, options: { waitMs?: number } = {}): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
    let delay = 50;
    while (true) {
      try {
        await this.patchThreadProvider(threadId, EXTERNAL_TURN_PROVIDER);
        return true;
      } catch (error) {
        if (!(error instanceof ThreadNotPersistedError)) throw error;
        if (Date.now() >= deadline) return false;
        await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
        delay = Math.min(delay * 2, 500);
      }
    }
  }

  async completeExternalTurn(threadId: string): Promise<ReconcileResult> {
    const item = await this.readJournal((journal) => journal.items[threadId]);
    if (!item) return { ok: true, threadId };
    const result = await this.retryReconcile(threadId);
    if (result.ok) {
      await this.mutateJournal((journal) => { delete journal.items[threadId]; });
    } else {
      await this.mutateJournal((journal) => {
        const current = journal.items[threadId];
        if (!current) return;
        journal.items[threadId] = {
          ...current,
          status: "failed",
          attempts: current.attempts + 1,
          updatedAt: Date.now(),
          lastError: result.error ?? "unknown reconcile failure",
        };
      });
    }
    return result;
  }

  async reconcilePending(): Promise<{ attempted: number; succeeded: number; failed: number }> {
    const items = await this.readJournal((journal) => Object.values(journal.items));
    let succeeded = 0;
    let failed = 0;
    for (const item of items) {
      const result = await this.completeExternalTurn(item.threadId);
      if (result.ok) succeeded++;
      else failed++;
    }
    return { attempted: items.length, succeeded, failed };
  }

  private async retryReconcile(threadId: string): Promise<ReconcileResult> {
    const item = await this.readJournal((journal) => journal.items[threadId]);
    const delays = [0, 250, 500, 1000, 2000];
    let lastError = "";
    for (const delay of delays) {
      if (delay) await sleep(delay);
      try {
        await this.reconcileThreadToOpenai(threadId, item?.restoreModel);
        return { ok: true, threadId };
      } catch (error) {
        lastError = message(error);
        if (!/locked|busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(lastError)) break;
      }
    }
    return { ok: false, threadId, error: lastError };
  }

  private async reconcileThreadToOpenai(threadId: string, restoreModel?: string): Promise<void> {
    await this.patchThreadProvider(threadId, TARGET_PROVIDER, restoreModel);
  }

  private async patchThreadProvider(threadId: string, targetProvider: string, targetModel?: string): Promise<void> {
    if (!existsSync(STATE_DB_PATH)) throw new ThreadNotPersistedError(`state DB not present: ${STATE_DB_PATH}`);

    const db = new DatabaseSync(STATE_DB_PATH);
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      ensureColumns(db);
      const row = readThreadRow(db, threadId);
      const rollout = await readSessionMeta(row.rollout_path, threadId);

      const dbNeedsPatch = row.model_provider !== targetProvider;
      const dbModelNeedsPatch = Boolean(targetModel && row.model !== targetModel);
      const rolloutNeedsPatch = rollout.meta.payload?.model_provider !== targetProvider;
      if (!dbNeedsPatch && !dbModelNeedsPatch && !rolloutNeedsPatch) return;

      await this.backup(threadId, row, targetProvider, targetModel);

      if (dbNeedsPatch) {
        db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?").run(targetProvider, threadId);
      }
      if (targetModel && dbModelNeedsPatch) {
        db.prepare("UPDATE threads SET model = ? WHERE id = ?").run(targetModel, threadId);
      }
      if (rolloutNeedsPatch && rollout.meta.payload) {
        rollout.meta.payload.model_provider = targetProvider;
        rollout.lines[0] = JSON.stringify(rollout.meta);
        await writeFile(row.rollout_path, rollout.lines.join("\n"), "utf8");
      }
    } finally {
      db.close();
    }
  }

  private async restoreModelFor(threadId: string): Promise<string> {
    if (!existsSync(STATE_DB_PATH)) return readDefaultCodexModel();
    const db = new DatabaseSync(STATE_DB_PATH);
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      ensureColumns(db);
      const row = readThreadRow(db, threadId);
      return row.model && !isExternalModel(row.model) ? row.model : await readDefaultCodexModel();
    } catch (error) {
      // New thread with no persisted row yet → nothing to restore; use default.
      if (error instanceof ThreadNotPersistedError) return readDefaultCodexModel();
      throw error;
    } finally {
      db.close();
    }
  }

  private async backup(threadId: string, row: ThreadRow, targetProvider: string, targetModel?: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(CODEX_HOME, "devil-codex-backups", `reconcile-${stamp}-${threadId}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await copyFile(STATE_DB_PATH, join(dir, "state_5.sqlite")).catch(() => undefined);
    await copyFile(row.rollout_path, join(dir, "rollout.jsonl")).catch(() => undefined);
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      version: 1,
      threadId,
      fromProvider: row.model_provider,
      fromModel: row.model,
      toProvider: targetProvider,
      toModel: targetModel,
      dbPath: STATE_DB_PATH,
      rolloutPath: row.rollout_path,
      createdAt: Date.now(),
    }, null, 2) + "\n", { mode: 0o600 });
    // Each backup copies the whole state_5.sqlite (multi-MB); without pruning
    // the directory grows by ~9MB per external turn.
    await pruneBackups("reconcile-", 10);
  }

  private journalPath(): string {
    return join(app.getPath("userData"), "providers", "pending-reconcile.json");
  }

  private async loadJournal(): Promise<JournalShape> {
    try {
      const parsed = JSON.parse(await readFile(this.journalPath(), "utf8")) as Partial<JournalShape>;
      if (parsed.version === 1 && parsed.items && typeof parsed.items === "object") return { version: 1, items: parsed.items as Record<string, PendingReconcileItem> };
    } catch {
      // Missing or malformed journal starts empty. Future failures will recreate it.
    }
    return { version: 1, items: {} };
  }

  private async saveJournal(journal: JournalShape): Promise<void> {
    const path = this.journalPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600 });
  }

  private async mutateJournal(change: (journal: JournalShape) => void | Promise<void>): Promise<void> {
    const run = this.writes.then(async () => {
      const journal = await this.loadJournal();
      await change(journal);
      await this.saveJournal(journal);
    });
    this.writes = run.catch(() => undefined);
    await run;
  }

  private async readJournal<T>(read: (journal: JournalShape) => T): Promise<T> {
    const run = this.writes.then(async () => read(await this.loadJournal()));
    this.writes = run.then(() => undefined, () => undefined);
    return run;
  }
}
