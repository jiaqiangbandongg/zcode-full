import type {
  WebRemoteControlDeviceListView,
  WebRemoteControlEntryConnection,
  WebRemoteControlEntryOptions,
  WebRemoteControlDeviceGroup,
} from "#src/web-remote-control/contract.js";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import { parseWebRemoteControlExternalQrParams } from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type { WebOAuthProviderId } from "#src/auth/browserOAuthCredentialRepo.js";
import { groupWebRemoteControlDevices } from "#src/web-remote-control/domain/webRemoteControlDeviceGroups.js";
import {
  readKnownDevices,
  rememberKnownDevices,
} from "#src/web-remote-control/app/webRemoteControlKnownDevices.js";

export function isWebRemoteControlOAuthCallback(url: URL): boolean {
  return (
    ["/remote/v4", "/remote/v4/"].includes(url.pathname) &&
    url.searchParams.has("state") &&
    // BigModel 使用 authCode；必须先进入既有回调校验，不能落回未登录门禁。
    (url.searchParams.has("code") ||
      url.searchParams.has("authCode") ||
      url.searchParams.has("error"))
  );
}

const LAST_DEVICE_KEY = "zcode-web-remote-last-device-sid";
const LAST_DEVICE_MID_KEY = "zcode-web-remote-last-device-mid";

/**
 * 最近设备的自动落点：最近 SID 在线优先；否则同一台电脑（最近 MID）恰好一个在线 SID 时接上它。
 * 桌面重新注册会换 SID 并尽力删除旧 SID，因此最近 MID 缺失时只能从列表里旧 SID 的离线记录取。
 * 同 MID 多个在线 SID 时不猜测目标，交给用户在列表中选择。
 */
function resolveAutoConnectSid(
  records: readonly WebRemoteControlRelayV2Device[],
  groups: readonly WebRemoteControlDeviceGroup[],
  lastSid: string | null,
  lastMid: string | null,
): string | undefined {
  if (!lastSid && !lastMid) return undefined;
  const lastRecord = lastSid ? records.find((record) => record.device_sid === lastSid) : undefined;
  if (lastRecord?.online) return lastRecord.device_sid;
  const mid = lastMid || lastRecord?.device_mid;
  const connections = groups.find((group) => group.deviceMid === mid)?.onlineConnections ?? [];
  return connections.length === 1 ? connections[0]?.device_sid : undefined;
}

/** 只负责连接前的 admission；配对后的 workspace/恢复仍归既有 bootstrap。 */
export class WebRemoteControlEntry {
  private scope = new AbortController();
  private list:
    | {
        view: WebRemoteControlDeviceListView;
        unsubscribe: () => void;
        request?: Promise<void>;
        lastSid: string | null;
        lastMid: string | null;
        acceptedJwt?: string;
      }
    | undefined;

  constructor(private readonly options: WebRemoteControlEntryOptions) {}

  dispose(): void {
    this.scope.abort();
    this.list?.unsubscribe();
    this.list = undefined;
  }

  private reset(): void {
    this.dispose();
    this.scope = new AbortController();
  }

  async start(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    if (isWebRemoteControlOAuthCallback(url)) {
      this.options.onView({ kind: "callback" });
      return;
    }
    if (!this.options.auth.getZCodeJwtToken()) {
      this.options.onView({ kind: "login" });
      return;
    }
    const params = parseWebRemoteControlExternalQrParams(url.searchParams);
    if (!params) {
      this.options.onView({ kind: "failure", failure: { reason: "invalid-mobile-connection" } });
      return;
    }
    if (!params.deviceSid) {
      await this.openDevices(true);
      return;
    }
    this.connect({ ...params, deviceSid: params.deviceSid });
  }

  private async openDevices(autoConnect: boolean): Promise<void> {
    this.reset();
    let lastSid: string | null = null;
    let lastMid: string | null = null;
    try {
      if (autoConnect) {
        lastSid = this.options.storage.getItem(LAST_DEVICE_KEY);
        lastMid = this.options.storage.getItem(LAST_DEVICE_MID_KEY);
      }
    } catch {
      // iOS 私密模式等环境可能禁用存储；最近设备只是偏好，不阻断入口。
    }
    const account = this.options.auth.getActiveAccount() ?? undefined;
    this.list = {
      view: {
        kind: "devices",
        devices: [],
        loading: false,
        error: false,
        ...(account ? { account } : {}),
      },
      unsubscribe: this.options.subscribeVisible(() => {
        void this.refreshDevices();
      }),
      lastSid,
      lastMid,
    };
    await this.refreshDevices();
  }

