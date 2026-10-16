import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  GitRepositorySummary,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4_PRIMARY_PANE_ID } from "@/v4/paneLayoutStore.js";
import type { WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { WorkbenchLeafPane } from "@/v4/WorkbenchPane.js";

const sessionPaneCapture = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: Record<string, unknown>) => {
      sessionPaneCapture.props.push(props);
      return React.createElement("div", {
        "data-testid": "mock-session-pane",
      });
    },
  };
});

vi.mock("@/v4/V4ConversationContext.js", async () => {
  const React = await import("react");
  return {
    V4ConversationProvider: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-workspace-provider" }, children),
    V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-provider" }, children),
  };
});

function gitSummary(
  overrides: Partial<GitRepositorySummary> = {},
): GitRepositorySummary {
  return {
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
    ...overrides,
  };
}

describe("v4 workspace status panel wiring", () => {
  it("passes shell git status props from the primary workbench pane to SessionPane", () => {
    sessionPaneCapture.props = [];
    const git = gitSummary();
    const activeTaskChangeSummary = {
      changedFiles: [],
    } as unknown as ZCodeTaskChangeSummary;
    const onRefreshGit = vi.fn();
    const onOpenGitReview = vi.fn();
    const onSummaryPanelVariantOverrideChange = vi.fn();
    const shell = {
      workspacePath: "/repo",
      workspaceIdentity: "local:/repo",
      sessionId: "sess-primary",
      gitSummary: git,
      gitDirtyFileCount: 2,
      gitWorktreeReviewSourceId: "unstaged",
      gitWorktreeChangeSummary: { added: 12, removed: 3 },
      activeTaskChangeSummary,
      summaryPanelVariantOverride: null,
      onSummaryPanelVariantOverrideChange,
      onRefreshGit,
      onOpenGitReview,
    } as unknown as WorkbenchShellBinding;

    renderToStaticMarkup(
      createElement(WorkbenchLeafPane, {
        paneId: V4_PRIMARY_PANE_ID,
        rect: { left: "0%", top: "0%", width: "100%", height: "100%" },
        focused: true,
        showFocusIndicator: false,
        canSplit: true,
        shellWorkspaceKey: "local:/repo",
        binding: null,
        shell,
        onFocusRequest: vi.fn(),
        onSplit: vi.fn(),
        onClosePane: vi.fn(),
        onBindSession: vi.fn(),
      }),
    );

    expect(sessionPaneCapture.props).toHaveLength(1);
    expect(sessionPaneCapture.props[0]).toMatchObject({
      gitSummary: git,
      gitDirtyFileCount: 2,
      gitWorktreeReviewSourceId: "unstaged",
      gitWorktreeChangeSummary: { added: 12, removed: 3 },
      activeTaskChangeSummary,
      summaryPanelVariantOverride: null,
      onSummaryPanelVariantOverrideChange,
      onRefreshGit,
      onOpenGitReview,
    });
  });

  it("passes the ordinary Git review action through the single-pane workspace path", () => {
    sessionPaneCapture.props = [];
    const onOpenGitReview = vi.fn();

    renderToStaticMarkup(
      createElement(V4ChatPane, {
        workspacePath: "/repo",
        sessionId: "sess-primary",
        gitWorktreeReviewSourceId: "staged",
        onOpenGitReview,
      }),
    );

    expect(sessionPaneCapture.props).toHaveLength(1);
    expect(sessionPaneCapture.props[0]).toMatchObject({
      gitWorktreeReviewSourceId: "staged",
      onOpenGitReview,
    });
  });

  it("passes plan-detail opening through the single-pane workspace path", () => {
    sessionPaneCapture.props = [];
    const onOpenPlanDetail = vi.fn();

    renderToStaticMarkup(
      createElement(V4ChatPane, {
        workspacePath: "/repo",
        sessionId: "sess-primary",
        onOpenPlanDetail,
      }),
    );

    expect(sessionPaneCapture.props).toHaveLength(1);
    expect(sessionPaneCapture.props[0]).toMatchObject({
      onOpenPlanDetail,
    });
  });

  it("passes read-only workbench bindings to SessionPane", () => {
    sessionPaneCapture.props = [];
    const shell = {
      workspacePath: "/repo",
      workspaceIdentity: "local:/repo",
      sessionId: "sess-primary",
    } as unknown as WorkbenchShellBinding;

    renderToStaticMarkup(
      createElement(WorkbenchLeafPane, {
        paneId: "pane-1",
        rect: { left: "50%", top: "0%", width: "50%", height: "100%" },
        focused: true,
        showFocusIndicator: true,
        canSplit: true,
        shellWorkspaceKey: "local:/repo",
        binding: {
          readOnly: true,
          sessionId: "sess-child",
          workspaceScope: {
            workspaceIdentity: "local:/repo",
            workspacePath: "/repo",
          },
        },
        shell,
        onFocusRequest: vi.fn(),
        onSplit: vi.fn(),
        onClosePane: vi.fn(),
        onBindSession: vi.fn(),
      }),
    );

    expect(sessionPaneCapture.props).toHaveLength(1);
    expect(sessionPaneCapture.props[0]).toMatchObject({
      readOnly: true,
      sessionId: "sess-child",
    });
  });
});
