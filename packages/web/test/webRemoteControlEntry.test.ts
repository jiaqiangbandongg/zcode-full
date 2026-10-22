import { describe, expect, it, vi } from "vitest";
import {
  WebRemoteControlV2ConnectionError,
  type WebRemoteControlRelayV2Device,
} from "@zcode/shared/web-remote-relay";
import {
  WebRemoteControlEntry,
  type WebRemoteControlDeviceListAccount,
} from "#src/web-remote-control/index.js";

function setup(
  jwt: string | null = null,
  href = "https://zcode.z.ai/remote/v4?app_version=3.13.0&sid=device-1&mid=mid-1&name=Desktop",
  account: WebRemoteControlDeviceListAccount | null = null,
) {
  const auth = {
    getZCodeJwtToken: () => jwt,
    getActiveAccount: vi.fn(() => (jwt ? account : null)),
    startLogin: vi.fn(),
    logout: vi.fn(async () => {
      jwt = null;
    }),
  };
  const token = vi.fn(async () => "one-use-token");
  const connect = vi.fn();
  const onView = vi.fn();
  const devices = vi.fn<
    (jwt: string, signal: AbortSignal) => Promise<WebRemoteControlRelayV2Device[]>
  >(async () => []);
  const storage = new Map<string, string>();
  let visible: (() => void) | undefined;
  const storageAdapter = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const entry = new WebRemoteControlEntry({
    auth,
    token,
    connect,
    onView,
    getHref: () => href,
    devices,
    replaceHref: (next) => {
      href = next;
    },
    storage: storageAdapter,
    locale: "en-US",
    subscribeVisible: (listener) => {
      visible = listener;
      return () => {
        visible = undefined;
      };
    },
  });
  return {
    entry,
    auth,
    token,
    connect,
    onView,
    devices,
    storage,
    storageAdapter,
    setJwt: (value: string | null) => {
      jwt = value;
    },
    show: () => visible?.(),
    get href() {
      return href;
    },
  };
}

describe("V2 手机入口", () => {
  it("无 JWT 先登录，保留完整扫码 URL 且不建连", async () => {
    const h = setup();
    await h.entry.start();
    expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.token).not.toHaveBeenCalled();
    h.entry.startLogin();
    expect(h.auth.startLogin).toHaveBeenCalledWith({ appReturnTo: h.href });
  });
  it.each(["zai", "bigmodel"] as const)(
    "扫码登录透传所选平台 %s 并保留返回地址",
    async (provider) => {
      const h = setup();
      await h.entry.start();
      h.entry.startLogin(provider);
      expect(h.auth.startLogin).toHaveBeenCalledWith({ provider, appReturnTo: h.href });
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.token).not.toHaveBeenCalled();
    },
  );
  it.each([
    "code=code-1&state=state-1",
    "authCode=bigmodel-code&state=state-1",
    "error=access_denied&state=state-1",
  ])("回调优先于登录门禁：%s", async (query) => {
    const h = setup(null, `https://zcode.z.ai/remote/v4/?${query}`);
    await h.entry.start();
    expect(h.onView).toHaveBeenCalledWith({ kind: "callback" });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("已登录但无 SID 拉当前账号设备，空列表不建连", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    await h.entry.start();
    expect(h.onView).toHaveBeenLastCalledWith({
      kind: "devices",
      devices: [],
      loading: false,
      error: false,
    });
    expect(h.devices).toHaveBeenCalledWith("jwt", expect.any(AbortSignal));
    expect(h.token).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("有 SID 直接连接；每次请求 token 都重新读登录态", async () => {
    const h = setup("jwt");
    await h.entry.start();
    const connection = h.connect.mock.calls[0][0];
    expect(connection.params).toEqual({
      deviceSid: "device-1",
      deviceMid: "mid-1",
      deviceName: "Desktop",
      appVersion: "3.13.0",
    });
    const signal = new AbortController().signal;
    expect(await connection.getToken(signal)).toBe("one-use-token");
    expect(h.token).toHaveBeenCalledWith("jwt", signal);
    await h.auth.logout();
    await expect(connection.getToken(signal)).rejects.toMatchObject({ reason: "auth-required" });
  });

  it("401 清会话回登录；账号不匹配保留失败页直至用户切换账号", async () => {
    const h = setup("jwt");
    await h.entry.start();
    const connection = h.connect.mock.calls[0][0];
    connection.onFailure({ reason: "device-not-owned" });
    expect(h.onView).toHaveBeenLastCalledWith({
      kind: "failure",
      failure: { reason: "device-not-owned" },
    });
    expect(h.auth.logout).not.toHaveBeenCalled();
    await h.entry.switchAccount();
    expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
    h.entry.startLogin();
    expect(h.auth.startLogin).toHaveBeenLastCalledWith({ appReturnTo: h.href });
    connection.onFailure({ reason: "auth-required" });
    await Promise.resolve();
    expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
  });

  it("拒绝 V1 hash/t，不能继续尝试连接", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4?sid=device-1&hash=secret&t=1");
    await h.entry.start();
    expect(h.onView).toHaveBeenCalledWith({
      kind: "failure",
      failure: { reason: "invalid-mobile-connection" },
    });
    expect(h.connect).not.toHaveBeenCalled();
  });
});

