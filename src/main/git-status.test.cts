import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getGitHeadOid, getGitRevisionChanges } from "./git-status.cjs";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
};

test("revision changes survive a clean worktree after the second commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devil-git-status-"));
  try {
    await git(directory, ["init"]);
    await git(directory, ["config", "user.name", "Devil Codex Test"]);
    await git(directory, ["config", "user.email", "devil-codex@example.test"]);
    await git(directory, ["config", "core.autocrlf", "false"]);
    assert.equal(await getGitHeadOid(directory), undefined);

    await Promise.all([
      writeFile(join(directory, "modified.txt"), "one\n"),
      writeFile(join(directory, "deleted.txt"), "remove me\n"),
      writeFile(join(directory, "rename source.txt"), "rename content\n"),
      writeFile(join(directory, "binary.dat"), Buffer.from([0, 1, 2, 3])),
    ]);
    await git(directory, ["add", "--all"]);
    await git(directory, ["commit", "-m", "base"]);
    const before = await getGitHeadOid(directory);
    assert.match(before ?? "", /^[0-9a-f]{40,64}$/);

    await Promise.all([
      writeFile(join(directory, "modified.txt"), "one\ntwo\n"),
      writeFile(join(directory, "added file.txt"), "added\n"),
      writeFile(join(directory, "binary.dat"), Buffer.from([0, 1, 2, 4])),
      unlink(join(directory, "deleted.txt")),
      rename(join(directory, "rename source.txt"), join(directory, "renamed file.txt")),
    ]);
    await git(directory, ["add", "--all"]);
    await git(directory, ["commit", "-m", "change files"]);
    const after = await getGitHeadOid(directory);
    assert.match(after ?? "", /^[0-9a-f]{40,64}$/);
    assert.notEqual(after, before);
    assert.equal(await git(directory, ["status", "--porcelain"]), "");

    const changes = await getGitRevisionChanges(directory, before!, after!);
    const byPath = new Map(changes.map((change) => [change.path, change]));

    assert.deepEqual(
      [...byPath.keys()].sort(),
      ["added file.txt", "binary.dat", "deleted.txt", "modified.txt", "renamed file.txt"],
    );
    assert.deepEqual(
      { ...byPath.get("added file.txt"), diff: undefined },
      {
        path: "added file.txt",
        status: "A",
        additions: 1,
        deletions: 0,
        binary: false,
        diff: undefined,
        previousPath: undefined,
      },
    );
    assert.match(byPath.get("added file.txt")?.diff ?? "", /\+added/);

    assert.equal(byPath.get("modified.txt")?.status, "M");
    assert.equal(byPath.get("modified.txt")?.additions, 1);
    assert.equal(byPath.get("modified.txt")?.deletions, 0);
    assert.match(byPath.get("modified.txt")?.diff ?? "", /\+two/);

    assert.equal(byPath.get("deleted.txt")?.status, "D");
    assert.equal(byPath.get("deleted.txt")?.additions, 0);
    assert.equal(byPath.get("deleted.txt")?.deletions, 1);
    assert.match(byPath.get("deleted.txt")?.diff ?? "", /-remove me/);

    assert.deepEqual(
      {
        status: byPath.get("renamed file.txt")?.status,
        previousPath: byPath.get("renamed file.txt")?.previousPath,
      },
      { status: "R", previousPath: "rename source.txt" },
    );
    assert.match(byPath.get("renamed file.txt")?.diff ?? "", /similarity index 100%/);

    assert.equal(byPath.get("binary.dat")?.status, "M");
    assert.equal(byPath.get("binary.dat")?.binary, true);
    assert.equal(byPath.get("binary.dat")?.additions, 0);
    assert.equal(byPath.get("binary.dat")?.deletions, 0);
    assert.match(byPath.get("binary.dat")?.diff ?? "", /Binary files/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revision helpers fall back safely outside Git and for invalid revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devil-git-status-empty-"));
  try {
    assert.equal(await getGitHeadOid(directory), undefined);
    assert.deepEqual(await getGitRevisionChanges(directory, "missing-a", "missing-b"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
