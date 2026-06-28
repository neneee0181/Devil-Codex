import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexHome } from "./codex-home.cjs";

const STATE_DB_PATH = join(codexHome(), "state_5.sqlite");

type ThreadRow = { rollout_path: string };

function rolloutPathForThread(threadId: string): string | undefined {
  if (!existsSync(STATE_DB_PATH)) return undefined;
  const db = new DatabaseSync(STATE_DB_PATH, { readOnly: true });
  try {
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
    return row?.rollout_path || undefined;
  } finally {
    db.close();
  }
}

export async function appendMirroredRolloutEvents(threadId: string, mirrorId: string, payloads: Array<Record<string, unknown>>): Promise<void> {
  if (!payloads.length) return;
  const rolloutPath = rolloutPathForThread(threadId);
  if (!rolloutPath || !existsSync(rolloutPath)) return;
  const existing = await readFile(rolloutPath, "utf8").catch(() => "");
  if (existing.includes(`"devil_mirror_id":"${mirrorId}"`)) return;
  const timestamp = new Date().toISOString();
  const lines = payloads.map((payload) => JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { ...payload, devil_mirror_id: mirrorId },
  }));
  await appendFile(rolloutPath, `\n${lines.join("\n")}`, "utf8");
}
