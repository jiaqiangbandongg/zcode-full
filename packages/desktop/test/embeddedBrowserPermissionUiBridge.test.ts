import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const resolveListeners: Array<(event: unknown, payload: unknown) => void> = [];
const sentPrompts: Array<{ hostWebContentsId: number | undefined; event: Record<string, unknown> }> =
  [];

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      if (channel === "zcode:embedded-browser-permission-resolve") {
        resolveListeners.push(listener);
      }
    },
  },
  webContents: {
    fromId: (id: number) => {
      const exists = sentPrompts.some((entry) => entry.hostWebContentsId === id);
      return exists
        ? { isDestroyed: () => false, send: (channel: string, event: unknown) => sentPrompts.push({ hostWebContentsId: id, event: event as Record<string, unknown> }) }
        : null;
    },
  },
  BrowserWindow: {
    getFocusedWindow: () => ({
      webContents: {
        id: 100,
        isDestroyed: () => false,
        send: (_channel: string, event: unknown) =>
          sentPrompts.push({ hostWebContentsId: 100, event: event as Record<string, unknown> }),
      },
    }),
    getAllWindows: () => [],
  },
  desktopCapturer: {
    getSources: async () => [
      {
        id: "screen:1",
        name: "Entire Screen",
        thumbnail: { toJPEG: () => Buffer.from("jpeg-bytes") },
      },
      { id: "window:2", name: "Doc — Preview", thumbnail: { toJPEG: () => Buffer.from("jpeg2") } },
    ],
  },
}));

const {
  createEmbeddedBrowserPermissionUiBridge,
  parseEmbeddedBrowserPermissionResolveRequest,
} = await import("../src/main/embeddedBrowserPermissionUiBridge.js");
const { createEmbeddedBrowserSitePermissionStore } = await import(
  "../src/main/embeddedBrowserSitePermissionStore.js"
);

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

/** 模拟 renderer 对最近一个推送的 prompt 做出决策。 */
function resolveLastPrompt(resolution: unknown): void {
  const last = sentPrompts.at(-1);
  expect(last).toBeDefined();
  const requestId = (last!.event as { requestId: string }).requestId;
  for (const listener of resolveListeners) {
    listener({}, { requestId, resolution });
  }
}

beforeEach(() => {
  sentPrompts.length = 0;
  resolveListeners.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseEmbeddedBrowserPermissionResolveRequest", () => {
  it("接受合法决策并规范化", () => {
    expect(parseEmbeddedBrowserPermissionResolveRequest({
      requestId: "r1",
      resolution: { action: "allow-always" },
    })).toEqual({ requestId: "r1", resolution: { action: "allow-always" } });
    expect(parseEmbeddedBrowserPermissionResolveRequest({
      requestId: "r2",
      resolution: { action: "share-screen", sourceId: "screen:1" },
    })).toEqual({ requestId: "r2", resolution: { action: "share-screen", sourceId: "screen:1" } });
    expect(parseEmbeddedBrowserPermissionResolveRequest({
      requestId: "r3",
      resolution: { action: "select-device", deviceId: "dev-1" },
    })).toEqual({ requestId: "r3", resolution: { action: "select-device", deviceId: "dev-1" } });
  });

  it.each([
    null,
    {},
    { requestId: 42 },
    { requestId: "r", resolution: null },
    { requestId: "r", resolution: { action: "unexpected" } },
    { requestId: "r", resolution: { action: "share-screen" } },
    { requestId: "r", resolution: { action: "share-screen", sourceId: "" } },
    { requestId: "r", resolution: { action: "select-device", deviceId: 7 } },
  ])("拒绝畸形载荷 %s", (payload) => {
    expect(parseEmbeddedBrowserPermissionResolveRequest(payload)).toBeNull();
  });
});

