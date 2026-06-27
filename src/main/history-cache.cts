import { app } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadHistoryItem } from "./contracts.cjs";

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
