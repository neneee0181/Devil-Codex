import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
const SKIP_SEARCH = new Set([".git", "node_modules", "dist", "dist-electron"]);

function inside(cwd: string, path = ""): { root: string; full: string; path: string } {
  const root = resolve(cwd);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(`${root}${sep}`)) throw new Error("Workspace 밖의 경로는 열 수 없습니다.");
  return { root, full, path: relative(root, full) };
}

export async function listWorkspaceDirectory(cwd: string, path = ""): Promise<Array<{ name: string; path: string; kind: "file" | "folder" }>> {
  const target = inside(cwd, path);
  const entries = await readdir(target.full, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() || entry.isFile()).map((entry) => ({ name: entry.name, path: relative(target.root, resolve(target.full, entry.name)), kind: entry.isDirectory() ? "folder" as const : "file" as const })).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1);
}

export async function readWorkspaceEntry(cwd: string, path: string): Promise<{ path: string; kind: "text" | "image" | "binary"; content: string }> {
  const target = inside(cwd, path);
  const info = await stat(target.full);
  if (!info.isFile()) throw new Error("파일이 아닙니다.");
  if (info.size > 8 * 1024 * 1024) return { path: target.path, kind: "binary", content: "파일이 너무 커서 미리보기를 표시할 수 없습니다." };
  const data = await readFile(target.full);
  const mime = IMAGE_TYPES[extname(target.full).toLowerCase()];
  if (mime) return { path: target.path, kind: "image", content: `data:${mime};base64,${data.toString("base64")}` };
  if (data.includes(0)) return { path: target.path, kind: "binary", content: "바이너리 파일은 미리보기를 표시할 수 없습니다." };
  return { path: target.path, kind: "text", content: data.toString("utf8") };
}

export async function writeWorkspaceFile(cwd: string, path: string, content: string): Promise<{ path: string }> {
  const target = inside(cwd, path);
  if (target.full === target.root) throw new Error("파일 경로가 필요합니다.");
  try {
    const info = await stat(target.full);
    if (!info.isFile()) throw new Error("파일이 아닙니다.");
  } catch (error) {
    // Allow creating a brand-new file, but surface other stat errors.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(target.full), { recursive: true });
  }
  await writeFile(target.full, content, "utf8");
  return { path: target.path };
}

async function workspaceEntryExists(full: string): Promise<boolean> {
  try { await stat(full); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

// Rename or move an entry: `to` is a workspace-relative path, so changing the
// parent segment moves it. Both endpoints stay inside the workspace root.
export async function renameWorkspaceEntry(cwd: string, from: string, to: string): Promise<{ path: string }> {
  const src = inside(cwd, from);
  const dst = inside(cwd, to);
  if (src.full === src.root || dst.full === dst.root) throw new Error("경로가 필요합니다.");
  if (src.full === dst.full) return { path: dst.path };
  if (await workspaceEntryExists(dst.full)) throw new Error("이미 존재하는 경로입니다.");
  await mkdir(dirname(dst.full), { recursive: true });
  await rename(src.full, dst.full);
  return { path: dst.path };
}

export async function deleteWorkspaceEntry(cwd: string, path: string): Promise<{ path: string }> {
  const target = inside(cwd, path);
  if (target.full === target.root) throw new Error("워크스페이스 루트는 삭제할 수 없습니다.");
  await rm(target.full, { recursive: true, force: true });
  return { path: target.path };
}

export async function createWorkspaceEntry(cwd: string, path: string, kind: "file" | "folder"): Promise<{ path: string; kind: "file" | "folder" }> {
  const target = inside(cwd, path);
  if (target.full === target.root) throw new Error("이름이 필요합니다.");
  if (await workspaceEntryExists(target.full)) throw new Error("이미 존재하는 경로입니다.");
  if (kind === "folder") await mkdir(target.full, { recursive: true });
  else { await mkdir(dirname(target.full), { recursive: true }); await writeFile(target.full, "", "utf8"); }
  return { path: target.path, kind };
}

export async function findWorkspaceFile(cwd: string, query: string): Promise<string | null> {
  const root = resolve(cwd);
  if (isAbsolute(query)) {
    const candidate = inside(cwd, relative(root, query));
    try { if ((await stat(candidate.full)).isFile()) return candidate.path; } catch { return null; }
  }
  try { const direct = inside(cwd, query); if ((await stat(direct.full)).isFile()) return direct.path; } catch { /* search by basename */ }
  const wanted = query.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!wanted) return null;
  const queue = [""];
  let visited = 0;
  while (queue.length && visited < 5000) {
    const dir = queue.shift()!;
    for (const entry of await listWorkspaceDirectory(root, dir).catch(() => [])) {
      visited += 1;
      if (entry.kind === "file" && entry.name.toLowerCase() === wanted) return entry.path;
      if (entry.kind === "folder" && !SKIP_SEARCH.has(entry.name)) queue.push(entry.path);
    }
  }
  return null;
}

export async function previewLocalImage(path: string): Promise<string | null> {
  // Chat attachments often live in macOS's temporary directory. Those paths are
  // expected to disappear after a restart, so a missing preview is not an IPC
  // failure and must not spam Electron's main-process log.
  if (!isAbsolute(path)) return null;
  const mime = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mime) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return null;
    return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
