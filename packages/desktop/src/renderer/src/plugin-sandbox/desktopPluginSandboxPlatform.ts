import { InternalChannels } from "@zcode/shared";
import type {
  PluginSandboxPlatformPort,
  PluginSandboxPortsEvent,
  PluginSandboxTransportPort,
} from "@zcode/shared/mcp-apps";

/**
 * 桌面 renderer 的插件沙箱平台端口：原生操作委托 preload 命名空间，那条 JSON-RPC 端口从 preload 经
 * window.postMessage transfer 到来（MessagePort 不能过 contextBridge，同 remoteWorkspaceServicePortBridge）。
 * 旧 preload 没有 zcodePluginSandbox 时返回 undefined，UI 按"不支持插件 UI"回退。
 */
export function createDesktopPluginSandboxPlatform(): PluginSandboxPlatformPort | undefined {
  const bridge = window.zcodePluginSandbox;
  if (!bridge) return undefined;
  return {
    supportsRetainedMove: bridge.supportsRetainedMove,
    ...(bridge.copyImage
      ? {
          copyImage: (input: import("@zcode/shared/mcp-apps").PluginSandboxCaptureRequest) =>
            bridge.copyImage!(input),
        }
      : {}),
    getOwnerWebContentsId: () => bridge.getOwnerWebContentsId(),
    disposeSandbox: (sandboxId, initId) => bridge.disposeSandbox(sandboxId, initId),
    consumeUserGesture: (sandboxId) => bridge.consumeUserGesture(sandboxId),
    onPorts(handler) {
      const listener = (event: MessageEvent) => {
        const parsed = parsePluginSandboxPortsMessage(event);
        if (parsed) handler(parsed);
      };
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
  };
}

export function parsePluginSandboxPortsMessage(event: {
  source?: unknown;
  data: unknown;
  ports: readonly MessagePort[];
}): PluginSandboxPortsEvent | null {
  if (event.source !== undefined && event.source !== window) return null;
  const data = event.data as { type?: unknown; sandboxId?: unknown; initId?: unknown };
  const port = event.ports[0];
  if (
    typeof data !== "object" ||
    data === null ||
    data.type !== InternalChannels.PluginSandboxPorts ||
    typeof data.sandboxId !== "string" ||
    typeof data.initId !== "number" ||
    !port ||
    event.ports.length !== 1
  ) {
    return null;
  }
  return {
    sandboxId: data.sandboxId,
    initId: data.initId,
    port: port as PluginSandboxTransportPort,
  };
}
