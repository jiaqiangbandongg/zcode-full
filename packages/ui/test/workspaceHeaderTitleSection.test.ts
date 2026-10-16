import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TID_WORKSPACE_MORE_BUTTON, TID_WORKSPACE_PATH, TID_WORKSPACE_TITLE } from "@zcode/shared";

const capturedGitBranchSwitcherProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    ...actual,
    Cloud: createIcon("cloud"),
    Ellipsis: createIcon("ellipsis"),
    Folder: createIcon("folder"),
    GitBranch: createIcon("git-branch"),
    LoaderIcon: createIcon("loader"),
    UploadCloud: createIcon("upload-cloud"),
  };
});

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-content" }, children),
  DropdownMenuItem: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-item" }, children),
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

vi.mock("@/GitBranchSwitcher.js", () => ({
  GitBranchSwitcher: (props: Record<string, unknown>) => {
    capturedGitBranchSwitcherProps.push(props);
    return createElement("span", {
      "data-testid": "git-branch",
      "data-trigger-class-name": String(props.triggerClassName ?? ""),
    });
  },
}));

vi.mock("@/TaskActionMenuContent.js", () => ({
  TaskActionMenuContent: () => createElement("div", { "data-testid": "task-action-menu" }),
}));

vi.mock("@/settings/RemoteSkillSyncDialog.js", () => ({
  RemoteSkillSyncDialog: () => createElement("div", { "data-testid": "remote-skill-sync-dialog" }),
}));

vi.mock("@/settings/RemoteMcpSyncDialog.js", () => ({
  RemoteMcpSyncDialog: () => createElement("div", { "data-testid": "remote-mcp-sync-dialog" }),
}));

vi.mock("@/settings/RemotePluginSyncDialog.js", () => ({
  RemotePluginSyncDialog: () =>
    createElement("div", { "data-testid": "remote-plugin-sync-dialog" }),
}));

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => vi.fn(async () => true),
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: () => ({ items: [], loading: false }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  // Bugfix: Header 现在同时读取 workspace services 和 base services；
  // 测试 mock 需要覆盖同模块全部被用到的 hook，避免新增导出后静态渲染直接崩溃。
  useBaseWorkspaceServices: () => ({
    skillSyncService: {},
    mcpSyncService: {},
    pluginSyncService: {},
  }),
  useWorkspaceServices: () => ({
    skillSyncService: {},
    mcpSyncService: {},
    pluginSyncService: {},
    zcodeTaskService: {
      archiveTask: vi.fn(),
      renameTask: vi.fn(),
      setTaskPinned: vi.fn(),
      setTaskUnread: vi.fn(),
    },
  }),
}));

vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: () => ({
    taskSessionFile: { path: "/tmp/session.json", exists: true },
    taskNativeSessionLogFile: { path: "/tmp/session.log", exists: true },
    providerConfigFile: { path: "/tmp/provider.json", exists: true },
    fileManagerLabel: "Finder",
    handleCopyText: vi.fn(),
    handleOpenTaskPathInFileManager: vi.fn(),
    handleOpenProviderConfig: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (selector: (state: { openSubmit: () => void }) => unknown) =>
    selector({ openSubmit: vi.fn() }),
}));

vi.mock("@/store/taskQueryCacheStore.js", () => ({
  applyTaskQueryCacheMutation: vi.fn(),
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      removeTaskState: vi.fn(),
      removeOptimisticTaskListItem: vi.fn(),
      setTaskUnreadIndicator: vi.fn(),
      upsertOptimisticTaskListItem: vi.fn(),
    }),
}));

vi.mock("@/store/remotePinnedTaskStore.js", () => ({
  useRemotePinnedTaskStore: {
    getState: () => ({
      removeTask: vi.fn(),
      upsertTask: vi.fn(),
    }),
  },
}));

vi.mock("@/store/remoteTimelineTaskStore.js", () => ({
  useRemoteTimelineTaskStore: {
    getState: () => ({
      removeTask: vi.fn(),
      upsertTask: vi.fn(),
    }),
  },
}));

vi.mock("@/store/modelTrajectoryStore.js", () => ({
  useModelTrajectoryStore: {
    getState: () => ({
      requestOpen: vi.fn(),
    }),
  },
}));

