/** @vitest-environment jsdom */

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitRepositorySummary } from "@zcode/shared";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/GitActionMenu.js", () => ({
  GitActionMenu: () => createElement("div", { "data-testid": "mock-git-action-menu" }),
}));

vi.mock("@/GitBranchSwitcher.js", () => ({
  GitBranchSwitcher: () => createElement("div", { "data-testid": "mock-git-branch-switcher" }),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/collapsible.js", () => ({
  Collapsible: ({ children, ...props }: { children: ReactNode }) =>
    createElement("div", props, children),
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => children,
  CollapsibleContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "zh-CN",
  }),
}));

const repositorySummary: GitRepositorySummary = {
  workspacePath: "/repo",
  repoRoot: "/repo",
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: "main",
  trackingBranchName: "origin/main",
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
};

afterEach(() => {
  cleanup();
});

describe("ConversationStatusPanel Git review entry", () => {
  it("opens the preferred worktree source when Changes is clicked", async () => {
    const onOpenGitReview = vi.fn();
    const { ConversationStatusPanel } = await import("@/v4/ConversationStatusPanel.js");

    render(
      createElement(ConversationStatusPanel, {
        workspacePath: "/repo",
        gitSummary: repositorySummary,
        gitDirtyFileCount: 1,
        gitWorktreeReviewSourceId: "staged",
        gitWorktreeChangeSummary: { added: 12, removed: 3 },
        summaryPanelVariantOverride: "panel",
        onRefreshGit: vi.fn(),
        onOpenGitReview,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /chat\.statusPanel\.changes/u,
      }),
    );

    expect(onOpenGitReview).toHaveBeenCalledOnce();
    expect(onOpenGitReview).toHaveBeenCalledWith("staged");
  });
});
