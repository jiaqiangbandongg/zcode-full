import { describe, expect, it } from "vitest";
import type {
  GitRepositorySummary,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";
import {
  filterCommitPreviewFilesByCurrentSession,
  getCurrentSessionFilePaths,
} from "@/git-action-menu/currentSessionFileScope.js";

function createGitSummary(): GitRepositorySummary {
  return {
    workspacePath: "/repo/packages/app",
    repoRoot: "/repo",
    workspaceInRepoPath: "packages/app",
    autoRefreshWatchPaths: [],
    branchName: "main",
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: true,
    isGitAvailable: true,
    isRepository: true,
  };
}

function createChange(
  workspaceRelativePath: string,
): GitBranchCommitPreviewFile {
  return {
    stagePath: `/repo/packages/app/${workspaceRelativePath}`,
    repoRelativePath: `packages/app/${workspaceRelativePath}`,
    workspaceRelativePath,
    kind: "modified",
    added: 1,
    removed: 0,
  };
}

function createSummary(path: string): ZCodeTaskChangeSummary {
  return {
    fileCount: 1,
    added: 1,
    removed: 0,
    files: [
      {
        path,
        added: 1,
        removed: 0,
        writeCount: 1,
        lastTurnIndex: 0,
      },
    ],
  };
}

describe("current session commit file scope", () => {
  it("filters commit preview files to the current session summary", () => {
    const files = [createChange("session.txt"), createChange("unrelated.txt")];

    const filtered = filterCommitPreviewFilesByCurrentSession({
      files,
      summary: createSummary("/repo/packages/app/session.txt"),
      gitSummary: createGitSummary(),
      workspacePath: "/repo/packages/app",
    });

    expect(filtered.map((file) => file.workspaceRelativePath)).toEqual([
      "session.txt",
    ]);
  });

  it("matches workspace-relative summary paths against repo-relative files", () => {
    const files = [createChange("nested/session.txt"), createChange("other.txt")];

    const filtered = filterCommitPreviewFilesByCurrentSession({
      files,
      summary: createSummary("nested/session.txt"),
      gitSummary: createGitSummary(),
      workspacePath: "/repo/packages/app",
    });

    expect(filtered.map((file) => file.repoRelativePath)).toEqual([
      "packages/app/nested/session.txt",
    ]);
    expect(getCurrentSessionFilePaths(createSummary("nested/session.txt"))).toEqual([
      "nested/session.txt",
    ]);
  });
});
