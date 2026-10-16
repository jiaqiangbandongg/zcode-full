import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyEmbeddedBrowserPermissionPolicy,
  type EmbeddedBrowserPermissionPromptRequest,
  type EmbeddedBrowserPermissionSession,
  type EmbeddedBrowserSitePermissionRecord,
  type EmbeddedBrowserSitePermissionStore,
} from "../src/main/embeddedBrowserPermissionPolicy.js";
import { resetEmbeddedBrowserSitePermissionsForTest } from "../src/main/embeddedBrowserSitePermissions.js";
import { installEmbeddedBrowserBluetoothDeviceGuard } from "../src/main/embeddedBrowserBluetoothGuard.js";

interface CapturedRequestHandlers {
  request:
    | ((
        webContents: { getURL(): string },
        permission: string,
        callback: (granted: boolean) => void,
        details: { requestingUrl?: string; mediaTypes?: string[] },
      ) => void)
    | null;
  check:
    | ((
        webContents: { getURL(): string } | null,
        permission: string,
        requestingOrigin: string,
      ) => boolean)
    | null;
  device: ((details: { origin?: string; device?: { deviceId?: string } }) => boolean) | null;
  displayMedia: ((request: unknown, callback: (result: unknown) => void) => void) | null;
}

interface FakeSessionHelpers {
  handlers: CapturedRequestHandlers;
  emit: (event: string, ...args: unknown[]) => void;
}

