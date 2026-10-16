import { randomUUID } from "node:crypto";
import { BrowserWindow, desktopCapturer, ipcMain, webContents } from "electron";
import {
  PlatformChannels,
  type EmbeddedBrowserPermissionDeviceOption,
  type EmbeddedBrowserPermissionResolveRequest,
} from "@zcode/shared";
import type {
  EmbeddedBrowserPermissionLogger,
  EmbeddedBrowserPermissionPromptAction,
  EmbeddedBrowserPermissionPromptRequest,
} from "./embeddedBrowserPermissionPolicy.js";

/**
 * 内置浏览器权限弹窗的 main ↔ renderer 桥：
 * - promptPermission / devicePicker / onDisplayMediaRequest 把策略模块的决策点
 *   转成 EmbeddedBrowserPermissionPrompt 事件推送到 guest 宿主窗口；
 * - renderer 的用户决策经 EmbeddedBrowserPermissionResolve 回传；
 * - 20s 无响应按 dismiss/cancel 结算（面板不可见或 agent 后台场景自然拒绝）。
 */
export interface EmbeddedBrowserPermissionUiBridge {
  promptPermission(request: EmbeddedBrowserPermissionPromptRequest): Promise<EmbeddedBrowserPermissionPromptAction>;
  devicePicker(input: {
    origin: string;
    permission: string;
    devices: EmbeddedBrowserPermissionDeviceOption[];
    hostWebContentsId?: number;
    guestWebContentsId?: number;
  }): {
    result: Promise<{ deviceId: string } | null>;
    updateDevices(devices: EmbeddedBrowserPermissionDeviceOption[]): void;
  };
  onDisplayMediaRequest(input: { origin: string }, callback: (result: unknown) => void): void;
  registerResolveListener(): void;
}

const ALLOWED_ACTIONS = new Set([
  "allow-always",
  "allow-session",
  "block-always",
  "dismiss",
  "cancel",
]);

/**
 * 模块级桥持有者（getPluginSandboxHost 同款模式）：index.ts 启动时装配，
 * desktopWindowChrome 等窗口层直接取用，避免多层 options 透传。
 */
let activeBridge: EmbeddedBrowserPermissionUiBridge | null = null;

export function setActiveEmbeddedBrowserPermissionUiBridge(
  bridge: EmbeddedBrowserPermissionUiBridge | null,
): void {
  activeBridge = bridge;
}

/** 蓝牙设备选择守卫用的设备选择器；桥未装配时返回 undefined（守卫回退为取消请求）。 */
export function getEmbeddedBrowserDevicePicker():
  | EmbeddedBrowserPermissionUiBridge["devicePicker"]
  | undefined {
  return activeBridge?.devicePicker.bind(activeBridge);
}

/** IPC 载荷的运行时校验：requestId 必须是待决请求，resolution 形状必须可识别。 */
export function parseEmbeddedBrowserPermissionResolveRequest(
  payload: unknown,
): EmbeddedBrowserPermissionResolveRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as {
    requestId?: unknown;
    resolution?: { action?: unknown; sourceId?: unknown; deviceId?: unknown };
  };
  if (typeof candidate.requestId !== "string" || !candidate.requestId) return null;
  const action = candidate.resolution?.action;
  if (typeof action !== "string") return null;
  if (action === "share-screen") {
    if (typeof candidate.resolution?.sourceId !== "string" || !candidate.resolution.sourceId) {
      return null;
    }
    return {
      requestId: candidate.requestId,
      resolution: { action, sourceId: candidate.resolution.sourceId },
    };
  }
  if (action === "select-device") {
    if (typeof candidate.resolution?.deviceId !== "string" || !candidate.resolution.deviceId) {
      return null;
    }
    return {
      requestId: candidate.requestId,
      resolution: { action, deviceId: candidate.resolution.deviceId },
    };
  }
  if (!ALLOWED_ACTIONS.has(action)) return null;
  return { requestId: candidate.requestId, resolution: { action } as { action: "allow-always" } };
}