  async refreshDevices(): Promise<void> {
    const list = this.list;
    if (!list) return;
    if (list.request) return list.request;
    const jwt = this.options.auth.getZCodeJwtToken();
    if (!jwt) return this.switchAccount();
    if (list.acceptedJwt && list.acceptedJwt !== jwt) return this.start();
    const { signal } = this.scope;
    list.view = { ...list.view, loading: true, error: false };
    this.options.onView(list.view);
    list.request = (async () => {
      try {
        const devices = await this.options.devices(jwt, signal);
        if (signal.aborted) return;
        // 账号变更后的响应不能为新账号提供设备或自动连接依据。
        if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
        list.acceptedJwt = jwt;
        // 先读缓存补全离线记录的名字/平台，再把本次在线记录写回；它们只是展示偏好，不进入 admission。
        const knownDevices = readKnownDevices(this.options.storage);
        const groups = groupWebRemoteControlDevices(devices, this.options.locale, knownDevices);
        rememberKnownDevices(this.options.storage, knownDevices, groups);
        list.view = { ...list.view, devices: groups, loading: false, error: false };
        const autoSid = resolveAutoConnectSid(devices, groups, list.lastSid, list.lastMid);
        // 自动落点只消费首次成功的列表；后续刷新不能打断用户选择。
        list.lastSid = null;
        list.lastMid = null;
        if (autoSid) this.selectDevice(autoSid);
        else this.options.onView(list.view);
      } catch (error) {
        if (signal.aborted) return;
        if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
        if (
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          await this.switchAccount();
          return;
        }
        list.view = { ...list.view, loading: false, error: true };
        this.options.onView(list.view);
      } finally {
        list.request = undefined;
      }
    })();
    return list.request;
  }

  selectDevice(sid: string): void {
    if (!this.list || this.list.view.loading || this.list.view.error) return;
    if (this.list.acceptedJwt !== this.options.auth.getZCodeJwtToken()) {
      void this.start();
      return;
    }
    const device = this.list.view.devices
      .flatMap((group) => group.onlineConnections)
      .find((item) => item.device_sid === sid);
    if (!device) return;
    const url = new URL(this.options.getHref());
    url.searchParams.set("sid", device.device_sid);
    url.searchParams.set("mid", device.device_mid);
    const name = device.meta.name?.trim();
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
    this.options.replaceHref(url.href);
    this.rememberDevice(device.device_sid, device.device_mid);
    this.connect({
      deviceSid: device.device_sid,
      deviceMid: device.device_mid,
      deviceName: name || undefined,
      appVersion: url.searchParams.get("app_version") || undefined,
    });
  }

  async chooseOtherDevice(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    for (const key of ["sid", "mid", "name", "hash", "t"]) url.searchParams.delete(key);
    this.options.replaceHref(url.href);
    await this.openDevices(false);
  }

  private rememberDevice(sid: string, mid: string | undefined): void {
    try {
      this.options.storage.setItem(LAST_DEVICE_KEY, sid);
      if (mid) this.options.storage.setItem(LAST_DEVICE_MID_KEY, mid);
    } catch {
      // 偏好持久化失败不影响连接，也不修改按 SID 隔离的业务状态。
    }
  }

  private connect(params: WebRemoteControlEntryConnection["params"]): void {
    this.reset();
    const { signal } = this.scope;
    this.options.connect({
      params,
      signal,
      getToken: (tokenSignal) => {
        const jwt = this.options.auth.getZCodeJwtToken();
        if (!jwt) return Promise.reject(new WebRemoteControlV2ConnectionError("auth-required"));
        return this.options.token(jwt, tokenSignal);
      },
      onPaired: () => {
        if (!signal.aborted) this.rememberDevice(params.deviceSid, params.deviceMid);
      },
      onFailure: (failure) => {
        if (signal.aborted) return;
        if (failure.reason === "auth-required") void this.switchAccount();
        else this.options.onView({ kind: "failure", failure });
      },
    });
  }

  startLogin(provider?: WebOAuthProviderId): void {
    this.options.auth.startLogin({
      ...this.options.loginOptions,
      ...(provider ? { provider } : {}),
      appReturnTo: this.options.getHref(),
    });
  }

  async switchAccount(): Promise<void> {
    this.reset();
    const { signal } = this.scope;
    await this.options.auth.logout();
    if (!signal.aborted) this.options.onView({ kind: "login" });
  }
}
