/* eslint-disable max-lines -- workspace shell 当前集中编排 sidebar、chat、terminal 和 browser pane 的布局联动，先保持单文件收口，避免为满足行数限制打散关键布局状态。*/
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { GripHorizontal, LoaderIcon } from "lucide-react";
import { TID_APP_HEADER } from "@zcode/shared";
// 保活：workspace tab 真正关闭时，按 workspaceKey 回收 side pane terminal 的常驻 PTY/xterm。
// 对称下侧 Terminal.tsx 的 openWorkspaceKeys 回收。
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import {
  V4SplitPaneEntryProvider,
  type V4SplitPaneSessionTarget,
} from "@/v4/splitPaneEntryContext.js";
import {
  SavedWorkflowHubProvider,
  type SavedWorkflowHubTarget,
} from "@/v4/savedWorkflowHubContext.js";
import {
  WorkflowRunOpenProvider,
  type WorkflowRunOpenTarget,
} from "@/v4/workflowRunOpenContext.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  canPlaceWorkbenchSessionInSplit,
  placeWorkbenchSessionInSplit,
  selectWorkbenchSession,
} from "@/v4/workbenchSessionPlacement.js";
import { usePaneSessionPersistence } from "@/v4/usePaneSessionPersistence.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { ChatEmptyWorkspacePreviewMenu } from "@/ChatEmptyState.js";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { WorkspacePluginPreview } from "@/WorkspacePluginPreview.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

import {
  AUTOMATIONS_TOAST_ANCHOR_ID,
  AutomationsSection,
} from "@/settings/AutomationsSection.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import {
  WorkspaceSidebar,
  type SidebarFileTreeOpenRequest,
} from "@/WorkspaceSidebar.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import {
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";

import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
  resolveWorkspaceShellWindowChromeClass,
} from "@/app-shell/workspaceShellWindowChrome.js";
import {
  getDefaultWebRemoteNavigationHeightPx,
  resolveWebRemoteNavigationDragState,
  resolveWebRemoteNavigationToggleState,
  shouldRenderWebRemoteNavigationPanel,
} from "@/app-shell/webRemoteNavigationLayout.js";
import type { WebRemoteNavigationState } from "@/app-shell/webRemoteNavigationLayout.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js";
import { toast } from "@/components/ui/toast.js";
import { getGitDirtyFileCount } from "@/git-branch-switcher/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import { shouldOpenAssistantHtmlInBrowser } from "@/lib/assistantPreviewCards.js";
import { setWorkspaceSidebarResizeActive } from "@/lib/workspaceSidebarResizeState.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  addWorkspacePathOpenRequestListener,
  selectWorkspacePathFileService,
  shouldFallbackWorkspacePathToCodeViewer,
  type WorkspacePathOpenRequest,
} from "@/lib/workspacePathNavigation.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { getActiveSelectionSideChatTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  areWorkspaceFilePathsEqual,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

const WEB_REMOTE_CONTROL_MOBILE_QUERY = "(max-width: 767px)";
const WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY =
  "zcode:web-remote-control:collapse-navigation-once";
const WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX = 800;
const WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX = 4;
const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY =
  "zcode:workspace-shell:sidebar-width-px";
const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
// WorkspaceShellLayout 是 memo 组件，默认 []/{} 会在缺省调用时每次创建新引用；
// 入口缺省这些集合时复用常量，避免浅比较误判 props 变化。
const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: NonNullable<
  WorkspaceShellLayoutProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_WORKSPACE_SESSIONS: NonNullable<
  WorkspaceShellLayoutProps["remoteWorkspaceSessions"]
> = [];
const CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX = 360;
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
// 性能修复：ResizablePanelGroup 收到深相等的新 panelIds 数组，
// 会跟随 chat streaming render 重算布局上下文；固定数组语义上不会随消息变化。
const WORKSPACE_BODY_PANEL_IDS = ["conversation-column", "browser"];
const WORKSPACE_CONVERSATION_PANEL_IDS = ["conversation", "terminal"];

type WebRemoteNavigationDragSession = {
  pointerId: number;
  startHeightPx: number;
  startY: number;
  didDrag: boolean;
};

type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

function clampWorkspaceSidebarWidth(
  widthPx: number,
  containerWidthPx?: number,
) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(
    Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)),
  );
}

function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(
      WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY,
    );
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? clampWorkspaceSidebarWidth(parsed)
      : null;
  } catch {
    return null;
  }
}

function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(
      LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY,
    );
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(widthPx)),
    );
  } catch {
    // ignore
  }
}

function getWebRemoteControlViewportHeight() {
  if (typeof window === "undefined") {
    return WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
  }

  return window.innerHeight || WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
}

function getIsWebRemoteControlMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY).matches
  );
}

function consumeWebRemoteControlCollapseIntent(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (
      window.sessionStorage.getItem(
        WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY,
      ) === "1"
    ) {
      window.sessionStorage.removeItem(
        WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY,
      );
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function markWebRemoteControlCollapseIntent() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY,
      "1",
    );
  } catch {
    // ignore
  }
}

