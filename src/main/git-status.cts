import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, resolve, sep } from "node:path";
import type { WorkspaceChange, WorkspaceChanges, WorkspaceDiff } from "./contracts.cjs";

const execFileAsync = promisify(execFile);
const isBinaryDiff = (text: string): boolean => /^Binary files .+ differ$/m.test(text) || /^GIT binary patch$/m.test(text);
const statFromNumstat = (text: string): { additions: number; deletions: number } => {
  const [added = "0", deleted = "0"] = text.trim().split("\t");
  return { additions: Number(added) || 0, deletions: Number(deleted) || 0 };
};

export interface GitRevisionChange extends WorkspaceChange {
  previousPath?: string;
  diff: string;
  binary: boolean;
}

interface GitPathChange {
  status: string;
  path: string;
  previousPath?: string;
}

interface GitNumstat {
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

const revisionOptions = (cwd: string) => ({ cwd, maxBuffer: 8 * 1024 * 1024 });

const resolveGitCommitOid = async (cwd: string, revision: string): Promise<string | undefined> => {
  if (!revision.trim()) return undefined;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], revisionOptions(cwd));
    const oid = result.stdout.trim();
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(oid) ? oid : undefined;
  } catch {
    return undefined;
  }
};

const parseNameStatus = (text: string): GitPathChange[] => {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: GitPathChange[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++] ?? "";
    const status = rawStatus.slice(0, 1);
    if (status === "R") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath !== undefined && path !== undefined) changes.push({ status, path, previousPath });
      continue;
    }
    const path = fields[index++];
    if (path !== undefined && ["A", "M", "D"].includes(status)) changes.push({ status, path });
  }
  return changes;
};

const parseNumstat = (text: string): GitNumstat[] => {
  const stats: GitNumstat[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf("\0", offset);
    if (end < 0) break;
    const header = text.slice(offset, end);
    offset = end + 1;
    const firstTab = header.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : header.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = header.slice(0, firstTab);
    const deleted = header.slice(firstTab + 1, secondTab);
    let path = header.slice(secondTab + 1);
    let previousPath: string | undefined;
    if (!path) {
      const previousEnd = text.indexOf("\0", offset);
      if (previousEnd < 0) break;
      previousPath = text.slice(offset, previousEnd);
      offset = previousEnd + 1;
      const pathEnd = text.indexOf("\0", offset);
      if (pathEnd < 0) break;
      path = text.slice(offset, pathEnd);
      offset = pathEnd + 1;
    }
    stats.push({
      path,
      previousPath,
      additions: Number(added) || 0,
      deletions: Number(deleted) || 0,
      binary: added === "-" || deleted === "-",
    });
  }
  return stats;
};

/** Returns the current commit OID, or undefined outside a Git repository or before the first commit. */
export async function getGitHeadOid(cwd: string): Promise<string | undefined> {
  return resolveGitCommitOid(cwd, "HEAD");
}

/** Returns committed file changes between two revisions; invalid revisions and unavailable Git yield an empty list. */
export async function getGitRevisionChanges(cwd: string, fromRevision: string, toRevision: string): Promise<GitRevisionChange[]> {
  const [fromOid, toOid] = await Promise.all([
    resolveGitCommitOid(cwd, fromRevision),
    resolveGitCommitOid(cwd, toRevision),
  ]);
  if (!fromOid || !toOid || fromOid === toOid) return [];
  try {
    const options = revisionOptions(cwd);
    const [namesResult, statsResult] = await Promise.all([
      execFileAsync("git", ["diff", "--name-status", "-z", "--find-renames", "--diff-filter=AMDR", fromOid, toOid, "--"], options),
      execFileAsync("git", ["diff", "--numstat", "-z", "--find-renames", "--diff-filter=AMDR", fromOid, toOid, "--"], options),
    ]);
    const statsByPath = new Map(parseNumstat(statsResult.stdout).map((stat) => [stat.path, stat]));
    const changes: GitRevisionChange[] = [];
    for (const change of parseNameStatus(namesResult.stdout)) {
      const stat = statsByPath.get(change.path);
      const pathspecs = change.previousPath ? [change.previousPath, change.path] : [change.path];
      let diff = "";
      try {
        diff = (await execFileAsync("git", [
          "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=3",
          fromOid, toOid, "--", ...pathspecs,
        ], options)).stdout;
      } catch {
        // A single oversized or unreadable diff must not hide the other committed changes.
      }
      changes.push({
        status: change.status,
        path: change.path,
        previousPath: change.previousPath,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        diff,
        binary: stat?.binary === true || isBinaryDiff(diff),
      });
    }
    return changes;
  } catch {
    return [];
  }
}

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