export function createEmbeddedBrowserPermissionUiBridge(deps: {
  logger: EmbeddedBrowserPermissionLogger;
  /** 弹窗无响应结算时长；测试注入短值。 */
  promptTimeoutMs?: number;
}): EmbeddedBrowserPermissionUiBridge {
  const { logger } = deps;
  const timeoutMs = deps.promptTimeoutMs ?? 20_000;
  const pending = new Map<string, (resolution: unknown) => void>();

  const sendPrompt = (
    hostWebContentsId: number | undefined,
    event: { requestId: string; kind: "permission" | "screen-share" | "device" } & Record<string, unknown>,
  ): boolean => {
    const host =
      (hostWebContentsId !== undefined ? webContents.fromId(hostWebContentsId) : undefined) ??
      BrowserWindow.getFocusedWindow()?.webContents ??
      BrowserWindow.getAllWindows()[0]?.webContents;
    if (!host || host.isDestroyed()) {
      logger.warn("[embedded-browser-permission] prompt target window unavailable");
      return false;
    }
    host.send(PlatformChannels.EmbeddedBrowserPermissionPrompt, event);
    return true;
  };

  /** 建一个待决请求：renderer 决策经 resolver 回来，超时按 fallback 结算。 */
  const openPendingPrompt = <T>(
    hostWebContentsId: number | undefined,
    event: { requestId: string; kind: "permission" | "screen-share" | "device" } & Record<string, unknown>,
    settle: (resolution: unknown) => T,
    fallbackValue: T,
  ): Promise<T> => {
    const { requestId } = event;
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        pending.delete(requestId);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        logger.info("[embedded-browser-permission] decision=denied", {
          requestId,
          source: "prompt-timeout",
        });
        finish(fallbackValue);
      }, timeoutMs);
      pending.set(requestId, (resolution) => finish(settle(resolution)));
      if (!sendPrompt(hostWebContentsId, event)) finish(fallbackValue);
    });
  };

  return {
    promptPermission(request) {
      return openPendingPrompt(
        request.hostWebContentsId,
        {
          requestId: randomUUID(),
          kind: "permission",
          origin: request.origin,
          permission: request.permission,
          ...(request.mediaTypes ? { mediaTypes: [...request.mediaTypes] } : {}),
          ...(request.guestWebContentsId !== undefined
            ? { guestWebContentsId: request.guestWebContentsId }
            : {}),
        },
        (resolution) => {
          const action = (resolution as { action?: string })?.action;
          return (["allow-always", "allow-session", "block-always", "dismiss"] as const).includes(
            action as never,
          )
            ? (action as EmbeddedBrowserPermissionPromptAction)
            : "dismiss";
        },
        "dismiss" as const,
      );
    },

    devicePicker(input) {
      // requestId 显式生成并保留在闭包：设备发现过程中 select-* 会连续 fire，
      // 同 requestId 的后续推送被 renderer 当作列表热更新而不是新弹窗。
      const requestId = randomUUID();
      const result = openPendingPrompt(
        input.hostWebContentsId,
        {
          requestId,
          kind: "device",
          origin: input.origin,
          permission: input.permission,
          devices: input.devices,
          ...(input.guestWebContentsId !== undefined
            ? { guestWebContentsId: input.guestWebContentsId }
            : {}),
        },
        (resolution) => {
          const candidate = resolution as { action?: string; deviceId?: string };
          return candidate?.action === "select-device" && candidate.deviceId
            ? { deviceId: candidate.deviceId }
            : null;
        },
        null,
      );
      return {
        result,
        updateDevices: (devices) => {
          if (!pending.has(requestId)) return;
          sendPrompt(input.hostWebContentsId, {
            requestId,
            kind: "device",
            origin: input.origin,
            permission: input.permission,
            devices,
            ...(input.guestWebContentsId !== undefined
              ? { guestWebContentsId: input.guestWebContentsId }
              : {}),
          });
        },
      };
    },

    onDisplayMediaRequest(input, callback) {
      void desktopCapturer
        .getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } })
        .then(async (sources) => {
          const picked = await openPendingPrompt(
            undefined,
            {
              requestId: randomUUID(),
              kind: "screen-share",
              origin: input.origin,
              screens: sources.map((source) => ({
                sourceId: source.id,
                name: source.name,
                // source.id 形如 "screen:0:0" / "window:12345:0"，据此在 UI 分组展示。
                kind: source.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
                thumbnailDataUrl: `data:image/jpeg;base64,${source.thumbnail.toJPEG(60).toString("base64")}`,
              })),
            },
            (resolution) => {
              const candidate = resolution as { action?: string; sourceId?: string };
              return candidate?.action === "share-screen" ? (candidate.sourceId ?? null) : null;
            },
            null,
          );
          const source = picked ? sources.find((candidate) => candidate.id === picked) : undefined;
          invokeDisplayMediaCallback(callback, source ? { video: source } : {});
        })
        .catch((error: unknown) => {
          logger.warn("[embedded-browser-permission] screen share sources unavailable:", error);
          invokeDisplayMediaCallback(callback, {});
        });
    },

    registerResolveListener() {
      ipcMain.on(PlatformChannels.EmbeddedBrowserPermissionResolve, (_event, payload: unknown) => {
        const parsed = parseEmbeddedBrowserPermissionResolveRequest(payload);
        const resolver = parsed ? pending.get(parsed.requestId) : undefined;
        if (!parsed || !resolver) {
          logger.warn("[embedded-browser-permission] ignored malformed or unknown resolve payload");
          return;
        }
        resolver(parsed.resolution);
      });
    },
  };
}


/**
 * Electron 41 在「页面请求了 video 但回调未提供流」时会从 callback 内部同步抛
 * TypeError（用户取消共享的正常路径）；直接在 promise 链里调用会被外层 catch 误记为
 * 源获取失败并二次回调。此处隔离后不再向外传播。
 */
function invokeDisplayMediaCallback(
  callback: (result: unknown) => void,
  result: unknown,
): void {
  try {
    callback(result);
  } catch {
    // 页面侧已按取消/拒绝路径收尾，无需处理。
  }
}
