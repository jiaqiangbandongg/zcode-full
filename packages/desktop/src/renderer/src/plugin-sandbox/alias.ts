import { App, LATEST_PROTOCOL_VERSION, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { ZCODE_GLOBALS_EVENT, createPluginSandboxAliasRuntime } from "./aliasRuntime.js";
import { OPENAI_SET_GLOBALS_EVENT } from "./openaiAlias.js";

/**
 * 注入到插件 HTML 顶部的 `window.zcode` / `window.openai` 别名（以 IIFE 打包为 out/plugin-sandbox/plugin-sandbox-alias.js）。
 * 官方 `App` 上的薄封装：只与父窗口（受信 relay shell，origin 为 shell-<id>）通信；懒连接，
 * 自建官方 `App` 的页面不会因为别名多一次 ui/initialize。
 */
// 不在这里 `declare global` 扩 Window：别名脚本与宿主 renderer 共用 tsconfig，`zcode?: unknown` 会覆盖宿主对
// `window.zcode`（preload 桥）的类型。这里只用 defineProperty / `in` 检查，不需要类型声明。

const app = new App(
  { name: "zcode-alias", version: "1" },
  {},
  // 用别名的页面自己调 notifyIntrinsicHeight；自动 ResizeObserver 会与页面自建的 App 重复上报。
  { autoResize: false },
);

const runtime = createPluginSandboxAliasRuntime({
  app,
  // 只接受 relay shell（window.parent）来的消息；SDK 的 transport 以 "*" 发出，origin 由 shell 侧校验。
  transport: new PostMessageTransport(window.parent, window.parent),
  protocolVersion: LATEST_PROTOCOL_VERSION,
  onChange: (globals) => {
    window.dispatchEvent(new CustomEvent(ZCODE_GLOBALS_EVENT));
    window.dispatchEvent(new CustomEvent(OPENAI_SET_GLOBALS_EVENT, { detail: { globals } }));
  },
});

// 别名握手前就收到宿主的 JSON-RPC（响应 / 通知）= 页面自建的官方 App 已在通信，别名不再握手（见 markForeignApp）。
window.addEventListener("message", (event) => {
  if (runtime.connecting || event.source !== window.parent) return;
  const data = event.data as { jsonrpc?: unknown } | null;
  if (data && typeof data === "object" && data.jsonrpc === "2.0") runtime.markForeignApp();
});

Object.defineProperty(window, "zcode", {
  value: runtime.zcode,
  writable: false,
  configurable: false,
  enumerable: true,
});
// 页面若自带 window.openai（如页面自带的 polyfill），不覆盖。
if (!("openai" in window)) {
  Object.defineProperty(window, "openai", {
    value: runtime.openai,
    writable: false,
    configurable: false,
    enumerable: true,
  });
}
