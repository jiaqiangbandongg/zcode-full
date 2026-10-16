import { describe, expect, it } from "vitest";
import {
  buildGitBranchAutoCommitMessage,
  buildGitBranchCommitPreviewFiles,
  getGitDirtyFileCount,
  getGitBranchCommitTotals,
  isGitBranchCommitAssistIssue,
  matchesGitBranchSearch,
  resolveGitBranchIssueMessageId,
  resolveGitBranchSuccessMessageId,
  resolveGitBranchTriggerLabel,
  selectGitBranchAffectedFiles,
} from "../src/git-branch-switcher/display.js";

describe("getGitDirtyFileCount", () => {
  it("deduplicates files that appear in both staged and unstaged datasets", () => {
    expect(
      getGitDirtyFileCount({
        unstaged: {
          sections: [
            {
              changes: [{ path: "src/app.ts" }, { path: "src/main.ts" }],
            },
          ],
        },
        staged: {
          sections: [
            {
              changes: [{ path: "src/app.ts" }, { path: "README.md" }],
            },
          ],
        },
      }),
    ).toBe(3);
  });
});

describe("resolveGitBranchTriggerLabel", () => {
  it("shows detached label when HEAD is detached", () => {
    expect(
      resolveGitBranchTriggerLabel({
        headRefType: "detached",
        currentBranchName: "main",
        detachedLabel: "Detached HEAD",
        fallbackLabel: "Branch",
      }),
    ).toBe("Detached HEAD");
  });

  it("falls back when current branch name is empty", () => {
    expect(
      resolveGitBranchTriggerLabel({
        headRefType: "branch",
        currentBranchName: "   ",
        detachedLabel: "Detached HEAD",
        fallbackLabel: "Branch",
      }),
    ).toBe("Branch");
  });
});

describe("matchesGitBranchSearch", () => {
  it("matches branch names case-insensitively", () => {
    expect(matchesGitBranchSearch("feature/Git-UI", "git")).toBe(true);
    expect(matchesGitBranchSearch("feature/Git-UI", "main")).toBe(false);
  });
});

describe("branch mutation message helpers", () => {
  it("maps known issue codes to i18n ids", () => {
    expect(
      resolveGitBranchIssueMessageId({
        code: "tracked-changes-would-be-overwritten",
        message: "blocked",
      }),
    ).toBe("git.branchSwitcher.error.trackedOverwrite");
    expect(
      resolveGitBranchIssueMessageId({
        code: "unknown",
        message: "blocked",
      }),
    ).toBeNull();
  });

  it("returns different success ids for switch and create-and-switch", () => {
    expect(
      resolveGitBranchSuccessMessageId({
        action: "switch",
        created: false,
        didChange: true,
      }),
    ).toBe("git.branchSwitcher.toast.switchSuccess");
    expect(
      resolveGitBranchSuccessMessageId({
        action: "create-and-switch",
        created: true,
        didChange: true,
      }),
    ).toBe("git.branchSwitcher.toast.createSuccess");
    expect(
      resolveGitBranchSuccessMessageId({
        action: "switch",
        created: false,
        didChange: false,
      }),
    ).toBeNull();
  });
});

describe("branch switch commit assist helpers", () => {
  it("recognizes overwrite issues as commit-assist candidates", () => {
    expect(isGitBranchCommitAssistIssue("tracked-changes-would-be-overwritten")).toBe(true);
    expect(isGitBranchCommitAssistIssue("untracked-changes-would-be-overwritten")).toBe(true);
    expect(isGitBranchCommitAssistIssue("operation-in-progress")).toBe(false);
  });

  it("merges staged and unstaged copies of the same file into one preview row", () => {
    const files = buildGitBranchCommitPreviewFiles([
      {
        path: "/repo/src/app.ts",
        repoRelativePath: "src/app.ts",
        workspaceRelativePath: "src/app.ts",
        kind: "modified",
        section: "unstaged",
        added: 3,
        removed: 1,
        isStaged: false,
        isUntracked: false,
        isConflicted: false,
      },
      {
        path: "/repo/src/app.ts",
        repoRelativePath: "src/app.ts",
        workspaceRelativePath: "src/app.ts",
        kind: "modified",
        section: "staged",
        added: 2,
        removed: 4,
        isStaged: true,
        isUntracked: false,
        isConflicted: false,
      },
      {
        path: "/repo/src/other.ts",
        repoRelativePath: "src/other.ts",
        workspaceRelativePath: "src/other.ts",
        kind: "added",
        section: "unstaged",
        added: 5,
        removed: 0,
        isStaged: false,
        isUntracked: true,
        isConflicted: false,
      },
    ]);

    expect(files).toEqual([
      {
        stagePath: "/repo/src/app.ts",
        repoRelativePath: "src/app.ts",
        workspaceRelativePath: "src/app.ts",
        kind: "modified",
        added: 5,
        removed: 5,
      },
      {
        stagePath: "/repo/src/other.ts",
        repoRelativePath: "src/other.ts",
        workspaceRelativePath: "src/other.ts",
        kind: "added",
        added: 5,
        removed: 0,
      },
    ]);
    expect(getGitBranchCommitTotals(files)).toEqual({
      fileCount: 2,
      totalAdded: 10,
      totalRemoved: 5,
    });
  });

  it("falls back to raw issue paths when a blocking file is outside the loaded preview list", () => {
    expect(
      selectGitBranchAffectedFiles({
        files: [
          {
            stagePath: "/repo/src/app.ts",
            repoRelativePath: "src/app.ts",
            workspaceRelativePath: "src/app.ts",
            kind: "modified",
            added: 1,
            removed: 2,
          },
        ],
        issuePaths: ["src/app.ts", "packages/ui/src/GitBranchSwitcher.tsx"],
      }),
    ).toEqual([
      {
        stagePath: "/repo/src/app.ts",
        repoRelativePath: "src/app.ts",
        workspaceRelativePath: "src/app.ts",
        kind: "modified",
        added: 1,
        removed: 2,
      },
      {
        stagePath: "packages/ui/src/GitBranchSwitcher.tsx",
        repoRelativePath: "packages/ui/src/GitBranchSwitcher.tsx",
        workspaceRelativePath: "packages/ui/src/GitBranchSwitcher.tsx",
        kind: "modified",
        added: 0,
        removed: 0,
      },
    ]);
  });

  it("builds a stable autogenerated checkpoint commit message", () => {
    expect(buildGitBranchAutoCommitMessage("feature/git-ui")).toBe(
      "chore: checkpoint before switching to feature/git-ui",
    );
    expect(buildGitBranchAutoCommitMessage("  ")).toBe(
      "chore: checkpoint before switching branches",
    );
  });
});
