import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DesktopCommandIds } from "@zcode/shared";

const appMock = {
  isPackaged: false,
  getAppPath: vi.fn(() => "/Applications/ZCode.app/Contents/Resources/app.asar"),
  getVersion: vi.fn(() => "3.5.0"),
};
const browserWindowInstances: Array<{
  close: ReturnType<typeof vi.fn>;
  emitTitle: (title: string) => void;
  isDestroyed: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> = [];
const sessionFromPartitionMock = vi.fn();
const codingPlanPartitionSession = {
  clearStorageData: vi.fn(async () => undefined),
};
const BrowserWindowMock = vi.fn(function BrowserWindowConstructor() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const instance = {
    close: vi.fn(),
    emitTitle: (title: string) => {
      handlers.get("page-title-updated")?.({ preventDefault: vi.fn() }, title);
    },
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(() => Promise.resolve()),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
  };
  browserWindowInstances.push(instance);
  return instance;
});

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: Object.assign(BrowserWindowMock, {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  }),
  dialog: {
    showMessageBox: vi.fn(),
  },
  net: {
    request: vi.fn(),
  },
  nativeTheme: {
    shouldUseDarkColors: true,
  },
  session: {
    fromPartition: sessionFromPartitionMock,
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("electron-updater", () => {
  class CancellationTokenMock {
    cancelled = false;
    private cancelListeners: Array<() => void> = [];

    cancel() {
      this.cancelled = true;
      const listeners = this.cancelListeners;
      this.cancelListeners = [];
      for (const listener of listeners) {
        listener();
      }
    }

    once(event: string, listener: () => void) {
      if (event === "cancel") {
        this.cancelListeners.push(listener);
      }
      return this;
    }

    dispose() {
      this.cancelListeners = [];
    }
  }

  class ProviderMock {
    constructor() {}
    get isUseMultipleRangeRequest() {
      return false;
    }
    setRequestHeaders() {}
  }

  return {
    CancellationToken: CancellationTokenMock,
    // Bugfix: desktopCommandHandlers 只断言菜单命令，但导入链会加载 autoUpdater 的 manifest provider。
    // mock 必须包含 Provider，否则 Vitest 会在模块初始化阶段报缺少 electron-updater 命名导出。
    Provider: ProviderMock,
    default: {
      autoUpdater: {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        logger: undefined,
        on: vi.fn(),
        checkForUpdates: vi.fn(() => Promise.resolve()),
        quitAndInstall: vi.fn(),
      },
    },
  };
});

const originalPlatform = process.platform;

function stubProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("desktopCommandHandlers resolveFeedbackUrl", () => {
  beforeEach(() => {
    vi.resetModules();
    appMock.getAppPath.mockClear();
    appMock.getVersion.mockClear();
    BrowserWindowMock.mockClear();
    browserWindowInstances.length = 0;
    sessionFromPartitionMock.mockReset();
    sessionFromPartitionMock.mockReturnValue(codingPlanPartitionSession);
    codingPlanPartitionSession.clearStorageData.mockClear();
  });

  afterEach(() => {
    stubProcessPlatform(originalPlatform);
  });

  it("优先使用远端 JSON 里的 feedback_url", async () => {
    const logger = {
      warn: vi.fn(),
    };
    // Bugfix: 这个用例需要 resetModules 后重新导入 desktopCommandHandlers。
    // 在全量测试并发执行时，Electron 相关模块初始化偶尔会比单跑慢很多，默认 5s 超时不够稳定，
    // 但实际断言链路本身很短。这里单独放宽超时，避免 verify:pre-push 被偶发慢启动误杀。
    const { resolveFeedbackUrl } = await import("../src/main/desktopCommandHandlers.js");

    const feedbackUrl = await resolveFeedbackUrl({
      logger,
      fetchRemoteConfig: async () => ({
        feedback_url: "https://remote.example.com/feedback",
      }),
      readLocalConfig: () => ({
        feedback_url: "https://local.example.com/feedback",
      }),
    });

    expect(feedbackUrl).toBe("https://remote.example.com/feedback");
  }, 15_000);

  it("远端不可用时回退到本地 JSON", async () => {
    const logger = {
      warn: vi.fn(),
    };
    const { resolveFeedbackUrl } = await import("../src/main/desktopCommandHandlers.js");

    const feedbackUrl = await resolveFeedbackUrl({
      logger,
      fetchRemoteConfig: async () => {
        throw new Error("network down");
      },
      readLocalConfig: () => ({
        feedback_url: "https://local.example.com/feedback",
      }),
    });

    expect(feedbackUrl).toBe("https://local.example.com/feedback");
    expect(logger.warn).toHaveBeenCalledWith(
      "[feedback] failed to fetch remote config:",
      expect.any(Error),
    );
  });

  it("两个 JSON 都没有有效地址时返回 undefined", async () => {
    const logger = {
      warn: vi.fn(),
    };
    const { resolveFeedbackUrl } = await import("../src/main/desktopCommandHandlers.js");

    const feedbackUrl = await resolveFeedbackUrl({
      logger,
      fetchRemoteConfig: async () => ({}),
      readLocalConfig: () => ({}),
    });

    expect(feedbackUrl).toBeUndefined();
  });

  it("中文界面只打开中文社群入口，缺失时不跨语言回退", async () => {
    const logger = {
      warn: vi.fn(),
    };
    const { resolveCommunityUrl } = await import("../src/main/desktopCommandHandlers.js");

    await expect(
      resolveCommunityUrl({
        locale: "zh-CN",
        logger,
        fetchRemoteConfig: async () => ({
          community_urls: {
            "zh-CN": "https://remote.example.com/zh-community",
            "en-US": "https://remote.example.com/en-community",
          },
        }),
      }),
    ).resolves.toBe("https://remote.example.com/zh-community");

    await expect(
      resolveCommunityUrl({
        locale: "zh-CN",
        logger,
        fetchRemoteConfig: async () => ({
          community_urls: {
            "en-US": "https://remote.example.com/en-community",
          },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("英文界面优先使用本地英文入口，不被远端中文入口截获", async () => {
    const logger = {
      warn: vi.fn(),
    };
    const { resolveCommunityUrl } = await import("../src/main/desktopCommandHandlers.js");

    const communityUrl = await resolveCommunityUrl({
      locale: "en-US",
      logger,
      fetchRemoteConfig: async () => ({
        community_urls: {
          "zh-CN": "https://remote.example.com/zh-community",
        },
      }),
      readLocalConfig: () => ({
        community_urls: {
          "zh-CN": "https://local.example.com/zh-community",
          "en-US": "https://local.example.com/en-community",
        },
      }),
    });

    expect(communityUrl).toBe("https://local.example.com/en-community");
  });

  it("正式包从 resources/config 读取内置配置，开发态继续读取仓库配置", async () => {
    const { resolveLocalAppConfigPath } = await import("../src/main/desktopCommandHandlers.js");

    // Bugfix：resolveLocalAppConfigPath 用宿主 path.join 拼接，Windows 上分隔符是 `\`，
    // 而这里原来写死 POSIX 字面量，两条断言在 Windows 上都对不上。改用宿主 join 组装期望值，
    // 断言仍然表达同一组「正式包读 resources/config、开发态回到仓库 config」。
    expect(
      resolveLocalAppConfigPath({
        isPackaged: true,
        resourcesPath: "/Applications/ZCode.app/Contents/Resources",
        appPath: "/Applications/ZCode.app/Contents/Resources/app.asar",
      }),
    ).toBe(join("/Applications/ZCode.app/Contents/Resources", "config/default.json"));
    expect(
      resolveLocalAppConfigPath({
        isPackaged: false,
        appPath: "/repo/packages/desktop",
      }),
    ).toBe(join("/repo", "config", "default.json"));
  });

  it("中文界面打开中文 changelog，其他语言打开英文 changelog", async () => {
    const { openChangelog } = await import("../src/main/desktopCommandHandlers.js");
    const { shell } = await import("electron");

    await openChangelog("zh-CN");
    await openChangelog("en-US");

    expect(shell.openExternal).toHaveBeenNthCalledWith(1, "https://zcode.z.ai/cn/changelog");
    expect(shell.openExternal).toHaveBeenNthCalledWith(2, "https://zcode.z.ai/en/changelog");
  });

  it("changelog 按当前非生产 endpoint 打开", async () => {
    const { executeDesktopCommand } = await import("../src/main/desktopCommandHandlers.js");
    const { shell } = await import("electron");
    const commandOptions = createCommandOptions({
      settings: { zcodeEndpointOrigin: "https://zcode.z.ai" },
    });

    await executeDesktopCommand({
      ...commandOptions,
      command: DesktopCommandIds.OpenChangelog,
      currentApplicationLocale: "en-US",
    });

    expect(shell.openExternal).toHaveBeenCalledWith("https://zcode.z.ai/en/changelog");
  });

  it("relaunch app 命令交给主进程重启回调", async () => {
    const { executeDesktopCommand } = await import("../src/main/desktopCommandHandlers.js");
    const onRelaunchApp = vi.fn(async () => undefined);
    const commandOptions = createCommandOptions({ onRelaunchApp });

    await executeDesktopCommand({
      ...commandOptions,
      command: DesktopCommandIds.RelaunchApp,
    });

    expect(onRelaunchApp).toHaveBeenCalledTimes(1);
  });

  it("清理 Coding Plan webview 持久 partition，避免账号切换后复用旧凭据", async () => {
    const { executeDesktopCommand } = await import("../src/main/desktopCommandHandlers.js");
    const commandOptions = createCommandOptions();

    await executeDesktopCommand({
      ...commandOptions,
      command: DesktopCommandIds.ClearCodingPlanWebviewStorage,
    });

    expect(sessionFromPartitionMock).toHaveBeenCalledWith("persist:zcode-coding-plan");
    expect(sessionFromPartitionMock).toHaveBeenCalledWith("persist:zcode-rewards");
    expect(codingPlanPartitionSession.clearStorageData).toHaveBeenCalledTimes(2);
    expect(commandOptions.logger.info).toHaveBeenCalledWith(
      "[coding-plan-webview] cleared persistent partition storage",
    );
  });

  it("非生产 endpoint 菜单命令能保存 test、自定义和 reset", async () => {
    const { executeDesktopCommand } = await import("../src/main/desktopCommandHandlers.js");
    const onZCodeEndpointChanged = vi.fn();
    const commandOptions = createCommandOptions({ onZCodeEndpointChanged });

    await executeDesktopCommand({
      ...commandOptions,
      command: DesktopCommandIds.SetZCodeEndpointTest,
    });
    expect(commandOptions.settingService.update).toHaveBeenLastCalledWith({
      zcodeEndpointOrigin: "https://zcode.z.ai",
    });

    await executeDesktopCommand({
      ...commandOptions,
      command: DesktopCommandIds.ResetZCodeEndpoint,
    });
    expect(commandOptions.settingService.update).toHaveBeenLastCalledWith({
      zcodeEndpointOrigin: undefined,
    });
    expect(onZCodeEndpointChanged).toHaveBeenCalledTimes(2);
  });

  it("Custom endpoint 菜单打开主进程输入窗并保存提交值", async () => {
    const { executeDesktopCommand } = await import("../src/main/desktopCommandHandlers.js");
    const onZCodeEndpointChanged = vi.fn();
    const commandOptions = createCommandOptions({ onZCodeEndpointChanged });

    const commandPromise = executeDesktopCommand({
      ...commandOptions,
      command: DesktopCommandIds.SetZCodeEndpointCustom,
    });
    await vi.waitFor(() => expect(BrowserWindowMock).toHaveBeenCalledTimes(1));
    const promptWindow = browserWindowInstances[0];
    expect(promptWindow?.loadURL).toHaveBeenCalledWith(expect.stringContaining("data:text/html"));

    promptWindow?.emitTitle(
      "zcode-endpoint-submit:" + encodeURIComponent("http://localhost:3030/path"),
    );
    await commandPromise;

    expect(commandOptions.settingService.update).toHaveBeenCalledWith({
      zcodeEndpointOrigin: "http://localhost:3030",
    });
    expect(onZCodeEndpointChanged).toHaveBeenCalledTimes(1);
  });

  it("系统缩放命令会限制在缩小 3 档和放大 5 档之间", async () => {
    stubProcessPlatform("darwin");
    const { updateDesktopZoomLevel } = await import("../src/main/desktopCommandHandlers.js");
    const targetWindow = createZoomWindow(Math.pow(1.1, 4));

    updateDesktopZoomLevel(targetWindow, "in");
    expect(targetWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(Math.pow(1.1, 5));
    expect(targetWindow.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 22, y: 44 });
    expect(targetWindow.webContents.send).toHaveBeenLastCalledWith(
      "zcode:desktop-zoom-level-changed",
      { zoomLevel: 5 },
    );
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      "zcode:window-controls-overlay-changed",
      { leftPaddingPx: 60 },
    );

    targetWindow.webContents.getZoomFactor.mockReturnValue(Math.pow(1.1, 5));
    updateDesktopZoomLevel(targetWindow, "in");
    expect(targetWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(Math.pow(1.1, 5));
    expect(targetWindow.webContents.send).toHaveBeenLastCalledWith(
      "zcode:desktop-zoom-level-changed",
      { zoomLevel: 5 },
    );

    targetWindow.webContents.getZoomFactor.mockReturnValue(Math.pow(1.1, -3));
    updateDesktopZoomLevel(targetWindow, "out");
    expect(targetWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(Math.pow(1.1, -3));
    expect(targetWindow.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 22, y: 14 });
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      "zcode:window-controls-overlay-changed",
      { leftPaddingPx: 128 },
    );
    expect(targetWindow.webContents.send).toHaveBeenLastCalledWith(
      "zcode:desktop-zoom-level-changed",
      { zoomLevel: -3 },
    );

    targetWindow.webContents.getZoomFactor.mockReturnValue(Math.pow(1.1, 5));
    updateDesktopZoomLevel(targetWindow, "reset");
    expect(targetWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(1);
    expect(targetWindow.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: 22, y: 23 });
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      "zcode:window-controls-overlay-changed",
      { leftPaddingPx: 96 },
    );
    expect(targetWindow.webContents.send).toHaveBeenLastCalledWith(
      "zcode:desktop-zoom-level-changed",
      { zoomLevel: 0 },
    );
  });

  it("Windows 系统缩放命令会同步右侧窗口控制区安全边距", async () => {
    stubProcessPlatform("win32");
    const { updateDesktopZoomLevel } = await import("../src/main/desktopCommandHandlers.js");
    const targetWindow = createZoomWindow(Math.pow(1.1, 4));

    updateDesktopZoomLevel(targetWindow, "in");

    expect(targetWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(Math.pow(1.1, 5));
    expect(targetWindow.setWindowButtonPosition).not.toHaveBeenCalled();
    expect(targetWindow.setTitleBarOverlay).toHaveBeenLastCalledWith({
      color: "#00000000",
      symbolColor: "#f5f5f5",
      height: 77,
    });
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      "zcode:window-controls-overlay-changed",
      { rightPaddingPx: 84, titleBarHeightPx: 77 },
    );
    expect(targetWindow.webContents.send).toHaveBeenLastCalledWith(
      "zcode:desktop-zoom-level-changed",
      { zoomLevel: 5 },
    );

    targetWindow.webContents.getZoomFactor.mockReturnValue(Math.pow(1.1, -3));
    updateDesktopZoomLevel(targetWindow, "out");
    expect(targetWindow.setTitleBarOverlay).toHaveBeenLastCalledWith({
      color: "#00000000",
      symbolColor: "#f5f5f5",
      height: 36,
    });
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      "zcode:window-controls-overlay-changed",
      { rightPaddingPx: 181, titleBarHeightPx: 36 },
    );
    expect(targetWindow.webContents.send).toHaveBeenLastCalledWith(
      "zcode:desktop-zoom-level-changed",
      { zoomLevel: -3 },
    );
  });

  it.each([
    [4, "in", 5, 84, 77],
    [-2, "out", -3, 181, 36],
    [4, "reset", 0, 136, 48],
  ] as const)(
    "Windows 缩放 %s/%s 区分自绘与原生窗控",
    async (initialLevel, action, nextLevel, nativePadding, height) => {
      stubProcessPlatform("win32");
      const { updateDesktopZoomLevel } = await import("../src/main/desktopCommandHandlers.js");
      const { registerCustomWindowsControls } =
        await import("../src/main/desktopWindowButtonPosition.js");
      const customWindow = createZoomWindow(Math.pow(1.1, initialLevel));
      const nativeWindow = createZoomWindow(Math.pow(1.1, initialLevel));
      registerCustomWindowsControls(customWindow);

      updateDesktopZoomLevel(customWindow, action);
      updateDesktopZoomLevel(nativeWindow, action);

      expect(customWindow.setTitleBarOverlay).not.toHaveBeenCalled();
      expect(customWindow.webContents.send).toHaveBeenCalledWith(
        "zcode:window-controls-overlay-changed",
        { rightPaddingPx: 136 },
      );
      expect(nativeWindow.webContents.send).toHaveBeenCalledWith(
        "zcode:window-controls-overlay-changed",
        { rightPaddingPx: nativePadding, titleBarHeightPx: height },
      );
      for (const targetWindow of [customWindow, nativeWindow]) {
        expect(targetWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(
          Math.pow(1.1, nextLevel),
        );
      }
    },
  );

  it("系统缩放命令执行后通知应用菜单刷新禁用态", async () => {
    const { executeDesktopCommand } = await import("../src/main/desktopCommandHandlers.js");
    const onDesktopZoomChanged = vi.fn();
    const targetWindow = createZoomWindow(1);
    const commandOptions = createCommandOptions({ onDesktopZoomChanged });

    await executeDesktopCommand({
      ...commandOptions,
      command: DesktopCommandIds.ZoomIn,
      senderWindow: targetWindow,
    });

    expect(targetWindow.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.1);
    expect(commandOptions.settingService.update).toHaveBeenLastCalledWith({
      desktopZoomLevel: 1,
    });
    expect(onDesktopZoomChanged).toHaveBeenCalledTimes(1);
    expect(onDesktopZoomChanged).toHaveBeenCalledWith(1);
  });
});

function createZoomWindow(initialZoomFactor: number) {
  return {
    isDestroyed: vi.fn(() => false),
    setWindowButtonPosition: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    webContents: {
      getZoomFactor: vi.fn(() => initialZoomFactor),
      setZoomFactor: vi.fn(),
      send: vi.fn(),
    },
  } as never;
}

function createCommandOptions(options?: {
  onDesktopZoomChanged?: () => void;
  onRelaunchApp?: () => Promise<void>;
  onZCodeEndpointChanged?: () => void;
  settings?: { zcodeEndpointOrigin?: string; desktopZoomLevel?: number };
}) {
  return {
    command: DesktopCommandIds.OpenChangelog,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    updateZCodeStdioTapDevMenuState: vi.fn(),
    onDesktopZoomChanged: options?.onDesktopZoomChanged ?? vi.fn(),
    onZCodeEndpointChanged: options?.onZCodeEndpointChanged ?? vi.fn(),
    onRelaunchApp: options?.onRelaunchApp ?? vi.fn(async () => undefined),
    settingService: {
      get: vi.fn(async () => options?.settings ?? {}),
      update: vi.fn(async () => undefined),
    },
    credentialsDir: "/tmp/zcode-test",
    currentApplicationLocale: "zh-CN" as const,
  };
}
