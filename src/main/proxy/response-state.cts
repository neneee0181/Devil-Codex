import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { app } from "electron";
import { writeTextFileAtomicSync } from "../atomic-file.cjs";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
}

const states = new Map<string, StoredResponseState>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPersistPath: string | undefined;

function statePath(): string {
  const override = process.env.DEVIL_CODEX_USER_DATA?.trim();
  let home = override || join(homedir(), ".devil-codex");
  if (!override) {
    try { home = app.getPath("userData"); } catch { /* plain Node tests use the fallback */ }
  }
  return join(home, "responses-state.json");
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(now = Date.now()): void {
  for (const [id, state] of states) {
    if (now - state.createdAt > RESPONSE_TTL_MS) states.delete(id);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    states.delete(oldest);
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const path = statePath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; states?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.states)) return;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, value] = entry as [unknown, unknown];
      if (typeof id !== "string" || !value || typeof value !== "object") continue;
      const state = value as StoredResponseState;
      if (typeof state.createdAt === "number" && Array.isArray(state.items)) states.set(id, state);
    }
    pruneResponses();
  } catch {
    // A corrupt cache must not prevent provider requests from running.
  }
}

function persistNow(path: string): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = undefined;
  pendingPersistPath = undefined;
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    for (const entry of [...states].reverse()) {
      const size = JSON.stringify(entry).length;
      if (size > SNAPSHOT_ENTRY_MAX_BYTES || total + size > SNAPSHOT_TOTAL_MAX_BYTES) continue;
      total += size;
      entries.push(entry);
    }
    entries.reverse();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(path), 0o700); } catch { /* best effort on Windows */ }
    writeTextFileAtomicSync(path, JSON.stringify({ version: 1, states: entries }));
  } catch {
    // Disk persistence is only a continuation cache, never a request prerequisite.
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  pendingPersistPath = statePath();
  persistTimer = setTimeout(() => persistNow(pendingPersistPath ?? statePath()), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  return { ...request, input: [...previous.items, ...inputItems(request.input)] };
}

export function rememberResponseState(requestBody: unknown, response: unknown): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  if (!response || typeof response !== "object" || Array.isArray(response)) return;
  const request = requestBody as Record<string, unknown>;
  const result = response as Record<string, unknown>;
  if (typeof result.id !== "string" || !Array.isArray(result.output) || result.status !== "completed") return;
  ensureLoaded();
  states.set(result.id, { createdAt: Date.now(), items: [...inputItems(request.input), ...result.output] });
  pruneResponses();
  schedulePersist();
}

export function flushResponseState(): void {
  if (persistTimer) persistNow(pendingPersistPath ?? statePath());
}

/** Simulate a fresh process without deleting the persisted continuation snapshot. */
export function resetResponseStateMemoryForTests(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = undefined;
  pendingPersistPath = undefined;
  states.clear();
  loaded = false;
}

export function clearResponseStateForTests(): void {
  resetResponseStateMemoryForTests();
  try { unlinkSync(statePath()); } catch { /* missing cache */ }
}
