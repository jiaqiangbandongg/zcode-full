import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const guest = {
    getType: vi.fn(() => "webview"),
    getURL: vi.fn(() => "https://www.runoob.com/try/try.php"),
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
  };
  return {
    browserWindowFromId: vi.fn(),
    guest,
    nativeImageCreateFromPath: vi.fn(() => ({ isEmpty: () => false })),
    showMessageBoxSync: vi.fn(() => 1),
    webContentsFromId: vi.fn(() => guest),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    fromId: h.browserWindowFromId,
  },
  dialog: {
    showMessageBoxSync: h.showMessageBoxSync,
  },
  nativeImage: {
    createFromPath: h.nativeImageCreateFromPath,
  },
  webContents: {
    fromId: h.webContentsFromId,
  },
}));

describe("EmbeddedBrowserJavaScriptDialogController", () => {
  beforeEach(() => {
    h.browserWindowFromId.mockReset();
    h.browserWindowFromId.mockReturnValue({ isDestroyed: () => false });
    h.guest.getType.mockReturnValue("webview");
    h.guest.getURL.mockReturnValue("https://www.runoob.com/try/try.php");
    h.guest.isDestroyed.mockReturnValue(false);
    h.guest.once.mockClear();
    h.nativeImageCreateFromPath.mockClear();
    h.showMessageBoxSync.mockReset();
    h.showMessageBoxSync.mockReturnValue(1);
    h.webContentsFromId.mockReset();
    h.webContentsFromId.mockReturnValue(h.guest);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the trusted frame host and returns the confirm choice synchronously", async () => {
    const { EmbeddedBrowserJavaScriptDialogController } = await import(
      "../src/main/embeddedBrowserJavaScriptDialog.js"
    );
    const controller = new EmbeddedBrowserJavaScriptDialogController({
      iconPath: "/app/icon.png",
      getLocale: () => "en-US",
      logger: { warn: vi.fn() },
    });
    controller.bindGuest("browser:user-tab", 42, 17);

    const accepted = controller.handleDialogRequest(42, "https://www.runoob.com/frame", {
      type: "confirm",
      message: "确定要删除吗?",
    });
    expect(accepted).toEqual({ handled: true, value: true });
    expect(h.showMessageBoxSync).toHaveBeenCalledWith(
      expect.objectContaining({ isDestroyed: expect.any(Function) }),
      expect.objectContaining({
        buttons: ["Cancel", "OK"],
        cancelId: 0,
        defaultId: 1,
        detail: "确定要删除吗?",
        message: "www.runoob.com says",
        type: "question",
      }),
    );

    h.showMessageBoxSync.mockReturnValueOnce(0);
    const cancelled = controller.handleDialogRequest(42, "https://example.com/frame", {
      type: "confirm",
      message: "cancel",
    });
    expect(cancelled).toEqual({ handled: true, value: false });
    controller.dispose();
  });

  it("falls back from about:blank to the guest host and localizes alert", async () => {
    const { EmbeddedBrowserJavaScriptDialogController } = await import(
      "../src/main/embeddedBrowserJavaScriptDialog.js"
    );
    const controller = new EmbeddedBrowserJavaScriptDialogController({
      iconPath: "/app/icon.png",
      getLocale: () => "zh-CN",
      logger: { warn: vi.fn() },
    });
    controller.bindGuest("browser:user-tab", 42, 17);

    expect(
      controller.handleDialogRequest(42, "about:blank", {
        type: "alert",
        message: "提示",
      }),
    ).toEqual({ handled: true });
    expect(h.showMessageBoxSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buttons: ["确定"],
        detail: "提示",
        message: "www.runoob.com says",
        type: "info",
      }),
    );
    controller.dispose();
  });

  it("resolves blob origins and only uses a neutral source without any trusted host", async () => {
    const { resolveEmbeddedBrowserDialogSource } = await import(
      "../src/main/embeddedBrowserJavaScriptDialog.js"
    );

    expect(resolveEmbeddedBrowserDialogSource("blob:https://example.com/id")).toBe(
      "example.com says",
    );
    expect(resolveEmbeddedBrowserDialogSource("about:blank", "data:text/html,page")).toBe(
      "This page says",
    );
  });

  it("passes through to native Chromium dialogs during automation and its grace period", async () => {
    vi.useFakeTimers();
    const { EmbeddedBrowserJavaScriptDialogController } = await import(
      "../src/main/embeddedBrowserJavaScriptDialog.js"
    );
    const controller = new EmbeddedBrowserJavaScriptDialogController({
      iconPath: "/app/icon.png",
      getLocale: () => "en-US",
      logger: { warn: vi.fn() },
      automationGraceMs: 3_000,
    });
    controller.bindGuest("browser:user-tab", 42, 17);
    const payload = { type: "confirm", message: "delete" };

    const endAutomation = controller.beginAutomation(17);
    expect(controller.handleDialogRequest(42, "https://example.com", payload)).toEqual({
      handled: false,
    });
    expect(h.showMessageBoxSync).not.toHaveBeenCalled();

    endAutomation();
    vi.advanceTimersByTime(2_999);
    expect(controller.handleDialogRequest(42, "https://example.com", payload)).toEqual({
      handled: false,
    });

    vi.advanceTimersByTime(1);
    expect(controller.handleDialogRequest(42, "https://example.com", payload)).toEqual({
      handled: true,
      value: true,
    });
    expect(h.showMessageBoxSync).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("rejects browser-use-only tabs and unsupported dialog requests", async () => {
    const { EmbeddedBrowserJavaScriptDialogController } = await import(
      "../src/main/embeddedBrowserJavaScriptDialog.js"
    );
    const controller = new EmbeddedBrowserJavaScriptDialogController({
      iconPath: "/app/icon.png",
      getLocale: () => "en-US",
      logger: { warn: vi.fn() },
    });

    controller.bindGuest("iab-tab:agent", 42, 17);
    expect(
      controller.handleDialogRequest(42, "https://example.com", {
        type: "confirm",
        message: "agent",
      }),
    ).toEqual({ handled: false });

    controller.bindGuest("browser:user-tab", 42, 17);
    expect(
      controller.handleDialogRequest(42, "https://example.com", {
        type: "prompt",
        message: "name",
      }),
    ).toEqual({ handled: false });
    expect(h.showMessageBoxSync).not.toHaveBeenCalled();
    controller.dispose();
  });
});