export const WorkspaceShellLayout = memo(
  function WorkspaceShellLayoutComponent({
    services,
    workspaceReadOnlyReason,
    workspaceMainView,
    pluginStoreOpenVersion,
    openAutomationId,
    openAutomationTab,
    openWorkflow,
    onOpenWorkflowConsumed,
    onOpenSavedWorkflowInHub,
    onWorkspaceMainViewChange,
    onOpenAutomationConsumed,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleManageInstalledPlugins,
    onConnectRemote,
    onSelectRemoteProject,
    onCancelRemoteProject,
    onReconnectRemoteWorkspace,
    onLogout,
    onLogin,
    user,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey = EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY,
    onCreateTask,
    onCreateConversationTask,
    onResolveConversationWorkspace,
    onOpenWorkspace,
    onOpenFolderFromWorkspaceMenu,
    onOpenRemoteWorkspace,
    onCreateScratchWorkspace,
    allowOpenWorkspace = true,
    webRemoteControlWorkspaceSwitcher,
    initialWebRemoteControlMobileNavigationIntent,
    initialWebRemoteControlWorkspaceList,
    webRemoteControlTerminalTransportState,
    allowRemoteWorkspace = true,
    remoteWorkspaceSessions = EMPTY_REMOTE_WORKSPACE_SESSIONS,
    workspaceAbsPath,
    workspaceRemoteSessionId,
    workspaceIdentity,
    isWorkspaceVisible = true,
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    workspaceShellZCodeState,
    theme,
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx = 136,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
    toggleSidebarShortcutLabel,
    newTaskShortcutLabel,
    goBackShortcutLabel,
    goForwardShortcutLabel,
    toggleSidePaneShortcutLabel,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
    isTerminalOpen,
    isSidebarVisible,
    isSidePaneOpen,
    isBrowserOpen,
    supportsEmbeddedBrowser,
    summaryPanelVariantOverride,
    onSummaryPanelVariantOverrideChange,
    sidePaneState,
    recentClosedSidePaneTabs,
    projectName,
    workspaceTabs,
    activeTaskId,
    sidePaneOwnerId,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    resolvedActiveTaskMeta,
    activeTaskTitle,
    activeTaskChangeSummary,
    gitWorktreeReviewSourceId,
    gitWorktreeChangeSummary,
    activeGitSourceId,
    gitState,
    browserNavigationRequest,
    browserRestoreUrls,
    providerConfigFile,
    taskNativeSessionLogFile,
    taskSessionFile,
    testMessages,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
    conversationFindQuery,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
    fileChangeFindActiveIndex,
    fileChangeFindNavigationRequestId,
    fileChangeFindQuery,
    onFileChangeFindMatchCountChange,
    appLogoUrl,
    platform,
    reloadSessionDisabled,
    reloadSessionPending,
    handleReloadSession,
    handleSelectTask,
    handleTaskNavBack,
    handleTaskNavForward,
    handleStartDraftInWorkspace,
    handleOpenCommandCenter,
    handleRefreshGit,
    handleBrowserUrlChange,
    handleBrowserPageMetadataChange,
    handleToggleSidebar,
    handleToggleTerminal,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleOpenBrowserPermissionSettings,
    handleOpenTreemapping,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenTerminalTab,
    handleToggleGit,
    handleOpenGitReview,
    handleToggleSidePane,
    handleOpenBrowserUrl,
    handleOpenCodeViewer,
    handleAutoOpenAssistantPptx,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab,
    handleBrowserNavigationRequestHandled,
    setIsTerminalOpen,
    setGitSelectedSourceId,
    taskFindDialogProps,
  }: WorkspaceShellLayoutProps) {
    const { intl } = useZCodeIntl();
    const isOfficeMode = useIsOfficeMode();
    const baseServices = useBaseWorkspaceServices();
    const tabStoreApi = useTabStoreApi();
    const isLinuxDesktop = Boolean(
      isDesktop && !isMacDesktop && !isWindowsDesktop,
    );
    const isWebRemoteControlShell = Boolean(webRemoteControlWorkspaceSwitcher);
    // Windows/Linux 原先遗漏外层留白，导致独立面板贴住窗口边缘；桌面统一使用 4px 间距。
    const hasDesktopPanelInset = isMacDesktop || isWindowsDesktop || isLinuxDesktop;
    const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
    const workspaceShellRadiusOptions = {
      isMacDesktop,
      isWindowsDesktop,
      isLinuxDesktop,
      macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
    };
    const workspacePanelRadiusPx = resolveWorkspaceShellPanelRadiusPx(workspaceShellRadiusOptions);
    const workspaceResizeHandleInsetPx = resolveWorkspaceShellResizeHandleInsetPx(workspaceShellRadiusOptions);
    const collapsedSidebarWidthPx = hasDesktopPanelInset ? 4 : 0;
    const [
      isWebRemoteControlNavigationCollapsed,
      setIsWebRemoteControlNavigationCollapsed,
    ] = useState(() =>
      isWebRemoteControlShell ? consumeWebRemoteControlCollapseIntent() : false,
    );
    const [
      webRemoteControlNavigationHeightPx,
      setWebRemoteControlNavigationHeightPx,
    ] = useState(() => {
      const viewportHeight = getWebRemoteControlViewportHeight();
      return resolveWebRemoteNavigationDragState({
        heightPx: getDefaultWebRemoteNavigationHeightPx(viewportHeight),
        viewportHeight,
      }).heightPx;
    });
    const [
      isWebRemoteControlTaskSwitching,
      setIsWebRemoteControlTaskSwitching,
    ] = useState(false);
    const [
      draftHeaderDropTargetController,
      setDraftHeaderDropTargetController,
    ] = useState<ConversationDropTargetController | null>(null);
    const fileTreeOpenRequestIdRef = useRef(0);
    const [fileTreeOpenRequest, setFileTreeOpenRequest] =
      useState<SidebarFileTreeOpenRequest | null>(null);
    const [isSidebarFileTreeOpen, setIsSidebarFileTreeOpen] = useState(false);
    const [
      isWebRemoteControlMobileViewport,
      setIsWebRemoteControlMobileViewport,
    ] = useState(getIsWebRemoteControlMobileViewport);
    const [
      isWebRemoteControlNavigationDragging,
      setIsWebRemoteControlNavigationDragging,
    ] = useState(false);
    const webRemoteControlNavigationHeightRef = useRef(
      webRemoteControlNavigationHeightPx,
    );
    const webRemoteControlNavigationCollapsedRef = useRef(
      isWebRemoteControlNavigationCollapsed,
    );
    const webRemoteControlNavigationDragRef =
      useRef<WebRemoteNavigationDragSession | null>(null);
    const suppressWebRemoteControlNavigationClickRef = useRef(false);
    const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
    const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(
      sidePaneState?.tabs ?? [],
    );
    const screenshotSurfaceTab = screenshotSurfaceRequest
      ? findScreenshotSurfaceTabForRender(
          sidePaneState?.tabs ?? [],
          screenshotSurfaceRequest,
        )
      : undefined;
    // v4 pane 绑定持久化（M3 门禁「输出中刷新恢复」）：renderer 刷新后恢复上次选中的
    // session；CLI/host 进程未死，pane 重订阅即拿 snapshot+续流。
    usePaneSessionPersistence({
      workspaceKey,
      activeSessionId: activeTaskId,
      draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
      enabled: !isWebRemoteControlShell,
      selectSession: (sessionId) =>
        handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity),
    });
    const workspaceShellRef = useRef<HTMLDivElement | null>(null);
    const workspaceSidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
    const conversationPanelElementRef = useRef<HTMLDivElement | null>(null);
    const conversationAutoCollapseStateRef = useRef({
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      workspaceKey,
    });
    const conversationAutoCollapseResizeTimerRef = useRef<number | null>(null);
    const workspaceSidebarResizeSessionRef =
      useRef<WorkspaceSidebarResizeSession | null>(null);
    const [workspaceSidebarPanelWidthPx, setWorkspaceSidebarPanelWidthPx] =
      useState(
        () =>
          readStoredWorkspaceSidebarWidthPx() ??
          WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
      );
    const workspaceSidebarPanelWidthPxRef = useRef(
      workspaceSidebarPanelWidthPx,
    );
    const openWorkspaceKeys = useMemo(
      () =>
        workspaceTabs.map(
          (tab) => tab.workspaceIdentity?.trim() || tab.workspacePath,
        ),
      [workspaceTabs],
    );
    // 保活回收：workspace tab 真正关闭（从 openWorkspaceKeys 移除）时，回收属于该 workspace 的
    // side pane terminal 常驻 session（杀 PTY + 销 xterm），避免孤儿进程泄漏。
    // 切 workspace 不会让 workspaceKey 离开这个集合，所以保活的 session 不受影响。
    // 对称下侧 Terminal.tsx:145-177 的 openWorkspaceKeys 回收逻辑。
    useEffect(() => {
      const retained = new Set(openWorkspaceKeys);
      sidePaneTerminalSessionRegistry.releaseByPredicate(
        (entry) => Boolean(entry.workspaceKey) && !retained.has(entry.workspaceKey),
      );
    }, [openWorkspaceKeys]);
    const isSidebarPanelVisible = isSidebarVisible;
    const {
      panelRef: terminalPanelRef,
      panelElementRef: terminalPanelElementRef,
      isVisible: isTerminalVisible,
    } = useAnimatedResizablePanel({
      open: isTerminalOpen,
      expandedSize: "30%",
      rememberExpandedSize: true,
    });
    const {
      panelRef: sidePanePanelRef,
      panelElementRef: sidePanePanelElementRef,
      isVisible: isSidePaneVisible,
    } = useAnimatedResizablePanel({
      // 截图 surface 由 browser-use tab 自己的 fixed 承载层提供尺寸，不能再把整个右侧
      // ResizablePanel 撑开；否则自动化页会闪出空白的 tab 栏，且面板过渡期间 guest surface
      // 仍可能被 Chromium 判定为不可合成。
      open: workspaceMainView === "chat" && isSidePaneOpen,
      expandedSize: SIDE_PANE_DEFAULT_EXPANDED_SIZE,
      rememberExpandedSize: true,
      resizeOnInitialVisibleMount: false,
    });
    const mobileSidePanePanelRef = useRef<PanelImperativeHandle | null>(null);
    const mobileSidePanePanelElementRef = useRef<HTMLDivElement | null>(null);
    const workspaceSessionActionDisabled =
      Boolean(workspaceReadOnlyReason) ||
      reloadSessionDisabled ||
      reloadSessionPending;
    const simplifyHeaderForNarrowRemote =
      isWebRemoteControlShell && isWebRemoteControlMobileViewport;
    // 修复原因：文件树打开时任务列表整屏滑出，侧栏里的 New Task 入口也随之不可见。
    // 顶部浮层需要临时露出 New Task，关闭文件树后继续沿用侧栏收起态规则。
    const showTopOverlayNewTaskButton =
      !isSidebarVisible || isSidebarFileTreeOpen;
    const workspaceSidebarResizeLabel = intl.formatMessage({
      id: "workspaceSidebar.resizeSidebar",
    });

    useEffect(() => {
      conversationAutoCollapseStateRef.current = {
        handleToggleSidebar,
        handleToggleSidePane,
        isSidebarVisible,
        isSidePaneOpen,
        workspaceKey,
      };
    }, [
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      workspaceKey,
    ]);

    useEffect(() => {
      if (workspaceMainView !== "chat") {
        return;
      }

      if (typeof window === "undefined") {
        return;
      }

      const readConversationWidthPx = () =>
        conversationPanelElementRef.current?.getBoundingClientRect().width ??
        null;

      const collapseSidebarIfStillNarrow = () => {
        const widthPx = readConversationWidthPx();
        if (widthPx === null) {
          return;
        }

        const {
          handleToggleSidebar: collapseSidebar,
          isSidebarVisible: latestIsSidebarVisible,
          workspaceKey: latestWorkspaceKey,
        } = conversationAutoCollapseStateRef.current;

        if (
          latestIsSidebarVisible &&
          widthPx < CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX
        ) {
          logger.info(
            "[WorkspaceShellLayout] conversation 过窄，自动收起左侧栏",
            {
              widthPx: Math.round(widthPx),
              thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
              workspaceKey: latestWorkspaceKey,
            },
          );
          collapseSidebar();
        }
      };

      const runAutoCollapseForWindowResize = () => {
        const widthPx = readConversationWidthPx();
        if (widthPx === null) {
          return;
        }

        const {
          handleToggleSidePane: collapseSidePane,
          isSidePaneOpen: latestIsSidePaneOpen,
          workspaceKey: latestWorkspaceKey,
        } = conversationAutoCollapseStateRef.current;

        // 功能说明：自动收起只响应用户改变窗口尺寸后的 conversation 实际宽度。
        // 不监听 conversation 自身 ResizeObserver，避免用户手动打开面板时又被策略关回去。
        if (
          latestIsSidePaneOpen &&
          widthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX
        ) {
          logger.info(
            "[WorkspaceShellLayout] conversation 过窄，自动收起右侧面板",
            {
              widthPx: Math.round(widthPx),
              thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
              workspaceKey: latestWorkspaceKey,
            },
          );
          collapseSidePane();
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(collapseSidebarIfStillNarrow);
          });
          return;
        }

        collapseSidebarIfStillNarrow();
      };

      const handleWindowResize = () => {
        if (conversationAutoCollapseResizeTimerRef.current !== null) {
          window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
        }

        // Bugfix: 大会话 resize trace 显示自动收起侧栏会触发 WorkspaceSidebar
        // 和大量 tooltip/menu 子树重渲染；拖拽窗口过程中先等 resize idle，再保留原收起语义。
        conversationAutoCollapseResizeTimerRef.current = window.setTimeout(
          () => {
            conversationAutoCollapseResizeTimerRef.current = null;
            runAutoCollapseForWindowResize();
          },
          CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS,
        );
      };

      window.addEventListener("resize", handleWindowResize);

      return () => {
        if (conversationAutoCollapseResizeTimerRef.current !== null) {
          window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
          conversationAutoCollapseResizeTimerRef.current = null;
        }
        window.removeEventListener("resize", handleWindowResize);
      };
    }, [workspaceMainView]);

    useEffect(() => {
      workspaceSidebarPanelWidthPxRef.current = workspaceSidebarPanelWidthPx;
    }, [workspaceSidebarPanelWidthPx]);

    const applyWorkspaceSidebarWidthDuringDrag = useCallback(
      (nextWidthPx: number) => {
        workspaceSidebarPanelWidthPxRef.current = nextWidthPx;
        const shellElement = workspaceShellRef.current;
        if (!shellElement) {
          return;
        }

        // Bugfix: 大会话 trace 显示拖拽侧栏时每个 pointermove 都 setState，
        // 会让 WorkspaceShellLayout、WorkspaceSidebar 和 ChatView 大树反复 render。
        // 拖拽中的宽度只是瞬时布局值，直接写 CSS 变量；释放时再提交 React state。
        shellElement.style.setProperty(
          WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR,
          `${isSidebarPanelVisible ? nextWidthPx : collapsedSidebarWidthPx}px`,
        );
        shellElement.style.setProperty(
          WORKSPACE_SIDEBAR_WIDTH_CSS_VAR,
          `${nextWidthPx}px`,
        );
      },
      [collapsedSidebarWidthPx, isSidebarPanelVisible],
    );

    useEffect(() => {
      if (readStoredWorkspaceSidebarWidthPx() !== null) {
        return;
      }

      const legacyRatio = readLegacyWorkspaceSidebarWidthRatio();
      const shellElement = workspaceShellRef.current;
      if (legacyRatio === null || !shellElement) {
        return;
      }

      const containerWidthPx = shellElement.getBoundingClientRect().width;
      if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
        return;
      }

      // 修复原因：外层 workspace shell 不再使用 react-resizable-panels，
      // 但旧版本已持久化过 sidebar/content 百分比。迁移成像素宽度后，
      // 普通窗口 resize 不会再触发 RRP layout store，同时仍保留用户拖出的侧栏宽度。
      const migratedWidthPx = clampWorkspaceSidebarWidth(
        containerWidthPx * legacyRatio,
        containerWidthPx,
      );
      workspaceSidebarPanelWidthPxRef.current = migratedWidthPx;
      setWorkspaceSidebarPanelWidthPx(migratedWidthPx);
      persistWorkspaceSidebarWidthPx(migratedWidthPx);
    }, []);

    const applyWorkspaceSidebarWidth = useCallback(
      (nextWidthPx: number, options: { persist: boolean }) => {
        const containerWidthPx =
          workspaceShellRef.current?.getBoundingClientRect().width;
        const resolvedWidthPx = clampWorkspaceSidebarWidth(
          nextWidthPx,
          containerWidthPx,
        );
        workspaceSidebarPanelWidthPxRef.current = resolvedWidthPx;
        setWorkspaceSidebarPanelWidthPx((currentWidthPx) =>
          currentWidthPx === resolvedWidthPx ? currentWidthPx : resolvedWidthPx,
        );
        if (options.persist) {
          persistWorkspaceSidebarWidthPx(resolvedWidthPx);
        }
        return resolvedWidthPx;
      },
      [],
    );

    const handleWorkspaceSidebarResizeStart = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (
          !isSidebarPanelVisible ||
          (event.pointerType === "mouse" && event.button !== 0)
        ) {
          return;
        }

        const shellElement = workspaceShellRef.current;
        if (!shellElement) {
          return;
        }

        const containerWidthPx = shellElement.getBoundingClientRect().width;
        workspaceSidebarResizeSessionRef.current = {
          containerWidthPx,
          pointerId: event.pointerId,
          startWidthPx: workspaceSidebarPanelWidthPxRef.current,
          startX: event.clientX,
        };
        setWorkspaceSidebarResizeActive({
          active: true,
          panelElement: workspaceSidebarPanelElementRef.current,
          shellElement,
        });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      },
      [isSidebarPanelVisible],
    );

    const handleWorkspaceSidebarResizeMove = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        const resizeSession = workspaceSidebarResizeSessionRef.current;
        if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
          return;
        }

        event.preventDefault();
        const nextWidthPx = clampWorkspaceSidebarWidth(
          resizeSession.startWidthPx + event.clientX - resizeSession.startX,
          resizeSession.containerWidthPx,
        );
        applyWorkspaceSidebarWidthDuringDrag(nextWidthPx);
        event.currentTarget.setAttribute(
          "aria-valuenow",
          String(Math.round(nextWidthPx)),
        );
      },
      [applyWorkspaceSidebarWidthDuringDrag],
    );

    const finishWorkspaceSidebarResize = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
        const resizeSession = workspaceSidebarResizeSessionRef.current;
        if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
          return;
        }

        workspaceSidebarResizeSessionRef.current = null;
        setWorkspaceSidebarResizeActive({
          active: false,
          panelElement: workspaceSidebarPanelElementRef.current,
          shellElement: workspaceShellRef.current,
        });
        setWorkspaceSidebarPanelWidthPx((currentWidthPx) => {
          const finalWidthPx = workspaceSidebarPanelWidthPxRef.current;
          return currentWidthPx === finalWidthPx
            ? currentWidthPx
            : finalWidthPx;
        });
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (!cancelled) {
          persistWorkspaceSidebarWidthPx(
            workspaceSidebarPanelWidthPxRef.current,
          );
        }
      },
      [],
    );

    const handleWorkspaceSidebarResizeKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!isSidebarPanelVisible) {
          return;
        }

        const containerWidthPx =
          workspaceShellRef.current?.getBoundingClientRect().width;
        const maxWidthPx =
          containerWidthPx && containerWidthPx > 0
            ? containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO
            : workspaceSidebarPanelWidthPxRef.current;
        let nextWidthPx: number | null = null;

        if (event.key === "ArrowLeft") {
          nextWidthPx =
            workspaceSidebarPanelWidthPxRef.current -
            WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
        } else if (event.key === "ArrowRight") {
          nextWidthPx =
            workspaceSidebarPanelWidthPxRef.current +
            WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
        } else if (event.key === "Home") {
          nextWidthPx = WORKSPACE_SIDEBAR_MIN_WIDTH_PX;
        } else if (event.key === "End") {
          nextWidthPx = maxWidthPx;
        }

        if (nextWidthPx === null) {
          return;
        }

        event.preventDefault();
        applyWorkspaceSidebarWidth(nextWidthPx, { persist: true });
      },
      [applyWorkspaceSidebarWidth, isSidebarPanelVisible],
    );

    useEffect(() => {
      return () => {
        setWorkspaceSidebarResizeActive({
          active: false,
          panelElement: workspaceSidebarPanelElementRef.current,
          shellElement: workspaceShellRef.current,
        });
      };
    }, []);

    useEffect(() => {
      webRemoteControlNavigationHeightRef.current =
        webRemoteControlNavigationHeightPx;
      webRemoteControlNavigationCollapsedRef.current =
        isWebRemoteControlNavigationCollapsed;
    }, [
      isWebRemoteControlNavigationCollapsed,
      webRemoteControlNavigationHeightPx,
    ]);
    useEffect(() => {
      if (
        !isWebRemoteControlShell ||
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      ) {
        return;
      }

      const mediaQueryList = window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY);
      const syncMobileViewport = () => {
        setIsWebRemoteControlMobileViewport(mediaQueryList.matches);
      };

      syncMobileViewport();
      if (typeof mediaQueryList.addEventListener === "function") {
        mediaQueryList.addEventListener("change", syncMobileViewport);
        return () => {
          mediaQueryList.removeEventListener("change", syncMobileViewport);
        };
      }

      mediaQueryList.addListener(syncMobileViewport);
      return () => {
        mediaQueryList.removeListener(syncMobileViewport);
      };
    }, [isWebRemoteControlShell]);

    useEffect(() => {
      if (!isWebRemoteControlShell || typeof window === "undefined") {
        return;
      }

      const clampNavigationHeightToViewport = () => {
        if (webRemoteControlNavigationCollapsedRef.current) {
          return;
        }

        const viewportHeight = getWebRemoteControlViewportHeight();
        setWebRemoteControlNavigationHeightPx(
          (currentHeightPx) =>
            resolveWebRemoteNavigationDragState({
              heightPx: currentHeightPx,
              viewportHeight,
            }).heightPx,
        );
      };

      window.addEventListener("resize", clampNavigationHeightToViewport);
      return () => {
        window.removeEventListener("resize", clampNavigationHeightToViewport);
      };
    }, [isWebRemoteControlShell]);
    const applyWebRemoteNavigationState = useCallback(
      (nextState: WebRemoteNavigationState) => {
        setWebRemoteControlNavigationHeightPx(nextState.heightPx);
        setIsWebRemoteControlNavigationCollapsed(nextState.isCollapsed);
      },
      [],
    );
    const toggleWebRemoteNavigation = useCallback(() => {
      const nextState = resolveWebRemoteNavigationToggleState({
        currentHeightPx: webRemoteControlNavigationHeightRef.current,
        isCollapsed: webRemoteControlNavigationCollapsedRef.current,
        viewportHeight: getWebRemoteControlViewportHeight(),
      });

      logger.debug("[WorkspaceShellLayout] Web 远控导航快速切换", nextState);
      applyWebRemoteNavigationState(nextState);
    }, [applyWebRemoteNavigationState]);
    const handleWebRemoteNavigationResizeStart = useCallback(
      (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
          return;
        }
        if (event.pointerType === "mouse" && event.button !== 0) {
          return;
        }

        const startHeightPx = webRemoteControlNavigationCollapsedRef.current
          ? 0
          : webRemoteControlNavigationHeightRef.current;
        webRemoteControlNavigationDragRef.current = {
          pointerId: event.pointerId,
          startHeightPx,
          startY: event.clientY,
          didDrag: false,
        };
        suppressWebRemoteControlNavigationClickRef.current = true;
        setIsWebRemoteControlNavigationDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽开始", {
          startHeightPx,
        });
      },
      [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
    );
    const handleWebRemoteNavigationResizeMove = useCallback(
      (event: ReactPointerEvent<HTMLButtonElement>) => {
        const dragSession = webRemoteControlNavigationDragRef.current;
        if (!dragSession || dragSession.pointerId !== event.pointerId) {
          return;
        }

        const deltaY = event.clientY - dragSession.startY;
        if (
          !dragSession.didDrag &&
          Math.abs(deltaY) < WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX
        ) {
          return;
        }

        event.preventDefault();
        dragSession.didDrag = true;
        applyWebRemoteNavigationState(
          resolveWebRemoteNavigationDragState({
            heightPx: dragSession.startHeightPx + deltaY,
            viewportHeight: getWebRemoteControlViewportHeight(),
          }),
        );
      },
      [applyWebRemoteNavigationState],
    );
    const finishWebRemoteNavigationResize = useCallback(
      (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
        const dragSession = webRemoteControlNavigationDragRef.current;
        if (!dragSession || dragSession.pointerId !== event.pointerId) {
          return;
        }

        webRemoteControlNavigationDragRef.current = null;
        setIsWebRemoteControlNavigationDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }

        if (cancelled) {
          suppressWebRemoteControlNavigationClickRef.current = false;
          return;
        }

        if (!dragSession.didDrag) {
          toggleWebRemoteNavigation();
          return;
        }

        const nextState = resolveWebRemoteNavigationDragState({
          heightPx:
            dragSession.startHeightPx + event.clientY - dragSession.startY,
          viewportHeight: getWebRemoteControlViewportHeight(),
        });
        logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽结束", nextState);
        applyWebRemoteNavigationState(nextState);
      },
      [applyWebRemoteNavigationState, toggleWebRemoteNavigation],
    );
    const handleWebRemoteNavigationHandleClick = useCallback(() => {
      if (suppressWebRemoteControlNavigationClickRef.current) {
        suppressWebRemoteControlNavigationClickRef.current = false;
        return;
      }

      toggleWebRemoteNavigation();
    }, [toggleWebRemoteNavigation]);
    const handleWebRemoteTaskOpen = useCallback(
      ({ crossWorkspace }: { crossWorkspace: boolean }) => {
        if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
          return;
        }

        // Bugfix: 远控移动端在“选中任务”后仍保持顶部导航展开，会挤压会话区域，读写消息时需要再手动折叠一次。
        // 这里在任务点击后自动折叠；跨 workspace 跳转时再写一次 session intent，确保新页面首帧也保持折叠态。
        setIsWebRemoteControlNavigationCollapsed(true);
        if (crossWorkspace) {
          markWebRemoteControlCollapseIntent();
        }
      },
      [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
    );
    const handleWebRemoteTaskSwitchingChange = useCallback(
      (switching: boolean) => {
        setIsWebRemoteControlTaskSwitching(switching);
      },
      [],
    );
    const renderWebRemoteNavigationPanel = shouldRenderWebRemoteNavigationPanel(
      {
        isCollapsed: isWebRemoteControlNavigationCollapsed,
        isMobileViewport: isWebRemoteControlMobileViewport,
        isWebRemoteControlShell,
      },
    );
    const activeSearchResultHighlightRequest = useMemo(() => {
      if (
        !searchResultHighlightRequest ||
        searchResultHighlightRequest.taskId !== activeTaskId
      ) {
        return null;
      }

      const activeWorkspaceKey = buildTaskWorkspaceKey(
        workspaceAbsPath,
        workspaceIdentity,
      );
      const requestWorkspaceKey = buildTaskWorkspaceKey(
        searchResultHighlightRequest.workspacePath,
        searchResultHighlightRequest.workspaceIdentity,
      );
      return activeWorkspaceKey === requestWorkspaceKey
        ? searchResultHighlightRequest
        : null;
    }, [
      activeTaskId,
      searchResultHighlightRequest,
      workspaceAbsPath,
      workspaceIdentity,
    ]);
    const renderChatFindDialog = () => (
      <TaskFindDialog {...taskFindDialogProps} placement="chat" />
    );
    const gitDirtyFileCount = useMemo(() => {
      // 关键业务逻辑：同一个文件可能同时出现在 staged / unstaged。
      // 这里按 path 去重后再统计，避免入口里“未提交更改文件数”被重复计算。
      return getGitDirtyFileCount(gitState.datasets);
    }, [gitState.datasets.staged, gitState.datasets.unstaged]);
    const workspaceRemoteTarget = useMemo(
      () =>
        workspaceTabs.find(
          (tab) =>
            tab.workspacePath === workspaceAbsPath &&
            (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
        )?.remoteTarget,
      [workspaceAbsPath, workspaceIdentity, workspaceTabs],
    );
    const workspaceLocalPathForRemoteMcpSync = useMemo(
      () =>
        workspaceTabs.find(
          (tab) =>
            tab.workspacePath === workspaceAbsPath &&
            (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
        )?.localWorkspacePath,
      [workspaceAbsPath, workspaceIdentity, workspaceTabs],
    );
    const webRemoteNavigationPanelStyle = useMemo<CSSProperties | undefined>(
      () =>
        isWebRemoteControlShell
          ? ({
              "--web-remote-navigation-height": `${webRemoteControlNavigationHeightPx}px`,
            } as CSSProperties)
          : undefined,
      [isWebRemoteControlShell, webRemoteControlNavigationHeightPx],
    );
    const workspaceShellSplitStyle = useMemo(
      () =>
        ({
          ...webRemoteNavigationPanelStyle,
          "--workspace-sidebar-panel-width": `${
            isSidebarPanelVisible
              ? workspaceSidebarPanelWidthPx
              : collapsedSidebarWidthPx
          }px`,
          "--workspace-sidebar-width": `${workspaceSidebarPanelWidthPx}px`,
          "--workspace-panel-radius": `${workspacePanelRadiusPx}px`,
          "--workspace-resize-handle-inset": `${workspaceResizeHandleInsetPx}px`,
        }) as CSSProperties,
      [
        collapsedSidebarWidthPx,
        isSidebarPanelVisible,
        workspacePanelRadiusPx,
        workspaceResizeHandleInsetPx,
        workspaceSidebarPanelWidthPx,
        webRemoteNavigationPanelStyle,
      ],
    );
    const activePreviewPath = useMemo(() => {
      const activeSidePaneTab =
        sidePaneState?.tabs.find(
          (tab) => tab.id === sidePaneState.activeTabId,
        ) ?? null;
      return activeSidePaneTab?.type === "code-viewer"
        ? (activeSidePaneTab.source.path ?? null)
        : null;
    }, [sidePaneState]);
    const findFileLinkOwnerWorkspace = useCallback(
      (
        targetPath: string,
        targetWorkspaceIdentity?: string,
        targetWorkspaceRemoteSessionId?: string,
      ) => {
        const matches = workspaceTabs.filter(
          (tab) =>
            isWorkspaceFilePathInside(tab.workspacePath, targetPath) &&
            (!targetWorkspaceIdentity ||
              tab.workspaceIdentity === targetWorkspaceIdentity) &&
            (!targetWorkspaceRemoteSessionId ||
              tab.remoteSessionId === targetWorkspaceRemoteSessionId),
        );
        if (matches.length === 0) {
          return null;
        }
        return (
          matches.sort((left, right) => {
            const leftActive =
              left.workspaceIdentity === workspaceIdentity ? 1 : 0;
            const rightActive =
              right.workspaceIdentity === workspaceIdentity ? 1 : 0;
            if (leftActive !== rightActive) {
              return rightActive - leftActive;
            }
            return right.workspacePath.length - left.workspacePath.length;
          })[0] ?? null
        );
      },
      [workspaceIdentity, workspaceTabs],
    );
    const openFileTreeRequest = useCallback(
      (request: Omit<SidebarFileTreeOpenRequest, "id">) => {
        fileTreeOpenRequestIdRef.current += 1;
        setFileTreeOpenRequest({
          id: fileTreeOpenRequestIdRef.current,
          ...request,
        });
      },
      [],
    );
    const showChatMainView = useCallback(() => {
      onWorkspaceMainViewChange("chat");
    }, [onWorkspaceMainViewChange]);
    const primaryNavigationBack =
      workspaceMainView === "plugin-store"
        ? handleManageInstalledPlugins
        : handleTaskNavBack;
    const canPrimaryNavigationBack =
      workspaceMainView === "plugin-store" || canTaskNavBack;
    useEffect(() => {
      if (
        isWebRemoteControlShell &&
        (workspaceMainView === "automations" ||
          workspaceMainView === "plugin-store")
      ) {
        // 修复原因：手机远控复用桌面 shell 时可能保留上一次主视图状态；
        // 远控不承载 Automations，必须立即回落到 continuous/replayable 边界之外的聊天页。
        onWorkspaceMainViewChange("chat");
      }
    }, [isWebRemoteControlShell, onWorkspaceMainViewChange, workspaceMainView]);
    const handleCreateTaskInChat = useCallback(
      (request?: Parameters<typeof onCreateTask>[0]) => {
        // workspaceReadOnlyReason 判定的是活动 workspace；当 request 显式带 targetWorkspace 时
        // 目标另属他项目（跨项目发起已保存工作流，docs/dynamic-workflow/launch.md「The detail page」），
        // 活动 workspace 的只读性不适用，真正的守卫是 root 动作对 target 的 isWorkspaceReadOnly。
        const hasTargetWorkspace =
          typeof request === "object" && request !== null && Boolean(request.targetWorkspace);
        if (!hasTargetWorkspace && workspaceReadOnlyReason) {
          return;
        }
        showChatMainView();
        onCreateTask(request);
      },
      [onCreateTask, showChatMainView, workspaceReadOnlyReason],
    );
    const shellWorkbenchBinding = useMemo<WorkbenchSessionBinding | null>(
      () =>
        activeTaskId
          ? {
              workspaceScope: {
                workspacePath: workspaceAbsPath,
                ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
                ...(workspaceRemoteSessionId
                  ? { remoteSessionId: workspaceRemoteSessionId }
                  : {}),
              },
              sessionId: activeTaskId,
            }
          : null,
      [
        activeTaskId,
        workspaceAbsPath,
        workspaceIdentity,
        workspaceRemoteSessionId,
      ],
    );
    const handleCreateAutomationInChat = useCallback(
      (
        prompt: string,
        targetWorkspace?: { workspacePath: string; workspaceIdentity?: string },
      ) => {
        // 带 target 时跳过活动 workspace 只读检查，交由 handleCreateTaskInChat / root 动作在
        // target 上校验（docs/dynamic-workflow/launch.md「The detail page」）；无 target 时形状不变。
        if (!targetWorkspace && workspaceReadOnlyReason) return;
        handleCreateTaskInChat({
          initialPrompt: prompt,
          ...(targetWorkspace ? { targetWorkspace } : {}),
        });
      },
      [handleCreateTaskInChat, workspaceReadOnlyReason],
    );
    // 工作流「运行」现由中枢直接启动（docs/dynamic-workflow/launch.md）：GUI 建空会话 +
    // 发 startSavedWorkflow 命令，不再合成对话文案。本层只在 accepted 后把会话切到前台。
    const handleSelectTaskInChat = useCallback(
      (
        targetWorkspacePath: string,
        taskId: string,
        targetWorkspaceIdentity?: string,
        targetRemoteSessionId?: string,
        expectedUnreadAt?: number,
      ) => {
        if (!isWebRemoteControlShell) {
          const workspaceResult = ensureTaskNavigationWorkspace({
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            activateTabByPath: tabStoreApi.getState().activateTabByPath,
            addLocalWorkspaceTab: (workspacePath) => {
              tabStoreApi.getState().addTab(workspacePath);
            },
          });
          if (!workspaceResult.accepted) {
            logger.warn(
              "[automations] 运行历史目标远程 workspace 未连接，保留当前页面",
              {
                sessionId: taskId,
                workspaceIdentity: targetWorkspaceIdentity,
                workspacePath: targetWorkspacePath,
              },
            );
            toast(
              intl.formatMessage({ id: "automations.runs.openSessionFailed" }),
            );
            return;
          }
          if (workspaceResult.openedLocalTab) {
            logger.info("[automations] 为运行历史会话补开本地 workspace tab", {
              sessionId: taskId,
              workspacePath: targetWorkspacePath,
            });
          }
          const resolvedRemoteSessionId =
            targetRemoteSessionId ??
            workspaceTabs.find(
              (tab) =>
                (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
                (targetWorkspaceIdentity?.trim() || targetWorkspacePath),
            )?.remoteSessionId;
          const target: V4SplitPaneSessionTarget = {
            workspacePath: targetWorkspacePath,
            ...(targetWorkspaceIdentity?.trim()
              ? { workspaceIdentity: targetWorkspaceIdentity }
              : {}),
            ...(resolvedRemoteSessionId
              ? { remoteSessionId: resolvedRemoteSessionId }
              : {}),
            sessionId: taskId,
          };
          selectWorkbenchSession(shellWorkbenchBinding, target);
        }
        // 只有目标 workspace 已经激活或补开成功后才关闭 Automations，避免失败时看起来像跳转成功。
        showChatMainView();
        if (typeof expectedUnreadAt === "number") {
          handleSelectTask(
            targetWorkspacePath,
            taskId,
            targetWorkspaceIdentity,
            expectedUnreadAt,
          );
        } else {
          handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
        }
      },
      [
        handleSelectTask,
        intl,
        isWebRemoteControlShell,
        shellWorkbenchBinding,
        showChatMainView,
        tabStoreApi,
        workspaceTabs,
      ],
    );
    // 中枢直接启动 accepted 后切到新会话（run 卡已在顶部）：复用运行历史那条导航，
    // target 恒带工作流所属项目坐标（不变式 7），remoteSessionId 决定连接 endpoint。
    // 「已保存」芯片的落点：交给 App 切主视图并设深链（与「自动化」入口同一条导航历史）。
    const handleOpenSavedWorkflowInHub = useCallback(
      (target: SavedWorkflowHubTarget) => {
        onOpenSavedWorkflowInHub(target);
      },
      [onOpenSavedWorkflowInHub],
    );
    const handleNavigateToLaunchedRun = useCallback(
      (target: SavedWorkflowLaunchTarget, sessionId: string) => {
        handleSelectTaskInChat(
          target.workspacePath,
          sessionId,
          target.workspaceIdentity,
          target.remoteSessionId,
        );
      },
      [handleSelectTaskInChat],
    );
    // 工作流运行历史「查看实例」：先回到发起它的会话（侧栏页只在 chat 视图里可见），再开实例详情页。
    const handleOpenSavedWorkflowRun = useCallback(
      (params: SavedWorkflowsOpenRunParams) => {
        // 中枢是跨项目视图：实例必须开在发起它的项目，而非活动项目（不变式 8）。
        // params 恒带 workspacePath/identity；仅在异常缺省时兜底回退到活动 workspace。
        const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
        const targetWorkspaceIdentity =
          params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
        // remoteSessionId 不在契约里：按目标 workspace 从已打开 tab 反查；命中活动项目即取活动值。
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === targetWorkspacePath &&
            (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          targetWorkspacePath,
          params.sessionId,
          targetWorkspaceIdentity,
          targetRemoteSessionId,
        );
        handleOpenWorkflowRun({
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
          ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
          parentSessionId: params.sessionId,
          toolCallId: params.toolCallId,
          runId: params.runId,
          workflowName: params.workflowName,
        });
      },
      [
        handleOpenWorkflowRun,
        handleSelectTaskInChat,
        workspaceAbsPath,
        workspaceIdentity,
        workspaceTabs,
      ],
    );
    // 侧栏运行行（docs/dynamic-workflow/presentation.md「The sidebar run line」）：与 composer 徽标
    // 同一跳转——先选中会话，再开 run pane。没有 toolCallId 的 run（不该有）只选中会话。
    const handleOpenSidebarWorkflowRun = useCallback(
      (target: WorkflowRunOpenTarget) => {
        if (target.run.toolCallId === undefined) {
          const targetRemoteSessionId = workspaceTabs.find(
            (tab) =>
              tab.workspacePath === target.workspacePath &&
              (!target.workspaceIdentity || tab.workspaceIdentity === target.workspaceIdentity),
          )?.remoteSessionId;
          handleSelectTaskInChat(
            target.workspacePath,
            target.sessionId,
            target.workspaceIdentity,
            targetRemoteSessionId,
          );
          return;
        }
        handleOpenSavedWorkflowRun({
          sessionId: target.sessionId,
          runId: target.run.runId,
          toolCallId: target.run.toolCallId,
          workflowName: target.run.name ?? "",
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        });
      },
      [handleOpenSavedWorkflowRun, handleSelectTaskInChat, workspaceTabs],
    );
    // 中枢的产物 chip：与「查看实例」逐字同构（同一条「先回到发起它的会话」的路径），
    // 只是终点是 `workflow-artifact` tab 而不是 run 详情页。
    const handleOpenSavedWorkflowArtifact = useCallback(
      (params: SavedWorkflowsOpenArtifactParams) => {
        const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
        const targetWorkspaceIdentity =
          params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === targetWorkspacePath &&
            (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          targetWorkspacePath,
          params.sessionId,
          targetWorkspaceIdentity,
          targetRemoteSessionId,
        );
        handleOpenWorkflowArtifact({
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
          ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
          parentSessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          ...(params.title === undefined ? {} : { title: params.title }),
          // 中枢的 chip 载荷带得到 contentType（html 产物据它直接开浏览器 tab）；`sourcePath`
          // 那份载荷没有，由 `handleOpenWorkflowArtifact` 自己查 journal 补。
          ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
        });
      },
      [
        handleOpenWorkflowArtifact,
        handleSelectTaskInChat,
        workspaceAbsPath,
        workspaceIdentity,
        workspaceTabs,
      ],
    );
    const handlePaneActiveSessionChange = useCallback(
      (
        scope: {
          workspacePath: string;
          workspaceIdentity?: string;
          remoteSessionId?: string;
        },
        sessionId: string,
      ) => {
        handleSelectTaskInChat(
          scope.workspacePath,
          sessionId,
          scope.workspaceIdentity,
          scope.remoteSessionId,
        );
      },
      [handleSelectTaskInChat],
    );

    const canOpenSessionInSplitPane = useCallback(
      (target: V4SplitPaneSessionTarget) => {
        return canPlaceWorkbenchSessionInSplit(shellWorkbenchBinding, target, {
          mode: "context-menu",
          side: "right",
        });
      },
      [shellWorkbenchBinding],
    );
    const handleOpenSessionInSplitPane = useCallback(
      (target: V4SplitPaneSessionTarget) => {
        showChatMainView();
        const shouldSelectTarget = placeWorkbenchSessionInSplit(
          shellWorkbenchBinding,
          target,
          {
            mode: "context-menu",
            side: "right",
          },
        );
        if (shouldSelectTarget) {
          handleSelectTask(
            target.workspacePath,
            target.sessionId,
            target.workspaceIdentity,
          );
        }
      },
      [handleSelectTask, shellWorkbenchBinding, showChatMainView],
    );
    const handleStartDraftInWorkspaceInChat = useCallback(
      (
        targetWorkspacePath: string,
        targetWorkspaceIdentity?: string,
        targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
        createSource?: import("@zcode/shared").SessionCreateSource,
      ) => {
        showChatMainView();
        handleStartDraftInWorkspace(
          targetWorkspacePath,
          targetWorkspaceIdentity,
          targetWorkspacePurpose,
          createSource,
        );
      },
      [handleStartDraftInWorkspace, showChatMainView],
    );
    const handleCreateProjectDraft = useCallback(
      (path: string, identity?: string) =>
        handleStartDraftInWorkspaceInChat(path, identity, undefined, "project"),
      [handleStartDraftInWorkspaceInChat],
    );
    const activeWorkspacePurpose =
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.workspacePurpose ?? "project";
    const handleSelectConversationWorkspace = useCallback(async () => {
      if (!onResolveConversationWorkspace) {
        return;
      }
      let targetWorkspacePath: string;
      try {
        targetWorkspacePath = await onResolveConversationWorkspace();
      } catch (error) {
        logger.error("[WorkspaceShellLayout] 切换对话 workspace 失败", {
          error,
        });
        return;
      }
      if (
        (workspaceIdentity?.trim() || workspaceAbsPath) !== targetWorkspacePath
      ) {
        requestV4ComposerDraftWorkspaceTransfer({
          sourceWorkspacePath: workspaceAbsPath,
          sourceWorkspaceIdentity: workspaceIdentity,
          targetWorkspacePath,
        });
      }
      handleStartDraftInWorkspaceInChat(
        targetWorkspacePath,
        undefined,
        "conversation",
      );
    }, [
      handleStartDraftInWorkspaceInChat,
      onResolveConversationWorkspace,
      workspaceAbsPath,
      workspaceIdentity,
    ]);
    const handleSelectComposerPlugin = useCallback(
      (mention: ComposerMentionPrefill) => {
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(
            workspaceAbsPath,
            mention.markdown,
            workspaceIdentity,
            mention,
            "prepend-if-missing",
          );
      },
      [workspaceAbsPath, workspaceIdentity],
    );
    // v4 pane 生命周期回调（稳定引用，供 memo 友好的 pane 宿主消费）：
    // createSession/fork 后接入既有选择路径；删除会话后回 draft。
    const handleV4SessionCreated = useCallback(
      (sessionId: string) => {
        handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity);
      },
      [handleSelectTask, workspaceAbsPath, workspaceIdentity],
    );
    // 草稿态 composer contextHeader（m5-composer-parity §5.2）：workspace 切换菜单 +
    // Git 分支切换器，与旧 ChatView 空态 contextHeaderContent 同构。壳级能力
    // （workspaceTabs / 远程连接回调）在此闭合，pane 只收 ReactNode。
    // onSelectWorkspace 语义与旧版一致：切到目标 workspace 的新草稿。
    const draftComposerHeader = useMemo(
      () => (
        <>
          <ChatEmptyWorkspacePreviewMenu
            workspacePath={workspaceAbsPath}
            workspaceIdentity={workspaceIdentity}
            isWindowsDesktop={isWindowsDesktop}
            compactForRemoteControl={isWebRemoteControlShell}
            workspaceTabs={workspaceTabs}
            onSelectWorkspace={(workspaceTab) =>
              handleStartDraftInWorkspaceInChat(
                workspaceTab.workspacePath,
                workspaceTab.workspaceIdentity,
                workspaceTab.workspacePurpose,
              )
            }
            onSelectConversationWorkspace={handleSelectConversationWorkspace}
            onOpenFolder={onOpenFolderFromWorkspaceMenu}
            allowOpenWorkspace={allowOpenWorkspace}
            allowRemoteWorkspace={allowRemoteWorkspace}
            remoteWorkspaceSessions={remoteWorkspaceSessions}
            onConnectRemote={onConnectRemote}
            onSelectRemoteProject={onSelectRemoteProject}
            onCancelRemoteProject={onCancelRemoteProject}
          />
          {isOfficeMode && !isWebRemoteControlShell ? (
            <WorkspacePluginPreview
              onOpen={handleOpenPluginStore}
              onSelectPlugin={handleSelectComposerPlugin}
              workspacePath={workspaceAbsPath}
              workspaceIdentity={workspaceIdentity}
              remoteSessionId={workspaceRemoteSessionId ?? undefined}
            />
          ) : !isOfficeMode && activeWorkspacePurpose === "project" ? (
            <GitBranchSwitcher
              workspacePath={workspaceAbsPath}
              gitSummary={gitState.summary}
              dirtyFileCount={gitDirtyFileCount}
              onRefreshGit={handleRefreshGit}
              compactForRemoteControl={isWebRemoteControlShell}
              className="px-0 pt-0"
              popoverClassName="w-72"
              branchListClassName="max-h-48"
              // Bugfix（旧注释保真）：输入框区域在底部，Radix 碰撞避让会把分支菜单翻到下方。
              // 这里锁定上方弹出，避免菜单遮挡输入区并保持操作方向稳定。
              avoidPopoverCollisions={false}
            />
          ) : null}
        </>
      ),
      [
        isOfficeMode,
        workspaceRemoteSessionId,
        handleOpenPluginStore,
        handleSelectComposerPlugin,
        allowOpenWorkspace,
        allowRemoteWorkspace,
        activeWorkspacePurpose,
        gitDirtyFileCount,
        gitState.summary,
        handleRefreshGit,
        handleSelectConversationWorkspace,
        handleStartDraftInWorkspaceInChat,
        isWebRemoteControlShell,
        isWindowsDesktop,
        onCancelRemoteProject,
        onConnectRemote,
        onOpenFolderFromWorkspaceMenu,
        onSelectRemoteProject,
        remoteWorkspaceSessions,
        workspaceAbsPath,
        workspaceIdentity,
        workspaceTabs,
      ],
    );
    const handleV4SessionDeleted = useCallback(() => {
      if (activeTaskId) {
        for (const tab of sidePaneState?.tabs ?? []) {
          if (
            tab.type === "selection-side-chat" &&
            tab.parentSessionId === activeTaskId
          ) {
            handleCloseSidePaneTab(tab.id);
          }
        }
      }
      handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity);
    }, [
      activeTaskId,
      handleCloseSidePaneTab,
      handleStartDraftInWorkspaceInChat,
      sidePaneState?.tabs,
      workspaceAbsPath,
      workspaceIdentity,
    ]);
    const handleOpenMarkdownFileLink = useCallback(
      async (target: WorkspacePathOpenRequest) => {
        if (workspaceReadOnlyReason && target.serviceScope !== "base-local") {
          return;
        }
        try {
          const fileService = selectWorkspacePathFileService(
            target,
            services.fileService,
            baseServices.fileService,
          );
          const fileStat = await fileService.stat({
            path: target.path,
          });
          if (fileStat.type === "file") {
            if (
              shouldOpenAssistantHtmlInBrowser({
                path: target.path,
                workspaceIdentity: target.workspaceIdentity,
                workspaceRemoteSessionId: target.workspaceRemoteSessionId,
                compactForRemoteControl: isWebRemoteControlShell,
              })
            ) {
              handleOpenBrowserUrl(toFileUrl(target.path));
              return;
            }
            handleOpenCodeViewer({
              type: "file",
              title: getPathLeaf(target.path),
              path: target.path,
              workspacePath: target.workspacePath,
              workspaceIdentity: target.workspaceIdentity,
              workspaceRemoteSessionId: target.workspaceRemoteSessionId,
            });
            return;
          }

          if (target.serviceScope === "base-local") {
            openFileTreeRequest({
              target: {
                workspacePath: target.path,
                workspaceName: target.label || getPathLeaf(target.path),
                revealPath: target.path,
                temporaryExternalDirectory: true,
              },
            });
            return;
          }

          const ownerWorkspace = findFileLinkOwnerWorkspace(
            target.path,
            target.workspaceIdentity,
            target.workspaceRemoteSessionId,
          );
          if (ownerWorkspace) {
            openFileTreeRequest({
              target: {
                workspacePath: ownerWorkspace.workspacePath,
                workspaceName: ownerWorkspace.label,
                workspaceIdentity: ownerWorkspace.workspaceIdentity,
                workspaceRemoteSessionId: ownerWorkspace.remoteSessionId,
                revealPath: areWorkspaceFilePathsEqual(
                  ownerWorkspace.workspacePath,
                  target.path,
                )
                  ? undefined
                  : target.path,
              },
            });
            return;
          }

          openFileTreeRequest({
            target: {
              workspacePath: target.path,
              workspaceName: target.label || getPathLeaf(target.path),
              revealPath: target.path,
              temporaryExternalDirectory: true,
            },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn("[WorkspaceShell] 打开 markdown 文件链接失败", {
            path: target.path,
            error: message,
          });
          if (shouldFallbackWorkspacePathToCodeViewer(target)) {
            // Bugfix: markdown file link 可能指向已不存在的路径。
            // stat 失败时保持旧行为交给 CodeViewer 展示具体读文件错误，避免点击完全无反馈。
            handleOpenCodeViewer({
              type: "file",
              title: getPathLeaf(target.path),
              path: target.path,
              workspacePath: target.workspacePath,
              workspaceIdentity: target.workspaceIdentity,
              workspaceRemoteSessionId: target.workspaceRemoteSessionId,
            });
          }
          toast(intl.formatMessage({ id: "workspaceFileTree.openFailed" }));
        }
      },
      [
        findFileLinkOwnerWorkspace,
        baseServices.fileService,
        handleOpenBrowserUrl,
        handleOpenCodeViewer,
        intl,
        isWebRemoteControlShell,
        openFileTreeRequest,
        services.fileService,
        workspaceReadOnlyReason,
      ],
    );
    useEffect(
      () =>
        addWorkspacePathOpenRequestListener((target) => {
          void handleOpenMarkdownFileLink(target);
        }),
      [handleOpenMarkdownFileLink],
    );
    const handleRevealGitFileInTree = useCallback(
      (path: string) => {
        if (workspaceReadOnlyReason) {
          return;
        }
        openFileTreeRequest({
          target: {
            workspacePath: workspaceAbsPath,
            workspaceName: projectName,
            workspaceIdentity,
            workspaceRemoteSessionId,
            revealPath: path,
          },
        });
      },
      [
        openFileTreeRequest,
        projectName,
        workspaceAbsPath,
        workspaceIdentity,
        workspaceRemoteSessionId,
        workspaceReadOnlyReason,
      ],
    );
    const activeSelectionSideChatSessionId = activeTaskId
      ? (getActiveSelectionSideChatTab(sidePaneState, {
          workspaceKey,
          parentSessionId: activeTaskId,
        })?.childSessionId ?? null)
      : null;
    const handleOpenSelectionSideConversationLauncher = useCallback(() => {
      if (!activeTaskId) return;
      const requested = requestSelectionSideChatOpen(
        buildSelectionSideChatKey(workspaceKey, activeTaskId),
      );
      if (!requested) {
        // 固定入口由当前主 SessionPane 承接命令；若 pane 尚未挂载，不允许壳层自行拼接远程身份或协议。
        logger.warn("[WorkspaceShell] 辅助对话入口没有可用的主会话控制器", {
          parentSessionId: activeTaskId,
          workspaceKey,
        });
      }
    }, [activeTaskId, workspaceKey]);
    const renderSidePanePanel = (options: { mobileOverlay?: boolean } = {}) => (
      <AnimatedSidePanePanel
        services={services}
        isDesktop={isDesktop}
        isWindowsDesktop={isWindowsDesktop}
        frameClassName={resolveWorkspaceShellWindowChromeClass({
          isMacDesktop,
          isWindowsDesktop,
          isLinuxDesktop,
          macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
          isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
          supportsNativeRoundedCorners: desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
        })}
        showWindowControls={!options.mobileOverlay && usesInlineWindowControls}
        isVisible={options.mobileOverlay ? isSidePaneOpen : isSidePaneVisible}
        onCloseSidePane={handleToggleSidePane}
        toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
        sidePaneState={sidePaneState}
        recentClosedSidePaneTabs={recentClosedSidePaneTabs}
        isBrowserOpen={isBrowserOpen}
        supportsEmbeddedBrowser={supportsEmbeddedBrowser}
        workspaceAbsPath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        activeTaskId={activeTaskId}
        sidePaneOwnerId={sidePaneOwnerId}
        gitState={gitState}
        activeGitSourceId={activeGitSourceId}
        panelRef={
          options.mobileOverlay ? mobileSidePanePanelRef : sidePanePanelRef
        }
        panelElementRef={
          options.mobileOverlay
            ? mobileSidePanePanelElementRef
            : sidePanePanelElementRef
        }
        browserNavigationRequest={browserNavigationRequest}
        browserRestoreUrls={browserRestoreUrls}
        screenshotSurfaceRequest={
          options.mobileOverlay ? null : screenshotSurfaceRequest
        }
        screenshotSurfaceTabId={
          options.mobileOverlay ? null : (screenshotSurfaceTab?.id ?? null)
        }
        fileChangeFindActiveIndex={fileChangeFindActiveIndex}
        fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
        fileChangeFindQuery={fileChangeFindQuery}
        onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
        onCloseCodeViewer={handleCloseCodeViewer}
        onCloseGit={handleCloseGit}
        onActivateTab={handleActivateSidePaneTab}
        onReorderTab={handleReorderSidePaneTab}
        onCloseTab={handleCloseSidePaneTab}
        onCloseOtherTabs={handleCloseOtherSidePaneTabs}
        onCloseAllTabs={handleCloseAllSidePaneTabs}
        onReopenClosedTab={handleReopenClosedSidePaneTab}
        onOpenBrowserTab={handleOpenBrowserTab}
        onOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
        onOpenWhiteboard={handleOpenWhiteboard}
        onOpenDeveloperTools={handleOpenDeveloperTools}
        onOpenTerminalTab={handleOpenTerminalTab}
        onOpenReviewTab={handleToggleGit}
        onOpenSelectionSideConversation={
          handleOpenSelectionSideConversationLauncher
        }
        onRevealGitFileInTree={handleRevealGitFileInTree}
        onOpenBrowserUrl={handleOpenBrowserUrl}
        onOpenCodeViewer={handleOpenCodeViewer}
        onOpenFileLink={handleOpenMarkdownFileLink}
        onOpenBackgroundBash={handleOpenBackgroundBash}
        onOpenSubagentSession={handleOpenSubagentSession}
        onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
        onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
        onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
        onOpenWorkflowRun={handleOpenWorkflowRun}
        onRefreshGit={handleRefreshGit}
        onBrowserNavigationRequestHandled={
          handleBrowserNavigationRequestHandled
        }
        onBrowserUrlChange={handleBrowserUrlChange}
        onBrowserPageMetadataChange={handleBrowserPageMetadataChange}
        onSelectGitSource={setGitSelectedSourceId}
        mobileOverlay={options.mobileOverlay}
        mobileStacked={isWebRemoteControlShell}
      />
    );
    const sidePanePanel = renderSidePanePanel();
    const hasUpdateStatusButton =
      updateReadyVersion !== null ||
      updateState?.kind === "update-available" ||
      updateState?.kind === "download-progress" ||
      updateState?.kind === "update-downloaded";
    // 修复原因：Draft 之前维护一套独立轻量 header，导致 side pane、caption 安全区和拖拽入口
    // 与 Task Header 分叉。桌面端统一复用 WorkspaceHeader，只由 variant 裁剪 task 专属内容；
    // 手机远控无 active task 时仍不渲染桌面 chrome，继续遵守 replayable overlay 边界。
    const shouldRenderMainViewHeader =
      workspaceMainView !== "automations" &&
      workspaceMainView !== "plugin-store";
    const shouldRenderWorkspaceHeader =
      shouldRenderMainViewHeader && (activeTaskId !== null || isDesktop);
    // 修复原因：ErrorBoundary resetKeys 的数组如果每次 render 都重新创建，
    // 即使 workspace/task 没变化也会在 React DevTools Components 轨道里持续表现为子树 props 变化。
    const workspaceOnlyResetKeys = useMemo(
      () => [workspaceKey],
      [workspaceKey],
    );
    const workspaceDraftResetKeys = useMemo(
      () => [workspaceKey, activeTaskId ?? "draft"],
      [workspaceKey, activeTaskId],
    );
    const workspaceSidebarVisibilityResetKeys = useMemo(
      () => [workspaceKey, isSidebarVisible],
      [workspaceKey, isSidebarVisible],
    );

    if (
      isWebRemoteControlShell &&
      isWebRemoteControlMobileViewport &&
      webRemoteControlWorkspaceSwitcher
    ) {
      return (
        <DesktopWindowFrame
          title={`ZCode / ${getPathLeaf(workspaceAbsPath)}`}
          showHeader
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          headerTestId={TID_APP_HEADER}
        >
          <WebRemoteControlMobileShell
            activeTaskId={activeTaskId}
            activeWorkspaceIdentity={workspaceIdentity}
            activeWorkspacePath={workspaceAbsPath}
            initialNavigationIntent={
              initialWebRemoteControlMobileNavigationIntent
            }
            initialWorkspaceList={initialWebRemoteControlWorkspaceList}
            webRemoteControlTerminalTransportState={
              webRemoteControlTerminalTransportState
            }
            isSidePaneOpen={isSidePaneOpen}
            onCloseSidePane={isSidePaneOpen ? handleToggleSidePane : undefined}
            onSelectTask={handleSelectTaskInChat}
            onStartDraftInWorkspace={handleCreateProjectDraft}
            switcher={webRemoteControlWorkspaceSwitcher}
            renderChatHeader={() =>
              shouldRenderWorkspaceHeader ? (
                <ScopedErrorBoundary
                  scope="workspace-header"
                  resetKeys={workspaceOnlyResetKeys}
                  variant="compact"
                  className="border-b"
                >
                  <WorkspaceHeader
                    variant={activeTaskId === null ? "draft" : "task"}
                    draftDropTargetController={
                      activeTaskId === null
                        ? draftHeaderDropTargetController
                        : undefined
                    }
                    readOnlyReason={workspaceReadOnlyReason}
                    workspaceAbsPath={workspaceAbsPath}
                    remoteSessionId={workspaceRemoteSessionId}
                    workspaceIdentity={workspaceIdentity}
                    remoteTarget={workspaceRemoteTarget}
                    localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                    projectName={projectName}
                    activeTaskTitle={activeTaskTitle}
                    activeTaskChangeSummary={activeTaskChangeSummary}
                    hasUpdateReady={hasUpdateStatusButton}
                    activeTaskId={activeTaskId}
                    user={user}
                    activeTraceId={activeTraceId}
                    activeSessionId={activeSessionId}
                    activeTaskProvider={activeTaskProvider}
                    resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                    sessionLogPath={taskSessionFile.path}
                    nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                    nativeSessionLogPath={taskNativeSessionLogFile.path}
                    nativeSessionLogExists={taskNativeSessionLogFile.exists}
                    nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                    providerWorkspaceConfigPath={providerConfigFile.path}
                    providerWorkspaceConfigExists={providerConfigFile.exists}
                    providerWorkspaceConfigLoading={providerConfigFile.loading}
                    workspaceHeaderState={workspaceShellZCodeState}
                    gitSummary={gitState.summary}
                    gitDirtyFileCount={gitDirtyFileCount}
                    isMacDesktop={isMacDesktop}
                    isMacFullscreen={isMacFullscreen}
                    isWindowsDesktop={isWindowsDesktop}
                    isWebRemoteControl={isWebRemoteControlShell}
                    windowsWindowControlsRightPaddingPx={
                      windowsWindowControlsRightPaddingPx
                    }
                    isDesktop={isDesktop}
                    simplifyForNarrowRemote
                    isSidebarVisible={isSidebarVisible}
                    isTerminalOpen={isTerminalOpen}
                    isSidePaneOpen={isSidePaneOpen}
                    onRefreshGit={handleRefreshGit}
                    onToggleTerminal={handleToggleTerminal}
                    onToggleBrowser={handleToggleBrowser}
                    onToggleSidePane={handleToggleSidePane}
                    toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                    onReloadSession={handleReloadSession}
                    reloadSessionDisabled={workspaceSessionActionDisabled}
                    reloadSessionPending={reloadSessionPending}
                    onCreateTask={handleCreateTaskInChat}
                    onOpenWorkspace={onOpenWorkspace}
                    allowOpenWorkspace={allowOpenWorkspace}
                  />
                </ScopedErrorBoundary>
              ) : null
            }
            chatOverlay={
              workspaceMainView === "chat" ? renderChatFindDialog() : undefined
            }
            chatContent={
              workspaceMainView === "automations" &&
                !isWebRemoteControlShell ? (
                <main
                  id={AUTOMATIONS_TOAST_ANCHOR_ID}
                  className="flex h-full min-h-0 flex-1 flex-col bg-background"
                >
                  <AutomationsMainBreadcrumbFrame
                    isDesktop={Boolean(isDesktop)}
                    sectionLabel={intl.formatMessage({
                      id: "settings.automations.title",
                    })}
                    ariaLabel={intl.formatMessage({
                      id: "automations.breadcrumbLabel",
                    })}
                  >
                    <div
                      // 修复原因：不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
                      // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
                      className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                    >
                      <ScopedErrorBoundary
                        scope="automations-main"
                        resetKeys={workspaceOnlyResetKeys}
                        variant="panel"
                        className="min-h-full"
                      >
                        <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                          <AutomationsSection
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            onCreateViaChat={handleCreateAutomationInChat}
                            onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                            onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                            onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                            openAutomationId={openAutomationId}
                            openAutomationTab={openAutomationTab}
                            onOpenAutomationConsumed={onOpenAutomationConsumed}
                            openWorkflow={openWorkflow}
                            onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                            onOpenSession={({
                              sessionId,
                              workspacePath,
                              workspaceIdentity,
                            }) =>
                              handleSelectTaskInChat(
                                workspacePath,
                                sessionId,
                                workspaceIdentity,
                              )
                            }
                          />
                        </div>
                      </ScopedErrorBoundary>
                    </div>
                  </AutomationsMainBreadcrumbFrame>
                </main>
              ) : workspaceMainView === "plugin-store" &&
                !isWebRemoteControlShell ? (
                <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                  <AutomationsMainBreadcrumbFrame
                    isDesktop={Boolean(isDesktop)}
                    sectionLabel={intl.formatMessage({
                      id: "workspace.openPluginsSettings",
                    })}
                    ariaLabel={intl.formatMessage({
                      id: "settings.breadcrumbLabel",
                    })}
                  >
                    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                      <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                        <PluginStorePage
                          isWebRemoteControl={isWebRemoteControlShell}
                          key={`plugin-store:${pluginStoreOpenVersion}`}
                          workspacePath={workspaceAbsPath}
                          workspaceIdentity={workspaceIdentity}
                          // Bug 根因：独立插件页曾绕过切回聊天页的包装回调，任务虽被创建，
                          // 视图仍停在插件详情，用户看到“立即试用”与示例 Prompt 点击无反应。
                          onCreateTask={handleCreateTaskInChat}
                          onManageInstalled={handleManageInstalledPlugins}
                        />
                      </div>
                    </div>
                  </AutomationsMainBreadcrumbFrame>
                </main>
              ) : (
                <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
                  {/* Bugfix: 手机远控聊天页中间层必须继续提供 flex 高度链。
                    只有 h-full 的普通 block 会让 ChatView 的 flex-1 失效，草稿空态贴顶且内部滚动被外层裁掉。 */}
                  <ScopedErrorBoundary
                    scope="workspace-chat"
                    resetKeys={workspaceDraftResetKeys}
                    variant="panel"
                    className="h-full"
                  >
                    {/* Bugfix(2026-07-05, M3 验收)：同桌面布局——绑定 activeTaskId 而非 meta 派生的
                      activeSessionId，避免新建 v4 session 因 meta 缓存未刷新而停在 draft。 */}
                    {/* Bug 根因：计划详情功能只给桌面 V4WorkspaceChatArea 接了回调，手机卡片因此
                      显示按钮却无法打开抽屉；两端必须复用同一个 renderer Side Pane 入口。 */}
                    <V4ChatPane
                      readOnly={Boolean(workspaceReadOnlyReason)}
                      workspacePath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      isDesktop={isDesktop === true}
                      compactForRemoteControl={isWebRemoteControlShell}
                      sessionId={activeTaskId}
                      provider={activeTaskProvider ?? undefined}
                      onSessionCreated={handleV4SessionCreated}
                      onSessionDeleted={handleV4SessionDeleted}
                      draftComposerHeader={draftComposerHeader}
                      gitSummary={gitState.summary}
                      gitDirtyFileCount={gitDirtyFileCount}
                      gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                      gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                      activeTaskChangeSummary={activeTaskChangeSummary}
                      summaryPanelVariantOverride={summaryPanelVariantOverride}
                      onSummaryPanelVariantOverrideChange={
                        onSummaryPanelVariantOverrideChange
                      }
                      onRefreshGit={handleRefreshGit}
                      onOpenGitReview={handleOpenGitReview}
                      onOpenBrowserUrl={handleOpenBrowserUrl}
                      onOpenAutomationsMain={handleOpenAutomations}
                      onOpenCodeViewer={handleOpenCodeViewer}
                      onAutoOpenAssistantPptx={
                        isDesktop && !isWebRemoteControlShell
                          ? handleAutoOpenAssistantPptx
                          : undefined
                      }
                      onOpenFileLink={handleOpenMarkdownFileLink}
                      onOpenBackgroundBash={handleOpenBackgroundBash}
                      onOpenSubagentSession={handleOpenSubagentSession}
                      onOpenSubagentDirectory={handleOpenSubagentDirectory}
                      onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                      onOpenPlanDetail={handleOpenPlanDetail}
                      onOpenWorkflowRun={handleOpenWorkflowRun}
                      onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                      onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                      onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                      onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                      conversationFindQuery={conversationFindQuery}
                    conversationFindActiveIndex={conversationFindActiveIndex}
                    conversationFindNavigationRequestId={conversationFindNavigationRequestId}
                      onConversationFindMatchStateChange={
                        onConversationFindMatchStateChange
                      }
                      searchResultHighlightRequest={
                        activeSearchResultHighlightRequest
                      }
                      onSearchResultHighlightDone={onSearchResultHighlightDone}
                    />
                  </ScopedErrorBoundary>
                </div>
              )
            }
            sidePaneContent={renderSidePanePanel({ mobileOverlay: true })}
          />
        </DesktopWindowFrame>
      );
    }

    return (
      // 完成卡上那两个壳级落点（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
      // run, and running it again」）：芯片开到中枢那一页、「再次运行」启动后切到新会话。只包桌面
      // 这一支——手机远控壳本来就不提供中枢，那边芯片是纯文字。
      <SavedWorkflowHubProvider
        openWorkflow={handleOpenSavedWorkflowInHub}
        navigateToRun={handleNavigateToLaunchedRun}
      >
      <DesktopWindowFrame
        title={`ZCode / ${getPathLeaf(workspaceAbsPath)}`}
        showHeader
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
        headerTestId={TID_APP_HEADER}
      >
        <div
          ref={workspaceShellRef}
          data-workspace-shell="true"
          style={workspaceShellSplitStyle}
          className={cn(
            "relative flex h-full min-h-0 w-full overflow-hidden",
            // 修复原因：窗口原生 resize 时，外层 react-resizable-panels 会把每一帧
            // 都写进 layout store，连带侧栏 tooltip/menu 子树反复 commit。这里改成
            // CSS 变量驱动的专用 split，普通窗口 resize 只走浏览器布局，不触发 React 状态。
            isWebRemoteControlShell && "max-md:flex-col",
          )}
        >
          <div
            ref={workspaceSidebarPanelElementRef}
            data-panel=""
            data-workspace-sidebar-panel="true"
            id="sidebar"
            className={cn(
              "w-[var(--workspace-sidebar-panel-width)] max-w-[50%] flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity",
              // 修复原因：拖动侧栏宽度时如果继续过渡 width，会让指针移动和实际宽度之间产生滞后。
              // 拖拽 active 通过 DOM 标记切 transition，避免 pointerdown/up 为了切 class 重渲染整棵 workspace。
              isWebRemoteControlShell &&
                cn(
                  // Bugfix: Web 远程控制在手机浏览器里仍复用桌面横向 shell，
                  // 264px 侧栏 + 320px 内容区会直接超过视口宽度，导致页面只能横向滚动。
                  // 这里只在远控模式的小屏断点把主布局改为上下堆叠，桌面端仍保持原来的分栏。
                  // 交互修复：远控移动端改为拖动 WorkspaceHeader 下边框的按钮控制顶部高度，
                  // 这里用 CSS 变量同步高度，避免拖动时卸载导航内容或打断任务列表状态。
                  renderWebRemoteNavigationPanel
                    ? "max-md:!h-[var(--web-remote-navigation-height)] max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-b max-md:border-border max-md:bg-sidebar"
                    : "max-md:!h-0 max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-0 max-md:!border-b-0",
                ),
              isSidebarPanelVisible
                ? "opacity-100"
                : "pointer-events-none opacity-0",
            )}
          >
            {/* Bugfix: 折叠远控顶部导航时保持组件挂载，避免展开后整块 sidebar 重新加载。 */}
            <aside
              id={
                isWebRemoteControlShell
                  ? "web-remote-control-navigation-panel"
                  : undefined
              }
              ref={sidebarContainerRef}
              className={cn(
                "h-full overflow-hidden select-none",
                isWebRemoteControlShell && "max-md:min-h-0 max-md:flex-1",
                !renderWebRemoteNavigationPanel && "max-md:hidden",
              )}
              aria-hidden={
                !isSidebarPanelVisible || !renderWebRemoteNavigationPanel
              }
            >
              <ScopedErrorBoundary
                scope="workspace-sidebar"
                resetKeys={workspaceOnlyResetKeys}
                variant="panel"
                className="h-full"
              >
                {/* session workbench groups：桌面和普通 web app 可分屏；手机和 /remote 远控不启用。 */}
                <V4SplitPaneEntryProvider
                  enabled={
                    !isWebRemoteControlShell &&
                    !isWebRemoteControlMobileViewport
                  }
                  canOpenSession={canOpenSessionInSplitPane}
                  onOpenSession={handleOpenSessionInSplitPane}
                >
                  <WorkflowRunOpenProvider onOpenRun={handleOpenSidebarWorkflowRun}>
                  <WorkspaceSidebar
                    workspacePath={workspaceAbsPath}
                    workspaceRemoteSessionId={workspaceRemoteSessionId}
                    activePreviewPath={activePreviewPath}
                    onSelectTask={handleSelectTaskInChat}
                    onStartDraftInWorkspace={handleCreateProjectDraft}
                    onOpenCodeViewer={handleOpenCodeViewer}
                    onOpenBrowserUrl={handleOpenBrowserUrl}
                    fileTreeOpenRequest={fileTreeOpenRequest}
                    onCreateTask={handleCreateTaskInChat}
                    onCreateConversationTask={
                      onCreateConversationTask ?? handleCreateTaskInChat
                    }
                    onOpenFolderFromWorkspaceMenu={
                      onOpenFolderFromWorkspaceMenu
                    }
                    onOpenRemoteWorkspace={onOpenRemoteWorkspace}
                    webRemoteControlWorkspaceSwitcher={
                      webRemoteControlWorkspaceSwitcher
                    }
                    theme={theme}
                    onConnectRemote={onConnectRemote}
                    onSelectRemoteProject={onSelectRemoteProject}
                    onCancelRemoteProject={onCancelRemoteProject}
                    onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
                    reconnectingRemoteWorkspaceKeys={
                      reconnectingRemoteWorkspaceKeys
                    }
                    remoteWorkspaceErrorByWorkspaceKey={
                      remoteWorkspaceErrorByWorkspaceKey
                    }
                    reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                      reconnectingRemoteWorkspaceLogsByWorkspaceKey
                    }
                    onLogout={onLogout}
                    onLogin={onLogin}
                    user={user}
                    isDesktop={isDesktop}
                    isWebRemoteControl={isWebRemoteControlShell}
                    isMacDesktop={isMacDesktop}
                    isWindowsDesktop={isWindowsDesktop}
                    isSidebarVisible={isSidebarVisible}
                    onToggleSidebar={handleToggleSidebar}
                    toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
                    canGoBack={canPrimaryNavigationBack}
                    canGoForward={canTaskNavForward}
                    onGoBack={primaryNavigationBack}
                    onGoForward={handleTaskNavForward}
                    goBackShortcutLabel={goBackShortcutLabel}
                    goForwardShortcutLabel={goForwardShortcutLabel}
                    onOpenCommandCenter={handleOpenCommandCenter}
                    onOpenAutomations={handleOpenAutomations}
                    automationsActive={workspaceMainView === "automations"}
                    onOpenPluginStore={handleOpenPluginStore}
                    pluginStoreActive={workspaceMainView === "plugin-store"}
                    onFileTreeOpenChange={setIsSidebarFileTreeOpen}
                    onWebRemoteTaskOpen={handleWebRemoteTaskOpen}
                    onWebRemoteTaskSwitchingChange={
                      handleWebRemoteTaskSwitchingChange
                    }
                  />
                  </WorkflowRunOpenProvider>
                </V4SplitPaneEntryProvider>
              </ScopedErrorBoundary>
            </aside>
          </div>

          {isSidebarVisible && renderWebRemoteNavigationPanel ? (
            <div
              role="separator"
              tabIndex={0}
              aria-controls="sidebar"
              aria-label={workspaceSidebarResizeLabel}
              aria-orientation="vertical"
              aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH_PX}
              aria-valuenow={Math.round(workspaceSidebarPanelWidthPx)}
              data-testid="resizable-handle"
              onKeyDown={handleWorkspaceSidebarResizeKeyDown}
              onPointerCancel={(event) =>
                finishWorkspaceSidebarResize(event, true)
              }
              onPointerDown={handleWorkspaceSidebarResizeStart}
              onPointerMove={handleWorkspaceSidebarResizeMove}
              onPointerUp={(event) => finishWorkspaceSidebarResize(event)}
              className={cn(
                "group/handle relative z-10 flex h-full w-1 shrink-0 touch-none cursor-ew-resize items-center justify-center bg-transparent outline-none [app-region:no-drag] focus:outline-none focus-visible:ring-0",
                "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius)] after:w-0.5",
                "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100 [[data-workspace-sidebar-resizing=true]_&]:after:opacity-100",
                hasDesktopPanelInset && "after:inset-y-[var(--workspace-resize-handle-inset)]",
                isWebRemoteControlShell && "max-md:hidden",
              )}
            />
          ) : null}
          {/* 右侧主工作区：上方 header，下面左侧会话+终端，右侧共享 browser/code-viewer 槽位 */}
          <div
            data-panel=""
            id="content"
            className={cn(
              "flex min-w-[320px] flex-1 flex-col",
              hasDesktopPanelInset ? "p-1 pl-0 pt-0" : "p-0",
              isWebRemoteControlShell &&
                "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0",
            )}
          >
            {
              hasDesktopPanelInset && (
                <div className="h-1 w-full [app-region:drag]" />
              ) /* 修复 macOS 顶部窗口控制按钮被 header 遮挡无法点击的问题 */
            }
              <ResizablePanelGroup
                layoutId="workspace-body-layout"
                panelIds={WORKSPACE_BODY_PANEL_IDS}
                className={cn(
                  "min-h-0 flex-1",
                  isWebRemoteControlShell && "max-md:!flex-col",
                )}
              >
                <ResizablePanel
                  id="conversation-column"
                  minSize={isWebRemoteControlShell ? "0px" : "35%"}
                  defaultSize={isSidePaneVisible ? "52%" : undefined}
                  className={
                    isWebRemoteControlShell
                      ? "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0"
                      : undefined
                  }
                >
                  <ResizablePanelGroup
                    orientation="vertical"
                    layoutId="workspace-conversation-column-layout"
                    panelIds={WORKSPACE_CONVERSATION_PANEL_IDS}
                    className="h-full min-h-0"
                  >
                    <ResizablePanel
                      id="conversation"
                      elementRef={conversationPanelElementRef}
                      minSize="35%"
                    >
                  <section
                    data-workspace-conversation-frame="true"
                    className={cn(
                      "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                      isSidePaneVisible ? "rounded-[var(--workspace-panel-radius)] border border-border" : resolveWorkspaceShellWindowChromeClass({
                        isMacDesktop,
                        isWindowsDesktop,
                        isLinuxDesktop,
                        macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                        isWindowsMaximized:
                          desktopWindowChromeState?.isMaximized ?? false,
                        supportsNativeRoundedCorners:
                          desktopWindowChromeState?.supportsNativeRoundedCorners ??
                          null,
                      }),
                      isTerminalVisible && "rounded-b-[var(--workspace-panel-radius)] border-b",
                      isWebRemoteControlShell &&
                        "max-md:rounded-none max-md:border-x-0 max-md:border-b-0",
                    )}
                  >
                    {shouldRenderWorkspaceHeader ? (
                      <ScopedErrorBoundary
                        scope="workspace-header"
                        resetKeys={workspaceOnlyResetKeys}
                        variant="compact"
                        className="border-b"
                      >
                        <WorkspaceHeader
                          reserveWindowControls={!isSidePaneVisible}
                          variant={activeTaskId === null ? "draft" : "task"}
                          draftDropTargetController={
                            activeTaskId === null
                              ? draftHeaderDropTargetController
                              : undefined
                          }
                          readOnlyReason={workspaceReadOnlyReason}
                          workspaceAbsPath={workspaceAbsPath}
                          remoteSessionId={workspaceRemoteSessionId}
                          workspaceIdentity={workspaceIdentity}
                          remoteTarget={workspaceRemoteTarget}
                          localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                          projectName={projectName}
                          activeTaskTitle={activeTaskTitle}
                          activeTaskChangeSummary={activeTaskChangeSummary}
                          hasUpdateReady={hasUpdateStatusButton}
                          activeTaskId={activeTaskId}
                          user={user}
                          activeTraceId={activeTraceId}
                          activeSessionId={activeSessionId}
                          activeTaskProvider={activeTaskProvider}
                          resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                          sessionLogPath={taskSessionFile.path}
                          nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                          nativeSessionLogPath={taskNativeSessionLogFile.path}
                          nativeSessionLogExists={taskNativeSessionLogFile.exists}
                          nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                          providerWorkspaceConfigPath={providerConfigFile.path}
                          providerWorkspaceConfigExists={providerConfigFile.exists}
                          providerWorkspaceConfigLoading={providerConfigFile.loading}
                          workspaceHeaderState={workspaceShellZCodeState}
                          gitSummary={gitState.summary}
                          gitDirtyFileCount={gitDirtyFileCount}
                          isMacDesktop={isMacDesktop}
                          isMacFullscreen={isMacFullscreen}
                          isWindowsDesktop={isWindowsDesktop}
                          isWebRemoteControl={isWebRemoteControlShell}
                          windowsWindowControlsRightPaddingPx={
                            windowsWindowControlsRightPaddingPx
                          }
                          isDesktop={isDesktop}
                          simplifyForNarrowRemote={simplifyHeaderForNarrowRemote}
                          isSidebarVisible={isSidebarVisible}
                          isTerminalOpen={isTerminalOpen}
                          isSidePaneOpen={isSidePaneOpen}
                          onRefreshGit={handleRefreshGit}
                          onToggleTerminal={handleToggleTerminal}
                          onToggleBrowser={handleToggleBrowser}
                          onToggleSidePane={handleToggleSidePane}
                          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                          onReloadSession={handleReloadSession}
                          reloadSessionDisabled={workspaceSessionActionDisabled}
                          reloadSessionPending={reloadSessionPending}
                          onCreateTask={handleCreateTaskInChat}
                          onOpenWorkspace={onOpenWorkspace}
                          allowOpenWorkspace={allowOpenWorkspace}
                        />
                      </ScopedErrorBoundary>
                    ) : null}
                    {isWebRemoteControlShell ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-md"
                        data-web-remote-navigation-resize-handle="true"
                        className={cn(
                          "absolute left-1/2 z-30 hidden -translate-x-1/2 -translate-y-1/2 touch-none cursor-ns-resize border-border bg-surface text-foreground-subtle shadow-sm hover:bg-surface-hover hover:text-foreground max-md:inline-flex [app-region:no-drag]",
                          shouldRenderWorkspaceHeader ? "top-12" : "top-0",
                          isWebRemoteControlNavigationDragging &&
                            "border-border-hover bg-surface-hover text-foreground",
                        )}
                        aria-expanded={!isWebRemoteControlNavigationCollapsed}
                        aria-controls="web-remote-control-navigation-panel"
                        aria-label={intl.formatMessage({
                          id: isWebRemoteControlNavigationCollapsed
                            ? "webRemoteControl.expandNavigation"
                            : "webRemoteControl.collapseNavigation",
                        })}
                        onPointerDown={handleWebRemoteNavigationResizeStart}
                        onPointerMove={handleWebRemoteNavigationResizeMove}
                        onPointerUp={(event) => {
                          finishWebRemoteNavigationResize(event);
                        }}
                        onPointerCancel={(event) => {
                          finishWebRemoteNavigationResize(event, true);
                        }}
                        onClick={handleWebRemoteNavigationHandleClick}
                      >
                        <GripHorizontal className="size-4" />
                      </Button>
                    ) : null}
                    <div className="min-h-0 flex-1 overflow-hidden">
                      {workspaceMainView === "automations" &&
                    !isWebRemoteControlShell ? (
                    <main
                      id={AUTOMATIONS_TOAST_ANCHOR_ID}
                      className="flex h-full min-h-0 flex-1 flex-col bg-background"
                    >
                      <AutomationsMainBreadcrumbFrame
                        isDesktop={Boolean(isDesktop)}
                        sectionLabel={intl.formatMessage({
                          id: "settings.automations.title",
                        })}
                        ariaLabel={intl.formatMessage({
                          id: "automations.breadcrumbLabel",
                        })}
                      >
                        <div
                          // 修复原因：不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
                          // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
                          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                        >
                          <ScopedErrorBoundary
                            scope="automations-main"
                            resetKeys={workspaceOnlyResetKeys}
                            variant="panel"
                            className="min-h-full"
                          >
                            <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                              <AutomationsSection
                                workspacePath={workspaceAbsPath}
                                workspaceIdentity={workspaceIdentity}
                                onCreateViaChat={handleCreateAutomationInChat}
                                onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                                onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                                onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                                openAutomationId={openAutomationId}
                                openAutomationTab={openAutomationTab}
                                onOpenAutomationConsumed={onOpenAutomationConsumed}
                                openWorkflow={openWorkflow}
                                onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                                onOpenSession={({
                                  sessionId,
                                  workspacePath,
                                  workspaceIdentity,
                                }) =>
                                  handleSelectTaskInChat(
                                    workspacePath,
                                    sessionId,
                                    workspaceIdentity,
                                  )
                                }
                              />
                            </div>
                          </ScopedErrorBoundary>
                        </div>
                      </AutomationsMainBreadcrumbFrame>
                    </main>
                  ) : workspaceMainView === "plugin-store" &&
                    !isWebRemoteControlShell ? (
                    <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                      <AutomationsMainBreadcrumbFrame
                        isDesktop={Boolean(isDesktop)}
                        sectionLabel={intl.formatMessage({
                          id: "workspace.openPluginsSettings",
                        })}
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                      >
                        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                          <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                            <PluginStorePage
                          isWebRemoteControl={isWebRemoteControlShell}
                              key={`plugin-store:${pluginStoreOpenVersion}`}
                              workspacePath={workspaceAbsPath}
                              workspaceIdentity={workspaceIdentity}
                              onCreateTask={handleCreateTaskInChat}
                              onManageInstalled={handleManageInstalledPlugins}
                            />
                          </div>
                        </div>
                      </AutomationsMainBreadcrumbFrame>
                    </main>
                  ) : (
                            <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                              {renderChatFindDialog()}
                              <ScopedErrorBoundary
                                scope="workspace-chat"
                                resetKeys={workspaceDraftResetKeys}
                                variant="panel"
                                className="h-full"
                              >
                                {/* Bugfix(2026-07-05, M3 验收)：pane 绑定必须用原始选择态 activeTaskId，
                                  不能用 meta 派生的 activeSessionId——v4 createSession 刚建的会话
                                  不在 taskListCache/optimistic 缓存里，meta 解析为 null 会让 pane
                                  永远停在 draft。v4 语义下 sessionId ≡ taskId，meta 只服务 Header 显示。
                                  M5⑤：桌面主区升级为分屏宿主（Layout/Focus 两层）；primary pane
                                  绑定语义与 testid 契约（paneId=workspace-main）不变。 */}
                                <V4WorkspaceChatArea
                                  readOnly={Boolean(workspaceReadOnlyReason)}
                                  foregroundEnabled={isWorkspaceVisible}
                                  workspacePath={workspaceAbsPath}
                                  workspaceIdentity={workspaceIdentity}
                                  isDesktop={isDesktop === true}
                                  remoteSessionId={workspaceRemoteSessionId}
                                  compactForRemoteControl={isWebRemoteControlShell}
                                  sessionId={activeTaskId}
                                  activeSelectionSideChatSessionId={
                                    activeSelectionSideChatSessionId
                                  }
                                  provider={activeTaskProvider ?? undefined}
                                  onSessionCreated={handleV4SessionCreated}
                                  onSessionDeleted={handleV4SessionDeleted}
                                  draftComposerHeader={draftComposerHeader}
                                  onPrimaryDraftDropTargetControllerChange={
                                    setDraftHeaderDropTargetController
                                  }
                                  gitSummary={gitState.summary}
                                  gitDirtyFileCount={gitDirtyFileCount}
                                  activeTaskChangeSummary={activeTaskChangeSummary}
                                  gitWorktreeReviewSourceId={
                                    gitWorktreeReviewSourceId
                                  }
                                  gitWorktreeChangeSummary={
                                    gitWorktreeChangeSummary
                                  }
                                  summaryPanelVariantOverride={
                                    summaryPanelVariantOverride
                                  }
                                  onSummaryPanelVariantOverrideChange={
                                    onSummaryPanelVariantOverrideChange
                                  }
                                  onRefreshGit={handleRefreshGit}
                                  onOpenGitReview={handleOpenGitReview}
                                  onPaneActiveSessionChange={
                                    handlePaneActiveSessionChange
                                  }
                                  onOpenBrowserUrl={handleOpenBrowserUrl}
                                  onOpenAutomationsMain={handleOpenAutomations}
                                  onOpenCodeViewer={handleOpenCodeViewer}
                                  onAutoOpenAssistantPptx={
                                    isDesktop && !isWebRemoteControlShell
                                      ? handleAutoOpenAssistantPptx
                                      : undefined
                                  }
                                  onOpenBackgroundBash={handleOpenBackgroundBash}
                                  onOpenSubagentSession={handleOpenSubagentSession}
                                  onOpenSubagentDirectory={
                                    handleOpenSubagentDirectory
                                  }
                                  onSyncSubagentSessionTabs={
                                    handleSyncSubagentSessionTabs
                                  }
                                  onOpenSelectionSideChat={
                                    handleOpenSelectionSideChat
                                  }
                                  onOpenPlanDetail={handleOpenPlanDetail}
                                  onOpenWorkflowRun={handleOpenWorkflowRun}
                                  onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                                  onOpenWorkflowRunDirectory={
                                    handleOpenWorkflowRunDirectory
                                  }
                                  onOpenWorkflowActorSession={
                                    handleOpenWorkflowActorSession
                                  }
                                  onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                                  onOpenFileLink={handleOpenMarkdownFileLink}
                                  conversationFindQuery={conversationFindQuery}
                                  conversationFindActiveIndex={
                                    conversationFindActiveIndex
                                  }
                                  conversationFindNavigationRequestId={
                                    conversationFindNavigationRequestId
                                  }
                                  onConversationFindMatchStateChange={
                                    onConversationFindMatchStateChange
                                  }
                                  searchResultHighlightRequest={
                                    activeSearchResultHighlightRequest
                                  }
                                  onSearchResultHighlightDone={
                                    onSearchResultHighlightDone
                                  }
                                />
                              </ScopedErrorBoundary>
                            </main>

                      )}
                    </div>
                  </section>
                    </ResizablePanel>
                    {isWebRemoteControlShell ||
                      (workspaceMainView !== "automations" && workspaceMainView !== "plugin-store") ? (
                          <AnimatedTerminalPanel
                            frameClassName={cn(
                              isSidePaneVisible ? "rounded-[var(--workspace-panel-radius)] border border-border" : resolveWorkspaceShellWindowChromeClass({
                                isMacDesktop,
                                isWindowsDesktop,
                                isLinuxDesktop,
                                macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                                isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                                supportsNativeRoundedCorners: desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                              }),
                              "rounded-t-[var(--workspace-panel-radius)] border-t",
                            )}
                            services={services}
                            workspaceAbsPath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            openWorkspaceKeys={openWorkspaceKeys}
                            isVisible={isTerminalVisible}
                            isWindowsDesktop={isWindowsDesktop}
                            panelRef={terminalPanelRef}
                            panelElementRef={terminalPanelElementRef}
                            onClose={() => setIsTerminalOpen(false)}
                            onOpenBrowserUrl={handleOpenBrowserUrl}
                          />
                    ) : null}
                  </ResizablePanelGroup>
                </ResizablePanel>
                {/* Bugfix：Browser Guest Host 必须与主视图路由解耦，避免 automations/plugin
                    切换时卸载 Guest；截图请求期间由上层临时展开真实面板承载可合成的 WebContents。 */}
                {sidePanePanel}
              </ResizablePanelGroup>
          </div>
          <ScopedErrorBoundary
            scope="desktop-top-overlay"
            resetKeys={workspaceSidebarVisibilityResetKeys}
            variant="silent"
          >
            <DesktopTopOverlay
              newTaskDisabledReason={workspaceReadOnlyReason}
              workspaceAbsPath={workspaceAbsPath}
              isMacDesktop={isMacDesktop}
              isMacFullscreen={isMacFullscreen}
              macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
              windowsWindowControlsRightPaddingPx={
                windowsWindowControlsRightPaddingPx
              }
              isWindowsDesktop={isWindowsDesktop}
              isDesktop={isDesktop}
              isSidebarVisible={isSidebarVisible}
              updateReadyVersion={updateReadyVersion}
              updateState={updateState}
              toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
              newTaskShortcutLabel={newTaskShortcutLabel}
              goBackShortcutLabel={goBackShortcutLabel}
              goForwardShortcutLabel={goForwardShortcutLabel}
              canTaskNavBack={canPrimaryNavigationBack}
              canTaskNavForward={canTaskNavForward}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              showNewTaskButton={showTopOverlayNewTaskButton}
              appLogoUrl={appLogoUrl}
              platform={platform}
              onToggleSidebar={handleToggleSidebar}
              onCreateTask={handleCreateTaskInChat}
              onGoBack={primaryNavigationBack}
              onGoForward={handleTaskNavForward}
              hideTaskNavigationButtons={simplifyHeaderForNarrowRemote}
            />
          </ScopedErrorBoundary>

          {isWebRemoteControlShell && isWebRemoteControlTaskSwitching ? (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
              aria-live="polite"
              aria-busy="true"
            >
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
                <LoaderIcon className="size-4 animate-spin" />
                {/* Bugfix: 跨 workspace 点击任务时旧页会很快卸载，之前在卸载前缺少统一占位，视觉上像“先白屏再渲染”。
                  这里补一个全局 loading overlay，给切换过程稳定反馈。 */}
                {intl.formatMessage({ id: "common.loading" })}
              </div>
            </div>
          ) : null}
        </div>
      </DesktopWindowFrame>
      </SavedWorkflowHubProvider>
    );
  },
);
