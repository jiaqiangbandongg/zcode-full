import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

const h = vi.hoisted(() => ({
  executeInMainWorld: vi.fn(),
  exposeInMainWorld: vi.fn(),
  sendSync: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    executeInMainWorld: h.executeInMainWorld,
    exposeInMainWorld: h.exposeInMainWorld,
  },
  ipcRenderer: {
    sendSync: h.sendSync,
  },
}));

async function installPreloadBridge() {
  await import("../src/preload/embeddedBrowserJavaScriptDialog.js");
  const [bridgeKey, bridge] = h.exposeInMainWorld.mock.calls[0] as [
    string,
    { show: (type: "alert" | "confirm", message: string) => unknown },
  ];
  const execution = h.executeInMainWorld.mock.calls[0]?.[0] as {
    func: (key: string) => void;
    args: [string];
  };
  return { bridge, bridgeKey, execution };
}

/** 第二个主世界注入：Notification.permission 状态 override。 */
async function installNotificationOverride(): Promise<() => void> {
  await import("../src/preload/embeddedBrowserJavaScriptDialog.js");
  const execution = h.executeInMainWorld.mock.calls[1]?.[0] as {
    func: () => void;
    args: [];
  };
  return execution.func;
}

describe("embedded browser JavaScript Dialog preload", () => {
  beforeEach(() => {
    vi.resetModules();
    h.executeInMainWorld.mockReset();
    h.exposeInMainWorld.mockReset();
    h.sendSync.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Notification.permission 状态 override", () => {
    // node 测试环境没有 Notification 全局，构造一个可 override 的替身。
    const stubNotificationGlobal = () => {
      vi.stubGlobal(
        "Notification",
        class Notification {
          static get permission(): NotificationPermission {
            return "denied";
          }
          static requestPermission(): Promise<NotificationPermission> {
            return Promise.resolve("denied");
          }
        },
      );
    };

    it("初始为 default（不误导为 denied），requestPermission 结果回写状态", async () => {
      stubNotificationGlobal();
      const install = await installNotificationOverride();

      const requestMock = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
      Object.defineProperty(Notification, "requestPermission", {
        value: requestMock,
        configurable: true,
        writable: true,
      });

      install();
      expect(Notification.permission).toBe("default");

      await Notification.requestPermission();
      expect(Notification.permission).toBe("granted");
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("denied 结果同样回写；旧回调签名仍被调用", async () => {
      stubNotificationGlobal();
      const install = await installNotificationOverride();

      const requestMock = vi.fn(() => Promise.resolve("denied" as NotificationPermission));
      Object.defineProperty(Notification, "requestPermission", {
        value: requestMock,
        configurable: true,
        writable: true,
      });

      install();
      const legacyCallback = vi.fn();
      await Notification.requestPermission(legacyCallback);
      expect(Notification.permission).toBe("denied");
      expect(legacyCallback).toHaveBeenCalledWith("denied");
    });
  });

  it("returns the main-process choice without invoking Chromium's native dialog", async () => {
    h.sendSync.mockReturnValue({ handled: true, value: false });
    const { bridge, bridgeKey, execution } = await installPreloadBridge();
    const nativeAlert = vi.fn();
    const nativeConfirm = vi.fn(() => true);
    const pageWindow = { alert: nativeAlert, confirm: nativeConfirm } as unknown as Window;
    Object.assign(pageWindow, { [bridgeKey]: bridge });
    vi.stubGlobal("window", pageWindow);

    execution.func(...execution.args);
    expect(window.confirm("delete")).toBe(false);
    window.alert("notice");

    expect(h.sendSync).toHaveBeenNthCalledWith(
      1,
      PlatformChannels.EmbeddedBrowserJavaScriptDialog,
      { type: "confirm", message: "delete" },
    );
    expect(h.sendSync).toHaveBeenNthCalledWith(
      2,
      PlatformChannels.EmbeddedBrowserJavaScriptDialog,
      { type: "alert", message: "notice" },
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(nativeAlert).not.toHaveBeenCalled();
  });

  it("calls the original API when main requests automation passthrough", async () => {
    h.sendSync.mockReturnValue({ handled: false });
    const { bridge, bridgeKey, execution } = await installPreloadBridge();
    const nativeAlert = vi.fn();
    const nativeConfirm = vi.fn(() => true);
    const pageWindow = { alert: nativeAlert, confirm: nativeConfirm } as unknown as Window;
    Object.assign(pageWindow, { [bridgeKey]: bridge });
    vi.stubGlobal("window", pageWindow);

    execution.func(...execution.args);
    expect(window.confirm("automation")).toBe(true);
    window.alert("automation-alert");

    expect(nativeConfirm).toHaveBeenCalledWith("automation");
    expect(nativeAlert).toHaveBeenCalledWith("automation-alert");
  });

  it("installs the same wrapper in an inherited same-origin blank iframe", async () => {
    h.sendSync.mockReturnValue({ handled: true, value: false });
    const { bridge, bridgeKey, execution } = await installPreloadBridge();
    const childNativeAlert = vi.fn();
    const childNativeConfirm = vi.fn(() => true);
    const childWindow = {
      alert: childNativeAlert,
      confirm: childNativeConfirm,
      document: { querySelectorAll: vi.fn(() => []) },
    } as unknown as Window;
    const frame = {
      addEventListener: vi.fn(),
      contentWindow: childWindow,
    } as unknown as HTMLIFrameElement;
    const observe = vi.fn();
    const pageWindow = {
      alert: vi.fn(),
      confirm: vi.fn(() => true),
      document: {
        documentElement: {},
        querySelectorAll: vi.fn(() => [frame]),
      },
      MutationObserver: class {
        observe = observe;
      },
    } as unknown as Window;
    Object.assign(pageWindow, { [bridgeKey]: bridge });
    vi.stubGlobal("window", pageWindow);

    execution.func(...execution.args);

    expect(childWindow.confirm("iframe-confirm")).toBe(false);
    expect(childNativeConfirm).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(
      pageWindow.document.documentElement,
      expect.objectContaining({ childList: true, subtree: true }),
    );
  });
});
