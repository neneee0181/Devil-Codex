import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface AtomicRenameIO {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
}

interface AtomicRenameSyncIO {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => void;
  sleep: (milliseconds: number) => void;
}

let atomicSequence = 0;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Windows can transiently reject a replace while Codex Desktop, an app-server,
// antivirus, or the file indexer has the destination open. OpenCodex retries
// these three errors instead of reporting a false save failure.
export async function renameAtomicFile(
  source: string,
  destination: string,
  io: AtomicRenameIO = { platform: process.platform, rename, sleep: wait },
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await io.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = io.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      if (!transientWindowsError || attempt >= 2) throw error;
      await io.sleep(25 * (attempt + 1));
    }
  }
}

export async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.devil.${process.pid}.${++atomicSequence}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  try {
    await renameAtomicFile(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export function renameAtomicFileSync(
  source: string,
  destination: string,
  io: AtomicRenameSyncIO = { platform: process.platform, rename: renameSync, sleep: waitSync },
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = io.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      if (!transientWindowsError || attempt >= 2) throw error;
      io.sleep(25 * (attempt + 1));
    }
  }
}

export function writeTextFileAtomicSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.devil.${process.pid}.${++atomicSequence}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  try {
    renameAtomicFileSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