const onlineDevice: WebRemoteControlRelayV2Device = {
  device_sid: "last-device",
  device_mid: "abcdefgh-1234",
  online: true,
  created_at: 1,
  meta: { name: "Alice’s MacBook" },
};

const singleOnlineGroup = (device: WebRemoteControlRelayV2Device) => ({
  deviceMid: device.device_mid,
  name: device.meta.name,
  onlineConnections: [device],
});

it("同一完整 MID 的 1 在线和 11 条历史离线注册只展示一个设备，连接仍选原 SID", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const offline = Array.from({ length: 11 }, (_, index) => ({
    ...onlineDevice,
    device_sid: `history-${index}`,
    online: false,
    meta: {},
  }));
  h.devices.mockResolvedValue([...offline, onlineDevice]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0].devices).toEqual([
    {
      deviceMid: onlineDevice.device_mid,
      name: "Alice’s MacBook",
      onlineConnections: [onlineDevice],
    },
  ]);
  await h.entry.refreshDevices();
  expect(h.onView.mock.lastCall[0].devices).toHaveLength(1);
  h.entry.selectDevice("history-0");
  expect(h.connect).not.toHaveBeenCalled();
  h.entry.selectDevice("last-device");
  expect(h.connect.mock.lastCall[0].params.deviceSid).toBe("last-device");
});

it("同 MID 全离线只展示一项，完整 MID 不同但前八位相同的设备不能合并", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  h.devices.mockResolvedValue([
    { ...onlineDevice, online: false, meta: {} },
    { ...onlineDevice, device_sid: "history", online: false, meta: {} },
    {
      ...onlineDevice,
      device_sid: "another",
      device_mid: "abcdefgh-5678",
      online: false,
      meta: {},
    },
  ]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0].devices).toEqual([
    { deviceMid: "abcdefgh-1234", name: undefined, onlineConnections: [] },
    { deviceMid: "abcdefgh-5678", name: undefined, onlineConnections: [] },
  ]);
  h.entry.selectDevice("last-device");
  expect(h.connect).not.toHaveBeenCalled();
});

it("多个在线 SID 保留在同一设备项内，任意连接都可被明确选择且刷新后旧连接失效", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4?app_version=3.13.0");
  const other = { ...onlineDevice, device_sid: "other", meta: { name: "ZCode Dev" } };
  h.devices.mockResolvedValue([other, onlineDevice]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0].devices).toEqual([
    {
      deviceMid: onlineDevice.device_mid,
      name: "Alice’s MacBook",
      onlineConnections: [onlineDevice, other],
    },
  ]);
  expect(h.connect).not.toHaveBeenCalled();
  h.devices.mockResolvedValue([onlineDevice, other]);
  await h.entry.refreshDevices();
  expect(h.onView.mock.lastCall[0].devices[0].onlineConnections).toEqual([onlineDevice, other]);
  h.devices.mockResolvedValue([{ ...onlineDevice, online: false, meta: {} }, other]);
  await h.entry.refreshDevices();
  h.entry.selectDevice("last-device");
  expect(h.connect).not.toHaveBeenCalled();
  h.entry.selectDevice("other");
  expect(Object.fromEntries(new URL(h.href).searchParams)).toEqual({
    app_version: "3.13.0",
    sid: "other",
    mid: onlineDevice.device_mid,
    name: "ZCode Dev",
  });
  expect(h.storage.get("zcode-web-remote-last-device-sid")).toBe("other");
  expect(h.storage.get("zcode-web-remote-last-device-mid")).toBe(onlineDevice.device_mid);
});