describe("createEmbeddedBrowserPermissionUiBridge", () => {
  it("promptPermission 推送 permission 事件并按 renderer 决策结算", async () => {
    const bridge = createEmbeddedBrowserPermissionUiBridge({ logger: createLogger() });
    bridge.registerResolveListener();

    const pending = bridge.promptPermission({
      origin: "https://example.com",
      permission: "media",
      mediaTypes: ["video"],
      guestWebContentsId: 42,
    });
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(1));
    expect(sentPrompts[0]!.event).toMatchObject({
      kind: "permission",
      origin: "https://example.com",
      permission: "media",
      mediaTypes: ["video"],
      guestWebContentsId: 42,
    });

    resolveLastPrompt({ action: "allow-session" });
    await expect(pending).resolves.toBe("allow-session");
  });

  it("promptPermission 超时按 dismiss 结算（面板不可见/agent 后台场景）", async () => {
    vi.useFakeTimers();
    try {
      const bridge = createEmbeddedBrowserPermissionUiBridge({
        logger: createLogger(),
        promptTimeoutMs: 20,
      });
      const pending = bridge.promptPermission({
        origin: "https://example.com",
        permission: "geolocation",
      });
      const assertion = expect(pending).resolves.toBe("dismiss");
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("devicePicker 推送设备列表，select-device 回传 deviceId，cancel 回传 null", async () => {
    const bridge = createEmbeddedBrowserPermissionUiBridge({ logger: createLogger() });
    bridge.registerResolveListener();

    const picker = bridge.devicePicker({
      origin: "https://example.com",
      permission: "select-hid-device",
      devices: [{ deviceId: "dev-1", name: "Ledger" }],
    });
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(1));
    expect(sentPrompts[0]!.event).toMatchObject({
      kind: "device",
      permission: "select-hid-device",
      devices: [{ deviceId: "dev-1", name: "Ledger" }],
    });

    resolveLastPrompt({ action: "select-device", deviceId: "dev-1" });
    await expect(picker.result).resolves.toEqual({ deviceId: "dev-1" });

    const second = bridge.devicePicker({
      origin: "https://example.com",
      permission: "select-usb-device",
      devices: [{ deviceId: "dev-2" }],
    });
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(2));
    resolveLastPrompt({ action: "cancel" });
    await expect(second.result).resolves.toBeNull();
  });

  it("updateDevices 以同 requestId 重推事件（renderer 据此热更新列表）", async () => {
    const bridge = createEmbeddedBrowserPermissionUiBridge({ logger: createLogger() });

    const picker = bridge.devicePicker({
      origin: "https://example.com",
      permission: "select-bluetooth-device",
      devices: [],
    });
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(1));
    const firstRequestId = (sentPrompts[0]!.event as { requestId: string }).requestId;

    picker.updateDevices([{ deviceId: "bt-1", name: "Headphones" }]);
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(2));
    expect(sentPrompts[1]!.event).toMatchObject({
      requestId: firstRequestId,
      kind: "device",
      devices: [{ deviceId: "bt-1", name: "Headphones" }],
    });

    // 结算后不再推送更新
    for (const listener of resolveListeners) listener({}, { requestId: firstRequestId, resolution: { action: "cancel" } });
    await expect(picker.result).resolves.toBeNull();
    picker.updateDevices([{ deviceId: "bt-2" }]);
    expect(sentPrompts).toHaveLength(2);
  });

  it("onDisplayMediaRequest 推送源列表（含 JPEG 缩略 dataURL），选中后回调对应 source", async () => {
    const bridge = createEmbeddedBrowserPermissionUiBridge({ logger: createLogger() });
    bridge.registerResolveListener();

    const callback = vi.fn();
    bridge.onDisplayMediaRequest({ origin: "https://example.com" }, callback);
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(1));
    expect(sentPrompts[0]!.event).toMatchObject({ kind: "screen-share" });
    const screens = (sentPrompts[0]!.event as {
      screens: Array<{ thumbnailDataUrl: string; kind: string }>;
    }).screens;
    expect(screens[0]!.thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    // 源类型按 desktopCapturer id 前缀区分，供 UI 分组
    expect(screens.map((screen) => screen.kind)).toEqual(["screen", "window"]);

    resolveLastPrompt({ action: "share-screen", sourceId: "window:2" });
    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith({
        video: expect.objectContaining({ id: "window:2" }),
      }),
    );
  });

  it("onDisplayMediaRequest 取消时回空调用方（页面拿 NotAllowedError）", async () => {
    const bridge = createEmbeddedBrowserPermissionUiBridge({ logger: createLogger() });
    bridge.registerResolveListener();

    const callback = vi.fn();
    bridge.onDisplayMediaRequest({ origin: "https://example.com" }, callback);
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(1));
    resolveLastPrompt({ action: "cancel" });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
  });

  it("未知 requestId 的 resolve 载荷被忽略（防伪造回放）", async () => {
    const bridge = createEmbeddedBrowserPermissionUiBridge({ logger: createLogger() });
    const logger = createLogger();
    const guardedBridge = createEmbeddedBrowserPermissionUiBridge({ logger });
    guardedBridge.registerResolveListener();
    void bridge;

    for (const listener of resolveListeners) {
      listener({}, { requestId: "not-exist", resolution: { action: "allow-always" } });
    }
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ignored malformed or unknown resolve payload"),
    );
  });
});

describe("createEmbeddedBrowserSitePermissionStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zcode-site-permissions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("空文件/不存在按空记录加载；persist 后可读回", async () => {
    const store = createEmbeddedBrowserSitePermissionStore(join(dir, "site-permissions.json"));
    await expect(store.load()).resolves.toEqual({});

    await store.persist({
      "https://example.com": { media: "allow", geolocation: "deny" },
    });
    await expect(store.load()).resolves.toEqual({
      "https://example.com": { media: "allow", geolocation: "deny" },
    });
  });

  it("损坏 JSON 按空记录加载（fail-open 到每次询问，不错误放行）", async () => {
    const path = join(dir, "site-permissions.json");
    await writeFile(path, "{ not json", "utf8");
    const store = createEmbeddedBrowserSitePermissionStore(path);
    await expect(store.load()).resolves.toEqual({});
  });

  it("非法状态值被过滤，只保留 allow/deny", async () => {
    const path = join(dir, "site-permissions.json");
    await writeFile(
      path,
      JSON.stringify({
        "https://good.com": { media: "allow", midi: "ask", notifications: 1 },
        "https://bad.com": "allow",
      }),
      "utf8",
    );
    const store = createEmbeddedBrowserSitePermissionStore(path);
    await expect(store.load()).resolves.toEqual({
      "https://good.com": { media: "allow" },
    });
  });

  it("persist 原子写：失败时不残留 tmp 文件", async () => {
    const path = join(dir, "sub", "site-permissions.json");
    const store = createEmbeddedBrowserSitePermissionStore(path);
    await store.persist({ "https://example.com": { media: "allow" } });
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toEqual({ "https://example.com": { media: "allow" } });
  });
});
