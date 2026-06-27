import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function safePath(cwd: string, path: string): string {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const workspacePath = relative(resolve(cwd), resolved);
  if (!workspacePath || workspacePath.startsWith("..") || isAbsolute(workspacePath)) throw new Error("안전하지 않은 파일 경로가 포함된 변경입니다.");
  return workspacePath;
}

function runGitApply(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["apply", "--reverse", "--whitespace=nowarn", ...args, "-"], { cwd, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || "파일 변경을 안전하게 실행 취소할 수 없습니다.")));
    child.stdin.end(input);
  });
}

function normalizedText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

function countDiff(diff: string): { additions: number; deletions: number } {
  return {
    additions: (diff.match(/^\+(?!\+\+)/gm) ?? []).length,
    deletions: (diff.match(/^-(?!--)/gm) ?? []).length,
  };
}

async function isTracked(cwd: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", path], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function untrackedPatch(cwd: string, path: string, expectedContent: string): Promise<string> {
  if (expectedContent.trim()) {
    const currentContent = await readFile(resolve(cwd, path), "utf8");
    if (normalizedText(currentContent) !== normalizedText(expectedContent)) throw new Error("파일이 AI 작업 뒤 변경되어 실행 취소하지 않았습니다.");
  }
  try {
    await execFileAsync("git", ["diff", "--no-index", "--", "/dev/null", path], { cwd });
    throw new Error("되돌릴 파일 변경을 찾을 수 없습니다.");
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    if (!stdout.trim()) throw new Error("되돌릴 새 파일 패치를 만들 수 없습니다.");
    return stdout;
  }
}

async function trackedPatch(cwd: string, path: string, change: FileUndoChange): Promise<string> {
  const result = await execFileAsync("git", ["diff", "--binary", "--full-index", "--", path], { cwd, encoding: "utf8" });
  const patch = result.stdout;
  if (!patch.trim()) throw new Error(`${path}: 되돌릴 작업 트리 변경이 없습니다.`);
  const counts = countDiff(patch);
  if (change.additions + change.deletions > 0 && (counts.additions !== change.additions || counts.deletions !== change.deletions)) {
    throw new Error(`${path}: AI 작업 뒤 다른 변경이 감지되었습니다.`);
  }

  const expected = normalizedText(change.diff.trim());
  if (expected) {
    try {
      const current = normalizedText(await readFile(resolve(cwd, path), "utf8"));
      if (current !== expected && change.additions + change.deletions === 0) throw new Error(`${path}: 현재 내용이 AI 작업 결과와 다릅니다.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const deleted = normalizedText(patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1)).join("\n"));
      if (deleted !== expected && change.additions + change.deletions === 0) throw new Error(`${path}: 삭제 전 내용을 검증할 수 없습니다.`);
    }
  }
  return patch;
}

type FileUndoChange = { path: string; diff: string; additions: number; deletions: number };

async function patchForChange(cwd: string, change: FileUndoChange): Promise<string> {
  const path = safePath(cwd, change.path);
  const diff = change.diff.trim();
  if (!diff.includes("\0") && /^diff --git /m.test(diff)) return diff;
  if (!diff.includes("\0") && /^@@ /m.test(diff)) {
    const created = /^@@ -0,0 \+/m.test(diff);
    return `${created ? "--- /dev/null" : `--- a/${path}`}\n+++ b/${path}\n${diff}\n`;
  }
  if (await isTracked(cwd, path)) return trackedPatch(cwd, path, change);
  return untrackedPatch(cwd, path, diff);
}

export async function undoFileChanges(input: { cwd: string; changes: FileUndoChange[] }): Promise<void> {
  if (!input.changes.length) throw new Error("이 작업에는 되돌릴 파일 변경 정보가 없습니다.");
  const patch = (await Promise.all(input.changes.map((change) => patchForChange(input.cwd, change)))).join("\n");

  await runGitApply(input.cwd, ["--check"], patch);
  await runGitApply(input.cwd, [], patch);
}
