import { describe, expect, it } from "vitest";
import {
  buildGitAutoRefreshWatchPaths,
  parseGitAutoRefreshWatchPaths,
  shouldEnableGitAutoRefreshForWorkspace,
  stringifyGitAutoRefreshWatchPaths,
} from "@/lib/gitAutoRefresh.js";

describe("buildGitAutoRefreshWatchPaths", () => {
  it("does not watch stale Git state after switching workspace identity", () => {
    expect(
      shouldEnableGitAutoRefreshForWorkspace({
        enabled: true,
        currentWorkspaceKey: "remote:ssh:root@server-b:/root",
        summaryWorkspaceKey: "remote:ssh:root@server-a:/root",
      }),
    ).toBe(false);
    expect(
      shouldEnableGitAutoRefreshForWorkspace({
        enabled: true,
        currentWorkspaceKey: "remote:ssh:root@server-b:/root",
        summaryWorkspaceKey: "remote:ssh:root@server-b:/root",
      }),
    ).toBe(true);
  });

  it("keeps the recursive workspace watcher on non-Linux platforms", () => {
    expect(
      buildGitAutoRefreshWatchPaths(
        {
          workspacePath: "/repo",
          repoRoot: "/repo",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [{ path: "/repo/.git", recursive: true }],
        },
        { platform: "darwin" },
      ),
    ).toEqual([
      {
        path: "/repo",
        recursive: true,
      },
      {
        path: "/repo/.git",
        recursive: true,
      },
    ]);
  });

  it("watches only Git metadata paths on Linux", () => {
    expect(
      buildGitAutoRefreshWatchPaths(
        {
          workspacePath: "/home/user",
          repoRoot: "/home/user",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [
            { path: "/home/user", recursive: true },
            { path: "/home/user/.git", recursive: true },
          ],
        },
        { platform: "linux" },
      ),
    ).toEqual([
      {
        path: "/home/user/.git",
        recursive: true,
      },
    ]);
  });

  it("keeps the conservative metadata-only policy before the workspace Host platform is known", () => {
    expect(
      buildGitAutoRefreshWatchPaths({
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: true,
        isRepository: true,
        autoRefreshWatchPaths: [
          { path: "/repo", recursive: true },
          { path: "/repo/.git", recursive: true },
        ],
      }),
    ).toEqual([
      {
        path: "/repo/.git",
        recursive: true,
      },
    ]);
  });

  it("does not reintroduce a legacy workspace path from an old server summary on Linux", () => {
    expect(
      buildGitAutoRefreshWatchPaths(
        {
          workspacePath: "/repo",
          repoRoot: "/repo",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [
            { path: "/repo/", recursive: true },
            { path: "/repo/.git", recursive: true },
          ],
        },
        { platform: "linux" },
      ),
    ).toEqual([
      {
        path: "/repo/.git",
        recursive: true,
      },
    ]);
  });

  it("also watches Git metadata paths returned by the repository summary", () => {
    expect(
      buildGitAutoRefreshWatchPaths(
        {
          workspacePath: "/worktree",
          repoRoot: "/worktree",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [
            { path: "/main/.git/worktrees/worktree", recursive: true },
            { path: "/main/.git", recursive: true },
          ],
        },
        { platform: "win32" },
      ),
    ).toEqual([
      {
        path: "/worktree",
        recursive: true,
      },
      {
        path: "/main/.git/worktrees/worktree",
        recursive: true,
      },
      {
        path: "/main/.git",
        recursive: true,
      },
    ]);
  });

  it("does not watch when git is unavailable or the workspace is not a repository", () => {
    expect(
      buildGitAutoRefreshWatchPaths({
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: false,
        isRepository: true,
      }),
    ).toEqual([]);

    expect(
      buildGitAutoRefreshWatchPaths({
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: true,
        isRepository: false,
      }),
    ).toEqual([]);
  });

  it("keeps the same signature for equivalent watch paths", () => {
    const first = buildGitAutoRefreshWatchPaths(
      {
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: true,
        isRepository: true,
        autoRefreshWatchPaths: [{ path: "/repo/.git", recursive: true }],
      },
      { platform: "linux" },
    );
    const second = buildGitAutoRefreshWatchPaths(
      {
        workspacePath: "/repo",
        repoRoot: "/repo",
        isGitAvailable: true,
        isRepository: true,
        autoRefreshWatchPaths: [{ path: "/repo/.git/", recursive: true }],
      },
      { platform: "linux" },
    );

    const signature = stringifyGitAutoRefreshWatchPaths(first);

    expect(stringifyGitAutoRefreshWatchPaths(second)).toBe(signature);
    expect(parseGitAutoRefreshWatchPaths(signature)).toEqual(first);
  });
});