it("最近 SID 在线时优先连接原 SID，即使同 MID 还有其他在线连接", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const preferred = { ...onlineDevice, device_sid: "preferred", meta: { name: "ZCode Dev" } };
  h.storage.set("zcode-web-remote-last-device-sid", "preferred");
  h.devices.mockResolvedValue([onlineDevice, preferred]);
  await h.entry.start();
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.lastCall[0].params.deviceSid).toBe("preferred");
});

it("最近 SID 离线时，同一台电脑恰好一个在线连接则自动接上；MID 取自列表中的离线记录", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const preferred = { ...onlineDevice, device_sid: "preferred", online: false, meta: {} };
  h.storage.set("zcode-web-remote-last-device-sid", "preferred");
  h.devices.mockResolvedValue([onlineDevice, preferred]);
  await h.entry.start();
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.lastCall[0].params).toMatchObject({
    deviceSid: "last-device",
    deviceMid: onlineDevice.device_mid,
  });
  expect(h.storage.get("zcode-web-remote-last-device-sid")).toBe("last-device");
  expect(h.storage.get("zcode-web-remote-last-device-mid")).toBe(onlineDevice.device_mid);
});

it("最近 SID 已被删除时按记住的最近 MID 接上唯一在线连接", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  h.storage.set("zcode-web-remote-last-device-sid", "deleted-sid");
  h.storage.set("zcode-web-remote-last-device-mid", onlineDevice.device_mid);
  const otherMachine = { ...onlineDevice, device_mid: "mid-other", device_sid: "other-sid" };
  h.devices.mockResolvedValue([otherMachine, onlineDevice]);
  await h.entry.start();
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.lastCall[0].params.deviceSid).toBe("last-device");
});

it.each([
  ["同 MID 有多个在线连接", [onlineDevice, { ...onlineDevice, device_sid: "second" }]],
  ["同 MID 全离线", [{ ...onlineDevice, online: false, meta: {} }]],
  ["只有其他电脑在线", [{ ...onlineDevice, device_mid: "mid-other", device_sid: "other-sid" }]],
])("最近 SID 不在线且%s时展示列表，不猜测连接目标", async (_case, records) => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  h.storage.set("zcode-web-remote-last-device-sid", "deleted-sid");
  h.storage.set("zcode-web-remote-last-device-mid", onlineDevice.device_mid);
  h.devices.mockResolvedValue(records);
  await h.entry.start();
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.onView.mock.lastCall[0].kind).toBe("devices");
});

it("列表视图携带当前账号展示资料，刷新后保持", async () => {
  const account = { displayName: "Ada", provider: "zai" as const };
  const h = setup("jwt", "https://zcode.z.ai/remote/v4", account);
  h.devices.mockResolvedValue([{ ...onlineDevice, meta: { name: "Mac", platform: "darwin" } }]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0]).toMatchObject({
    account,
    devices: [{ deviceMid: onlineDevice.device_mid, platform: "darwin" }],
  });
  await h.entry.refreshDevices();
  expect(h.onView.mock.lastCall[0].account).toEqual(account);
});

it("无码入口自动连接当前账号在线的最近设备，并回写可恢复 URL", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4?app_version=3.13.0&name=stale");
  h.storage.set("zcode-web-remote-last-device-sid", "last-device");
  h.devices.mockResolvedValue([onlineDevice]);
  await h.entry.start();
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.calls[0][0].params).toEqual({
    deviceSid: "last-device",
    deviceMid: "abcdefgh-1234",
    deviceName: "Alice’s MacBook",
    appVersion: "3.13.0",
  });
  const url = new URL(h.href);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    sid: "last-device",
    mid: "abcdefgh-1234",
    name: "Alice’s MacBook",
    app_version: "3.13.0",
  });
});

