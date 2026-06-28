import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThreadSummary } from "./contracts.cjs";

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const SESSION_INDEX_PATH = join(CODEX_HOME, "session_index.jsonl");

type SessionIndexRow = {
  id?: string;
  thread_name?: string;
};

let cached: { loadedAt: number; titles: Map<string, string> } | undefined;

async function loadTitles(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < 1500) return cached.titles;
  const titles = new Map<string, string>();
  const text = await readFile(SESSION_INDEX_PATH, "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as SessionIndexRow;
      const id = String(row.id ?? "");
      const title = String(row.thread_name ?? "").trim();
      if (id && title) titles.set(id, title);
    } catch {
      /* ignore malformed index rows */
    }
  }
  cached = { loadedAt: now, titles };
  return titles;
}

export async function applySessionIndexTitles<T extends ThreadSummary>(threads: T[]): Promise<T[]> {
  const titles = await loadTitles();
  return threads.map((thread) => {
    const title = titles.get(thread.id);
    return title && title !== thread.title ? { ...thread, title } : thread;
  });
}