function createFakeSession(): EmbeddedBrowserPermissionSession & FakeSessionHelpers {
  const handlers: CapturedRequestHandlers = {
    request: null,
    check: null,
    device: null,
    displayMedia: null,
  };
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const fake = {
    handlers,
    setPermissionRequestHandler: (handler: unknown) => {
      handlers.request = handler as CapturedRequestHandlers["request"];
    },
    setPermissionCheckHandler: (handler: unknown) => {
      handlers.check = handler as CapturedRequestHandlers["check"];
    },
    setDevicePermissionHandler: (handler: unknown) => {
      handlers.device = handler as CapturedRequestHandlers["device"];
    },
    setDisplayMediaRequestHandler: (handler: unknown) => {
      handlers.displayMedia = handler as CapturedRequestHandlers["displayMedia"];
    },
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return fake as EmbeddedBrowserPermissionSession & FakeSessionHelpers;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createInMemoryStore(initial: EmbeddedBrowserSitePermissionRecord = {}) {
  const record: EmbeddedBrowserSitePermissionRecord = structuredClone(initial);
  const store: EmbeddedBrowserSitePermissionStore & {
    record: EmbeddedBrowserSitePermissionRecord;
  } = {
    record,
    load: async () => structuredClone(record),
    persist: async (next) => {
      Object.keys(record).forEach((key) => delete record[key]);
      Object.assign(record, structuredClone(next));
    },
  };
  return store;
}

/** 驱动一次 permission request，返回 callback 收到的 granted 值。 */
function driveRequest(
  session: EmbeddedBrowserPermissionSession & FakeSessionHelpers,
  permission: string,
  details: { requestingUrl?: string; mediaTypes?: string[] } = {},
): Promise<boolean> {
  const handler = session.handlers.request;
  if (!handler) throw new Error("request handler not registered");
  return new Promise((resolve) => {
    handler(
      {
        getURL: () => details.requestingUrl ?? "https://example.com/page",
        // 模拟 webview guest：自身 id 42，宿主 renderer id 3。
        id: 42,
        hostWebContents: { id: 3 },
      },
      permission,
      resolve,
      details,
    );
  });
}

const GUEST_URL = "https://example.com/page";
const GUEST_ORIGIN = "https://example.com";

let session: ReturnType<typeof createFakeSession>;
let logger: ReturnType<typeof createLogger>;

beforeEach(() => {
  session = createFakeSession();
  logger = createLogger();
  resetEmbeddedBrowserSitePermissionsForTest();
});

describe("applyEmbeddedBrowserPermissionPolicy 注册", () => {
  it("注册全部权限 handler 与 select-*/displayMedia 监听", async () => {
    await applyEmbeddedBrowserPermissionPolicy(session, { logger });

    expect(session.handlers.request).toBeTypeOf("function");
    expect(session.handlers.check).toBeTypeOf("function");
    expect(session.handlers.device).toBeTypeOf("function");
    expect(session.handlers.displayMedia).toBeTypeOf("function");
    expect(session.on).toHaveBeenCalledWith("select-hid-device", expect.any(Function));
    expect(session.on).toHaveBeenCalledWith("select-usb-device", expect.any(Function));
    expect(session.on).toHaveBeenCalledWith("select-serial-port", expect.any(Function));
    // select-bluetooth-device 挂在 guest WebContents 上，由
    // installEmbeddedBrowserBluetoothDeviceGuard 在 did-attach-webview 安装。
  });
});

describe("静默放行白名单", () => {
  it.each([
    "clipboard-sanitized-write",
    "fullscreen",
    "pointerLock",
    "mediaKeySystem",
  ])("%s 放行且打 allowlist 日志", async (permission) => {
    await applyEmbeddedBrowserPermissionPolicy(session, { logger });

    await expect(driveRequest(session, permission, { requestingUrl: GUEST_URL })).resolves.toBe(
      true,
    );
    expect(session.handlers.check!(null, permission, GUEST_ORIGIN)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("decision=granted"),
      expect.objectContaining({ permission, source: "allowlist" }),
    );
  });
});

describe("弹窗级敏感权限", () => {
  it("无记录且未接入弹窗时默认拒绝（安全闭环）", async () => {
    await applyEmbeddedBrowserPermissionPolicy(session, { logger });

    await expect(driveRequest(session, "media", { requestingUrl: GUEST_URL })).resolves.toBe(
      false,
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("decision=denied"),
      expect.objectContaining({ permission: "media", source: "default-deny" }),
    );
  });

  it("持久记录 allow 时静默放行，deny 时静默拒绝且不弹窗", async () => {
    const store = createInMemoryStore({
      [GUEST_ORIGIN]: { media: "allow", geolocation: "deny" },
    });
    const prompt = vi.fn();
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt, store });

    await expect(driveRequest(session, "media", { requestingUrl: GUEST_URL })).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permission: "media", source: "site-setting" }),
    );

    await expect(driveRequest(session, "geolocation", { requestingUrl: GUEST_URL })).resolves.toBe(
      false,
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it("check handler 与持久记录一致：allow → true，deny/无记录 → false", async () => {
    const store = createInMemoryStore({ [GUEST_ORIGIN]: { media: "allow" } });
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, store });

    expect(session.handlers.check!(null, "media", GUEST_ORIGIN)).toBe(true);
    expect(session.handlers.check!(null, "geolocation", GUEST_ORIGIN)).toBe(false);
    expect(session.handlers.check!(null, "clipboard-read", GUEST_ORIGIN)).toBe(false);
  });

  it.each([
    ["allow-always", true, "site-setting"],
    ["allow-session", true, "session-allow"],
    ["block-always", false, "site-setting"],
  ] as const)(
    "弹窗动作 %s → granted=%s，二次请求命中 %s 且不再弹窗",
    async (action, granted, secondSource) => {
      const store = createInMemoryStore();
      const prompt = vi.fn(async () => action);
      await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt, store });

      await expect(driveRequest(session, "clipboard-read", { requestingUrl: GUEST_URL })).resolves
        .toBe(granted);
      expect(prompt).toHaveBeenCalledTimes(1);

      await expect(driveRequest(session, "clipboard-read", { requestingUrl: GUEST_URL })).resolves
        .toBe(granted);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ permission: "clipboard-read", source: secondSource }),
      );

      if (action === "allow-always") {
        expect(store.record[GUEST_ORIGIN]?.["clipboard-read"]).toBe("allow");
      }
      if (action === "block-always") {
        expect(store.record[GUEST_ORIGIN]?.["clipboard-read"]).toBe("deny");
      }
    },
  );

  it("dismiss（✕/超时）不记忆：本次拒绝，下次再弹", async () => {
    const store = createInMemoryStore();
    const prompt = vi.fn(async () => "dismiss" as const);
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt, store });

    await expect(driveRequest(session, "clipboard-read", { requestingUrl: GUEST_URL })).resolves.toBe(
      false,
    );
    await expect(driveRequest(session, "clipboard-read", { requestingUrl: GUEST_URL })).resolves.toBe(
      false,
    );
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(store.record[GUEST_ORIGIN]).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permission: "clipboard-read", source: "user-prompt" }),
    );
  });

  it("allow-session 按 origin 隔离：不同站点各自弹窗、各自记忆", async () => {
    const prompt = vi.fn(async () => "allow-session" as const);
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt });

    await expect(driveRequest(session, "media", { requestingUrl: GUEST_URL })).resolves.toBe(true);
    await expect(
      driveRequest(session, "media", { requestingUrl: "https://other.com/page" }),
    ).resolves.toBe(true);
    // 两个 origin 各自弹窗：example.com 的运行期同意没有喂给 other.com
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0][0].origin).toBe(GUEST_ORIGIN);
    expect(prompt.mock.calls[1][0].origin).toBe("https://other.com");
    // 各自记忆后二次请求都不再弹窗
    await expect(driveRequest(session, "media", { requestingUrl: GUEST_URL })).resolves.toBe(true);
    await expect(
      driveRequest(session, "media", { requestingUrl: "https://other.com/page" }),
    ).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("同 origin+权限并发请求只弹一个弹窗", async () => {
    let resolvePrompt: (action: "allow-always") => void = () => undefined;
    const prompt = vi.fn(
      () =>
        new Promise<"allow-always">((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt });

    const first = driveRequest(session, "media", { requestingUrl: GUEST_URL });
    const second = driveRequest(session, "media", { requestingUrl: GUEST_URL });
    resolvePrompt("allow-always");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("弹窗请求携带 mediaTypes，用于 UI 标明摄像头/麦克风", async () => {
    const prompt = vi.fn(async () => "dismiss" as const);
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt });

    await driveRequest(session, "media", {
      requestingUrl: GUEST_URL,
      mediaTypes: ["video"],
    });
    const request: EmbeddedBrowserPermissionPromptRequest = prompt.mock.calls[0][0];
    expect(request.origin).toBe(GUEST_ORIGIN);
    expect(request.permission).toBe("media");
    expect(request.mediaTypes).toEqual(["video"]);
    // 弹窗按宿主路由窗口、按 guest 归属 tab
    expect(request.hostWebContentsId).toBe(3);
    expect(request.guestWebContentsId).toBe(42);
  });

  it("弹窗 promise 异常时拒绝并打 warn", async () => {
    const prompt = vi.fn(async () => {
      throw new Error("renderer gone");
    });
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt });

    await expect(driveRequest(session, "media", { requestingUrl: GUEST_URL })).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("fail-closed 拒绝", () => {
  it.each(["openExternal", "unknown", "deprecated-sync-clipboard-read", "brand-new-permission"])(
    "%s 一律拒绝并打 warn 日志",
    async (permission) => {
      await applyEmbeddedBrowserPermissionPolicy(session, { logger });

      await expect(driveRequest(session, permission, { requestingUrl: GUEST_URL })).resolves.toBe(
        false,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("decision=denied"),
        expect.objectContaining({ permission, source: "default-deny" }),
      );
      expect(session.handlers.check!(null, permission, GUEST_ORIGIN)).toBe(false);
    },
  );
});

describe("设备与屏幕共享", () => {
  it("setDevicePermissionHandler 恒 true：放行到 select-* chooser（实测 false 会拦死 requestDevice）", async () => {
    await applyEmbeddedBrowserPermissionPolicy(session, { logger });

    expect(
      session.handlers.device!({ origin: GUEST_ORIGIN, device: { deviceId: "dev-1" } }),
    ).toBe(true);
    expect(session.handlers.device!({ origin: "unknown", device: undefined })).toBe(true);
  });

  it("check handler 对设备类权限（usb/hid/serial）放行到 chooser（实测 false 会在 check 层拦死 requestDevice）", async () => {
    await applyEmbeddedBrowserPermissionPolicy(session, { logger });

    expect(session.handlers.check!(null, "usb", GUEST_ORIGIN)).toBe(true);
    expect(session.handlers.check!(null, "hid", GUEST_ORIGIN)).toBe(true);
    expect(session.handlers.check!(null, "serial", GUEST_ORIGIN)).toBe(true);
    // 其余未识别权限仍 fail-closed
    expect(session.handlers.check!(null, "unknown", GUEST_ORIGIN)).toBe(false);
  });

  it.each([
    ["select-hid-device", undefined],
    ["select-usb-device", undefined],
    ["select-serial-port", ""],
  ])("%s 未接入选择器前取消请求（阻断静默授权第一个设备）", async (event, cancelArg) => {
    await applyEmbeddedBrowserPermissionPolicy(session, { logger });

    const callback = vi.fn();
    const webContentsStub = { getURL: () => GUEST_URL, id: 7, hostWebContents: { id: 3 } };
    if (event === "select-serial-port") {
      session.emit(event, { preventDefault: vi.fn() }, [{ portId: "port-1", portName: "COM1" }], webContentsStub, callback);
    } else {
      session.emit(event, { preventDefault: vi.fn() }, { deviceList: [{ deviceId: "dev-1" }] }, callback);
    }
    expect(callback).toHaveBeenCalledWith(cancelArg);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("decision=denied"),
      expect.objectContaining({ permission: event, source: "device-picker" }),
    );
  });

  it("设备选择器选中后回调 deviceId", async () => {
    const devicePicker = vi.fn(() => ({
      result: Promise.resolve({ deviceId: "dev-9" }),
      updateDevices: vi.fn(),
    }));
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, devicePicker });

    const callback = vi.fn();
    session.emit("select-hid-device", { preventDefault: vi.fn() }, { deviceList: [{ deviceId: "dev-9" }] }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith("dev-9"));
    expect(devicePicker).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "select-hid-device", origin: "unknown" }),
    );
  });

  it("设备选择器取消（null）时按取消语义回调", async () => {
    const devicePicker = vi.fn(() => ({
      result: Promise.resolve(null),
      updateDevices: vi.fn(),
    }));
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, devicePicker });

    const callback = vi.fn();
    session.emit("select-usb-device", { preventDefault: vi.fn() }, { deviceList: [{ deviceId: "dev-1" }] }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(undefined));
  });

  it("同权限选择器打开期间，后续 select 事件只热更新列表不新开", async () => {
    let resolvePicker: (value: { deviceId: string } | null) => void = () => undefined;
    const updateDevices = vi.fn();
    const devicePicker = vi.fn(() => ({
      result: new Promise<{ deviceId: string } | null>((resolve) => {
        resolvePicker = resolve;
      }),
      updateDevices,
    }));
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, devicePicker });

    const firstCallback = vi.fn();
    session.emit("select-hid-device", {}, { deviceList: [{ deviceId: "dev-1" }] }, firstCallback);
    await vi.waitFor(() => expect(devicePicker).toHaveBeenCalledTimes(1));

    // 蓝牙/USB 扫描的后续 fire：只更新列表，不开新选择器、不动首个 callback
    const secondCallback = vi.fn();
    session.emit(
      "select-hid-device",
      { preventDefault: vi.fn() },
      { deviceList: [{ deviceId: "dev-1" }, { deviceId: "dev-2" }] },
      secondCallback,
    );
    expect(devicePicker).toHaveBeenCalledTimes(1);
    expect(updateDevices).toHaveBeenCalledWith([
      { deviceId: "dev-1" },
      { deviceId: "dev-2" },
    ]);
    expect(secondCallback).not.toHaveBeenCalled();

    resolvePicker({ deviceId: "dev-2" });
    await vi.waitFor(() => expect(firstCallback).toHaveBeenCalledWith("dev-2"));
    // 结算后可以开新的选择器
    const thirdCallback = vi.fn();
    session.emit("select-hid-device", { preventDefault: vi.fn() }, { deviceList: [{ deviceId: "dev-3" }] }, thirdCallback);
    await vi.waitFor(() => expect(devicePicker).toHaveBeenCalledTimes(2));
  });

  it("displayMedia 转发给 onDisplayMediaRequest，回调结果透传", async () => {
    const onDisplayMediaRequest = vi.fn(
      (_input: { origin: string }, callback: (result: unknown) => void) => {
        callback({ video: { id: "screen:1" } });
      },
    );
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, onDisplayMediaRequest });

    const callback = vi.fn();
    session.handlers.displayMedia!(
      { frame: { url: GUEST_URL }, videoRequested: true },
      callback,
    );
    expect(onDisplayMediaRequest).toHaveBeenCalledWith(
      { origin: GUEST_ORIGIN },
      expect.any(Function),
    );
    expect(callback).toHaveBeenCalledWith({ video: { id: "screen:1" } });
  });

  it("select-bluetooth-device 挂在 guest WebContents 上：安装守卫后空串取消请求", async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const guestWebContents = {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const bucket = listeners.get(event) ?? [];
        bucket.push(listener);
        listeners.set(event, bucket);
      },
    };
    installEmbeddedBrowserBluetoothDeviceGuard(guestWebContents, logger.info);

    const callback = vi.fn();
    for (const listener of listeners.get("select-bluetooth-device") ?? []) {
      listener({}, [{ deviceId: "bt-1" }], callback);
    }
    expect(callback).toHaveBeenCalledWith("");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("decision=denied"),
      expect.objectContaining({ permission: "select-bluetooth-device", source: "device-picker" }),
    );
  });

  it("setDisplayMediaRequestHandler 未接入源选择器前一律拒绝", async () => {
    await applyEmbeddedBrowserPermissionPolicy(session, { logger });

    const callback = vi.fn();
    session.handlers.displayMedia!({ frame: null, videoRequested: true }, callback);
    expect(callback).toHaveBeenCalledWith({});
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("decision=denied"),
      expect.objectContaining({ permission: "display-capture", source: "default-deny" }),
    );
  });
});

