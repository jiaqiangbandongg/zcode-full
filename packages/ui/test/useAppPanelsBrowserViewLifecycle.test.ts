// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import {
  buildTaskSidePaneMemoryKey,
  clearTaskSidePaneMemoryStateForTest,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";

const { closeSessionMock } = vi.hoisted(() => ({
  closeSessionMock: vi.fn(async () => {}),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    zcodeSessionService: { closeSession: closeSessionMock },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

type ReadyHandler = Parameters<NonNullable<IPlatformService["onBrowserViewReady"]>>[0];
type ReadyPayload = Parameters<ReadyHandler>[0];
type VisibilityHandler = Parameters<NonNullable<IPlatformService["onBrowserViewVisibility"]>>[0];
type VisibilityPayload = Parameters<VisibilityHandler>[0];
type CloseHandler = Parameters<NonNullable<IPlatformService["onBrowserViewCloseTab"]>>[0];
type OperationHandler = Parameters<NonNullable<IPlatformService["onBrowserViewOperation"]>>[0];
type OpenBrowserUrlHandler = Parameters<NonNullable<IPlatformService["onOpenBrowserUrl"]>>[0];

function createBrowserViewPlatformHarness() {
  let readyHandler: ReadyHandler | null = null;
  let visibilityHandler: VisibilityHandler | null = null;
  let closeHandler: CloseHandler | null = null;
  let operationHandler: OperationHandler | null = null;
  let openBrowserUrlHandler: OpenBrowserUrlHandler | null = null;
  const platform = {
    browserViewCloseTab: vi.fn(async () => {}),
    onBrowserViewCloseTab: vi.fn((handler: CloseHandler) => {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) closeHandler = null;
      };
    }),
    onOpenBrowserUrl: vi.fn((handler: OpenBrowserUrlHandler) => {
      openBrowserUrlHandler = handler;
      return () => {
        if (openBrowserUrlHandler === handler) openBrowserUrlHandler = null;
      };
    }),
    onBrowserViewReady: vi.fn((handler: ReadyHandler) => {
      readyHandler = handler;
      return () => {
        if (readyHandler === handler) readyHandler = null;
      };
    }),
    onBrowserViewOperation: vi.fn((handler: OperationHandler) => {
      operationHandler = handler;
      return () => {
        if (operationHandler === handler) operationHandler = null;
      };
    }),
    onBrowserViewVisibility: vi.fn((handler: VisibilityHandler) => {
      visibilityHandler = handler;
      return () => {
        if (visibilityHandler === handler) visibilityHandler = null;
      };
    }),
  } as NonNullable<Parameters<typeof useAppPanels>[0]["platform"]>;

  return {
    emitClose(payload: Parameters<CloseHandler>[0]) {
      if (!closeHandler) throw new Error("close handler 尚未注册");
      closeHandler(payload);
    },
    emitOperation(payload: Parameters<OperationHandler>[0]) {
      if (!operationHandler) throw new Error("operation handler 尚未注册");
      operationHandler(payload);
    },
    emitOpenBrowserUrl(payload: Parameters<OpenBrowserUrlHandler>[0]) {
      if (!openBrowserUrlHandler) throw new Error("open browser url handler 尚未注册");
      openBrowserUrlHandler(payload);
    },
    emitReady(payload: ReadyPayload) {
      if (!readyHandler) throw new Error("ready handler 尚未注册");
      readyHandler(payload);
    },
    emitVisibility(payload: VisibilityPayload) {
      if (!visibilityHandler) throw new Error("visibility handler 尚未注册");
      visibilityHandler(payload);
    },
    platform,
  };
}

function readyPayload(tabId: string, overrides: Partial<ReadyPayload> = {}): ReadyPayload {
  return {
    workspaceKey: "ssh://host/repo",
    remoteSessionId: "remote-a",
    sessionId: "sess-a",
    tabId,
    browserId: "iab-a",
    browserGeneration: 2,
    ...overrides,
  };
}

function renderBrowserViewLifecycleHook() {
  const harness = createBrowserViewPlatformHarness();
  const rendered = renderHook(() =>
    useAppPanels({
      workspaceAbsPath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      workspaceRemoteSessionId: "remote-a",
      activeTaskId: "sess-a",
      sidePaneOwnerId: "sess-a",
      isDesktop: true,
      isWorkspaceVisible: true,
      supportsEmbeddedBrowser: true,
      defaultWhiteboardNamePrefix: "Whiteboard",
      platform: harness.platform,
    }),
  );
  return { ...harness, ...rendered };
}

const WORKSPACE_KEY = "ssh://host/repo";
const OTHER_WORKSPACE_KEY = "ssh://host/other";

/**
 * 设置页是覆盖层，App 不卸载但 isWorkspaceVisible 会变 false。
 * 这个 helper 让用例能在渲染后切换该标志，覆盖“订阅是否被可见性误关”的场景。
 */
function renderSettingsOverlayHook(initialIsWorkspaceVisible: boolean) {
  const harness = createBrowserViewPlatformHarness();
  const rendered = renderHook(
    ({ isWorkspaceVisible }: { isWorkspaceVisible: boolean }) =>
      useAppPanels({
        workspaceAbsPath: "/repo",
        workspaceIdentity: WORKSPACE_KEY,
        workspaceRemoteSessionId: "remote-a",
        activeTaskId: "sess-a",
        sidePaneOwnerId: "sess-a",
        isDesktop: true,
        isWorkspaceVisible,
        supportsEmbeddedBrowser: true,
        defaultWhiteboardNamePrefix: "Whiteboard",
        platform: harness.platform,
      }),
    { initialProps: { isWorkspaceVisible: initialIsWorkspaceVisible } },
  );
  return { ...harness, ...rendered };
}

/** side pane memory 按 workspace 隔离，切换 workspace 才能覆盖“通知落在非活跃 workspace”的场景。 */
function renderCrossWorkspaceHook() {
  const harness = createBrowserViewPlatformHarness();
  const rendered = renderHook(
    ({ workspaceIdentity }: { workspaceIdentity: string }) =>
      useAppPanels({
        workspaceAbsPath: "/repo",
        workspaceIdentity,
        workspaceRemoteSessionId: "remote-a",
        activeTaskId: "sess-a",
        sidePaneOwnerId: "sess-a",
        isDesktop: true,
        isWorkspaceVisible: true,
        supportsEmbeddedBrowser: true,
        defaultWhiteboardNamePrefix: "Whiteboard",
        platform: harness.platform,
      }),
    { initialProps: { workspaceIdentity: WORKSPACE_KEY } },
  );
  return { ...harness, ...rendered };
}

describe("useAppPanels BrowserView lifecycle", () => {
  beforeEach(() => {
    clearTaskSidePaneMemoryStateForTest();
    closeSessionMock.mockClear();
  });

  afterEach(() => {
    clearTaskSidePaneMemoryStateForTest();
  });

  it("设置页覆盖期间 Ready 仍挂载 tab 并按 scope 展开激活", () => {
    const { emitReady, result, unmount } = renderSettingsOverlayHook(false);

    act(() => {
      emitReady(readyPayload("tab-a"));
    });

    expect(result.current.sidePaneState).toMatchObject({
      activeTabId: "browser-use:tab-a",
      tabs: [{ id: "browser-use:tab-a", tabId: "tab-a" }],
    });
    expect(result.current.isSidePaneCollapsed).toBe(false);
    unmount();
  });

  it("切进设置页后 Ready 订阅不断开", () => {
    const { emitReady, rerender, result, unmount } = renderSettingsOverlayHook(true);

    act(() => {
      rerender({ isWorkspaceVisible: false });
    });
    act(() => {
      emitReady(readyPayload("tab-a"));
    });

    expect(result.current.sidePaneState).toMatchObject({
      tabs: [{ id: "browser-use:tab-a", tabId: "tab-a" }],
    });
    unmount();
  });

  it("设置页覆盖期间 visibility 仍能切换 active tab", () => {
    const { emitReady, emitVisibility, result, unmount } = renderSettingsOverlayHook(false);

    act(() => {
      emitReady(readyPayload("tab-a"));
      emitReady(readyPayload("tab-b"));
    });
    expect(result.current.sidePaneState?.activeTabId).toBe("browser-use:tab-b");

    act(() => {
      emitVisibility({ ...readyPayload("tab-a"), visible: true });
    });

    expect(result.current.sidePaneState?.activeTabId).toBe("browser-use:tab-a");
    unmount();
  });

  it("设置页覆盖期间 webview 的 target=_blank 仍能开右侧 browser tab", () => {
    const { emitOpenBrowserUrl, result, unmount } = renderSettingsOverlayHook(false);

    act(() => {
      emitOpenBrowserUrl({
        url: "https://example.com/",
        disposition: "foreground-tab",
      });
    });

    expect(result.current.sidePaneState?.tabs).toEqual([
      expect.objectContaining({ type: "browser" }),
    ]);
    expect(result.current.isSidePaneCollapsed).toBe(false);
    unmount();
  });

  it("非当前对话的 webview popup 只后台挂载，不抢当前对话焦点", () => {
    const { emitOpenBrowserUrl, result, unmount } = renderBrowserViewLifecycleHook();

    act(() => {
      emitOpenBrowserUrl({
        url: "https://example.com/from-session-b",
        disposition: "foreground-tab",
        workspaceKey: WORKSPACE_KEY,
        remoteSessionId: "remote-a",
        sessionId: "sess-b",
        browserId: "iab-a",
        browserGeneration: 2,
        sourceTabId: "tab-b",
      });
    });

    expect(result.current.sidePaneState?.activeTabId).not.toMatch(/^browser:/);
    expect(result.current.sidePaneState?.tabs).toEqual([
      expect.objectContaining({
        type: "browser",
        ownerTaskId: "sess-b",
        workspaceKey: WORKSPACE_KEY,
        initialUrl: "https://example.com/from-session-b",
      }),
    ]);
    expect(result.current.isSidePaneCollapsed).toBe(true);
    unmount();
  });

  it("同一 React batch 内按 Ready(A) → Ready(B) → visibility(B) 保留 shell 并激活 B", () => {
    const { emitReady, emitVisibility, result, unmount } = renderBrowserViewLifecycleHook();

    act(() => {
      emitReady(readyPayload("tab-a"));
      emitReady(readyPayload("tab-b"));
      emitVisibility({ ...readyPayload("tab-b"), visible: true });
    });

    expect(result.current.sidePaneState).toMatchObject({
      activeTabId: "browser-use:tab-b",
      tabs: [
        { id: "browser-use:tab-a", tabId: "tab-a" },
        { id: "browser-use:tab-b", tabId: "tab-b" },
      ],
    });
    expect(result.current.isSidePaneCollapsed).toBe(false);
    unmount();
  });

  it("同一 React batch 内普通 tab 打开先于 Ready 时保留两类 tab", () => {
    const { emitReady, result, unmount } = renderBrowserViewLifecycleHook();

    act(() => {
      result.current.handleToggleGit();
      emitReady(readyPayload("tab-a"));
    });

    expect(result.current.sidePaneState?.tabs.map((tab) => tab.type)).toEqual([
      "git",
      "browser-use",
    ]);
    expect(result.current.sidePaneState?.activeTabId).toBe("browser-use:tab-a");
    unmount();
  });

  it("同一 React batch 内普通激活先于 BrowserView operation 时不回滚 active tab", () => {
    const { emitOperation, emitReady, result, unmount } = renderBrowserViewLifecycleHook();
    act(() => emitReady(readyPayload("tab-a")));
    act(() => result.current.handleToggleGit());
    act(() => result.current.handleActivateSidePaneTab("browser-use:tab-a"));

    act(() => {
      result.current.handleActivateSidePaneTab("git");
      emitOperation(readyPayload("tab-a"));
    });

    expect(result.current.sidePaneState?.activeTabId).toBe("git");
    unmount();
  });

  it("同一 React batch 内普通排序先于 BrowserView operation 时不回滚 tab 顺序", () => {
    const { emitOperation, emitReady, result, unmount } = renderBrowserViewLifecycleHook();
    act(() => emitReady(readyPayload("tab-a")));
    act(() => emitReady(readyPayload("tab-b")));

    act(() => {
      result.current.handleReorderSidePaneTab("browser-use:tab-b", "browser-use:tab-a");
      emitOperation(readyPayload("tab-a"));
    });

    expect(result.current.sidePaneState?.tabs.map((tab) => tab.id)).toEqual([
      "browser-use:tab-b",
      "browser-use:tab-a",
    ]);
    unmount();
  });

  it("close(B) 后相邻到达的迟到 visibility(B) 不重建 shell", () => {
    const { emitClose, emitReady, emitVisibility, result, unmount } =
      renderBrowserViewLifecycleHook();
    act(() => emitReady(readyPayload("tab-a")));
    act(() => emitReady(readyPayload("tab-b")));

    act(() => {
      emitClose({ tabId: "tab-b" });
      emitVisibility({ ...readyPayload("tab-b"), visible: true });
    });

    expect(result.current.sidePaneState).toMatchObject({
      activeTabId: "browser-use:tab-a",
      tabs: [{ id: "browser-use:tab-a", tabId: "tab-a" }],
    });
    unmount();
  });

  it("用户关闭 B 获得 main authority 后，迟到 visibility(B) 不重建 shell", async () => {
    const { emitReady, emitVisibility, platform, result, unmount } =
      renderBrowserViewLifecycleHook();
    act(() => emitReady(readyPayload("tab-a")));
    act(() => emitReady(readyPayload("tab-b")));

    await act(async () => {
      result.current.handleCloseSidePaneTab("browser-use:tab-b");
      await Promise.resolve();
      await Promise.resolve();
      emitVisibility({ ...readyPayload("tab-b"), visible: true });
    });

    expect(platform.browserViewCloseTab).toHaveBeenCalledWith({
      tabId: "tab-b",
      workspaceKey: "ssh://host/repo",
      remoteSessionId: "remote-a",
      sessionId: "sess-a",
    });
    expect(result.current.sidePaneState).toMatchObject({
      activeTabId: "browser-use:tab-a",
      tabs: [{ id: "browser-use:tab-a", tabId: "tab-a" }],
    });
    unmount();
  });

  it("A 主动收起后关闭 B，仍有可见 tab 时保持收起和 owner 偏好", () => {
    const { emitClose, emitReady, result, unmount } = renderBrowserViewLifecycleHook();

    act(() => {
      emitReady(readyPayload("tab-a"));
      emitReady(readyPayload("tab-b"));
    });
    act(() => result.current.handleToggleSidePaneCollapse());
    expect(result.current.isSidePaneCollapsed).toBe(true);

    act(() => {
      emitClose({
        tabId: "tab-b",
        workspaceKey: WORKSPACE_KEY,
        remoteSessionId: "remote-a",
        sessionId: "sess-a",
      });
    });

    expect(result.current.sidePaneState?.tabs).toHaveLength(1);
    expect(result.current.isSidePaneCollapsed).toBe(true);
    const memoryKey = buildTaskSidePaneMemoryKey({
      workspacePath: "/repo",
      workspaceIdentity: WORKSPACE_KEY,
      taskId: "sess-a",
    });
    expect(getSidePaneCollapsedPreference(readTaskSidePaneMemoryState(memoryKey), "sess-a")).toBe(
      true,
    );
    unmount();
  });

  it("用户通过切换入口打开 Browser tab 时仍会展开面板", () => {
    const { result, unmount } = renderBrowserViewLifecycleHook();

    act(() => result.current.handleToggleBrowser());

    expect(result.current.sidePaneState?.tabs).toEqual([
      expect.objectContaining({ type: "browser" }),
    ]);
    expect(result.current.isSidePaneCollapsed).toBe(false);
    unmount();
  });

  it("用户通过切换入口打开 Git tab 时仍会展开面板", () => {
    const { result, unmount } = renderBrowserViewLifecycleHook();

    act(() => result.current.handleToggleGit());

    expect(result.current.sidePaneState?.tabs).toEqual([expect.objectContaining({ type: "git" })]);
    expect(result.current.isSidePaneCollapsed).toBe(false);
    unmount();
  });

  it("旧 generation 与不同 remote session 的 visibility 不改变 active tab", () => {
    const { emitReady, emitVisibility, result, unmount } = renderBrowserViewLifecycleHook();
    act(() => emitReady(readyPayload("tab-a")));
    act(() => emitReady(readyPayload("tab-b")));
    act(() => emitVisibility({ ...readyPayload("tab-a"), visible: true }));

    act(() => {
      emitVisibility({
        ...readyPayload("tab-b", { browserGeneration: 1 }),
        visible: true,
      });
      emitVisibility({
        ...readyPayload("tab-b", { remoteSessionId: "remote-b" }),
        visible: true,
      });
    });

    expect(result.current.sidePaneState?.activeTabId).toBe("browser-use:tab-a");
    expect(result.current.sidePaneState?.tabs).toHaveLength(2);
    unmount();
  });

  it("旧 generation 与不同 remote session 的 hide 不折叠当前 shell", () => {
    const { emitReady, emitVisibility, result, unmount } = renderBrowserViewLifecycleHook();
    act(() => emitReady(readyPayload("tab-a")));

    act(() => {
      emitVisibility({
        ...readyPayload("tab-a", { browserGeneration: 1 }),
        visible: false,
      });
    });
    expect(result.current.isSidePaneCollapsed).toBe(false);

    act(() => {
      emitVisibility({
        ...readyPayload("tab-a", { remoteSessionId: "remote-b" }),
        visible: false,
      });
    });
    expect(result.current.isSidePaneCollapsed).toBe(false);
    unmount();
  });

  it("Agent 在其他 workspace 活跃时关闭 tab，切回原 workspace 不残留幽灵 tab", () => {
    const { emitClose, emitReady, rerender, result, unmount } = renderCrossWorkspaceHook();
    act(() => emitReady(readyPayload("tab-a")));
    expect(result.current.sidePaneState?.tabs.map((tab) => tab.id)).toEqual(["browser-use:tab-a"]);

    // 用户切到另一个 workspace，原 workspace 的 side pane 状态被存入 memory。
    act(() => rerender({ workspaceIdentity: OTHER_WORKSPACE_KEY }));
    expect(result.current.sidePaneState?.tabs ?? []).toEqual([]);

    // Bug 回归：Agent 此刻关掉 tab-a，通知只带 tabId 时 renderer 只能在“当前活跃 workspace”里找，
    // 找不到就静默丢弃；原 workspace 的持久化 memory 仍保留这个 tab，切回来就是关不掉的幽灵 tab。
    act(() =>
      emitClose({
        tabId: "tab-a",
        workspaceKey: WORKSPACE_KEY,
        remoteSessionId: "remote-a",
        sessionId: "sess-a",
      }),
    );

    act(() => rerender({ workspaceIdentity: WORKSPACE_KEY }));
    expect(result.current.sidePaneState?.tabs ?? []).toEqual([]);
    unmount();
  });

  it("关闭通知带的 workspace scope 等于当前活跃 workspace 时立即从 UI 移除", () => {
    const { emitClose, emitReady, result, unmount } = renderCrossWorkspaceHook();
    act(() => emitReady(readyPayload("tab-a")));
    expect(result.current.sidePaneState?.tabs.map((tab) => tab.id)).toEqual(["browser-use:tab-a"]);

    // 修复后 main 会给每条通知都带上 owner scope，所以「没切 workspace 时 Agent 关 tab」这条
    // 生产最常见路径也走带 workspaceKey 的分支。它必须落回活跃分支、同步更新当前 React state，
    // 而不是绕进 memory 分支 —— 后者只改持久化状态，UI 上的 tab 不会消失，正是用户报的症状。
    // 这条用例锁的是 renderer 侧的分支选择：payload.workspaceKey 与当前活跃 workspace 相同时，
    // 必须判定为「当前 workspace」。注意它锁不住 main 侧 workspaceKey 的构造式 —— 这里的
    // WORKSPACE_KEY 是硬编码值，而 main 只是把 renderer attach 时传过去的 key 原样回声。
    // 字段拼装那一侧由 packages/desktop/test/browserCloseTabNotification.test.ts 守。
    act(() =>
      emitClose({
        tabId: "tab-a",
        workspaceKey: WORKSPACE_KEY,
        remoteSessionId: "remote-a",
        sessionId: "sess-a",
      }),
    );

    expect(result.current.sidePaneState?.tabs ?? []).toEqual([]);
    unmount();
  });

  it("关闭通知带的 workspace scope 不匹配时不误删其他 workspace 的同名 tab", () => {
    const { emitClose, emitReady, rerender, result, unmount } = renderCrossWorkspaceHook();
    act(() => emitReady(readyPayload("tab-a")));
    act(() => rerender({ workspaceIdentity: OTHER_WORKSPACE_KEY }));

    act(() =>
      emitClose({
        tabId: "tab-a",
        workspaceKey: "ssh://host/unrelated",
        remoteSessionId: "remote-a",
        sessionId: "sess-a",
      }),
    );

    act(() => rerender({ workspaceIdentity: WORKSPACE_KEY }));
    expect(result.current.sidePaneState?.tabs.map((tab) => tab.id)).toEqual(["browser-use:tab-a"]);
    unmount();
  });

  it("远程下打开链接创建的 human tab，关闭请求必须带上 remoteSessionId", async () => {
    // Bug 回归（远程内置浏览器 tab 关不掉）：attach 侧用 `tab.remoteSessionId ?? workspaceRemoteSessionId`
    // 兜底冻结了 main 侧 owner.remoteSessionId，close 侧却只取 tab.remoteSessionId。human tab 从不写该
    // 字段，且 stamp 会跳过已带 ownerTaskId 的 tab，于是远程下 close payload 缺 remoteSessionId，
    // main 判 scope 失配抛错，renderer 拿不到授权就永不移除 UI 壳 —— tab 永远关不掉。
    const { emitOpenBrowserUrl, platform, result, unmount } = renderBrowserViewLifecycleHook();

    act(() => {
      emitOpenBrowserUrl({
        url: "https://example.com/from-link",
        disposition: "foreground-tab",
        workspaceKey: WORKSPACE_KEY,
        remoteSessionId: "remote-a",
        sessionId: "sess-a",
        browserId: "iab-a",
        browserGeneration: 2,
        sourceTabId: "tab-a",
      });
    });

    const humanTab = result.current.sidePaneState?.tabs.find((tab) => tab.type === "browser");
    expect(humanTab).toMatchObject({ remoteSessionId: "remote-a" });

    await act(async () => {
      result.current.handleCloseSidePaneTab(humanTab!.id);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(platform.browserViewCloseTab).toHaveBeenCalledWith({
      tabId: humanTab!.id,
      workspaceKey: WORKSPACE_KEY,
      remoteSessionId: "remote-a",
      sessionId: "sess-a",
    });
    // 授权拿到后 UI 壳必须真的移除（tab 清空后 sidePaneState 本身会归空）。
    expect((result.current.sidePaneState?.tabs ?? []).filter((tab) => tab.type === "browser")).toEqual(
      [],
    );
    unmount();
  });
});
