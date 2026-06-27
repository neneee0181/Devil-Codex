import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GitWorktreeInfo } from "./contracts.cjs";

const execFileAsync = promisify(execFile);

export async function listGitWorktrees(input: { cwd: string }): Promise<GitWorktreeInfo[]> {
  const result = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: input.cwd });
  return result.stdout.trim().split("\n\n").filter(Boolean).map((block) => {
    const fields = new Map(block.split("\n").map((line) => {
      const space = line.indexOf(" ");
      return space < 0 ? [line, "true"] : [line.slice(0, space), line.slice(space + 1)];
    }));
    return {
      path: fields.get("worktree") ?? "",
      branch: (fields.get("branch") ?? "detached").replace(/^refs\/heads\//, ""),
      head: fields.get("HEAD") ?? "",
      detached: fields.has("detached"),
      locked: fields.has("locked"),
    };
  });
}

export async function createGitWorktree(input: { cwd: string; branch: string }): Promise<GitWorktreeInfo> {
  const branch = input.branch.trim();
  if (!branch || branch.startsWith("-")) throw new Error("브랜치 이름을 입력하세요.");
  await execFileAsync("git", ["check-ref-format", "--branch", branch], { cwd: input.cwd });
  const suffix = branch.replace(/^codex\//, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const path = join(dirname(input.cwd), `${basename(input.cwd)}-${suffix}`);
  await execFileAsync("git", ["worktree", "add", "-b", branch, path], { cwd: input.cwd, maxBuffer: 4 * 1024 * 1024 });
  return (await listGitWorktrees(input)).find((item) => item.path === path) ?? { path, branch, head: "", detached: false, locked: false };
}
