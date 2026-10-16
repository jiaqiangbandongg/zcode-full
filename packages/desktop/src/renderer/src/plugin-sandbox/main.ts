import { createPluginSandboxRelay, resolvePluginSandboxShellIdentity } from "./relay.js";

/**
 * 受信 relay shell 的 DOM 接线：监听 preload 转交的 init 帧，创建插件 iframe，
 * 只接受来自该 iframe 且 origin 为 plugin-<id> 的消息，原样转发到宿主端口；反向亦然。
 */
const root = document.getElementById("root") ?? document.body;
const errorNode = document.getElementById("error");
const identity = resolvePluginSandboxShellIdentity(window.location.href);
let frameElement: HTMLIFrameElement | null = null;

function showError(message: string): void {
  if (errorNode) {
    errorNode.textContent = message;
    errorNode.hidden = false;
  }
}

if (!identity) {
  showError(`Plugin sandbox: unexpected shell origin ${window.location.origin}`);
} else {
  const relay = createPluginSandboxRelay({
    ...identity,
    createPluginFrame(src, allow) {
      const iframe = document.createElement("iframe");
      // 规范 MUST：allow-scripts + allow-same-origin；表单交互放行 allow-forms。
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      // 资源声明的权限（camera / microphone / geolocation / clipboard-write）委托给跨源插件 iframe；
      // 真正放行还要过 main 的权限闸门（未声明拒绝、首次使用弹框）。
      if (allow) iframe.setAttribute("allow", allow);
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.title = "plugin";
      iframe.src = src;
      iframe.addEventListener("error", () =>
        console.warn(`[plugin-sandbox-shell] frame error src=${src}`),
      );
      root.appendChild(iframe);
      frameElement = iframe;
      return {
        postMessage(message, targetOrigin) {
          iframe.contentWindow?.postMessage(message, targetOrigin);
        },
        remove() {
          iframe.remove();
          if (frameElement === iframe) frameElement = null;
        },
      };
    },
    showError,
    log: (message) => console.warn(message),
  });

  window.addEventListener("message", (event) => {
    // preload 在同一 window 上 postMessage；插件 iframe 的消息 source 是它的 contentWindow。
    if (event.source === window && event.origin === window.location.origin) {
      relay.handleInit(
        event.data,
        event.ports as unknown as Parameters<typeof relay.handleInit>[1],
      );
      return;
    }
    if (
      frameElement &&
      event.source === frameElement.contentWindow &&
      event.origin === identity.pluginOrigin
    ) {
      relay.handleFrameMessage(event.data);
      return;
    }
    // 来源或 origin 不匹配的消息一律丢弃；guest console 会转到 main 日志，便于排查沙箱 origin 问题。
    console.warn(
      `[plugin-sandbox-shell] dropped message origin=${event.origin} expected=${identity.pluginOrigin} fromFrame=${String(
        Boolean(frameElement && event.source === frameElement.contentWindow),
      )}`,
    );
  });

  window.addEventListener("beforeunload", () => relay.dispose());
}
