import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  let promptAction: "auto" | "manual" | "quit" = "quit";
  let triggerReadyToShow = true;
  let readyToShowHandler: (() => void) | undefined;
  let didFinishLoadHandler: (() => void) | undefined;
  let _didFailLoadHandler:
    | ((event: unknown, errorCode: number, errorDescription: string) => void)
    | undefined;
  let closedHandler: (() => void) | undefined;
  let pageTitleHandler:
    | ((event: { preventDefault: () => void }, title: string) => void)
    | undefined;

  const browserWindowInstance = {
    close: vi.fn(() => {
      closedHandler?.();
    }),
    emitPageTitle: (title: string) => {
      pageTitleHandler?.({ preventDefault: vi.fn() }, title);
    },
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    executeJavaScriptMock: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(async () => {
      if (triggerReadyToShow) {
        readyToShowHandler?.();
      }
      didFinishLoadHandler?.();
      pageTitleHandler?.({ preventDefault: vi.fn() }, `force-update:${promptAction}`);
    }),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "closed") {
        closedHandler = handler;
      }
    }),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === "ready-to-show") {
        readyToShowHandler = handler;
      }
    }),
    setAlwaysOnTop: vi.fn(),
    setSize: vi.fn(),
    center: vi.fn(),
    show: vi.fn(),
    webContents: {
      executeJavaScript: vi.fn((script: string) => browserWindowInstance.executeJavaScriptMock(script)),
      on: vi.fn(
        (
          event: string,
          handler: (event: { preventDefault: () => void }, title: string) => void,
        ) => {
          if (event === "page-title-updated") {
            pageTitleHandler = handler;
          }
        },
      ),
      once: vi.fn(
        (
          event: string,
          handler:
            | (() => void)
            | ((event: unknown, errorCode: number, errorDescription: string) => void),
        ) => {
          if (event === "did-finish-load") {
            didFinishLoadHandler = handler as () => void;
          }
          if (event === "did-fail-load") {
            _didFailLoadHandler = handler as (
              event: unknown,
              errorCode: number,
              errorDescription: string,
            ) => void;
          }
        },
      ),
    },
  };

  return {
    appQuitMock: vi.fn(),
    browserWindowConstructorMock: vi.fn(),
    browserWindowGetAllWindowsMock: vi.fn(() => []),
    browserWindowGetFocusedWindowMock: vi.fn(() => null),
    browserWindowInstance,
    netRequestMock: vi.fn(),
    resetPromptHandlers: () => {
      triggerReadyToShow = true;
      readyToShowHandler = undefined;
      didFinishLoadHandler = undefined;
      _didFailLoadHandler = undefined;
      closedHandler = undefined;
      pageTitleHandler = undefined;
      browserWindowInstance.executeJavaScriptMock.mockClear();
      electronMocks.netRequestMock.mockReset();
      browserWindowInstance.show.mockClear();
      browserWindowInstance.focus.mockClear();
      browserWindowInstance.close.mockClear();
      browserWindowInstance.setAlwaysOnTop.mockClear();
      browserWindowInstance.setSize.mockClear();
      browserWindowInstance.center.mockClear();
      browserWindowInstance.loadURL.mockClear();
      browserWindowInstance.webContents.executeJavaScript.mockClear();
      electronMocks.appQuitMock.mockClear();
      electronMocks.shellOpenExternalMock.mockClear();
    },
    setPromptAction: (action: "auto" | "manual" | "quit") => {
      promptAction = action;
    },
    setTriggerReadyToShow: (enabled: boolean) => {
      triggerReadyToShow = enabled;
    },
    shellOpenExternalMock: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("electron", () => {
  class BrowserWindow {
    static getFocusedWindow = electronMocks.browserWindowGetFocusedWindowMock;
    static getAllWindows = electronMocks.browserWindowGetAllWindowsMock;

    constructor(options: unknown) {
      electronMocks.browserWindowConstructorMock(options);
      return electronMocks.browserWindowInstance;
    }
  }

  return {
    BrowserWindow,
    app: {
      getAppPath: vi.fn(() => "/Applications/ZCode.app/Contents/Resources/app.asar"),
      quit: electronMocks.appQuitMock,
    },
    nativeTheme: {
      shouldUseDarkColors: false,
    },
    net: {
      request: electronMocks.netRequestMock,
    },
    shell: {
      openExternal: electronMocks.shellOpenExternalMock,
    },
  };
});

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
    // Bugfix: forceUpdateGuard 会导入 requestForceAutoUpdate，进而初始化 manifest update provider。
    // 这里补齐 Provider 命名导出，避免测试在实际强更逻辑执行前就因 mock 形状不完整失败。
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

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function getLoadedPromptHtml() {
  const loadedUrl = electronMocks.browserWindowInstance.loadURL.mock.calls.at(-1)?.[0] as
    | string
    | undefined;
  expect(loadedUrl).toBeDefined();
  const prefix = "data:text/html;charset=utf-8,";
  expect(loadedUrl?.startsWith(prefix)).toBe(true);
  return decodeURIComponent(loadedUrl?.slice(prefix.length) ?? "");
}

function mockNetResponse(options: {
  statusCode?: number;
  chunks?: Array<string | Buffer>;
  hang?: boolean;
}) {
  const request = new EventEmitter() as EventEmitter & {
    abort: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  request.abort = vi.fn(() => {
    request.emit("error", new Error("aborted"));
  });
  request.end = vi.fn(() => {
    if (options.hang) {
      return;
    }

    const response = new EventEmitter() as EventEmitter & { statusCode?: number };
    response.statusCode = options.statusCode ?? 200;
    request.emit("response", response);
    for (const chunk of options.chunks ?? []) {
      response.emit("data", chunk);
    }
    response.emit("end");
  });
  electronMocks.netRequestMock.mockReturnValue(request);
  return request;
}

describe("forceUpdateGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.resetPromptHandlers();
    electronMocks.setPromptAction("quit");
  });

  it("按当前 endpoint 拼接 client/configs 地址", async () => {
    const { resolveForceUpdateClientConfigUrl } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const url = new URL(resolveForceUpdateClientConfigUrl("https://zcode.z.ai"));

    expect(url.origin).toBe("https://zcode.z.ai");
    expect(url.pathname).toBe("/api/v1/client/configs");
    expect(url.searchParams.get("app_version")).toBeTruthy();
    expect(url.searchParams.get("platform")).toBe(`${process.platform}-${process.arch}`);
  });

  it("远端 client/configs 最低版本高于当前版本时返回强制升级要求", async () => {
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger: createLogger(),
      fetchRemoteConfig: async () => ({
        data: {
          configs: {
            forceUpdate: { minimalVersion: "999.0.0" },
          },
        },
      }),
    });

    expect(requirement?.minimalVersion).toBe("999.0.0");
  });

  it("远端 client/configs envelope code 非 0 时跳过强制升级校验", async () => {
    const logger = createLogger();
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger,
      fetchRemoteConfig: async () => ({
        code: 500,
        data: {
          configs: {
            forceUpdate: { minimalVersion: "999.0.0" },
          },
        },
      }),
    });

    expect(requirement).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[force-update] 读取远端强制升级配置失败，跳过强制升级校验",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("兼容静态 config/default.json 形态的强制升级配置", async () => {
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger: createLogger(),
      fetchRemoteConfig: async () => ({
        forceUpdate: { minimalVersion: "999.0.0" },
      }),
    });

    expect(requirement?.minimalVersion).toBe("999.0.0");
  });

  it("配置读取失败时跳过校验，预留离线进入主界面能力", async () => {
    const logger = createLogger();
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger,
      fetchRemoteConfig: async () => {
        throw new Error("offline");
      },
    });

    expect(requirement).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("远端 client/configs 非 2xx 响应时跳过校验并中止请求", async () => {
    const logger = createLogger();
    const request = mockNetResponse({ statusCode: 503, chunks: ["service unavailable"] });
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({ logger });

    expect(requirement).toBeNull();
    expect(request.abort).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "[force-update] 读取远端强制升级配置失败，跳过强制升级校验",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("远端 client/configs 响应体过大时跳过校验并中止请求", async () => {
    const logger = createLogger();
    const request = mockNetResponse({ chunks: [Buffer.alloc(1024 * 1024 + 1)] });
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({ logger });

    expect(requirement).toBeNull();
    expect(request.abort).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("远端 client/configs 超时时跳过校验并中止请求", async () => {
    vi.useFakeTimers();
    try {
      const logger = createLogger();
      const request = mockNetResponse({ hang: true });
      const { resolveDesktopForceUpdateRequirement } = await import(
        "../src/main/forceUpdateGuard.js"
      );

      const requirementPromise = resolveDesktopForceUpdateRequirement({ logger });
      await vi.advanceTimersByTimeAsync(10_000);
      const requirement = await requirementPromise;

      expect(requirement).toBeNull();
      expect(request.abort).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("命中强制升级时自动升级按钮触发窗口内更新状态并保留窗口", async () => {
    electronMocks.setPromptAction("auto");
    let onStateChange: ((state: { kind: string; progress?: string }) => void) | undefined;
    const requestAutoUpdate = vi.fn((listener?: (state: { kind: string; progress?: string }) => void) => {
      onStateChange = listener;
      listener?.({ kind: "checking" });
      return vi.fn();
    });
    const { maybeBlockStartupForForceUpdate } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const resultPromise = maybeBlockStartupForForceUpdate({
      locale: "zh-CN",
      logger: createLogger(),
      fetchRemoteConfig: async () => ({
        forceUpdate: { minimalVersion: "999.0.0" },
      }),
      requestAutoUpdate,
    });
    await vi.waitFor(() => expect(electronMocks.browserWindowConstructorMock).toHaveBeenCalled());

    expect(electronMocks.browserWindowConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        alwaysOnTop: true,
        center: true,
        focusable: true,
        frame: false,
        hasShadow: true,
        height: 256,
        minHeight: 256,
        minWidth: 480,
        paintWhenInitiallyHidden: true,
        roundedCorners: false,
        show: false,
        skipTaskbar: false,
        transparent: false,
        width: 480,
      }),
    );
    expect(electronMocks.browserWindowInstance.show).toHaveBeenCalledTimes(2);
    expect(electronMocks.browserWindowInstance.focus).toHaveBeenCalledTimes(2);
    expect(electronMocks.browserWindowInstance.setAlwaysOnTop).toHaveBeenCalledWith(
      true,
      "modal-panel",
    );
    expect(requestAutoUpdate).toHaveBeenCalledOnce();
    expect(onStateChange).toBeDefined();
    onStateChange?.({ kind: "downloading", progress: "42" });
    expect(electronMocks.browserWindowInstance.executeJavaScriptMock).toHaveBeenCalledWith(
      expect.stringContaining('"kind":"checking"'),
    );
    expect(electronMocks.browserWindowInstance.executeJavaScriptMock).toHaveBeenCalledWith(
      expect.stringContaining('"progress":"42"'),
    );
    expect(electronMocks.browserWindowInstance.close).not.toHaveBeenCalled();
    const promptHtml = getLoadedPromptHtml();
    expect(promptHtml).toContain("自动升级正在进行");
    expect(promptHtml).toContain("确认关闭");
    expect(promptHtml).toContain("继续更新");
    expect(promptHtml).toContain("showCloseConfirmation");
    expect(promptHtml).toContain("action === 'quit' || action === 'manual'");
    electronMocks.browserWindowInstance.emitPageTitle("force-update:quit");
    expect(electronMocks.browserWindowInstance.close).toHaveBeenCalledOnce();
    expect(electronMocks.shellOpenExternalMock).not.toHaveBeenCalled();
    const result = await resultPromise;
    expect(result.blocked).toBe(true);
    expect(electronMocks.appQuitMock).toHaveBeenCalledOnce();
  });

  it("ready-to-show 未触发时通过 did-finish-load 兜底显示强制升级窗口", async () => {
    electronMocks.setPromptAction("auto");
    electronMocks.setTriggerReadyToShow(false);
    const { maybeBlockStartupForForceUpdate } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const resultPromise = maybeBlockStartupForForceUpdate({
      locale: "zh-CN",
      logger: createLogger(),
      fetchRemoteConfig: async () => ({
        forceUpdate: { minimalVersion: "999.0.0" },
      }),
      requestAutoUpdate: vi.fn(() => undefined),
    });
    await vi.waitFor(() => expect(electronMocks.browserWindowInstance.show).toHaveBeenCalledOnce());

    expect(electronMocks.browserWindowInstance.focus).toHaveBeenCalledOnce();
    electronMocks.browserWindowInstance.emitPageTitle("force-update:quit");
    await resultPromise;
  });

  it("命中强制升级时手动升级按钮打开官网下载页并退出", async () => {
    electronMocks.setPromptAction("manual");
    const { maybeBlockStartupForForceUpdate } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const result = await maybeBlockStartupForForceUpdate({
      locale: "en-US",
      logger: createLogger(),
      endpointOrigin: "https://zcode.z.ai",
      fetchRemoteConfig: async () => ({
        forceUpdate: { minimalVersion: "999.0.0" },
      }),
    });

    expect(result.blocked).toBe(true);
    expect(electronMocks.shellOpenExternalMock).toHaveBeenCalledWith("https://zcode.z.ai/en");
    expect(electronMocks.appQuitMock).toHaveBeenCalled();
  });

  it("弹窗文案只包含当前版本和最低可用版本", async () => {
    const { formatForceUpdateDialogText } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const text = formatForceUpdateDialogText(
      { currentVersion: "3.1.7", minimalVersion: "4.0.0" },
      "zh-CN",
    );

    expect(text.detail).toBe("当前版本：v3.1.7\n最低可用版本：v4.0.0");
    expect(text.autoUpdateButton).toBe("自动升级");
    expect(text.manualUpdateButton).toBe("手动升级");
  });
});
