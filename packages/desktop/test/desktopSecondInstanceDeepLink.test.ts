import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

const electronMocks = vi.hoisted(() => ({
  appShow: vi.fn(),
  showMessageBoxSync: vi.fn(() => 0),
  getFocusedWindow: vi.fn(),
  getAllWindows: vi.fn(),
  setAsDefaultProtocolClient: vi.fn(() => true),
}));
const fsMocks = vi.hoisted(() => ({
  statSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMocks.statSync.mockImplementation(actual.statSync);
  return {
    ...actual,
    statSync: fsMocks.statSync,
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    get isPackaged() {
      return false;
    },
    setAsDefaultProtocolClient: electronMocks.setAsDefaultProtocolClient,
    show: electronMocks.appShow,
  },
  BrowserWindow: {
    getFocusedWindow: electronMocks.getFocusedWindow,
    getAllWindows: electronMocks.getAllWindows,
  },
  dialog: {
    showMessageBoxSync: electronMocks.showMessageBoxSync,
  },
}));

const tempDirs: string[] = [];

beforeEach(() => {
  vi.resetModules();
  electronMocks.appShow.mockClear();
  electronMocks.showMessageBoxSync.mockReset();
  electronMocks.showMessageBoxSync.mockReturnValue(0);
  electronMocks.getFocusedWindow.mockReset();
  electronMocks.getAllWindows.mockReset();
  electronMocks.setAsDefaultProtocolClient.mockClear();
  fsMocks.statSync.mockClear();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktop second-instance workspace deep link routing", () => {
  it("第二实例 workspace deep link 用户确认后投递到已就绪窗口", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(31);
    const logger = { warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const {
      createDeepLinkSingleInstanceData,
      deliverPendingDeepLink,
      handleDeepLink,
      handleOpenWorkspacePath,
      handleSecondInstanceWorkspaceRequest,
      resolveExternalWorkspaceOpenDialogCopy,
    } = await importHarness();

    deliverPendingDeepLink(targetWindow.webContents);
    targetWindow.webContents.send.mockClear();
    const handled = handleSecondInstanceWorkspaceRequest({
      additionalData: createDeepLinkSingleInstanceData([
        "ZCode",
        buildWorkspaceOpenUrl(workspacePath),
      ]),
      argv: ["ZCode"],
      focusForceUpdateGateWindow: vi.fn(),
      forceUpdateBlocked: false,
      handleDeepLink: (url, options) =>
        handleDeepLink(url, { info: vi.fn(), warn: logger.warn }, options),
      handleOpenWorkspacePath: (path) =>
        handleOpenWorkspacePath(
          path,
          { info: vi.fn(), warn: logger.warn },
          {
            allowWithoutReadyWindow: true,
          },
        ),
      logger,
      workspaceConfirmationCopy: resolveExternalWorkspaceOpenDialogCopy("zh-CN"),
    });

    expect(handled).toBe(true);
    expect(electronMocks.showMessageBoxSync).toHaveBeenCalledWith(
      targetWindow,
      expect.objectContaining({
        buttons: ["打开文件夹", "取消"],
      }),
    );
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenWorkspacePath,
      workspacePath,
    );
  });

  it("第二实例工作区参数把业务窗口解析器传给路由层", async () => {
    const workspacePath = createTempWorkspace();
    const resolveApplicationWindow = vi.fn(() => null);
    const handleOpenWorkspacePath = vi.fn(() => true);
    const { createDeepLinkSingleInstanceData, handleSecondInstanceWorkspaceRequest } =
      await importHarness();

    const handled = handleSecondInstanceWorkspaceRequest({
      additionalData: createDeepLinkSingleInstanceData([
        "ZCode",
        "--open-workspace",
        workspacePath,
      ]),
      argv: ["ZCode"],
      focusForceUpdateGateWindow: vi.fn(),
      forceUpdateBlocked: false,
      handleDeepLink: vi.fn(() => false),
      handleOpenWorkspacePath,
      logger: { warn: vi.fn() },
      resolveApplicationWindow,
    });

    expect(handled).toBe(true);
    expect(handleOpenWorkspacePath).toHaveBeenCalledWith(workspacePath, {
      resolveApplicationWindow,
    });
  });

  it("第二实例 workspace deep link 用户取消后不投递", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(32);
    const logger = { warn: vi.fn() };
    electronMocks.showMessageBoxSync.mockReturnValue(1);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const {
      createDeepLinkSingleInstanceData,
      handleDeepLink,
      handleOpenWorkspacePath,
      handleSecondInstanceWorkspaceRequest,
    } = await importHarness();

    const handled = handleSecondInstanceWorkspaceRequest({
      additionalData: createDeepLinkSingleInstanceData([
        "ZCode",
        buildWorkspaceOpenUrl(workspacePath),
      ]),
      argv: ["ZCode"],
      focusForceUpdateGateWindow: vi.fn(),
      forceUpdateBlocked: false,
      handleDeepLink: (url, options) =>
        handleDeepLink(url, { info: vi.fn(), warn: logger.warn }, options),
      handleOpenWorkspacePath: (path) =>
        handleOpenWorkspacePath(
          path,
          { info: vi.fn(), warn: logger.warn },
          {
            allowWithoutReadyWindow: true,
          },
        ),
      logger,
    });

    expect(handled).toBe(true);
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("[deep-link] 用户取消打开外部链接工作区", {
      path: workspacePath,
    });
  });

  it("第二实例 UNC workspace deep link 在目录探测前被拒绝", async () => {
    const targetWindow = createMockWindow(33);
    const logger = { warn: vi.fn() };
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);

    const {
      createDeepLinkSingleInstanceData,
      handleDeepLink,
      handleOpenWorkspacePath,
      handleSecondInstanceWorkspaceRequest,
    } = await importHarness();

    const handled = handleSecondInstanceWorkspaceRequest({
      additionalData: createDeepLinkSingleInstanceData([
        "ZCode",
        buildWorkspaceOpenUrl("\\\\attacker\\share"),
      ]),
      argv: ["ZCode"],
      focusForceUpdateGateWindow: vi.fn(),
      forceUpdateBlocked: false,
      handleDeepLink: (url, options) =>
        handleDeepLink(url, { info: vi.fn(), warn: logger.warn }, options),
      handleOpenWorkspacePath: (path) =>
        handleOpenWorkspacePath(
          path,
          { info: vi.fn(), warn: logger.warn },
          {
            allowWithoutReadyWindow: true,
          },
        ),
      logger,
    });

    expect(handled).toBe(false);
    expect(fsMocks.statSync).not.toHaveBeenCalled();
    expect(electronMocks.showMessageBoxSync).not.toHaveBeenCalled();
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("[deep-link] 网络工作区路径已拒绝", {
      path: "\\\\attacker\\share",
    });
  });
});

