import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, resolve, sep } from "node:path";
import type { WorkspaceChanges, WorkspaceDiff } from "./contracts.cjs";

const execFileAsync = promisify(execFile);
const isBinaryDiff = (text: string): boolean => /^Binary files .+ differ$/m.test(text);
const statFromNumstat = (text: string): { additions: number; deletions: number } => {
  const [added = "0", deleted = "0"] = text.trim().split("\t");
  return { additions: Number(added) || 0, deletions: Number(deleted) || 0 };
};

export async function getWorkspaceChanges(cwd: string): Promise<WorkspaceChanges> {
  try {
    const options = { cwd, maxBuffer: 1024 * 1024 };
    const [statusResult, branchResult, diffResult, stagedResult] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain=v1"], options),
      execFileAsync("git", ["branch", "--show-current"], options),
      execFileAsync("git", ["diff", "--numstat"], options),
      execFileAsync("git", ["diff", "--cached", "--numstat"], options),
    ]);
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const line of `${diffResult.stdout}\n${stagedResult.stdout}`.split("\n").filter(Boolean)) {
      const [added, deleted] = line.split("\t");
      const path = line.split("\t").slice(2).join("\t");
      const current = stats.get(path) ?? { additions: 0, deletions: 0 };
      current.additions += Number(added) || 0;
      current.deletions += Number(deleted) || 0;
      stats.set(path, current);
    }
    const statusLines = statusResult.stdout.split("\n").filter(Boolean);
    await Promise.all(statusLines.filter((line) => line.startsWith("??")).map(async (line) => {
      const path = line.slice(3).trim();
      try {
        await execFileAsync("git", ["diff", "--no-index", "--numstat", "--", "/dev/null", path], options);
      } catch (error) {
        const output = (error as { stdout?: string }).stdout ?? "";
        stats.set(path, statFromNumstat(output));
      }
    }));
    const files = statusLines.map((line) => {
      const path = line.slice(3).split(" -> ").at(-1)?.trim() ?? "";
      const fileStats = stats.get(path) ?? { additions: 0, deletions: 0 };
      return { status: line.slice(0, 2).trim() || "?", staged: line[0] !== " " && line[0] !== "?", path, ...fileStats };
    });
    const totals = files.reduce((result, file) => ({ additions: result.additions + file.additions, deletions: result.deletions + file.deletions }), { additions: 0, deletions: 0 });
    return {
      available: true,
      files,
      branch: branchResult.stdout.trim() || "detached",
      ...totals,
    };
  } catch {
    return { available: false, files: [], branch: "", additions: 0, deletions: 0, detail: "Git status is unavailable for this workspace." };
  }
}

export async function getWorkspaceDiff(cwd: string, path: string): Promise<WorkspaceDiff> {
  const absolutePath = resolve(cwd, path);
  if (relative(cwd, absolutePath).startsWith("..") || (!absolutePath.startsWith(`${resolve(cwd)}${sep}`) && absolutePath !== resolve(cwd))) {
    throw new Error("Workspace 밖의 파일은 검토할 수 없습니다.");
  }
  const options = { cwd, maxBuffer: 4 * 1024 * 1024 };
  const statusResult = await execFileAsync("git", ["status", "--porcelain=v1", "--", path], options);
  const status = statusResult.stdout.slice(0, 2).trim() || "?";
  const numstat = await execFileAsync("git", ["diff", "--numstat", "--", path], options);
  const [added = "0", deleted = "0"] = numstat.stdout.trim().split("\t");
  if (status === "?" || status === "??") {
    try {
      await execFileAsync("git", ["diff", "--no-index", "--", "/dev/null", path], options);
    } catch (error) {
      const result = error as { stdout?: string };
      const text = result.stdout ?? "";
      const lines = text.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
      return { path, status, additions: lines.length, deletions: 0, text, binary: isBinaryDiff(text) };
    }
  }
  try {
    const result = await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", "--", path], options);
    const staged = result.stdout || (await execFileAsync("git", ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", path], options)).stdout;
    return { path, status, additions: Number(added) || 0, deletions: Number(deleted) || 0, text: staged, binary: isBinaryDiff(staged) };
  } catch (error) {
    const result = error as { stdout?: string };
    return { path, status, additions: 0, deletions: 0, text: result.stdout ?? "", binary: false };
  }
}
