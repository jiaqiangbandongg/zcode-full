import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GIT_PUSH_OUTPUT_BYTES, DEFAULT_GIT_PUSH_TIMEOUT_MS } from "../src/git/config.js";
import type {
  GitCommandExecutionOptions,
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";
import { createGitService } from "../src/git/gitService.js";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

const tempDirs: string[] = [];

function createCommandResult(
  options: GitCommandExecutionOptions,
  overrides?: Partial<GitCommandExecutionResult>,
): GitCommandExecutionResult {
  return {
    binaryPath: "git",
    cwd: options.cwd,
    args: options.args,
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createMockCommandProvider(): {
  commandProvider: GitCommandProvider;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(
    async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
      const command = options.args.join(" ");
      switch (command) {
        case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
          return createCommandResult(options, {
            stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
          });
        case "status --porcelain=v2 --branch --untracked-files=all -z":
          return createCommandResult(options, {
            stdout: "# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0",
          });
        case "diff --cached --numstat -z --find-renames --":
        case "diff --numstat -z --find-renames --":
          return createCommandResult(options);
        case "config --show-scope --show-origin --get user.name":
          return createCommandResult(options, {
            stdout: "local\tfile:.git/config\tZCode Tester\n",
          });
        case "config --show-scope --show-origin --get user.email":
          return createCommandResult(options, {
            stdout: "local\tfile:.git/config\ttester@example.com\n",
          });
        case "push":
          return createCommandResult(options);
        default:
          throw new Error(`Unexpected git command in test: ${command}`);
      }
    },
  );

  return {
    commandProvider: {
      resolveGitBinary: vi.fn().mockResolvedValue("git"),
      run,
    },
    run,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("gitCliRepo", () => {
  it("reuses the in-flight status snapshot for concurrent readers", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    const [left, right] = await Promise.all([
      repo.getStatus(workspacePath),
      repo.getStatus(workspacePath),
    ]);

    expect(left.summary.repoRoot).toBe("/repo");
    expect(right.summary.workspaceInRepoPath).toBe("packages/app");
    expect(run.mock.calls.map(([options]) => options.args.join(" "))).toEqual([
      "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir",
      "status --porcelain=v2 --branch --untracked-files=all -z",
      "diff --cached --numstat -z --find-renames --",
      "diff --numstat -z --find-renames --",
    ]);
  });

  it("详细状态超限后应按 repoRoot 复用未跟踪目录折叠模式", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    run.mockImplementation(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
            });
          case "status --porcelain=v2 --branch --untracked-files=all -z":
            return createCommandResult(options, {
              stdout: "# branch.head main\0? packages/app/.npm/cache/partial-entry\0",
              outputTruncated: true,
            });
          case "status --porcelain=v2 --branch --untracked-files=normal -z":
            return createCommandResult(options, {
              stdout: "# branch.head main\0? packages/app/.npm/\0",
            });
          case "diff --cached --numstat -z --find-renames --":
          case "diff --numstat -z --find-renames --":
            return createCommandResult(options);
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({ commandProvider });
    const service = createGitService({ repo });
    const workspacePath = "/repo/packages/app";

    const first = await repo.getStatus(workspacePath);
    const second = await repo.getStatus(workspacePath);
    const changes = await service.getChanges({ workspacePath, sourceId: "unstaged" });

    expect(first.summary).toMatchObject({ branchName: "main", isDirty: true });
    expect(first.entries.map((entry) => entry.path)).toEqual(["packages/app/.npm/"]);
    expect(second.entries.map((entry) => entry.path)).toEqual(["packages/app/.npm/"]);
    expect(changes).toEqual([
      expect.objectContaining({
        workspaceRelativePath: ".npm/",
        section: "untracked",
        added: 0,
        removed: 0,
      }),
    ]);
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") === "status --porcelain=v2 --branch --untracked-files=all -z",
      ),
    ).toHaveLength(1);
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") === "status --porcelain=v2 --branch --untracked-files=normal -z",
      ),
    ).toHaveLength(3);
  });

  it("reuses the in-flight repository resolution across status and identity reads", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    const [status, identity] = await Promise.all([
      repo.getStatus(workspacePath),
      repo.getIdentity(workspacePath),
    ]);

    expect(status.summary.repoRoot).toBe("/repo");
    expect(identity.userName).toBe("ZCode Tester");
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") ===
          "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir",
      ),
    ).toHaveLength(1);
  });

  it("identifies main-tree workspaces via repoRoot/.git directory", async () => {
    const repoRoot = makeTempDir("zcode-git-main-tree-");
    mkdirSync(join(repoRoot, ".git"));
    const workspacePath = join(repoRoot, "packages", "app");
    mkdirSync(workspacePath, { recursive: true });
    const { commandProvider } = createMockCommandProvider();
    commandProvider.run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: `${repoRoot}\npackages/app/\n${join(repoRoot, ".git")}\n.git\n`,
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({ commandProvider });

    await expect(repo.getWorkspaceRepositoryInfo(workspacePath)).resolves.toEqual({
      workspacePath,
      kind: "main-tree",
      isGitAvailable: true,
    });
  });

  it("identifies linked worktree workspaces via repoRoot/.git file", async () => {
    const mainTreeRoot = makeTempDir("zcode-git-worktree-main-");
    mkdirSync(join(mainTreeRoot, ".git", "worktrees", "feature"), { recursive: true });
    const worktreeRoot = makeTempDir("zcode-git-worktree-linked-");
    writeFileSync(
      join(worktreeRoot, ".git"),
      `gitdir: ${join(mainTreeRoot, ".git", "worktrees", "feature")}\n`,
      "utf-8",
    );
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: `${worktreeRoot}\n\n${join(mainTreeRoot, ".git", "worktrees", "feature")}\n${join(mainTreeRoot, ".git")}\n`,
            });
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(repo.getWorkspaceRepositoryInfo(worktreeRoot)).resolves.toEqual({
      workspacePath: worktreeRoot,
      kind: "linked-worktree",
      isGitAvailable: true,
    });
  });

  it("includes worktree gitdir and common gitdir in status auto-refresh watch paths", async () => {
    const worktreeRoot = "/repo-linked";
    const worktreeGitDir = "/repo-main/.git/worktrees/repo-linked";
    const commonGitDir = "/repo-main/.git";
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: `${worktreeRoot}\n\n${worktreeGitDir}\n${commonGitDir}\n`,
            });
          case "status --porcelain=v2 --branch --untracked-files=all -z":
            return createCommandResult(options, {
              stdout: "# branch.head feature\0",
            });
          case "diff --cached --numstat -z --find-renames --":
          case "diff --numstat -z --find-renames --":
            return createCommandResult(options);
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    const status = await repo.getStatus(worktreeRoot);

    expect(status.summary.autoRefreshWatchPaths).toEqual([
      {
        path: worktreeGitDir,
        recursive: true,
      },
      {
        path: commonGitDir,
        recursive: true,
      },
    ]);
  });

  it("resolves a relative common git dir from the workspace command cwd", async () => {
    // 根因：本用例是唯一走「相对 --git-common-dir + 宿主 resolve()」的分支，其它用例只做字面量
    // 比较。原来用 POSIX 字面量 "/root/.git" 作断言，而 resolve("/root/demo-project","../.git")
    // 在 win32 上得到 "C:\root\.git" —— 两者不相等，去重失败，watch 路径多出一条。
    // 用宿主 path 组装 fixture，让断言在三个平台上表达同一个"仓库根下的 .git"。
    const repoRoot = resolve("/root");
    const workspacePath = join(repoRoot, "demo-project");
    const absoluteGitDir = join(repoRoot, ".git");
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: `${repoRoot}\ndemo-project/\n${absoluteGitDir}\n../.git\n`,
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    const resolution = await repo.resolveRepository(workspacePath);

    expect(resolution.autoRefreshWatchPaths).toEqual([
      {
        path: absoluteGitDir,
        recursive: true,
      },
    ]);
  });

  it("treats spawn git ENOENT during repository resolution as not-repository", async () => {
    const workspacePath = "/missing/worktree-path";
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            exitCode: -2,
            stderr: "spawn git ENOENT",
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(repo.getWorkspaceRepositoryInfo(workspacePath)).resolves.toEqual({
      workspacePath,
      kind: "not-repository",
      isGitAvailable: true,
    });
  });

  it("uses the dedicated long timeout and larger output budget for push hooks", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    await repo.push(workspacePath);

    const pushCall = run.mock.calls.find(([options]) => options.args.join(" ") === "push");
    expect(pushCall?.[0].timeoutMs).toBe(DEFAULT_GIT_PUSH_TIMEOUT_MS);
    expect(pushCall?.[0].maxOutputBytes).toBe(DEFAULT_GIT_PUSH_OUTPUT_BYTES);
  });

  it("checks ignored paths from argv without using incompatible -z output", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    run.mockImplementation(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
          });
        }
        if (command === "check-ignore -- packages/app/.env packages/app/src/index.ts") {
          return createCommandResult(options, {
            stdout: "packages/app/.env\n",
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );

    await expect(
      repo.getIgnoredPaths(workspacePath, [
        "/repo/packages/app/.env",
        "/repo/packages/app/src/index.ts",
      ]),
    ).resolves.toEqual(["/repo/packages/app/.env"]);
  });

  it("keeps a valid unstaged patch when the working-tree content cannot be read", async () => {
    const workspacePath = "/repo/packages/app";
    const filePath = "/repo/packages/app/index.vue";
    const patch = [
      "diff --git a/packages/app/index.vue b/packages/app/index.vue",
      "index 1111111..2222222 100644",
      "--- a/packages/app/index.vue",
      "+++ b/packages/app/index.vue",
      "@@ -1,2 +1,3 @@",
      " <template>",
      "+  <SearchSelect />",
      " </template>",
      "",
    ].join("\n");
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
            });
          case "diff --no-ext-diff --no-color --binary -- packages/app/index.vue":
            return createCommandResult(options, { stdout: patch });
          case "show :packages/app/index.vue":
            return createCommandResult(options, {
              stdout: "<template>\n</template>\n",
            });
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(
      repo.getDiff({
        workspacePath,
        path: filePath,
        sourceId: "unstaged",
      }),
    ).resolves.toEqual({
      path: filePath,
      availability: "patch",
      patch,
      beforeContent: null,
      afterContent: null,
      summary: null,
    });
  });
});
