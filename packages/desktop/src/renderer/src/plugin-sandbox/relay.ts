/**
 * 受信 relay shell 的纯逻辑：不解析、不缓冲协议消息，只在宿主 MessagePort 与插件 iframe 之间原样转发 JSON-RPC。
 * 协议状态（握手、超时、teardown）全部在宿主 renderer 的官方 AppBridge 里；DOM 接线在 main.ts。
 */
export interface PluginSandboxRelayFrame {
  postMessage(message: unknown, targetOrigin: string): void;
  remove(): void;
}

export interface PluginSandboxRelayPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?(): void;
  close(): void;
}

export interface PluginSandboxRelay {
  /** preload 转交的 init 帧：`{ type: "init", sandboxId, initId }` + 一条端口。 */
  handleInit(data: unknown, ports: readonly PluginSandboxRelayPort[]): void;
  /** 来自插件 iframe（source / origin 已由 main.ts 校验）的消息。 */
  handleFrameMessage(data: unknown): void;
  readonly initId: number | null;
  dispose(): void;
}

/** 插件 iframe `allow` 只接受这四个 Permission Policy 特性（与 main 的权限闸门同一集合）。 */
export const PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS: readonly string[] = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-write",
];

/** 过滤 init 帧里的 allow 串：未知 token 丢弃，去重，保持原顺序。 */
export function sanitizePluginSandboxIframeAllow(value: unknown): string {
  if (typeof value !== "string") return "";
  const tokens = value
    .split(";")
    .map((token) => token.trim())
    .filter((token) => PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS.includes(token));
  return [...new Set(tokens)].join("; ");
}

export const PLUGIN_SANDBOX_SHELL_HOST_PREFIX = "shell-";
export const PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX = "plugin-";

/** 从 shell 自己的 origin（zcode-sandbox://shell-<id>）推导 sandboxId 与插件 iframe 的 origin / URL。 */
export function resolvePluginSandboxShellIdentity(origin: string): {
  sandboxId: string;
  pluginOrigin: string;
  pluginUrl: string;
} | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (!url.hostname.startsWith(PLUGIN_SANDBOX_SHELL_HOST_PREFIX)) return null;
  const sandboxId = url.pathname.split("/")[2];
  if (!sandboxId) return null;
  const appIdentity = url.hostname.slice(PLUGIN_SANDBOX_SHELL_HOST_PREFIX.length);
  if (!appIdentity || !/^[a-f0-9]{64}$/.test(appIdentity)) return null;
  const pluginOrigin = `${url.protocol}//${PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX}${appIdentity}`;
  return { sandboxId, pluginOrigin, pluginUrl: `${pluginOrigin}/instance/${sandboxId}/index.html` };
}

export function createPluginSandboxRelay(deps: {
  sandboxId: string;
  pluginOrigin: string;
  pluginUrl: string;
  /** `allow` 为空串时不设该属性。 */
  createPluginFrame(src: string, allow: string): PluginSandboxRelayFrame;
  showError(message: string): void;
  log(message: string): void;
}): PluginSandboxRelay {
  let port: PluginSandboxRelayPort | null = null;
  let frame: PluginSandboxRelayFrame | null = null;
  let initId: number | null = null;
  let disposed = false;

  return {
    get initId() {
      return initId;
    },
    handleInit(data, ports) {
      if (disposed) return;
      const init = data as {
        type?: unknown;
        sandboxId?: unknown;
        initId?: unknown;
        allow?: unknown;
      } | null;
      if (
        typeof init !== "object" ||
        init === null ||
        init.type !== "init" ||
        typeof init.sandboxId !== "string" ||
        typeof init.initId !== "number"
      ) {
        return;
      }
      if (init.sandboxId !== deps.sandboxId) {
        deps.log(
          `[plugin-sandbox-shell] init for another sandbox ${init.sandboxId}, expected ${deps.sandboxId}`,
        );
        return;
      }
      const incoming = ports[0];
      if (!incoming || ports.length !== 1) {
        deps.showError("Plugin sandbox: init without a port.");
        return;
      }
      if (port) {
        // main 只在 guest dom-ready 时发一次 init；重复 init 只可能来自串线，保留首个。
        deps.log(
          `[plugin-sandbox-shell] duplicate init ignored (initId=${init.initId}, current=${initId})`,
        );
        incoming.close();
        return;
      }
      port = incoming;
      initId = init.initId;
      frame = deps.createPluginFrame(deps.pluginUrl, sanitizePluginSandboxIframeAllow(init.allow));
      port.onmessage = (event) => {
        frame?.postMessage(event.data, deps.pluginOrigin);
      };
      port.start?.();
    },
    handleFrameMessage(data) {
      if (disposed || !port) return;
      if (typeof data !== "object" || data === null) return;
      port.postMessage(data);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port?.close();
      port = null;
      frame?.remove();
      frame = null;
    },
  };
}
