import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { V4ChatPaneProps } from "@/v4/V4ChatPane.js";
import { V4_PRIMARY_PANE_ID } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

vi.mock("@/app-shell/AnimatedSidePanePanel.js", () => ({
  AnimatedSidePanePanel: ({
    isVisible,
    mobileOverlay,
    mobileStacked,
  }: {
    isVisible?: boolean;
    mobileOverlay?: boolean;
    mobileStacked?: boolean;
  }) =>
    createElement("div", {
      "data-mobile-overlay": mobileOverlay ? "true" : "false",
      "data-mobile-stacked": mobileStacked ? "true" : "false",
      "data-panel-visible": isVisible ? "true" : "false",
      "data-testid": "side-pane-panel",
    }),
}));

vi.mock("@/app-shell/AnimatedTerminalPanel.js", () => ({
  AnimatedTerminalPanel: () => createElement("div", { "data-testid": "terminal-panel" }),
}));

vi.mock("@/app-shell/useAnimatedResizablePanel.js", () => ({
  useAnimatedResizablePanel: ({ open }: { open: boolean }) => ({
    isVisible: open,
    panelElementRef: { current: null },
    panelRef: { current: null },
  }),
}));

vi.mock("@/settings/AutomationsSection.js", () => ({
  AUTOMATIONS_TOAST_ANCHOR_ID: "automations-main-toast-anchor",
  AutomationsSection: () => createElement("div", { "data-testid": "automations-section" }),
}));

vi.mock("@/settings/PluginStorePage.js", () => ({
  PluginStorePage: () => createElement("div", { "data-testid": "plugin-store-page" }),
}));

const capturedChatPaneProps: V4ChatPaneProps[] = [];

vi.mock("@/v4/V4ChatPane.js", () => ({
  V4ChatPane: (props: V4ChatPaneProps) => {
    capturedChatPaneProps.push(props);
    return createElement("div", { "data-testid": "v4-chat-pane" });
  },
}));

// M5⑤：桌面主区改由分屏宿主承载（props 形状与 V4ChatPane 相同的超集），
// 布局测试同样打桩——分屏行为在 v4PaneLayoutStore 单测与 v4-split e2e 覆盖。
vi.mock("@/v4/V4WorkspaceChatArea.js", () => ({
  V4WorkspaceChatArea: (props: V4ChatPaneProps) => {
    capturedChatPaneProps.push(props);
    return createElement("div", { "data-testid": "v4-chat-pane" });
  },
}));

vi.mock("@/BotsDialog.js", () => ({
  BotsDialog: () => createElement("div", { "data-testid": "bots-dialog" }),
}));

vi.mock("@/components/ui/resizable.js", () => ({
  ResizableHandle: ({ className }: { className?: string }) =>
    createElement("div", {
      className,
      "data-testid": "resizable-handle",
    }),
  ResizablePanel: ({
    children,
    className,
    "data-state": dataState,
    disabled,
    id,
    minSize,
  }: {
    children: ReactNode;
    className?: string;
    "data-state"?: string;
    disabled?: boolean;
    id: string;
    minSize?: string;
  }) =>
    createElement(
      "section",
      {
        className,
        "data-disabled": disabled ? "true" : "false",
        "data-min-size": minSize,
        "data-panel-id": id,
        "data-state": dataState,
      },
      children,
    ),
  ResizablePanelGroup: ({
    children,
    className,
    layoutId,
    panelIds,
    style,
  }: {
    children: ReactNode;
    className?: string;
    layoutId: string;
    panelIds?: string[];
    style?: Record<string, string>;
  }) =>
    createElement(
      "div",
      {
        className,
        "data-layout-id": layoutId,
        "data-panel-ids": panelIds?.join(","),
        style,
      },
      children,
    ),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-menu-content" }, children),
  DropdownMenuItem: ({ children }: { children: ReactNode }) =>
    createElement("button", { "data-testid": "dropdown-menu-item" }, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/DesktopTopOverlay.js", () => ({
  DesktopTopOverlay: () => createElement("div", { "data-testid": "desktop-top-overlay" }),
}));

vi.mock("@/DesktopWindowFrame.js", () => ({
  DesktopWindowFrame: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "desktop-window-frame" }, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: { openFeatureRequest: () => void; openSubmit: () => void }) => unknown,
  ) =>
    selector({
      openFeatureRequest: vi.fn(),
      openSubmit: vi.fn(),
    }),
}));

