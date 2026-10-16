import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";

const { buttonPropsCalls, dialogPropsCalls } = vi.hoisted(() => ({
  buttonPropsCalls: [] as Array<Record<string, unknown>>,
  dialogPropsCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/UpdateStatusDialog.js", () => ({
  UpdateStatusDialog: (props: Record<string, unknown>) => {
    dialogPropsCalls.push(props);
    return null;
  },
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => {
    buttonPropsCalls.push(props);
    return createElement("button", props, children);
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/components/ai-elements/message.js", () => ({
  MessageResponse: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  TooltipContent: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  TooltipProvider: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("lucide-react", () => ({
  ArrowDownToLine: (props: Record<string, unknown>) => createElement("svg", props),
  LoaderCircle: (props: Record<string, unknown>) => createElement("svg", props),
}));

const noopPlatform = {
  openExternal: () => undefined,
  downloadUpdate: async () => undefined,
  cancelUpdateDownload: async () => undefined,
  getAutoUpdatePreferences: async () => ({
    autoDownloadAndInstallUpdates: false,
  }),
  setAutoDownloadAndInstallUpdates: async () => undefined,
  skipUpdateVersion: async () => undefined,
  quitAndInstallUpdate: async () => undefined,
} as unknown as IPlatformService;

const noopServices = {
  settingService: {
    get: async () => ({}),
    update: async () => undefined,
  },
} as unknown as IServiceAccessor;

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

function latestDialogProps() {
  const props = dialogPropsCalls.at(-1);
  expect(props).toBeTruthy();
  return props!;
}

describe("UpdateStatusButton release notes cache", () => {
  afterEach(() => {
    vi.useRealTimers();
    buttonPropsCalls.length = 0;
    dialogPropsCalls.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("opens the dialog from the main update entry", async () => {
    const { UpdateStatusButton } = await import("@/UpdateStatusButton.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    const { PlatformProvider } = await import("@/hooks/usePlatform.js");
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: noopServices },
          createElement(
            PlatformProvider,
            { platform: noopPlatform },
            createElement(
              ZCodeIntlProvider,
              { initialLocale: "zh-CN" },
              createElement(UpdateStatusButton, {
                platform: noopPlatform,
                version: null,
                updateState: {
                  kind: "download-progress",
                  version: "3.3.3",
                  progress: "42",
                  transferredBytes: 4.2 * 1024 * 1024,
                  totalBytes: 10 * 1024 * 1024,
                } satisfies UpdateStatePayload,
              }),
            ),
          ),
        ),
      );
    });

    expect(latestDialogProps().open).toBe(false);
    const updateEntryButton = buttonPropsCalls.find(
      (props) => typeof props.className === "string" && props.className.includes("bg-success"),
    );
    expect(typeof updateEntryButton?.onClick).toBe("function");

    await act(async () => {
      (updateEntryButton!.onClick as () => void)();
    });

    expect(latestDialogProps().open).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it("opens the native update window when the desktop bridge is available", async () => {
    const { UpdateStatusButton } = await import("@/UpdateStatusButton.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    const { PlatformProvider } = await import("@/hooks/usePlatform.js");
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const root: Root = createRoot(installMinimalDom());
    const platform = {
      ...noopPlatform,
      openUpdateStatusWindow: vi.fn(async () => undefined),
    } as unknown as IPlatformService;

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: noopServices },
          createElement(
            PlatformProvider,
            { platform },
            createElement(
              ZCodeIntlProvider,
              { initialLocale: "zh-CN" },
              createElement(UpdateStatusButton, {
                platform,
                version: null,
                updateState: {
                  kind: "update-available",
                  version: "3.3.4",
                  channel: "stable",
                } satisfies UpdateStatePayload,
              }),
            ),
          ),
        ),
      );
    });

    const updateEntryButton = buttonPropsCalls.find(
      (props) => typeof props.className === "string" && props.className.includes("bg-success"),
    );
    expect(typeof updateEntryButton?.onClick).toBe("function");

    await act(async () => {
      (updateEntryButton!.onClick as () => void)();
    });

    expect(platform.openUpdateStatusWindow).toHaveBeenCalledTimes(1);
    expect(latestDialogProps().open).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it("restores hidden release notes after download finishes without notes payload", async () => {
    const { UpdateStatusButton } = await import("@/UpdateStatusButton.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    const { PlatformProvider } = await import("@/hooks/usePlatform.js");
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const root: Root = createRoot(installMinimalDom());
    const availableState = {
      kind: "update-available",
      version: "3.3.3",
      channel: "stable",
      releaseNotes: {
        version: "3.3.3",
        title: "Release v3.3.3",
        markdown: "- Visible again after download",
        releaseDate: "2026-07-09T00:00:00.000Z",
      },
    } satisfies UpdateStatePayload;

    const renderState = (updateState: UpdateStatePayload) =>
      createElement(
        ServiceProvider,
        { services: noopServices },
        createElement(
          PlatformProvider,
          { platform: noopPlatform },
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "en-US" },
            createElement(UpdateStatusButton, {
              platform: noopPlatform,
              version: null,
              updateState,
            }),
          ),
        ),
      );

    await act(async () => {
      root.render(renderState(availableState));
    });
    expect(latestDialogProps().phase).toBe("before-download");
    expect(latestDialogProps().localizedUpdateReleaseNotes).toEqual({
      markdown: "- Visible again after download",
      title: "Release v3.3.3",
    });
    expect(latestDialogProps().releaseDateLabel).toBe("July 9, 2026");

    await act(async () => {
      root.render(
        renderState({
          kind: "download-progress",
          version: "3.3.3",
          progress: "42",
          channel: "stable",
        } satisfies UpdateStatePayload),
      );
    });
    expect(latestDialogProps().phase).toBe("downloading");
    expect(latestDialogProps().localizedUpdateReleaseNotes).toBeNull();

    await act(async () => {
      root.render(
        renderState({
          kind: "update-downloaded",
          version: "3.3.3",
          channel: "stable",
        } satisfies UpdateStatePayload),
      );
    });

    expect(latestDialogProps().phase).toBe("downloaded");
    expect(latestDialogProps().localizedUpdateReleaseNotes).toEqual({
      markdown: "- Visible again after download",
      title: "Release v3.3.3",
    });
    expect(latestDialogProps().releaseDateLabel).toBe("July 9, 2026");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the dialog mounted during transient states after starting download", async () => {
    const { UpdateStatusButton } = await import("@/UpdateStatusButton.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    const { PlatformProvider } = await import("@/hooks/usePlatform.js");
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const root: Root = createRoot(installMinimalDom());
    const platform = {
      ...noopPlatform,
      downloadUpdate: vi.fn(async () => undefined),
    } as unknown as IPlatformService;

    const renderState = (updateState: UpdateStatePayload) =>
      createElement(
        ServiceProvider,
        { services: noopServices },
        createElement(
          PlatformProvider,
          { platform },
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(UpdateStatusButton, {
              platform,
              version: null,
              updateState,
            }),
          ),
        ),
      );

    await act(async () => {
      root.render(
        renderState({
          kind: "update-available",
          version: "3.3.3",
          channel: "stable",
        } satisfies UpdateStatePayload),
      );
    });

    const updateEntryButton = buttonPropsCalls.find(
      (props) => typeof props.className === "string" && props.className.includes("bg-success"),
    );
    await act(async () => {
      (updateEntryButton!.onClick as () => void)();
    });
    expect(latestDialogProps().open).toBe(true);

    await act(async () => {
      await (latestDialogProps().onDownloadUpdate as () => Promise<void>)();
    });
    expect(latestDialogProps().phase).toBe("before-download");
    expect(latestDialogProps().isUpdateActionPending).toBe(true);
    expect(latestDialogProps().progressLabel).toBeNull();

    await act(async () => {
      root.render(renderState({ kind: "checking", enabled: true } satisfies UpdateStatePayload));
    });

    // Bugfix: downloadUpdate() 只是命令 ACK。命中本地已下载缓存时 main 会直接广播
    // update-downloaded，所以 progress 到达前不能乐观切到“下载中”，但也不能卸载弹窗。
    expect(platform.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(latestDialogProps().open).toBe(true);
    expect(latestDialogProps().phase).toBe("before-download");
    expect(latestDialogProps().displayVersion).toBe("3.3.3");

    await act(async () => {
      root.render(
        renderState({
          kind: "update-downloaded",
          version: "3.3.3",
          channel: "stable",
        } satisfies UpdateStatePayload),
      );
    });

    expect(latestDialogProps().phase).toBe("downloaded");
    expect(latestDialogProps().displayVersion).toBe("3.3.3");

    act(() => {
      root.unmount();
    });
  });

  it("persists auto download preference and starts downloading the current available update", async () => {
    const { UpdateStatusButton } = await import("@/UpdateStatusButton.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    const { PlatformProvider } = await import("@/hooks/usePlatform.js");
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const root: Root = createRoot(installMinimalDom());
    const platform = {
      ...noopPlatform,
      downloadUpdate: vi.fn(async () => undefined),
      setAutoDownloadAndInstallUpdates: vi.fn(async () => undefined),
    } as unknown as IPlatformService;

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: noopServices },
          createElement(
            PlatformProvider,
            { platform },
            createElement(
              ZCodeIntlProvider,
              { initialLocale: "zh-CN" },
              createElement(UpdateStatusButton, {
                platform,
                version: null,
                updateState: {
                  kind: "update-available",
                  version: "3.3.4",
                  channel: "stable",
                } satisfies UpdateStatePayload,
              }),
            ),
          ),
        ),
      );
    });

    await act(async () => {
      await (
        latestDialogProps().onAutoDownloadAndInstallUpdatesChange as (
          enabled: boolean,
        ) => Promise<void>
      )(true);
    });

    expect(platform.setAutoDownloadAndInstallUpdates).toHaveBeenCalledWith(true);
    expect(platform.downloadUpdate).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("asks for confirmation before restart when desktop tasks are running", async () => {
    vi.useFakeTimers();
    const { UpdateStatusButton } = await import("@/UpdateStatusButton.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    const { PlatformProvider } = await import("@/hooks/usePlatform.js");
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const { useConfirmDialogStore } = await import("@/store/confirmDialogStore.js");
    const root: Root = createRoot(installMinimalDom());
    const platform = {
      ...noopPlatform,
      getDesktopSessionActivity: vi.fn(async () => ({
        runningAgentSessionCount: 1,
      })),
      quitAndInstallUpdate: vi.fn(async () => undefined),
    } as unknown as IPlatformService;

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: noopServices },
          createElement(
            PlatformProvider,
            { platform },
            createElement(
              ZCodeIntlProvider,
              { initialLocale: "zh-CN" },
              createElement(UpdateStatusButton, {
                platform,
                version: null,
                updateState: {
                  kind: "update-downloaded",
                  version: "3.3.4",
                  channel: "stable",
                } satisfies UpdateStatePayload,
              }),
            ),
          ),
        ),
      );
    });

    let restartPromise: Promise<void>;
    await act(async () => {
      restartPromise = (latestDialogProps().onRestartUpdate as () => Promise<void>)();
      await Promise.resolve();
    });

    expect(useConfirmDialogStore.getState().pendingRequest?.description).toBe(
      "应用将退出并重启以完成更新，进行中的任务会中断。",
    );
    expect(platform.quitAndInstallUpdate).not.toHaveBeenCalled();

    await act(async () => {
      useConfirmDialogStore.getState().settleConfirmation(true);
      await restartPromise!;
    });

    expect(platform.quitAndInstallUpdate).toHaveBeenCalledTimes(1);
    expect(latestDialogProps().isUpdateActionPending).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    // Bugfix:更新交接可能超过旧的 5 秒 ACK 窗口；成功路径必须保持禁用直到应用退出。
    expect(latestDialogProps().isUpdateActionPending).toBe(true);

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: noopServices },
          createElement(
            PlatformProvider,
            { platform },
            createElement(
              ZCodeIntlProvider,
              { initialLocale: "zh-CN" },
              createElement(UpdateStatusButton, {
                platform,
                version: null,
                updateState: {
                  kind: "update-available",
                  version: "3.3.4",
                  channel: "stable",
                } satisfies UpdateStatePayload,
              }),
            ),
          ),
        ),
      );
    });

    expect(latestDialogProps().isUpdateActionPending).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it("releases restart pending when the install IPC rejects", async () => {
    const { UpdateStatusButton } = await import("@/UpdateStatusButton.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    const { PlatformProvider } = await import("@/hooks/usePlatform.js");
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const root: Root = createRoot(installMinimalDom());
    const installError = new Error("prepare quit and install failed");
    const platform = {
      ...noopPlatform,
      quitAndInstallUpdate: vi.fn(async () => {
        throw installError;
      }),
    } as unknown as IPlatformService;

    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: noopServices },
          createElement(
            PlatformProvider,
            { platform },
            createElement(
              ZCodeIntlProvider,
              { initialLocale: "zh-CN" },
              createElement(UpdateStatusButton, {
                platform,
                version: null,
                updateState: {
                  kind: "update-downloaded",
                  version: "3.3.4",
                  channel: "stable",
                } satisfies UpdateStatePayload,
              }),
            ),
          ),
        ),
      );
    });

    let caughtError: unknown;
    await act(async () => {
      try {
        await (latestDialogProps().onRestartUpdate as () => Promise<void>)();
      } catch (error) {
        caughtError = error;
      }
    });

    expect(caughtError).toBe(installError);
    expect(latestDialogProps().isUpdateActionPending).toBe(false);

    act(() => {
      root.unmount();
    });
  });
});
