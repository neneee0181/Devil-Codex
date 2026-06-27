import { execFile, spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitBranchInfo } from "./contracts.cjs";

const execFileAsync = promisify(execFile);

function safePaths(cwd: string, paths: string[]): string[] {
  if (!paths.length) throw new Error("선택한 파일이 없습니다.");
  return paths.map((path) => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    const workspacePath = relative(resolve(cwd), absolute);
    if (!workspacePath || workspacePath.startsWith("..") || isAbsolute(workspacePath)) throw new Error("작업공간 밖 파일은 Git 작업에 사용할 수 없습니다.");
    return workspacePath;
  });
}

export async function stageWorkspaceFiles(input: { cwd: string; paths: string[] }): Promise<void> {
  await execFileAsync("git", ["add", "--", ...safePaths(input.cwd, input.paths)], { cwd: input.cwd });
}

export async function unstageWorkspaceFiles(input: { cwd: string; paths: string[] }): Promise<void> {
  await execFileAsync("git", ["restore", "--staged", "--", ...safePaths(input.cwd, input.paths)], { cwd: input.cwd });
}

async function unstagedDiff(cwd: string, path: string): Promise<string> {
  const options = { cwd, maxBuffer: 4 * 1024 * 1024 };
  const status = (await execFileAsync("git", ["status", "--porcelain=v1", "--", path], options)).stdout.slice(0, 2).trim();
  if (status === "?" || status === "??") {
    try {
      await execFileAsync("git", ["diff", "--no-index", "--no-ext-diff", "--unified=3", "--", "/dev/null", path], options);
    } catch (error) {
      return (error as { stdout?: string }).stdout ?? "";
    }
  }
  return (await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", "--", path], options)).stdout;
}

function selectedHunkPatch(diff: string, hunk: string): string {
  const lines = diff.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0) throw new Error("적용할 diff hunk를 찾을 수 없습니다.");
  const index = lines.findIndex((line, lineIndex) => lineIndex >= firstHunk && line === hunk);
  if (index < 0) throw new Error("파일이 변경되어 선택한 hunk를 다시 찾을 수 없습니다.");
  let end = index + 1;
  while (end < lines.length && !lines[end].startsWith("@@ ")) end += 1;
  return `${[...lines.slice(0, firstHunk), ...lines.slice(index, end)].join("\n")}\n`;
}

function applyPatch(cwd: string, patch: string, args: string[]): Promise<void> {
  return new Promise((resolveApply, reject) => {
    const child = spawn("git", ["apply", ...args, "-"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveApply() : reject(new Error(stderr.trim() || `git apply 실패 (${code})`)));
    child.stdin.end(patch);
  });
}

export async function applyWorkspaceHunk(input: { cwd: string; path: string; hunk: string; action: "stage" | "revert" }): Promise<void> {
  const path = safePaths(input.cwd, [input.path])[0];
  if (!input.hunk.startsWith("@@ ")) throw new Error("올바르지 않은 diff hunk입니다.");
  const patch = selectedHunkPatch(await unstagedDiff(input.cwd, path), input.hunk);
  await applyPatch(input.cwd, patch, input.action === "stage" ? ["--cached"] : ["--reverse"]);
}

export async function listGitBranches(input: { cwd: string }): Promise<GitBranchInfo[]> {
  const result = await execFileAsync("git", ["for-each-ref", "--format=%(refname:short)%09%(HEAD)", "refs/heads", "refs/remotes"], { cwd: input.cwd });
  return result.stdout.split("\n").filter(Boolean).filter((line) => !line.startsWith("origin/HEAD\t")).map((line) => {
    const [name, head] = line.split("\t");
    return { name, current: head === "*", remote: name.includes("/") };
  });
}

export async function switchGitBranch(input: { cwd: string; branch: string; create?: boolean }): Promise<void> {
  const branch = input.branch.trim();
  if (!branch || branch.startsWith("-")) throw new Error("브랜치 이름을 입력하세요.");
  await execFileAsync("git", ["check-ref-format", "--branch", branch], { cwd: input.cwd });
  let args = input.create ? ["switch", "-c", branch] : ["switch", branch];
  if (!input.create && branch.startsWith("origin/")) {
    const localBranch = branch.slice("origin/".length);
    const exists = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${localBranch}`], { cwd: input.cwd })
      .then(() => true)
      .catch(() => false);
    args = exists ? ["switch", localBranch] : ["switch", "--track", branch];
  }
  await execFileAsync("git", args, { cwd: input.cwd });
}

export async function commitWorkspace(input: { cwd: string; message: string; paths: string[] }): Promise<string> {
  const message = input.message.trim();
  if (!message) throw new Error("커밋 메시지를 입력하세요.");
  const result = await execFileAsync("git", ["commit", "--only", "-m", message, "--", ...safePaths(input.cwd, input.paths)], { cwd: input.cwd, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

export async function pushWorkspace(input: { cwd: string }): Promise<string> {
  try {
    const result = await execFileAsync("git", ["push"], { cwd: input.cwd, maxBuffer: 4 * 1024 * 1024 });
    return `${result.stdout}${result.stderr}`.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (!/no upstream branch|set-upstream/i.test(stderr)) throw error;
    const branch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: input.cwd })).stdout.trim();
    if (!branch) throw new Error("detached HEAD에서는 push할 수 없습니다.");
    const result = await execFileAsync("git", ["push", "--set-upstream", "origin", branch], { cwd: input.cwd, maxBuffer: 4 * 1024 * 1024 });
    return `${result.stdout}${result.stderr}`.trim();
  }
}

export async function createPullRequest(input: { cwd: string; draft: boolean }): Promise<string> {
  const branch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: input.cwd })).stdout.trim();
  if (!branch || branch === "main" || branch === "master") throw new Error("기본 브랜치에서는 Pull Request를 만들 수 없습니다. feature branch를 먼저 생성하세요.");
  const args = ["pr", "create", "--fill", "--head", branch];
  if (input.draft) args.push("--draft");
  const result = await execFileAsync("gh", args, { cwd: input.cwd, maxBuffer: 4 * 1024 * 1024 });
  const url = result.stdout.trim().split("\n").find((line) => /^https:\/\/github\.com\//.test(line));
  if (!url) throw new Error(result.stderr.trim() || "Pull Request URL을 확인할 수 없습니다.");
  return url;
}
