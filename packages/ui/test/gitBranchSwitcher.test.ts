import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    ChevronDownIcon: createIcon("chevron-down"),
    GitBranchIcon: createIcon("git-branch"),
    GitGraph: createIcon("git-graph"),
    LoaderIcon: createIcon("loader"),
    PlusIcon: createIcon("plus"),
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/command.js", () => ({
  Command: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CommandEmpty: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CommandGroup: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CommandInput: (props: Record<string, unknown>) => createElement("input", props),
  CommandItem: ({ children, ...props }: { children: ReactNode }) =>
    createElement("div", props, children),
  CommandList: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/components/ui/popover.js", () => ({
  Popover: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "popover" }, children),
  PopoverContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "popover-content" }, children),
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/git-branch-switcher/GitBranchDialogs.js", () => ({
  GitBranchCreateDialog: () => null,
  GitBranchSwitchAssistDialog: () => null,
}));

vi.mock("@/git-graph/GitGraphDialog.js", () => ({
  GitGraphDialog: () => null,
}));

vi.mock("@/hooks/useGitBranchSwitcher.js", () => ({
  useGitBranchSwitcher: () => ({
    branchesResult: null,
    closeSwitchAssistDialog: vi.fn(),
    commitAndSwitchBranch: vi.fn(),
    commitError: null,
    commitMessage: "",
    createBranchAndSwitch: vi.fn(),
    createBranchName: "",
    createDialogOpen: false,
    gitGraphDialogOpen: false,
    loadingBranches: false,
    mutationPending: false,
    open: false,
    openSwitchCommitDialog: vi.fn(),
    setCommitMessage: vi.fn(),
    setCreateBranchName: vi.fn(),
    setCreateDialogOpen: vi.fn(),
    setGitGraphDialogOpen: vi.fn(),
    setOpen: vi.fn(),
    switchAssistState: null,
    switchAssistStep: "commit",
    switchBranch: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "zh-CN",
  }),
}));

describe("GitBranchSwitcher", () => {
  it("marks the primary branch icon separately from trailing status icons", async () => {
    const { GitBranchSwitcher } = await import("@/GitBranchSwitcher.js");

    const html = renderToStaticMarkup(
      createElement(GitBranchSwitcher, {
        dirtyFileCount: 0,
        gitSummary: {
          branchName: "main",
          headRefType: "branch",
          isGitAvailable: true,
          isRepository: true,
        },
        onRefreshGit: vi.fn(),
        workspacePath: "/workspace/zcode-cli",
      }),
    );

    expect(html).toContain('data-branch-switcher-primary-icon="true"');
    expect(html).toContain('data-branch-switcher-trailing-icon="true"');
    expect(html).toContain("main");
  });

  it("keeps the primary branch icon in compact remote mode", async () => {
    const { GitBranchSwitcher } = await import("@/GitBranchSwitcher.js");

    const html = renderToStaticMarkup(
      createElement(GitBranchSwitcher, {
        compactForRemoteControl: true,
        dirtyFileCount: 0,
        gitSummary: {
          branchName: "main",
          headRefType: "branch",
          isGitAvailable: true,
          isRepository: true,
        },
        onRefreshGit: vi.fn(),
        workspacePath: "/workspace/zcode-cli",
      }),
    );

    expect(html).toContain('data-branch-switcher-primary-icon="true"');
    expect(html).not.toContain('data-branch-switcher-trailing-icon="true"');
    expect(html).not.toContain("main");
  });

  it("can hide branch creation and graph footer actions", async () => {
    const { GitBranchSwitcher } = await import("@/GitBranchSwitcher.js");

    const html = renderToStaticMarkup(
      createElement(GitBranchSwitcher, {
        dirtyFileCount: 0,
        gitSummary: {
          branchName: "main",
          headRefType: "branch",
          isGitAvailable: true,
          isRepository: true,
        },
        onRefreshGit: vi.fn(),
        showFooterActions: false,
        workspacePath: "/workspace/zcode-cli",
      }),
    );

    expect(html).not.toContain("git.branchSwitcher.createAction");
    expect(html).not.toContain("gitGraph.menuAction");
  });
});