vi.mock("@/hooks/usePlatform.js", async (importOriginal) => ({
  // 布局 SSR 没有 PlatformProvider；保留可选读取的真实空边界，避免整模块 mock 漏掉新增 hook。
  ...(await importOriginal<typeof import("@/hooks/usePlatform.js")>()),
  usePlatform: () => ({
    openCommunity: vi.fn(async () => {}),
    openExternal: vi.fn(),
  }),
  // DirectoryOwner 的角标同步走 optional 平台；布局测试无 Provider，返回 null 即跳过。
  useOptionalPlatform: () => null,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({}),
  // 布局断言不启动远端挂回；保留 services resolver 的本地 ready 合同。
  useWorkspaceServicesResolution: () => ({ services: {}, connectionKind: "local-ready" }),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  // 项目树（useProjectTree / useProjectTaskNavigation）直接订阅 tab store；
  // 这里给出最小状态，避免真实侧栏在窄屏分支挂载时缺少 useTabStore。
  useTabStore: (select: (state: any) => unknown) =>
    select({ tabs: [], activeWorkspaceIdentity: undefined }),
  useTabStoreApi: () => ({
    getState: () => ({
      activateTabByPath: vi.fn(() => true),
      addTab: vi.fn(),
    }),
  }),
}));

vi.mock("@/WorkspaceHeader.js", () => ({
  WorkspaceHeader: ({ variant }: { variant?: string }) =>
    createElement("header", {
      "data-testid": "workspace-header",
      "data-workspace-header-variant": variant,
    }),
}));

vi.mock("@/WindowsCaptionMenuButton.js", () => ({
  WindowsCaptionMenuButton: ({ triggerPresentation }: { triggerPresentation?: string }) =>
    createElement("button", {
      "data-testid": "windows-caption-menu",
      "data-trigger-presentation": triggerPresentation ?? "header",
    }),
}));

vi.mock("@/WebRemoteControlMobileShell.js", () => ({
  WebRemoteControlMobileShell: ({
    children,
    isMobileViewport = true,
    chatContent,
    renderTaskHome,
    chatOverlay,
    isSidePaneOpen,
    renderChatHeader,
    sidePaneContent,
  }: {
    children?: ReactNode;
    isMobileViewport?: boolean;
    chatContent?: ReactNode;
    renderTaskHome?: (options: {
      navigateToChat(): void;
      setSwitching(switching: boolean): void;
    }) => ReactNode;
    chatOverlay?: ReactNode;
    isSidePaneOpen?: boolean;
    renderChatHeader?: () => ReactNode;
    sidePaneContent?: ReactNode;
  }) =>
    !isMobileViewport
      ? children
      : createElement(
          "div",
          {
            "data-mobile-side-pane-open": isSidePaneOpen ? "true" : "false",
            "data-testid": "web-remote-mobile-shell",
          },
          renderChatHeader?.(),
          renderTaskHome?.({ navigateToChat: vi.fn(), setSwitching: vi.fn() }),
          createElement("div", { "data-testid": "mobile-chat-content" }, chatContent),
          chatOverlay
            ? createElement("div", { "data-testid": "mobile-chat-overlay-prop" }, chatOverlay)
            : null,
          sidePaneContent
            ? createElement("div", { "data-testid": "mobile-side-pane-overlay" }, sidePaneContent)
            : null,
        ),
}));

const capturedWorkspaceSidebarProps = vi.hoisted(() => ({
  props: [] as Array<{
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
    onSelectTask: (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
    ) => void;
  }>,
}));

vi.mock("@/WorkspaceSidebar.js", () => ({
  WorkspaceSidebar: (props: (typeof capturedWorkspaceSidebarProps.props)[number]) => {
    capturedWorkspaceSidebarProps.props.push(props);
    return createElement("aside", { "data-testid": "workspace-sidebar" });
  },
}));

