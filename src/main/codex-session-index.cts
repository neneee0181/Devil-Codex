import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadSummary } from "./contracts.cjs";
import { codexHome } from "./codex-home.cjs";

const SESSION_INDEX_PATH = join(codexHome(), "session_index.jsonl");

type SessionIndexRow = {
  id?: string;
  thread_name?: string;
};

const EDITED_USER_MESSAGE_MARKER = "[수정된 사용자 메시지]";
const EDITED_CONTINUATION_PREFIX = "아래는 편집 지점 이전 대화입니다.";

function cleanThreadTitle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  const markerIndex = text.lastIndexOf(EDITED_USER_MESSAGE_MARKER);
  const clean = markerIndex >= 0
    ? text.slice(markerIndex + EDITED_USER_MESSAGE_MARKER.length).trim()
    : text.startsWith(EDITED_CONTINUATION_PREFIX)
      ? "수정된 대화"
      : text;
  return clean.length > 64 ? `${clean.slice(0, 61).trimEnd()}...` : clean;
}

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
      const title = cleanThreadTitle(String(row.thread_name ?? ""));
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
