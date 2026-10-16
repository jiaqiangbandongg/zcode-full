import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCheckpointService } from "../src/git/gitCheckpointService.js";
import { GitCheckpointStore } from "../src/git/repo/gitCheckpointStore.js";
import { setDataBaseDir } from "../src/paths.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const describeIfGit = gitAvailable ? describe : describe.skip;
const tempDirs: string[] = [];
// 修复原因：这些用例会创建真实临时仓库并执行多次 Git 子进程；全量并发时磁盘与
// 子进程调度会超过 15 秒，但聚焦运行时业务断言稳定通过，统一保留合理的调度余量。
const GIT_INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const gitLocalEnvVars = gitAvailable
  ? execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf-8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  : [];

function createDetachedGitEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
  };

  // Bugfix: pre-push hook 会携带当前仓库的 GIT_DIR/GIT_WORK_TREE。
  // 这些变量会让临时仓库测试命令“串仓”，把真实工作分支误改名。
  // 测试 helper 在这里清理 Git local env，保证命令只作用于目标 cwd 仓库。
  for (const variableName of gitLocalEnvVars) {
    delete env[variableName];
  }

  return env;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string | undefined, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: createDetachedGitEnv(),
  }).trim();
}

function createRepo() {
  const repoPath = makeTempDir("zcode-git-checkpoint-repo-");
  const dataBaseDir = makeTempDir("zcode-git-checkpoint-data-");
  setDataBaseDir(dataBaseDir);
  const workspacePath = join(repoPath, "packages", "app");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(repoPath, "packages", "other"), { recursive: true });

  writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2\n");
  writeFileSync(join(workspacePath, "delete-me.txt"), "delete me\n");
  writeFileSync(join(workspacePath, "rename-me.txt"), "rename me\n");
  writeFileSync(join(workspacePath, "stage-me.txt"), "stage base\n");
  writeFileSync(join(repoPath, "packages", "other", "skip.txt"), "skip\n");

  runGit(repoPath, ["init"]);
  runGit(repoPath, ["branch", "-M", "main"]);
  runGit(repoPath, ["config", "user.name", "ZCode Tester"]);
  runGit(repoPath, ["config", "user.email", "tester@example.com"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  runGit(repoPath, ["config", "core.autocrlf", "false"]);
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "chore: initial"]);

  return { dataBaseDir, repoPath, workspacePath };
}

afterEach(() => {
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describeIfGit("gitCheckpointService", () => {
  it("creates workspace-scoped checkpoints, diffs them, and restores files without touching staged state", async () => {
    const { dataBaseDir, repoPath, workspacePath } = createRepo();
    const service = createGitCheckpointService({
      store: new GitCheckpointStore({ rootDir: join(repoPath, ".zcode-test-checkpoints") }),
    });

    const base = await service.createCheckpoint({ workspacePath });

    writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2 changed\n");
    rmSync(join(workspacePath, "delete-me.txt"));
    runGit(repoPath, ["mv", "packages/app/rename-me.txt", "packages/app/renamed.txt"]);
    writeFileSync(join(workspacePath, "new-file.txt"), "new file\n");
    writeFileSync(join(workspacePath, "stage-me.txt"), "stage changed\n");
    writeFileSync(join(repoPath, "packages", "other", "skip.txt"), "skip changed\n");
    runGit(repoPath, ["add", "packages/app/stage-me.txt"]);

    const stagedBeforeRestore = runGit(repoPath, ["diff", "--cached", "--name-only"]);
    const changed = await service.createCheckpoint({ workspacePath });
    const diff = await service.diffCheckpoints({
      workspacePath,
      fromCheckpointId: base.checkpointId,
      toCheckpointId: changed.checkpointId,
    });

    expect(diff.files.map((file) => `${file.kind}:${file.workspaceRelativePath}`).sort()).toEqual([
      "added:new-file.txt",
      "deleted:delete-me.txt",
      "modified:stage-me.txt",
      "modified:tracked.txt",
      "renamed:renamed.txt",
    ]);
    expect(diff.files.some((file) => file.repoRelativePath.includes("packages/other"))).toBe(false);

    const restoreResult = await service.restoreBetweenCheckpoints({
      workspacePath,
      fromCheckpointId: changed.checkpointId,
      toCheckpointId: base.checkpointId,
    });

    expect(restoreResult.success).toBe(true);
    expect(readFileSync(join(workspacePath, "tracked.txt"), "utf-8")).toBe("line 1\nline 2\n");
    expect(readFileSync(join(workspacePath, "delete-me.txt"), "utf-8")).toBe("delete me\n");
    expect(() => readFileSync(join(workspacePath, "new-file.txt"), "utf-8")).toThrow();
    expect(() => readFileSync(join(workspacePath, "renamed.txt"), "utf-8")).toThrow();
    expect(readFileSync(join(workspacePath, "rename-me.txt"), "utf-8")).toBe("rename me\n");
    expect(readFileSync(join(repoPath, "packages", "other", "skip.txt"), "utf-8")).toBe(
      "skip changed\n",
    );
    expect(runGit(repoPath, ["diff", "--cached", "--name-only"])).toBe(stagedBeforeRestore);
    expect(readdirSync(join(dataBaseDir, ".zcode", "git-checkpoint-index"))).toEqual([]);
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);

  it("returns conflicts when affected files drift away from the declared fromCheckpoint and supports force restore", async () => {
    const { repoPath, workspacePath } = createRepo();
    const service = createGitCheckpointService({
      store: new GitCheckpointStore({ rootDir: join(repoPath, ".zcode-test-checkpoints") }),
    });

    const base = await service.createCheckpoint({ workspacePath });
    writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2 changed\n");
    const changed = await service.createCheckpoint({ workspacePath });

    writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2 changed again\n");

    const conflicted = await service.restoreBetweenCheckpoints({
      workspacePath,
      fromCheckpointId: changed.checkpointId,
      toCheckpointId: base.checkpointId,
    });
    expect(conflicted.success).toBe(false);
    expect(conflicted.conflicts?.map((conflict) => conflict.workspaceRelativePath)).toEqual([
      "tracked.txt",
    ]);

    const forced = await service.restoreBetweenCheckpoints({
      workspacePath,
      fromCheckpointId: changed.checkpointId,
      toCheckpointId: base.checkpointId,
      force: true,
    });
    expect(forced.success).toBe(true);
    expect(readFileSync(join(workspacePath, "tracked.txt"), "utf-8")).toBe("line 1\nline 2\n");

    await service.deleteCheckpoint({ workspacePath, checkpointId: changed.checkpointId });
    await expect(
      service.diffCheckpoints({
        workspacePath,
        fromCheckpointId: base.checkpointId,
        toCheckpointId: changed.checkpointId,
      }),
    ).rejects.toThrow(`Checkpoint does not exist: ${changed.checkpointId}`);
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);
});
