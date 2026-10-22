// @vitest-environment jsdom
import { render, cleanup, act } from "@testing-library/react";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { RemoteProjectPresentationProvider } from "@/hooks/RemoteProjectPresentationContext.js";
import { getSourceServerStatusRegistry } from "@/store/sourceServerStatusRegistry.js";
import { getSourceServerDisplayNameRegistry } from "@/store/sourceServerDisplayNameRegistry.js";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TID_WORKSPACE_MORE_BUTTON,
  TID_WORKSPACE_PATH,
  TID_WORKSPACE_TITLE,
} from "@zcode/shared/test-ids";

const headerManagement = vi.hoisted(() => ({
  getSnapshot: vi.fn(async () => ({
    servers: [
      {
        sourceServerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        displayName: "Dev",
        installState: "installed",
      },
    ],
    profiles: [
      {
        profileId: "p",
        sourceServerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        target: { kind: "ssh", host: "dev", username: "user" },
      },
    ],
    states: [{ profileId: "p", state: "online", updatedAt: 1 }],
  })),
  onDidChangeState: () => ({ dispose() {} }),
  onDidChangeDirectory: () => ({ dispose() {} }),
}));
const capturedGitBranchSwitcherProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  // 共享组件（RemoteSyncActions 等）的图标随迭代增减，枚举 mock 会反复缺导出；
  // 保留既有命名映射，其余图标名用 Proxy 兜底为占位 svg。
  const icons: Record<string, unknown> = {
    ...actual,
    Cloud: createIcon("cloud"),
    Ellipsis: createIcon("ellipsis"),
    Folder: createIcon("folder"),
    GitBranch: createIcon("git-branch"),
    LoaderIcon: createIcon("loader"),
    UploadCloud: createIcon("upload-cloud"),
  };
  return new Proxy(icons, {
    // vitest 对具名导出做 `in` 检查，动态图标必须声明存在。
    has: (target, name) => typeof name === "string" || Reflect.has(target, name),
    get: (target, name) => {
      if (typeof name !== "string") return Reflect.get(target, name);
      if (name === "default" || name === "then" || name === "__esModule") {
        return Reflect.get(target, name);
      }
      return (
        target[name] ??
        createIcon(
          name
            .replace(/Icon$/u, "")
            .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
            .toLowerCase(),
        )
      );
    },
  });
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
    sourceServerManagementService: headerManagement,
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

vi.mock("@/store/modelTrajectoryStore.js", () => ({
  useModelTrajectoryStore: {
    getState: () => ({
      requestOpen: vi.fn(),
    }),
  },
}));