async function importHarness() {
  const [{ createDeepLinkSingleInstanceData }, oauthDeepLink, secondInstance] = await Promise.all([
    import("../src/main/desktopDeepLinkUrl.js"),
    import("../src/main/desktopOAuthDeepLink.js"),
    import("../src/main/desktopSecondInstanceDeepLink.js"),
  ]);
  return {
    createDeepLinkSingleInstanceData,
    deliverPendingDeepLink: oauthDeepLink.deliverPendingDeepLink,
    handleDeepLink: oauthDeepLink.handleDeepLink,
    handleOpenWorkspacePath: oauthDeepLink.handleOpenWorkspacePath,
    handleSecondInstanceWorkspaceRequest: secondInstance.handleSecondInstanceWorkspaceRequest,
    resolveExternalWorkspaceOpenDialogCopy: oauthDeepLink.resolveExternalWorkspaceOpenDialogCopy,
  };
}

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-second-instance-deep-link-"));
  tempDirs.push(dir);
  return dir;
}

function createMockWindow(webContentsId: number) {
  return {
    webContents: {
      id: webContentsId,
      send: vi.fn(),
    },
    focus: vi.fn(),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
  };
}

function buildWorkspaceOpenUrl(workspacePath: string): string {
  return `zcode://workspace/open?path=${encodeURIComponent(workspacePath)}`;
}