function createWorkspaceShellProps() {
  return {
    activeGitSourceId: "unstaged" as const,
    activeSessionId: null,
    activeTaskChangeSummary: null,
    activeTaskId: null,
    activeTaskProvider: null,
    activeTaskTitle: "",
    activeTraceId: null,
    allowOpenWorkspace: false,
    allowRemoteWorkspace: false,
    appLogoUrl: "",
    browserNavigationRequest: null,
    browserRestoreUrls: {},
    canGoBack: false,
    canGoForward: false,
    canTaskNavBack: false,
    canTaskNavForward: false,
    gitState: {
      datasets: {
        staged: { sections: [] },
        unstaged: { sections: [] },
      },
      summary: {
        isGitAvailable: false,
        isRepository: false,
      },
    },
    goBackShortcutLabel: "",
    goForwardShortcutLabel: "",
    handleActivateSidePaneTab: vi.fn(),
    handleBrowserNavigationRequestHandled: vi.fn(),
    handleBrowserPageMetadataChange: vi.fn(),
    handleBrowserUrlChange: vi.fn(),
    handleCloseCodeViewer: vi.fn(),
    handleCloseGit: vi.fn(),
    handleOpenBrowserTab: vi.fn(),
    handleOpenBrowserUrl: vi.fn(),
    handleOpenCodeViewer: vi.fn(),
    handleRefreshGit: vi.fn(),
    handleReloadSession: vi.fn(async () => {}),
    handleReorderSidePaneTab: vi.fn(),
    handleOpenAutomations: vi.fn(),
    handleSelectTask: vi.fn(),
    handleStartDraftInWorkspace: vi.fn(),
    handleTaskNavBack: vi.fn(),
    handleTaskNavForward: vi.fn(),
    handleToggleBrowser: vi.fn(),
    handleToggleGit: vi.fn(),
    handleToggleSidePane: vi.fn(),
    handleToggleSidebar: vi.fn(),
    handleToggleTerminal: vi.fn(),
    onOpenAutomationConsumed: vi.fn(),
    onWorkspaceMainViewChange: vi.fn(),
    openAutomationId: null,
    workspaceMainView: "chat" as const,
    headerGitChangeSummary: null,
    isBrowserOpen: false,
    isDesktop: false,
    isGitOpen: false,
    isMacDesktop: false,
    isMacFullscreen: false,
    isSidePaneOpen: false,
    isWorkspaceVisible: true,
    isSidebarVisible: true,
    isTerminalOpen: false,
    isWindowsDesktop: false,
    newTaskShortcutLabel: "",
    onCancelRemoteProject: vi.fn(async () => {}),
    onConnectRemote: vi.fn(async () => ""),
    onCreateTask: vi.fn(),
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    onSelectRemoteProject: vi.fn(async () => {}),
    platform: {},
    projectName: "project",
    providerConfigFile: {
      exists: false,
      loading: false,
      path: null,
    },
    reconnectingRemoteWorkspaceKeys: [],
    reloadSessionDisabled: false,
    reloadSessionPending: false,
    remoteWorkspaceErrorByWorkspaceKey: {},
    remoteWorkspaceSessions: [],
    resolvedActiveTaskMeta: null,
    services: {},
    setGitSelectedSourceId: vi.fn(),
    setIsTerminalOpen: vi.fn(),
    shellPanelIds: ["sidebar", "content"],
    sidePaneState: null,
    sidebarContainerRef: { current: null },
    taskNativeSessionLogFile: {
      exists: false,
      loading: false,
      path: null,
      provider: null,
    },
    taskSessionFile: {
      path: null,
    },
    testMessages: null,
    theme: "light" as const,
    toggleSidebarShortcutLabel: "",
    toggleSidePaneShortcutLabel: "",
    updateReadyVersion: null,
    user: null,
    webRemoteControlWorkspaceSwitcher: undefined,
    workspaceAbsPath: "/tmp/project",
    workspaceRemoteSessionId: undefined,
    workspaceShellZCodeState: {
      activeTaskId: null,
      modelSwitchPending: false,
      modelSwitchStage: null,
      optimisticTaskListByTaskId: {},
      selectedProvider: "codex",
      taskError: null,
      taskStatus: "notReady",
      workspaceInit: {
        attempts: 0,
        error: null,
        status: "idle",
      },
    },
    workspaceTabs: [],
  };
}