it("最近设备离线时在线置顶按名字排序；手动/回前台刷新不自动连接，选择后只接纳一次", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4?app_version=3.13.0&name=stale");
  h.storage.set("zcode-web-remote-last-device-sid", "last-device");
  const offline = { ...onlineDevice, online: false, meta: {} };
  const beta = {
    ...onlineDevice,
    device_mid: "mid-beta",
    device_sid: "beta",
    meta: { name: "Beta" },
  };
  const alpha = {
    ...onlineDevice,
    device_mid: "mid-alpha",
    device_sid: "alpha",
    meta: { name: "Alpha" },
  };
  const unnamed = { ...onlineDevice, device_mid: "mid-unnamed", device_sid: "unnamed", meta: {} };
  h.devices.mockResolvedValue([offline, beta, unnamed, alpha]);
  await h.entry.start();
  expect(h.onView).toHaveBeenLastCalledWith({
    kind: "devices",
    devices: [
      singleOnlineGroup(alpha),
      singleOnlineGroup(beta),
      singleOnlineGroup(unnamed),
      { deviceMid: offline.device_mid, name: undefined, onlineConnections: [] },
    ],
    loading: false,
    error: false,
  });
  h.entry.selectDevice("last-device");
  expect(h.connect).not.toHaveBeenCalled();
  h.devices.mockResolvedValue([onlineDevice, unnamed]);
  await h.entry.refreshDevices();
  h.show();
  await vi.waitFor(() => expect(h.devices).toHaveBeenCalledTimes(3));
  expect(h.connect).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(h.onView).toHaveBeenLastCalledWith({
      kind: "devices",
      devices: [singleOnlineGroup(onlineDevice), singleOnlineGroup(unnamed)],
      loading: false,
      error: false,
    }),
  );
  h.entry.selectDevice("unnamed");
  h.entry.selectDevice("unnamed");
  expect(h.connect).toHaveBeenCalledOnce();
  expect(Object.fromEntries(new URL(h.href).searchParams)).toEqual({
    app_version: "3.13.0",
    sid: "unnamed",
    mid: "mid-unnamed",
  });
  expect(h.storage.get("zcode-web-remote-last-device-sid")).toBe("unnamed");
  h.show();
  expect(h.devices).toHaveBeenCalledTimes(3);
});

it("切换账号取消并发刷新，迟到旧账号列表不能覆盖登录页", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const pending = Promise.withResolvers<WebRemoteControlRelayV2Device[]>();
  h.devices.mockReturnValue(pending.promise);
  const started = h.entry.start();
  h.show();
  void h.entry.refreshDevices();
  expect(h.devices).toHaveBeenCalledOnce();
  const signal = h.devices.mock.calls[0][1];
  await h.entry.switchAccount();
  expect(signal.aborted).toBe(true);
  pending.resolve([onlineDevice]);
  await started;
  expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
  expect(h.connect).not.toHaveBeenCalled();
  h.show();
  expect(h.devices).toHaveBeenCalledOnce();
});

it("列表刷新失败显示错误且禁用旧列表，401 则回登录并保留 URL", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4?app_version=3.13.0");
  h.devices.mockResolvedValue([onlineDevice]);
  await h.entry.start();
  h.devices.mockRejectedValueOnce(new Error("network"));
  await h.entry.refreshDevices();
  expect(h.onView).toHaveBeenLastCalledWith({
    kind: "devices",
    devices: [singleOnlineGroup(onlineDevice)],
    loading: false,
    error: true,
  });
  h.entry.selectDevice("last-device");
  expect(h.connect).not.toHaveBeenCalled();
  h.devices.mockRejectedValueOnce(new WebRemoteControlV2ConnectionError("auth-required"));
  await h.entry.refreshDevices();
  expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
  expect(h.auth.logout).toHaveBeenCalledOnce();
  h.entry.startLogin();
  expect(h.auth.startLogin).toHaveBeenCalledWith({ appReturnTo: h.href });
});

it("选择其他设备释放连接、移除目标参数并跳过最近设备；旧连接事件无效", async () => {
  const h = setup("jwt");
  await h.entry.start();
  const old = h.connect.mock.calls[0][0];
  old.onPaired();
  expect(h.storage.get("zcode-web-remote-last-device-sid")).toBe("device-1");
  expect(h.storage.get("zcode-web-remote-last-device-mid")).toBe("mid-1");
  h.devices.mockResolvedValue([{ ...onlineDevice, device_sid: "device-1" }]);
  await h.entry.chooseOtherDevice();
  expect(old.signal.aborted).toBe(true);
  expect(Object.fromEntries(new URL(h.href).searchParams)).toEqual({ app_version: "3.13.0" });
  expect(h.connect).toHaveBeenCalledOnce();
  old.onFailure({ reason: "auth-required" });
  old.onPaired();
  expect(h.auth.logout).not.toHaveBeenCalled();
  expect(h.onView.mock.lastCall[0].kind).toBe("devices");
});

