import type { WebContents } from "electron";
import type { EmbeddedBrowserPermissionDeviceOption } from "@zcode/shared";
import {
  EMBEDDED_BROWSER_PERMISSION_LOG_TAG as LOG_TAG,
  originFromUrl,
  type EmbeddedBrowserDevicePickerSession,
} from "./embeddedBrowserPermissionPolicy.js";
import { readDeviceOptions } from "./embeddedBrowserDeviceOptions.js";

/**
 * 蓝牙设备选择事件挂在 guest 的 WebContents 而非 Session 上（Electron 41 API 分布），
 * 需要在 did-attach-webview 的 browser guest 分支逐个安装；空字符串取消请求。
 * log 参数接收宿主可用的日志函数（windowChrome 的 logger 只有 warn，也用 warn 落这条轨迹）。
 * options.devicePicker 注入后走设备选择弹窗；缺省取消请求（阻断 Electron 默认静默授权）。
 */
export function installEmbeddedBrowserBluetoothDeviceGuard(
  guestWebContents: Pick<WebContents, "getURL" | "id" | "on">,
  log: (...args: unknown[]) => void = console.info,
  options: {
    devicePicker?: (input: {
      origin: string;
      permission: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      hostWebContentsId?: number;
      guestWebContentsId?: number;
    }) => EmbeddedBrowserDevicePickerSession;
    hostWebContentsId?: number;
  } = {},
): void {
  // 蓝牙扫描期间 Chromium 会连续多次 fire select-bluetooth-device（渐进发现设备），
  // 同一请求在 callback 结算前只开一个弹窗，后续 fire 热更新设备列表。
  let session: EmbeddedBrowserDevicePickerSession | null = null;
  guestWebContents.on(
    "select-bluetooth-device",
    (event: unknown, devices: unknown, callback: (deviceId: string) => void) => {
      // 与 hid/usb/serial 一致：阻止默认取消，等待用户选择（Chromium 默认行为
      // 是事件 fire 后立即以「未选择」终止页面请求）。
      (event as { preventDefault?: () => void }).preventDefault?.();
      if (!options.devicePicker) {
        log(`${LOG_TAG} decision=denied`, {
          permission: "select-bluetooth-device",
          source: "device-picker",
        });
        callback("");
        return;
      }
      // event.sender 在 webview guest 上拿不到可靠 URL（实测 origin=unknown），改用 guest 自身。
      const origin = originFromUrl(guestWebContents.getURL());
      const deviceOptions = readDeviceOptions(devices);
      if (session) {
        log(`${LOG_TAG} device list updated`, {
          permission: "select-bluetooth-device",
          origin,
          deviceCount: deviceOptions.length,
        });
        session.updateDevices(deviceOptions);
        return;
      }
      try {
        session = options.devicePicker({
          origin,
          permission: "select-bluetooth-device",
          devices: deviceOptions,
          ...(options.hostWebContentsId !== undefined
            ? { hostWebContentsId: options.hostWebContentsId }
            : {}),
          guestWebContentsId: guestWebContents.id,
        });
      } catch (error) {
        log(`${LOG_TAG} decision=denied`, {
          permission: "select-bluetooth-device",
          origin,
          source: "device-picker",
          error: String(error),
        });
        callback("");
        return;
      }
      log(`${LOG_TAG} device picker opened`, {
        permission: "select-bluetooth-device",
        origin,
        deviceCount: deviceOptions.length,
      });
      void session.result.then(
        (picked) => {
          session = null;
          log(`${LOG_TAG} decision=${picked ? "granted" : "denied"}`, {
            permission: "select-bluetooth-device",
            origin,
            source: "device-picker",
          });
          callback(picked?.deviceId ?? "");
        },
        (error: unknown) => {
          session = null;
          log(`${LOG_TAG} decision=denied`, {
            permission: "select-bluetooth-device",
            origin,
            source: "device-picker",
            error: String(error),
          });
          callback("");
        },
      );
    },
  );
}