describe("WorkspaceHeaderTitleSection", () => {
  it("hides task-only title, context and menus in the local draft variant", async () => {
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

    expect(html).not.toContain(`data-testid="${TID_WORKSPACE_TITLE}"`);
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
    // 回归保护：aria-label 只有显示名，e2e 判定“header 属于哪个工作区”依赖这个绝对路径
    // 数据属性。上一次它以 DOM title 形式存在，被 tooltip 重构顺手删掉后无人发现。
    expect(html).toContain('data-workspace-abs-path="/workspace/zcode-cli"');
    expect(html.indexOf(`data-testid="${TID_WORKSPACE_PATH}"`)).toBeLessThan(
      html.indexOf(`data-testid="${TID_WORKSPACE_TITLE}"`),
    );
  });

  it.each(["task", "draft"] as const)(
    "keeps device context visible in the remote %s header",
    async (variant) => {
      const { WorkspaceHeaderTitleSection } = await import("@/WorkspaceHeaderSections.js");

      const html = renderToStaticMarkup(
        createElement(WorkspaceHeaderTitleSection, {
          variant,
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

      expect(html).toContain('data-workspace-device-name=""');
      expect(html).toContain(">linux-arm64</span>");
      expect(html).toContain('aria-label="root"');
      expect(html).toContain('data-remote-state-icon="cloud-off"');
      expect(html).not.toContain("[SSH: linux-arm64]");
      expect(html).not.toContain(">root</span><span");
    },
  );

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

    // 同步菜单已按原型 L1197-1203 收敛为 remote.sync* key 与分化图标（wand/cable）。
    expect(html).toContain("remote.syncSkills");
    expect(html).toContain("remote.syncMcp");
  });
});

it.each([false, true])("头部读取项目错误/恢复事实（恢复=%s）", async (recovering) => {
  getSourceServerStatusRegistry(headerManagement as never);
  getSourceServerDisplayNameRegistry(headerManagement as never);
  await Promise.resolve();
  const { WorkspaceHeaderTitleSection } = await import("@/WorkspaceHeaderSections.js");
  const identity = "remote:server:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:/srv";
  const child = createElement(WorkspaceHeaderTitleSection, {
    workspaceAbsPath: "/srv",
    workspaceIdentity: identity,
    remoteTarget: { kind: "ssh", host: "dev", username: "user" },
    projectName: "Project",
    activeTaskTitle: "task",
    activeTaskId: "task",
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
  });
  const html = renderToStaticMarkup(
    createElement(RemoteProjectPresentationProvider, {
      reconnectingKeys: recovering ? [identity] : [],
      errors: { [identity]: "attachment failed" },
      recovery: recovering ? { [identity]: { mode: "automatic", attempt: 2, limit: 3 } } : {},
      children: child,
    }),
  );
  expect(html).toContain(
    recovering ? "workspaceSidebar.recoveringAutomaticAttempt" : "remote.status.failed",
  );
  expect(html).toContain(
    recovering ? "text-progress-surface-foreground" : "text-destructive-surface-foreground",
  );
});

const headerDirectory = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/project-sidebar/index.js", () => ({
  useOptionalProjectDirectory: () => headerDirectory.current,
}));

it("远控 Header 从身份索引读取连接并从同一 Host 读取名称，连接换代和删除会更新", async () => {
  const identity = "remote:server:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:/srv";
  const store = useRemoteWorkspaceSessionStore;
  headerDirectory.current = {
    directory: {
      hosts: [
        {
          id: "remote:server:other",
          target: { kind: "ssh", host: "wrong.example", username: "dev" },
        },
        {
          id: "remote:server:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          target: {
            kind: "ssh",
            host: "right.example",
            username: "dev",
            sshConfigAlias: "Remote Dev",
          },
        },
      ],
    },
  };
  store.getState().registerSession({ sessionId: "bridge", services: {} as never });
  store.getState().bindWorkspaceIdentity(identity, "bridge");
  const { WorkspaceHeaderTitleSection } = await import("@/WorkspaceHeaderSections.js");
  const props = {
    workspaceAbsPath: "/srv",
    workspaceIdentity: identity,
    projectName: "Project",
    activeTaskTitle: "task",
    activeTaskId: "task",
    activeTraceId: null,
    activeSessionId: null,
    activeTaskProvider: null,
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
    isWebRemoteControl: true,
  } satisfies import("@/WorkspaceHeaderSections.js").WorkspaceHeaderTitleSectionProps;
  const view = render(createElement(WorkspaceHeaderTitleSection, props));
  try {
    const header = () => view.container.querySelector('[data-testid="workspace-path"]')!;
    expect(header().getAttribute("aria-description")).toBe("remote.status.online");
    expect(header().textContent).toBe("Remote Dev");
    act(() => store.getState().unregisterSession("bridge"));
    expect(header().getAttribute("aria-description")).toBe("remote.status.offline");
    act(() => {
      store.getState().registerSession({ sessionId: "replacement", services: {} as never });
      store.getState().bindWorkspaceIdentity(identity, "replacement");
    });
    expect(header().getAttribute("aria-description")).toBe("remote.status.online");
  } finally {
    cleanup();
    store.getState().unregisterSession("bridge");
    store.getState().unregisterSession("replacement");
    headerDirectory.current = null;
  }
});