it("账号在列表显示后变化时，旧设备选择重新经过当前账号列表", async () => {
  const h = setup("alice", "https://zcode.z.ai/remote/v4");
  h.devices.mockResolvedValue([onlineDevice]);
  await h.entry.start();
  h.setJwt("bob");
  h.devices.mockResolvedValue([]);
  h.entry.selectDevice("last-device");
  await vi.waitFor(() =>
    expect(h.devices).toHaveBeenLastCalledWith("bob", expect.any(AbortSignal)),
  );
  expect(h.connect).not.toHaveBeenCalled();
  expect(new URL(h.href).searchParams.has("sid")).toBe(false);
});

it("存储不可用不阻断手动选择；已有 SID 业务状态保持原样", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  h.storage.set("zcode-web-remote-client-id:last-device", "existing-client");
  vi.spyOn(h.storageAdapter, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(h.storageAdapter, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  h.devices.mockResolvedValue([onlineDevice]);
  await h.entry.start();
  expect(h.onView.mock.lastCall[0].devices).toEqual([singleOnlineGroup(onlineDevice)]);
  h.entry.selectDevice("last-device");
  expect(h.connect).toHaveBeenCalledOnce();
  h.connect.mock.calls[0][0].onPaired();
  expect(h.storage.get("zcode-web-remote-client-id:last-device")).toBe("existing-client");
});

it("最近 SID 不属于当前账号时不连接；同名按 MID/SID 排序且没有轮询", async () => {
  vi.useFakeTimers();
  try {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.storage.set("zcode-web-remote-last-device-sid", "other-account-device");
    const b = { ...onlineDevice, device_mid: "mid-b" };
    const a2 = { ...onlineDevice, device_mid: "mid-a", device_sid: "sid-2" };
    const a1 = { ...a2, device_sid: "sid-1" };
    h.devices.mockResolvedValue([b, a2, a1]);
    await h.entry.start();
    expect(h.onView.mock.lastCall[0].devices).toEqual([
      { deviceMid: "mid-a", name: "Alice’s MacBook", onlineConnections: [a1, a2] },
      singleOnlineGroup(b),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.devices).toHaveBeenCalledOnce();
    expect(h.connect).not.toHaveBeenCalled();
    h.entry.dispose();
    h.show();
    expect(h.devices).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("聚合列表刷新期间拒绝所有 SID，刷新成全离线后保留记住的名字但不保留连接", async () => {
  const h = setup("jwt", "https://zcode.z.ai/remote/v4");
  const other = { ...onlineDevice, device_sid: "other" };
  h.devices.mockResolvedValue([onlineDevice, other]);
  await h.entry.start();
  const pending = Promise.withResolvers<WebRemoteControlRelayV2Device[]>();
  h.devices.mockReturnValueOnce(pending.promise);
  const refreshed = h.entry.refreshDevices();
  h.entry.selectDevice("last-device");
  h.entry.selectDevice("other");
  expect(h.connect).not.toHaveBeenCalled();
  pending.resolve([onlineDevice, other].map((device) => ({ ...device, online: false, meta: {} })));
  await refreshed;
  expect(h.onView.mock.lastCall[0].devices).toEqual([
    { deviceMid: onlineDevice.device_mid, name: "Alice’s MacBook", onlineConnections: [] },
  ]);
  h.entry.selectDevice("other");
  expect(h.connect).not.toHaveBeenCalled();
});

const DEVICE_NAMES_KEY = "zcode-web-remote-device-names";

describe("本地记住的设备名与平台", () => {
  it("在线平台写入缓存，下次该设备离线时仍显示记住的平台", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.devices.mockResolvedValue([
      { ...onlineDevice, meta: { name: "Alice’s MacBook", platform: "darwin" } },
    ]);
    await h.entry.start();
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([
      ["abcdefgh-1234", "Alice’s MacBook", "darwin"],
    ]);
    const next = setup("jwt", "https://zcode.z.ai/remote/v4");
    next.storage.set(DEVICE_NAMES_KEY, h.storage.get(DEVICE_NAMES_KEY)!);
    next.devices.mockResolvedValue([{ ...onlineDevice, online: false, meta: {} }]);
    await next.entry.start();
    expect(next.onView.mock.lastCall[0].devices).toEqual([
      {
        deviceMid: "abcdefgh-1234",
        name: "Alice’s MacBook",
        platform: "darwin",
        onlineConnections: [],
      },
    ]);
  });

  it("在线设备名按 MID 写入本地缓存；下次入口该设备离线时显示记住的名字且仍不可连接", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.devices.mockResolvedValue([onlineDevice]);
    await h.entry.start();
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([
      ["abcdefgh-1234", "Alice’s MacBook"],
    ]);
    // 模拟下次打开：新入口实例复用同一份 localStorage 内容
    const next = setup("jwt", "https://zcode.z.ai/remote/v4");
    next.storage.set(DEVICE_NAMES_KEY, h.storage.get(DEVICE_NAMES_KEY)!);
    next.devices.mockResolvedValue([
      { ...onlineDevice, device_sid: "history", online: false, meta: {} },
    ]);
    await next.entry.start();
    expect(next.onView).toHaveBeenLastCalledWith({
      kind: "devices",
      devices: [{ deviceMid: "abcdefgh-1234", name: "Alice’s MacBook", onlineConnections: [] }],
      loading: false,
      error: false,
    });
    next.entry.selectDevice("history");
    expect(next.connect).not.toHaveBeenCalled();
  });

  it("在线记录无名字时回退到记住的名字；电脑改名后上线刷新覆盖旧名字", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.storage.set(DEVICE_NAMES_KEY, JSON.stringify([["abcdefgh-1234", "Old Name"]]));
    h.devices.mockResolvedValue([{ ...onlineDevice, meta: {} }]);
    await h.entry.start();
    expect(h.onView.mock.lastCall[0].devices[0].name).toBe("Old Name");
    h.devices.mockResolvedValue([{ ...onlineDevice, meta: { name: "  New Name  " } }]);
    await h.entry.refreshDevices();
    expect(h.onView.mock.lastCall[0].devices[0].name).toBe("New Name");
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([["abcdefgh-1234", "New Name"]]);
  });

  it("离线设备按记住的名字排序，没有名字的离线设备排最后；全离线刷新不写缓存", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    const seeded = JSON.stringify([
      ["mid-b", "Beta"],
      ["mid-a", "Alpha"],
    ]);
    h.storage.set(DEVICE_NAMES_KEY, seeded);
    const offline = (mid: string) => ({
      ...onlineDevice,
      device_mid: mid,
      device_sid: `${mid}-sid`,
      online: false,
      meta: {},
    });
    h.devices.mockResolvedValue([offline("mid-c"), offline("mid-b"), offline("mid-a")]);
    await h.entry.start();
    expect(h.onView.mock.lastCall[0].devices).toEqual([
      { deviceMid: "mid-a", name: "Alpha", onlineConnections: [] },
      { deviceMid: "mid-b", name: "Beta", onlineConnections: [] },
      { deviceMid: "mid-c", name: undefined, onlineConnections: [] },
    ]);
    expect(h.storage.get(DEVICE_NAMES_KEY)).toBe(seeded);
  });

  it("缓存内容损坏按空处理，不阻断列表；刷新成功后重写为合法内容", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.storage.set(DEVICE_NAMES_KEY, "{not json");
    h.devices.mockResolvedValue([
      onlineDevice,
      { ...onlineDevice, device_mid: "mid-x", device_sid: "sid-x", online: false, meta: {} },
    ]);
    await h.entry.start();
    expect(h.onView.mock.lastCall[0].devices).toEqual([
      singleOnlineGroup(onlineDevice),
      { deviceMid: "mid-x", name: undefined, onlineConnections: [] },
    ]);
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([
      ["abcdefgh-1234", "Alice’s MacBook"],
    ]);
  });

  it("切换账号不清除设备名缓存", async () => {
    const h = setup("jwt", "https://zcode.z.ai/remote/v4");
    h.devices.mockResolvedValue([onlineDevice]);
    await h.entry.start();
    await h.entry.switchAccount();
    expect(h.onView).toHaveBeenLastCalledWith({ kind: "login" });
    expect(JSON.parse(h.storage.get(DEVICE_NAMES_KEY)!)).toEqual([
      ["abcdefgh-1234", "Alice’s MacBook"],
    ]);
  });
});