async function renderWorkspaceShell(
  overrides: Partial<ReturnType<typeof createWorkspaceShellProps>> = {},
) {
  const { WorkspaceShellLayout } = await import("@/app-shell/WorkspaceShellLayout.js");

  return renderToStaticMarkup(
    createElement(WorkspaceShellLayout, {
      ...createWorkspaceShellProps(),
      ...overrides,
    } as Parameters<typeof WorkspaceShellLayout>[0]),
  );
}

describe("WorkspaceShellLayout Web remote control mobile layout", () => {
  it.each([
    { mobile: false, sidePaneOpen: false, workspaceVisible: true, expected: true },
    { mobile: false, sidePaneOpen: true, workspaceVisible: true, expected: false },
    { mobile: false, sidePaneOpen: false, workspaceVisible: false, expected: false },
    { mobile: true, sidePaneOpen: false, workspaceVisible: true, expected: true },
    { mobile: true, sidePaneOpen: true, workspaceVisible: true, expected: false },
    { mobile: true, sidePaneOpen: false, workspaceVisible: false, expected: false },
  ])(
    "limits default Esc stop to the visible main chat without a side pane: %j",
    async (scenario) => {
      capturedChatPaneProps.length = 0;
      vi.stubGlobal("window", {
        innerHeight: 800,
        matchMedia: vi.fn(() => ({
          addEventListener: vi.fn(),
          addListener: vi.fn(),
          matches: scenario.mobile,
          removeEventListener: vi.fn(),
          removeListener: vi.fn(),
        })),
        sessionStorage: { getItem: vi.fn(() => null), removeItem: vi.fn(), setItem: vi.fn() },
      });
      try {
        await renderWorkspaceShell({
          isSidePaneOpen: scenario.sidePaneOpen,
          isWorkspaceVisible: scenario.workspaceVisible,
          webRemoteControlWorkspaceSwitcher: scenario.mobile
            ? {
                listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
                switchWorkspace: vi.fn(async () => {}),
              }
            : undefined,
        });
        expect(capturedChatPaneProps).toHaveLength(1);
        expect(capturedChatPaneProps[0]?.allowEscapeStopOutsidePane).toBe(scenario.expected);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  // Bugfix: 这些断言只覆盖远控导航纯计算逻辑，直接导入小模块，避免全量并发单测时拉起整页组件。
  it("resolves draggable navigation heights and collapse thresholds", async () => {
    const {
      getDefaultWebRemoteNavigationHeightPx,
      resolveWebRemoteNavigationDragState,
      resolveWebRemoteNavigationToggleState,
    } = await import("@/app-shell/webRemoteNavigationLayout.js");

    expect(getDefaultWebRemoteNavigationHeightPx(800)).toBe(352);
    expect(getDefaultWebRemoteNavigationHeightPx(600)).toBe(252);
    expect(
      resolveWebRemoteNavigationDragState({
        heightPx: 18,
        viewportHeight: 800,
      }),
    ).toEqual({ heightPx: 0, isCollapsed: true });
    expect(
      resolveWebRemoteNavigationDragState({
        heightPx: 320,
        viewportHeight: 800,
      }),
    ).toEqual({ heightPx: 320, isCollapsed: false });
    expect(
      resolveWebRemoteNavigationDragState({
        heightPx: 720,
        viewportHeight: 800,
      }),
    ).toEqual({ heightPx: 584, isCollapsed: false });
    expect(
      resolveWebRemoteNavigationToggleState({
        currentHeightPx: 280,
        isCollapsed: false,
        viewportHeight: 800,
      }),
    ).toEqual({ heightPx: 0, isCollapsed: true });
    expect(
      resolveWebRemoteNavigationToggleState({
        currentHeightPx: 0,
        isCollapsed: true,
        viewportHeight: 800,
      }),
    ).toEqual({ heightPx: 352, isCollapsed: false });
  });

  it("keeps sidebar panel ids stable while still marking collapsed mobile layout", async () => {
    const { getActiveWorkspaceShellPanelIds, shouldRenderWebRemoteNavigationPanel } =
      await import("@/app-shell/webRemoteNavigationLayout.js");

    expect(
      shouldRenderWebRemoteNavigationPanel({
        isCollapsed: true,
        isMobileViewport: true,
        isWebRemoteControlShell: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderWebRemoteNavigationPanel({
        isCollapsed: true,
        isMobileViewport: false,
        isWebRemoteControlShell: true,
      }),
    ).toBe(true);
    expect(
      shouldRenderWebRemoteNavigationPanel({
        isCollapsed: true,
        isMobileViewport: true,
        isWebRemoteControlShell: false,
      }),
    ).toBe(true);
    expect(getActiveWorkspaceShellPanelIds(["sidebar", "content"], false)).toEqual([
      "sidebar",
      "content",
    ]);
    expect(getActiveWorkspaceShellPanelIds(["sidebar", "content"], true)).toEqual([
      "sidebar",
      "content",
    ]);
  });

  // Bugfix: 该断言需要 SSR 整个 WorkspaceShellLayout，renderWorkspaceShell 内的动态 import
  // 会一次性 transform 整张页面模块图，成本全记在本文件第一个整页用例上（实测冷启动 5s 量级）。
  // 纯计算逻辑已拆到 webRemoteNavigationLayout。这里曾写死 `}, 15_000)`，但 vitest.config.ts
  // 全局 testTimeout 已是 30s，per-test 参数是覆盖而非取大，局部值反而把预算砍到 15s 并在
  // 全量并发时被打穿；故删除局部值，回落到全局 30s。
  it("keeps the hidden sidebar mounted without an outer resizable panel target", async () => {
    const html = await renderWorkspaceShell({ isSidebarVisible: false });

    expect(html).toContain('id="sidebar"');
    expect(html).toContain("--workspace-sidebar-panel-width:0px");
    expect(html).not.toContain('data-panel-id="sidebar"');
    expect(html).not.toContain('data-layout-id="workspace-shell-layout"');
  });

  it("keeps the desktop Browser Guest host mounted and collapsed on the Automations main view", async () => {
    const html = await renderWorkspaceShell({
      isDesktop: true,
      isSidePaneOpen: true,
      sidePaneState: {
        activeTabId: "browser-use:iab-tab:automation",
        tabs: [
          {
            id: "browser-use:iab-tab:automation",
            sessionId: "automation-session",
            tabId: "iab-tab:automation",
            type: "browser-use",
            workspaceKey: "/tmp/project",
          },
        ],
      } as never,
      workspaceMainView: "automations",
    });

    expect(html).toContain('id="automations-main-toast-anchor"');
    expect(html).toContain('data-layout-id="workspace-body-layout"');
    expect(html).toContain('data-panel-id="conversation-column"');
    expect(html.match(/data-testid="side-pane-panel"/gu)).toHaveLength(1);
    expect(html).toContain('data-panel-visible="false"');

    const chatHtml = await renderWorkspaceShell({
      isDesktop: true,
      isSidePaneOpen: true,
      workspaceMainView: "chat",
    });
    expect(chatHtml.match(/data-testid="side-pane-panel"/gu)).toHaveLength(1);
    expect(chatHtml).toContain('data-panel-visible="true"');
  });

  it.each([true, false])(
    "hides retained side panes with an inactive workspace (desktop=%s)",
    async (isDesktop) => {
      const html = await renderWorkspaceShell({
        isDesktop,
        isSidePaneOpen: true,
        isWorkspaceVisible: false,
        workspaceMainView: "chat",
      });
      expect(html).toContain('data-panel-visible="false"');
      expect(html).not.toContain('data-panel-visible="true"');
    },
  );

  it("hides the retained side pane on the plugin marketplace main page", async () => {
    const html = await renderWorkspaceShell({
      isDesktop: true,
      isSidePaneOpen: true,
      workspaceMainView: "plugin-store",
    });
    expect(html).toContain('data-panel-visible="false"');
    expect(html).not.toContain('data-panel-visible="true"');
  });

  it("adds mobile stacking classes only for Web remote control mode", async () => {
    const html = await renderWorkspaceShell({
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    });

    expect(html).not.toContain("max-md:data-[state=collapsed]");
    expect(html).not.toContain('data-layout-id="workspace-shell-layout"');
    expect(html).not.toContain('data-web-remote-navigation-toggle="true"');
    expect(html).toContain('data-web-remote-navigation-resize-handle="true"');
    expect(html).toContain("--web-remote-navigation-height:352px");
    expect(html).toContain('aria-controls="web-remote-control-navigation-panel"');
    expect(html).toContain("webRemoteControl.collapseNavigation");
    expect(html).not.toContain("webRemoteControl.navigationPanel");
    expect(html).not.toContain("max-md:!h-10");
    expect(html).toContain('data-mobile-stacked="true"');
  });

  it("keeps remote sidebar selection out of hidden workbench group context", async () => {
    capturedWorkspaceSidebarProps.props = [];
    useWorkbenchGroupStore.getState().configureClientMode("desktop-continuous");
    useWorkbenchGroupStore.getState().resetWorkbenchGroups();
    useWorkbenchGroupStore.getState().splitSessionIntoGroup(
      V4_PRIMARY_PANE_ID,
      "right",
      {
        workspaceScope: { workspacePath: "/workspace-b" },
        sessionId: "secondary-session",
      },
      {
        workspaceScope: { workspacePath: "/tmp/project" },
        sessionId: "main-session",
      },
    );
    const groupId = useWorkbenchGroupStore.getState().activeGroupId;
    const handleSelectTask = vi.fn();

    await renderWorkspaceShell({
      activeTaskId: "main-session",
      handleSelectTask,
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    });
    const onSelectTask = capturedWorkspaceSidebarProps.props.at(-1)?.onSelectTask;
    expect(onSelectTask).toBeTypeOf("function");
    onSelectTask?.("/tmp/project", "main-session");

    expect(handleSelectTask).toHaveBeenCalledWith("/tmp/project", "main-session", undefined);
    expect(useWorkbenchGroupStore.getState().groups[groupId!]?.focusedPaneId).toBe("pane-1");
    useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  });

  it("renders the dedicated mobile task shell on Web remote control mobile viewports", async () => {
    vi.stubGlobal("window", {
      innerHeight: 800,
      matchMedia: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
      sessionStorage: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });

    const html = await renderWorkspaceShell({
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    });

    expect(html).toContain('data-testid="web-remote-mobile-shell"');
    expect(html).toContain('data-testid="workspace-sidebar"');

    vi.unstubAllGlobals();
  });

  it("passes workspace identity to mobile V4ChatPane for remote workspaces", async () => {
    capturedChatPaneProps.length = 0;
    vi.stubGlobal("window", {
      innerHeight: 800,
      matchMedia: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
      sessionStorage: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });

    const workspaceIdentity = "remote:ssh:dev:22:root:/root";
    await renderWorkspaceShell({
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
      workspaceIdentity,
      workspaceRemoteSessionId: "remote-session-1",
    });

    expect(capturedChatPaneProps[0]?.workspaceIdentity).toBe(workspaceIdentity);

    vi.unstubAllGlobals();
  });

  it("exposes plan-detail opening from the mobile remote chat", async () => {
    capturedChatPaneProps.length = 0;
    const handleOpenPlanDetail = vi.fn();
    vi.stubGlobal("window", {
      innerHeight: 800,
      matchMedia: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
      sessionStorage: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });

    await renderWorkspaceShell({
      activeTaskId: "task-with-plan",
      handleOpenPlanDetail,
      initialWebRemoteControlMobileNavigationIntent: "chat",
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    });

    expect(capturedChatPaneProps[0]?.onOpenPlanDetail).toBe(handleOpenPlanDetail);

    vi.unstubAllGlobals();
  });

  it("passes side pane content as a right-side overlay into the dedicated mobile chat shell", async () => {
    vi.stubGlobal("window", {
      innerHeight: 800,
      matchMedia: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
      sessionStorage: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });

    const html = await renderWorkspaceShell({
      isSidePaneOpen: true,
      sidePaneState: {
        activeTabId: "git",
        tabs: [{ id: "git", type: "git" }],
      },
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    });

    expect(html).toContain('data-testid="web-remote-mobile-shell"');
    expect(html).toContain('data-mobile-side-pane-open="true"');
    expect(html).toContain('data-testid="mobile-side-pane-overlay"');
    expect(html).toContain('data-testid="side-pane-panel"');
    expect(html).toContain('data-mobile-overlay="true"');
    expect(html).toContain('data-panel-visible="true"');

    const hiddenHtml = await renderWorkspaceShell({
      isWorkspaceVisible: false,
      isSidePaneOpen: true,
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    });
    expect(hiddenHtml).toContain('data-mobile-overlay="true"');
    expect(hiddenHtml).toContain('data-panel-visible="false"');
    expect(hiddenHtml).not.toContain('data-panel-visible="true"');

    vi.unstubAllGlobals();
  });

  it("routes mobile task find through the shell overlay instead of chat content", async () => {
    vi.stubGlobal("window", {
      innerHeight: 800,
      matchMedia: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
      sessionStorage: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });

    const html = await renderWorkspaceShell({
      initialWebRemoteControlMobileNavigationIntent: "chat",
      isSidePaneOpen: true,
      taskFindDialogProps: {
        open: true,
        placement: "chat",
        focusRequestId: 1,
        conversationMatchCount: 1,
        conversationMatchIndex: 0,
        fileChangeMatchCount: 1,
        fileChangeMatchIndex: 0,
        onOpenChange: vi.fn(),
        onConversationFindChange: vi.fn(),
        onConversationFindNavigate: vi.fn(),
        onFileChangeFindChange: vi.fn(),
        onFileChangeFindNavigate: vi.fn(),
        onOpenFileChanges: vi.fn(),
      },
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    });
    const chatContentStart = html.indexOf('data-testid="mobile-chat-content"');
    const chatOverlayStart = html.indexOf('data-testid="mobile-chat-overlay-prop"');

    expect(chatOverlayStart).toBeGreaterThan(chatContentStart);
    expect(html.slice(chatContentStart, chatOverlayStart)).not.toContain(
      'placeholder="quickPick.find.placeholder.conversation"',
    );
    expect(html.slice(chatOverlayStart)).toContain(
      'placeholder="quickPick.find.placeholder.conversation"',
    );

    vi.unstubAllGlobals();
  });

  it("keeps mobile stacking disabled for the default shell", async () => {
    const html = await renderWorkspaceShell();

    expect(html).toContain('data-mobile-stacked="false"');
  });

  it("renders the draft workspace header while a new task draft is active", async () => {
    const html = await renderWorkspaceShell({
      activeTaskId: null,
      isDesktop: true,
      workspaceShellZCodeState: {
        ...createWorkspaceShellProps().workspaceShellZCodeState,
        activeTaskId: null,
      },
    });

    expect(html).toContain('data-testid="workspace-header"');
    expect(html).toContain('data-workspace-header-variant="draft"');
    expect(html).toContain("<header");
    expect(html).not.toContain('data-testid="new-task-draft-drag-region"');
    expect(html).not.toContain("absolute inset-x-0 top-0 z-10 h-10 [app-region:drag]");
  });

  it("does not render the draft drag region on web", async () => {
    const html = await renderWorkspaceShell({
      activeTaskId: null,
      isDesktop: false,
      workspaceShellZCodeState: {
        ...createWorkspaceShellProps().workspaceShellZCodeState,
        activeTaskId: null,
      },
    });

    expect(html).not.toContain('data-testid="new-task-draft-drag-region"');
    expect(html).not.toContain('data-testid="terminal-toggle"');
  });

  it("uses the draft workspace header within Windows chrome", async () => {
    const html = await renderWorkspaceShell({
      activeTaskId: null,
      isDesktop: true,
      isMacDesktop: false,
      isWindowsDesktop: true,
      workspaceShellZCodeState: {
        ...createWorkspaceShellProps().workspaceShellZCodeState,
        activeTaskId: null,
      },
    });

    expect(html).toContain('data-workspace-header-variant="draft"');
    expect(html).not.toContain('data-testid="linux-window-controls"');
  });

  it("uses the draft workspace header within Linux chrome", async () => {
    const html = await renderWorkspaceShell({
      activeTaskId: null,
      isDesktop: true,
      isMacDesktop: false,
      isWindowsDesktop: false,
      workspaceShellZCodeState: {
        ...createWorkspaceShellProps().workspaceShellZCodeState,
        activeTaskId: null,
      },
    });

    expect(html).toContain('data-workspace-header-variant="draft"');
    expect(html).not.toContain('data-testid="linux-window-controls"');
    expect(html).toContain("rounded-xl");
  });

  it("renders the workspace header again after the draft is promoted to a task", async () => {
    const html = await renderWorkspaceShell({
      activeTaskId: "task-1",
      activeTaskTitle: "Task 1",
      workspaceShellZCodeState: {
        ...createWorkspaceShellProps().workspaceShellZCodeState,
        activeTaskId: "task-1",
      },
    });

    expect(html).toContain('data-testid="workspace-header"');
    expect(html).toContain('data-workspace-header-variant="task"');
    expect(html).not.toContain('data-testid="new-task-draft-drag-region"');
  });

  it("does not inject the workspace header into mobile remote chat while a new task draft is active", async () => {
    vi.stubGlobal("window", {
      innerHeight: 800,
      matchMedia: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
      sessionStorage: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });

    const html = await renderWorkspaceShell({
      activeTaskId: null,
      initialWebRemoteControlMobileNavigationIntent: "chat",
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
      workspaceShellZCodeState: {
        ...createWorkspaceShellProps().workspaceShellZCodeState,
        activeTaskId: null,
      },
    });

    expect(html).toContain('data-testid="web-remote-mobile-shell"');
    expect(html).not.toContain('data-testid="workspace-header"');

    vi.unstubAllGlobals();
  });
});

it("places the workspace header inside the independent conversation frame", async () => {
  const html = await renderWorkspaceShell({ isDesktop: true, isMacDesktop: true });
  expect(html).toContain('data-workspace-conversation-frame="true"');
  expect(html.indexOf('data-panel-id="conversation-column"')).toBeLessThan(
    html.indexOf('data-testid="workspace-header"'),
  );
  expect(html.indexOf('data-workspace-conversation-frame="true"')).toBeLessThan(
    html.indexOf('data-testid="workspace-header"'),
  );
});

it("项目侧栏保留当前远端 identity 与 attachment，不按相同 cwd 合并", async () => {
  capturedWorkspaceSidebarProps.props = [];
  await renderWorkspaceShell({
    workspaceAbsPath: "/same",
    workspaceIdentity: "remote:server:one:/same",
    workspaceRemoteSessionId: "attachment-one",
  });
  await renderWorkspaceShell({
    workspaceAbsPath: "/same",
    workspaceIdentity: "remote:server:two:/same",
    workspaceRemoteSessionId: "attachment-two",
  });
  expect(
    capturedWorkspaceSidebarProps.props.map((props) => [
      props.workspaceIdentity,
      props.workspaceRemoteSessionId,
    ]),
  ).toEqual([
    ["remote:server:one:/same", "attachment-one"],
    ["remote:server:two:/same", "attachment-two"],
  ]);
});

it("mounts the same project sidebar in the real narrow mobile branch", async () => {
  vi.stubGlobal("window", {
    innerHeight: 844,
    innerWidth: 390,
    matchMedia: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
    sessionStorage: { getItem: vi.fn(() => null), removeItem: vi.fn(), setItem: vi.fn() },
  });
  try {
    const html = await renderWorkspaceShell({
      webRemoteControlWorkspaceSwitcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    });
    expect(html).toContain('data-testid="web-remote-mobile-shell"');
    expect(html).toContain('data-testid="workspace-sidebar"');
  } finally {
    vi.unstubAllGlobals();
  }
});
