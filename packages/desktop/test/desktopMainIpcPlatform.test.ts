import { describe, expect, it, vi, beforeEach } from "vitest";
import { PlatformChannels } from "@zcode/shared";

type IpcHandler = (...args: unknown[]) => unknown;

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    openCuaPermissionOnboarding: vi.fn(),
    // 拖拽授权引导的 helper 预校验：本文件只覆盖 platform IPC 注册，不验证 helper
    // 缓存路径，所以固定返回失败结果走 clearVerifiedHelper 分支。必须返回对象——
    // 调用方 refreshVerifiedHelperAppPath 直接读 result.success。
    prepareCuaHelperPermissionDrag: vi.fn(async () => ({
      success: false as const,
      error: "prepareCuaHelperPermissionDrag is not exercised in platform IPC tests",
    })),
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn(),
    ipcHandle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    ipcOn: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    browserWindowFromWebContents: vi.fn(() => null),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: electronMocks.browserWindowFromWebContents,
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showMessageBox: electronMocks.showMessageBox,
  },
  ipcMain: {
    handle: electronMocks.ipcHandle,
    on: electronMocks.ipcOn,
  },
  nativeTheme: {
    themeSource: "system",
  },
  nativeImage: {},
  shell: {
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock("../src/main/editors.js", () => ({
  getInstalledEditors: vi.fn(() => []),
}));

vi.mock("../src/main/exportLogs.js", () => ({
  exportLogs: vi.fn(),
}));

vi.mock("../src/main/desktopCommandHandlers.js", () => ({
  resolveCommunityUrl: vi.fn(() => "https://example.com"),
}));

vi.mock("../src/main/openInEditor.js", () => ({
  openInEditor: vi.fn(),
}));

vi.mock("../src/main/resourceManagerWindow.js", () => ({
  getResourceUsageSnapshot: vi.fn(),
  setResourceUsageSamplingActive: vi.fn(),
  openResourceManager: vi.fn(),
}));

vi.mock("../src/main/desktopWindowChrome.js", () => ({
  applyWindowsTitleBarTheme: vi.fn(),
  getWindowOverlayTheme: vi.fn(() => null),
}));

vi.mock("../src/main/desktopWindowLifecycle.js", () => ({
  handleWindowUnreadCountSync: vi.fn(),
}));

vi.mock("../src/main/desktopWindowButtonPosition.js", () => ({
  syncWindowControlsOverlayForZoomLevel: vi.fn(),
}));

vi.mock("../src/main/mcpUserDirectory/index.js", () => ({
  loadCliMcpFromUserDirectory: vi.fn(),
  migrateLegacyCommonMcp: vi.fn(),
  saveCliMcpToUserDirectory: vi.fn(),
}));

vi.mock("../src/main/cuaAccessibilitySettings.js", () => ({
  openCuaPermissionOnboarding: electronMocks.openCuaPermissionOnboarding,
  prepareCuaHelperPermissionDrag: electronMocks.prepareCuaHelperPermissionDrag,
}));

describe("registerPlatformIpcHandlers", () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    electronMocks.openCuaPermissionOnboarding.mockReset();
    electronMocks.showOpenDialog.mockReset();
    electronMocks.showMessageBox.mockReset();
    electronMocks.ipcHandle.mockClear();
    electronMocks.ipcOn.mockClear();
    electronMocks.browserWindowFromWebContents.mockReset();
    electronMocks.browserWindowFromWebContents.mockReturnValue(null);
  });

  it("allows creating folders from the workspace directory picker", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");

    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand: vi.fn(async () => {}),
      acknowledgePostUpdateReleaseNotes: vi.fn(async () => {}),
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      getUpdateState: vi.fn(() => ({ status: "idle" })),
      syncWebRemoteControlWorkspaces: vi.fn(),
      syncWebRemoteControlTasks: vi.fn(),
      deviceMid: "test-device-mid",
    });

    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/new-workspace"],
    });

    const handler = electronMocks.handlers.get(PlatformChannels.SelectDirectory);
    expect(handler).toBeDefined();
    await handler?.();

    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory", "createDirectory"],
    });
  });

  it("syncs macOS window controls when preload reports startup zoom metrics", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");
    const { syncWindowControlsOverlayForZoomLevel } =
      await import("../src/main/desktopWindowButtonPosition.js");

    const targetWindow = { id: 1 };
    electronMocks.browserWindowFromWebContents.mockReturnValue(targetWindow);

    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand: vi.fn(async () => {}),
      acknowledgePostUpdateReleaseNotes: vi.fn(async () => {}),
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      getUpdateState: vi.fn(() => ({ status: "idle" })),
      syncWebRemoteControlWorkspaces: vi.fn(),
      syncWebRemoteControlTasks: vi.fn(),
      deviceMid: "test-device-mid",
    });

    const handler = electronMocks.handlers.get(PlatformChannels.WindowControlsOverlayReady);
    expect(handler).toBeDefined();
    handler?.(
      { sender: {} },
      {
        zoomLevel: 2,
        metrics: { leftPaddingPx: 79 },
      },
    );

    expect(syncWindowControlsOverlayForZoomLevel).toHaveBeenCalledWith(targetWindow, 2);
  });

  it("offers restored local workspace contexts to Web remote control startup recovery", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");
    const restorePreviouslyEnabledWebRemoteControl = vi.fn();
    const targetWindow = { id: 7 };
    electronMocks.browserWindowFromWebContents.mockReturnValue(targetWindow);

    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand: vi.fn(async () => {}),
      acknowledgePostUpdateReleaseNotes: vi.fn(async () => {}),
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      restorePreviouslyEnabledWebRemoteControl,
      getUpdateState: vi.fn(() => ({ status: "idle" })),
      syncWebRemoteControlWorkspaces: vi.fn(),
      syncWebRemoteControlTasks: vi.fn(),
      deviceMid: "test-device-mid",
    });

    electronMocks.handlers.get(PlatformChannels.SyncWindowTabs)?.({ sender: {} }, [
      "/workspace/one",
      "/workspace/two",
    ]);

    expect(restorePreviouslyEnabledWebRemoteControl).toHaveBeenCalledWith(7, [
      { workspacePath: "/workspace/one" },
      { workspacePath: "/workspace/two" },
    ]);
  });

  it("runs generalized CUA permission onboarding for Screen Recording", async () => {
    const { registerPlatformIpcHandlers } = await import("../src/main/desktopMainIpcPlatform.js");

    electronMocks.openCuaPermissionOnboarding.mockResolvedValueOnce({
      success: true,
      sessionId: "session-1",
      returnedFromSettings: true,
    });
    registerPlatformIpcHandlers({
      logger: { info: vi.fn(), warn: vi.fn() },
      applyApplicationLocale: vi.fn(async () => {}),
      focusWorkspaceInExistingWindow: vi.fn(() => ({ activated: false })),
      windowWorkspaceMap: new Map(),
      windowUnreadCountMap: new Map(),
      currentApplicationLocale: () => "en-US",
      executeDesktopCommand: vi.fn(async () => {}),
      acknowledgePostUpdateReleaseNotes: vi.fn(async () => {}),
      syncTaskRealtimeWorkspaceKeys: vi.fn(),
      getUpdateState: vi.fn(() => ({ status: "idle" })),
      syncWebRemoteControlWorkspaces: vi.fn(),
      syncWebRemoteControlTasks: vi.fn(),
      deviceMid: "test-device-mid",
    });

    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const handler = electronMocks.handlers.get(PlatformChannels.OpenCuaPermissionOnboarding);
    expect(handler).toBeDefined();

    await expect(
      handler?.(
        { sender: {} },
        {
          initialPermission: "screen_recording",
          requiredPermissions: ["screen_recording"],
          // 旧 renderer 即使传入未知 alias，main 也不能再转发或回显它们。
          prepareAllRequired: true,
          missingPermissions: ["accessibility"],
        },
      ),
    ).resolves.toEqual({
      success: true,
      sessionId: "session-1",
      returnedFromSettings: true,
    });
    expect(electronMocks.openCuaPermissionOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPermission: "screen_recording",
        requiredPermissions: ["screen_recording"],
        logger: { info: expect.any(Function), warn: expect.any(Function) },
        signal: expect.any(AbortSignal),
        openSettingsAndWaitForReturn: expect.any(Function),
      }),
    );
    expect(electronMocks.openCuaPermissionOnboarding).not.toHaveBeenCalledWith(
      expect.objectContaining({
        prepareAllRequired: expect.anything(),
        missingPermissions: expect.anything(),
      }),
    );
  });
});
