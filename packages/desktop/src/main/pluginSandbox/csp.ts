import type {
  McpAppCspRelaxations,
  McpAppsResourcePermission,
  McpToolUiCsp,
} from "@zcode/shared/mcp-apps";
import { normalizeCspOrigin } from "@zcode/shared/mcp-apps";
import { buildPluginSandboxShellUrl } from "./contract.js";

/**
 * App iframe 的 CSP：缺省严格按 MCP Apps 规范块（`default-src 'none'; script-src 'self' 'unsafe-inline'; …`），
 * 四类域只放行资源 `_meta.ui.csp` 声明的 origin（规范 MUST NOT 放行未声明域）。
 * inline script / style 必须放行——MCP Apps 的 HTML 资源普遍内联脚本，隔离边界是独立 partition + 独立 origin +
 * iframe sandbox，而不是禁止内联。
 *
 * 与规范缺省的差异只有非域类来源：`script-src` 加 `blob: data:`（单文件打包器把 worker / 动态 import 的 chunk
 * 内联成 data: URL，官方 pdf-server 示例的 pdf.js worker 即如此；已有 'unsafe-inline' 时这不增加任何能力，
 * 官方参考宿主 basic-host 同样放行）、`blob:`（canvas 导出 / worker）、`font-src 'self' data:`（规范缺省没有
 * font-src，按 default-src 'none' 连内嵌字体也拦）。`'unsafe-eval'` / `'wasm-unsafe-eval'` 不缺省放行：需要
 * eval / WebAssembly 的资源（如 OpenPencil 的 kiwi schema 编译与 CanvasKit）在资源 `_meta["zcode/csp"]` 里声明。
 */
export function buildPluginSandboxCsp(input: {
  csp?: McpToolUiCsp;
  cspRelaxations?: McpAppCspRelaxations;
  sandboxId: string;
  appIdentity: string;
}): string {
  const resource = normalizeOrigins(input.csp?.resourceDomains);
  const connect = normalizeOrigins(input.csp?.connectDomains);
  const frame = normalizeOrigins(input.csp?.frameDomains);
  const baseUri = normalizeOrigins(input.csp?.baseUriDomains);
  if (!PLUGIN_SANDBOX_CSP_HOST_SAFE_ID.test(input.sandboxId)) {
    // 见 registry createId 注释：非法字符会让 frame-ancestors 静默变成 'none'，这里直接拒绝而不是产出坏头。
    throw new Error(`plugin sandbox id is not CSP host-safe: ${input.sandboxId}`);
  }
  const shellUrl = new URL(buildPluginSandboxShellUrl(input.sandboxId, input.appIdentity));
  const shellOrigin = `${shellUrl.protocol}//${shellUrl.host}`;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "blob:",
    "data:",
    ...(input.cspRelaxations?.unsafeEval ? ["'unsafe-eval'"] : []),
    ...(input.cspRelaxations?.wasmUnsafeEval ? ["'wasm-unsafe-eval'"] : []),
    ...resource,
  ];
  return [
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${["'self'", "'unsafe-inline'", ...resource].join(" ")}`,
    `img-src ${["'self'", "data:", "blob:", ...resource].join(" ")}`,
    `media-src ${["'self'", "data:", "blob:", ...resource].join(" ")}`,
    `font-src ${["'self'", "data:", ...resource].join(" ")}`,
    `connect-src ${connect.length > 0 ? connect.join(" ") : "'none'"}`,
    `frame-src ${frame.length > 0 ? frame.join(" ") : "'none'"}`,
    `base-uri ${["'self'", ...baseUri].join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    `frame-ancestors ${shellOrigin}`,
    "form-action 'none'",
  ].join("; ");
}

/** CSP host-source 的 host 字符集（ALPHA / DIGIT / "-"）。 */
export const PLUGIN_SANDBOX_CSP_HOST_SAFE_ID = /^[A-Za-z0-9-]+$/;

/** 受信 shell 只加载打包资源，不联网。 */
export const PLUGIN_SANDBOX_SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-src zcode-sandbox:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join("; ");

export const PLUGIN_SANDBOX_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "display-capture=()",
  "payment=()",
  "usb=()",
  "clipboard-read=()",
].join(", ");

/**
 * 按资源声明放宽 Permissions-Policy：shell 文档对声明的特性用 `*`（它只嵌本沙箱的插件 iframe，
 * 自定义 scheme 的 origin 串 Chromium 不一定接受），插件文档用 `(self)`；未声明的一律 `()`。
 */
export function buildPluginSandboxPermissionsPolicy(
  permissions: readonly McpAppsResourcePermission[] | undefined,
  document: "shell" | "plugin",
): string {
  const granted = new Set(permissions ?? []);
  const allow = document === "shell" ? "*" : "(self)";
  return [
    `camera=${granted.has("camera") ? allow : "()"}`,
    `microphone=${granted.has("microphone") ? allow : "()"}`,
    `geolocation=${granted.has("geolocation") ? allow : "()"}`,
    "display-capture=()",
    "payment=()",
    "usb=()",
    "clipboard-read=()",
  ].join(", ");
}

function normalizeOrigins(list: string[] | undefined): string[] {
  if (!list) return [];
  const origins = list
    .map(normalizeCspOrigin)
    .filter((origin): origin is string => origin !== null);
  return [...new Set(origins)];
}