describe("持久化 store 集成", () => {
  it("apply 时加载持久记录，写入时同步到 store", async () => {
    const store = createInMemoryStore({ "https://allowed.com": { notifications: "allow" } });
    const prompt = vi.fn(async () => "block-always" as const);
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt, store });

    expect(
      session.handlers.check!(null, "notifications", "https://allowed.com"),
    ).toBe(true);

    await expect(
      driveRequest(session, "notifications", { requestingUrl: "https://allowed.com/page" }),
    ).resolves.toBe(true);

    await expect(driveRequest(session, "midi", { requestingUrl: GUEST_URL })).resolves.toBe(false);
    expect(store.record[GUEST_ORIGIN]?.["midi"]).toBe("deny");
  });

  it("store persist 失败不影响内存决策，仅打 warn", async () => {
    const store: EmbeddedBrowserSitePermissionStore = {
      load: async () => ({}),
      persist: async () => {
        throw new Error("disk full");
      },
    };
    const prompt = vi.fn(async () => "allow-always" as const);
    await applyEmbeddedBrowserPermissionPolicy(session, { logger, prompt, store });

    await expect(driveRequest(session, "midi", { requestingUrl: GUEST_URL })).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    // 内存记录仍生效：二次请求不再弹窗
    await expect(driveRequest(session, "midi", { requestingUrl: GUEST_URL })).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