describe("WorkspaceHeaderTitleSection", () => {
  it("keeps the title but hides task-only context and menus in the draft variant", async () => {
    capturedGitBranchSwitcherProps.length = 0;
    const { WorkspaceHeaderTitleSection } = await import("@/WorkspaceHeaderSections.js");

    const html = renderToStaticMarkup(
      createElement(WorkspaceHeaderTitleSection, {
        variant: "draft",
        workspaceAbsPath: "/workspace/zcode-cli",
        projectName: "zcode-cli",
        activeTaskTitle: "New task",
        activeTaskId: null,
        activeTraceId: null,
        activeSessionId: null,
        activeTaskProvider: null,
        gitSummary: { isRepository: true, branchName: "main" },
        gitDirtyFileCount: 0,
        sessionLogPath: null,
        nativeSessionLogProvider: null,
        nativeSessionLogPath: null,
        nativeSessionLogExists: false,
        nativeSessionLogLoading: false,
        providerWorkspaceConfigPath: null,
        providerWorkspaceConfigExists: false,
        providerWorkspaceConfigLoading: false,
        workspaceHeaderState: { selectedProvider: "codex" },
        selectedEditor: null,
        onRefreshGit: vi.fn(),
      }),
    );

    expect(html).toContain(`data-testid="${TID_WORKSPACE_TITLE}"`);
    expect(html).not.toContain(`data-testid="${TID_WORKSPACE_PATH}"`);
    expect(html).not.toContain(`data-testid="${TID_WORKSPACE_MORE_BUTTON}"`);
    expect(capturedGitBranchSwitcherProps).toHaveLength(0);
  });

  it("places the workspace icon before the title and removes the inline branch in mobile mode", async () => {
    capturedGitBranchSwitcherProps.length = 0;
    const { WorkspaceHeaderTitleSection } = await import("@/WorkspaceHeaderSections.js");

    const html = renderToStaticMarkup(
      createElement(WorkspaceHeaderTitleSection, {
        workspaceAbsPath: "/workspace/zcode-cli",
        projectName: "zcode-cli",
        activeTaskTitle: "hello",
        activeTaskId: "task-1",
        activeTraceId: "trace-1",
        activeSessionId: "session-1",
        activeTaskProvider: "glm",
        gitSummary: {
          isGitAvailable: true,
          isRepository: true,
          branchName: "main",
          headRefType: "branch",
        },
        gitDirtyFileCount: 0,
        sessionLogPath: null,
        nativeSessionLogProvider: null,
        nativeSessionLogPath: null,
        nativeSessionLogExists: false,
        nativeSessionLogLoading: false,
        providerWorkspaceConfigPath: null,
        providerWorkspaceConfigExists: false,
        providerWorkspaceConfigLoading: false,
        workspaceHeaderState: { selectedProvider: "glm" },
        selectedEditor: null,
        simplifyForNarrowRemote: true,
        onRefreshGit: vi.fn(),
      }),
    );

    expect(capturedGitBranchSwitcherProps).toHaveLength(0);
    expect(html).toContain('data-icon="folder"');
    expect(html).toContain('aria-label="zcode-cli · main"');
    expect(html.indexOf(`data-testid="${TID_WORKSPACE_PATH}"`)).toBeLessThan(
      html.indexOf(`data-testid="${TID_WORKSPACE_TITLE}"`),
    );
  });

  it("uses the SSH alias suffix format for remote workspace context", async () => {
    const { WorkspaceHeaderTitleSection } = await import("@/WorkspaceHeaderSections.js");

    const html = renderToStaticMarkup(
      createElement(WorkspaceHeaderTitleSection, {
        workspaceAbsPath: "/root",
        remoteSessionId: "remote-session-1",
        workspaceIdentity: "remote:ssh:localhost:2223:root:/root",
        remoteTarget: {
          kind: "ssh",
          host: "localhost",
          port: 2223,
          username: "root",
          sshConfigAlias: "linux-arm64",
        },
        projectName: "root",
        activeTaskTitle: "hello",
        activeTaskId: "task-1",
        activeTraceId: "trace-1",
        activeSessionId: "session-1",
        activeTaskProvider: "glm",
        gitSummary: { isRepository: false },
        gitDirtyFileCount: 0,
        sessionLogPath: null,
        nativeSessionLogProvider: null,
        nativeSessionLogPath: null,
        nativeSessionLogExists: false,
        nativeSessionLogLoading: false,
        providerWorkspaceConfigPath: null,
        providerWorkspaceConfigExists: false,
        providerWorkspaceConfigLoading: false,
        workspaceHeaderState: { selectedProvider: "glm" },
        selectedEditor: null,
        onRefreshGit: vi.fn(),
      }),
    );

    expect(html).toContain("root [SSH: linux-arm64]");
    expect(html).toContain('data-icon="cloud"');
    expect(html).not.toContain(">root</span><span");
    expect(html).not.toContain(">localhost:2223</span>");
  });

  it("shows Skills and MCP sync actions for connected SSH workspace header menu", async () => {
    const { WorkspaceHeaderTitleSection } = await import("@/WorkspaceHeaderSections.js");

    const html = renderToStaticMarkup(
      createElement(WorkspaceHeaderTitleSection, {
        workspaceAbsPath: "/root/folder1",
        remoteSessionId: "remote-session-1",
        workspaceIdentity: "remote:ssh:localhost:2223:root:/root/folder1",
        remoteTarget: {
          kind: "ssh",
          host: "localhost",
          port: 2223,
          username: "root",
          sshConfigAlias: "linux-arm64",
        },
        projectName: "folder1",
        activeTaskTitle: "hello",
        activeTaskId: "task-1",
        activeTraceId: "trace-1",
        activeSessionId: "session-1",
        activeTaskProvider: "glm",
        gitSummary: { isRepository: false },
        gitDirtyFileCount: 0,
        sessionLogPath: null,
        nativeSessionLogProvider: null,
        nativeSessionLogPath: null,
        nativeSessionLogExists: false,
        nativeSessionLogLoading: false,
        providerWorkspaceConfigPath: null,
        providerWorkspaceConfigExists: false,
        providerWorkspaceConfigLoading: false,
        workspaceHeaderState: { selectedProvider: "glm" },
        selectedEditor: null,
        onRefreshGit: vi.fn(),
      }),
    );

    expect(html).toContain("settings.skills.remoteSync.open");
    expect(html).toContain("settings.mcp.remoteSync.open");
  });
});
