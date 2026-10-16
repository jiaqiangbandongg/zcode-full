import type {
  McpAppCspRelaxations,
  McpAppResourceMeta,
  McpAppsDisplayMode,
  McpAppsResourcePermission,
  McpAppsToolVisibility,
  McpToolUiCsp,
  McpToolUiDescriptor,
} from "./contract.js";
import {
  MCP_APPS_CSP_RELAXATION_FLAGS,
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_DEFAULT_TOOL_VISIBILITY,
  MCP_APPS_RESOURCE_PERMISSIONS,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_UI_RESOURCE_SCHEME,
} from "./contract.js";

/**
 * 工具可见性与 UI 呈现解耦。只读 `_meta.ui.visibility`，缺省 `["model", "app"]`；
 * 没有 `ui://` 资源的纯数据工具同样按它决定进不进模型工具表，不再因为缺 resourceUri 而整体丢失。
 */
export function readMcpToolVisibility(meta: unknown): McpAppsToolVisibility[] {
  return readVisibility(asRecord(asRecord(meta)?.ui)?.visibility);
}

/**
 * 工具 `_meta` → UI 描述的归一化。纯函数。resourceUri 来源按优先级：`_meta.ui.resourceUri` →
 * 弃用扁平键 `_meta["ui/resourceUri"]`（规范 MUST 兼容）→ 兼容接口的 `openai/outputTemplate`。
 * 兼容 `openai/*` 别名；任何一项非法只丢弃该项，唯独 resourceUri 非法则整体为 null
 * （此时可见性由 readMcpToolVisibility 单独给出）。
 */
export function normalizeMcpToolUiMeta(meta: unknown): McpToolUiDescriptor | null {
  const root = asRecord(meta);
  if (!root) return null;
  const ui = asRecord(root.ui);
  const resourceUri =
    readResourceUri(ui?.resourceUri) ??
    readResourceUri(root[MCP_APPS_LEGACY_RESOURCE_URI_META_KEY]) ??
    readResourceUri(root["openai/outputTemplate"]);
  if (!resourceUri) return null;

  const descriptor: McpToolUiDescriptor = {
    resourceUri,
    visibility: readVisibility(ui?.visibility),
  };
  const preferredDisplayMode = readDisplayMode(
    asRecord(root["openai/ui"])?.preferredModelDisplayMode,
  );
  if (preferredDisplayMode) descriptor.preferredDisplayMode = preferredDisplayMode;
  const csp = readCsp(asRecord(ui?.csp), asRecord(root["openai/widgetCSP"]));
  if (csp) descriptor.csp = csp;
  const prefersBorder =
    readBoolean(ui?.prefersBorder) ?? readBoolean(root["openai/widgetPrefersBorder"]);
  if (prefersBorder !== undefined) descriptor.prefersBorder = prefersBorder;
  const surface = readSurfaceId(ui?.surface);
  if (surface) descriptor.surface = surface;
  const showInline =
    readBoolean(ui?.showInline) ?? readBoolean(root["openai/widgetShowCodexWidgetInline"]);
  if (showInline !== undefined) descriptor.showInline = showInline;
  return descriptor;
}

/**
 * `ui://` HTML 资源项自己的 `_meta`（以被选中内容项的 `_meta.ui` 为准）。
 * csp 与 prefersBorder 兼容 `openai/widgetCSP` / `openai/widgetPrefersBorder` 别名；
 * 尺寸提示只有 `openai/widgetHeightHint` / `openai/widgetMinFrameHeight`；`openai/widgetShowCodexWidgetInline` → showInline；
 * 什么都没声明返回 null。
 */
export function normalizeMcpAppResourceMeta(meta: unknown): McpAppResourceMeta | null {
  const root = asRecord(meta);
  if (!root) return null;
  const ui = asRecord(root.ui);
  const result: McpAppResourceMeta = {};
  const csp = readCsp(asRecord(ui?.csp), asRecord(root["openai/widgetCSP"]));
  if (csp) result.csp = csp;
  const prefersBorder =
    readBoolean(ui?.prefersBorder) ?? readBoolean(root["openai/widgetPrefersBorder"]);
  if (prefersBorder !== undefined) result.prefersBorder = prefersBorder;
  const heightHint = readPositiveInt(root["openai/widgetHeightHint"]);
  if (heightHint !== undefined) result.heightHint = heightHint;
  const minFrameHeight = readPositiveInt(root["openai/widgetMinFrameHeight"]);
  if (minFrameHeight !== undefined) result.minFrameHeight = minFrameHeight;
  const showInline =
    readBoolean(ui?.showInline) ?? readBoolean(root["openai/widgetShowCodexWidgetInline"]);
  if (showInline !== undefined) result.showInline = showInline;
  const cspRelaxations = normalizeMcpAppCspRelaxations(meta);
  if (cspRelaxations) result.cspRelaxations = cspRelaxations;
  const permissions = normalizeMcpAppResourcePermissions(ui?.permissions);
  if (permissions.length > 0) result.permissions = permissions;
  return Object.keys(result).length > 0 ? result : null;
}

/** `_meta.ui.permissions`：只认规范四键且值为对象（`{}`），未知键丢弃；按固定顺序返回。 */
export function normalizeMcpAppResourcePermissions(value: unknown): McpAppsResourcePermission[] {
  const root = asRecord(value);
  if (!root) return [];
  return MCP_APPS_RESOURCE_PERMISSIONS.filter((key) => asRecord(root[key]) !== null);
}

/**
 * 资源级 `_meta["zcode/csp"]`：只认 `MCP_APPS_CSP_RELAXATION_FLAGS` 里的布尔键，未知键与非布尔值丢弃；
 * 没有任何为 true 的键返回 null（false 等于不声明）。
 */
export function normalizeMcpAppCspRelaxations(meta: unknown): McpAppCspRelaxations | null {
  const root = asRecord(asRecord(meta)?.[MCP_APPS_CSP_RELAXATION_META_KEY]);
  if (!root) return null;
  const result: McpAppCspRelaxations = {};
  for (const flag of MCP_APPS_CSP_RELAXATION_FLAGS) {
    if (root[flag] === true) result[flag] = true;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** 面板 id：长度与字符集受限，非法即丢弃（工具结果退回内联卡片，不报错）。 */
export function readSurfaceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MCP_APPS_SURFACE_ID_MAX_CHARS) return undefined;
  return MCP_APPS_SURFACE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * 校验 CSP 允许列表中的单个 origin，返回归一化 origin（保留端口），非法返回 null。
 * - `https:` / `wss:`：任意 host。
 * - `http:` / `ws:`：仅当 hostname 恰为 `127.0.0.1`（openpencil H-B 回环放行），为的是插件自带的本机服务
 *   （例如插件 MCP server 进程里的 WebSocket 桥）能被沙箱页面连接。不放 `localhost`（可被 hosts 文件改写）、
 *   不放 `[::1]`（与我们 MCP 桥绑定的 127.0.0.1 不一致）、不放其他 IP。
 * - 一律不接受凭据、query、hash 与路径。
 */
export function normalizeCspOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "127.0.0.1" && (url.protocol === "http:" || url.protocol === "ws:");
  if (url.protocol !== "https:" && url.protocol !== "wss:" && !loopback) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

function readResourceUri(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith(MCP_APPS_UI_RESOURCE_SCHEME)) return null;
  if (trimmed.length > MCP_APPS_RESOURCE_URI_MAX_CHARS) return null;
  return trimmed;
}

function readVisibility(value: unknown): McpAppsToolVisibility[] {
  if (!Array.isArray(value)) return [...MCP_APPS_DEFAULT_TOOL_VISIBILITY];
  const filtered = value.filter(
    (item): item is McpAppsToolVisibility => item === "model" || item === "app",
  );
  return filtered.length > 0 ? [...new Set(filtered)] : [...MCP_APPS_DEFAULT_TOOL_VISIBILITY];
}

function readDisplayMode(value: unknown): McpAppsDisplayMode | undefined {
  return value === "inline" || value === "fullscreen" || value === "pip" ? value : undefined;
}

/** 四类域各自独立读取；`openai/widgetCSP` 同时接受 camelCase 与 snake_case。 */
function readCsp(
  modern: Record<string, unknown> | null,
  legacy: Record<string, unknown> | null,
): McpToolUiCsp | undefined {
  const pick = (camel: string, snake: string) =>
    readOriginList(modern?.[camel]) ??
    readOriginList(legacy?.[camel]) ??
    readOriginList(legacy?.[snake]);
  const connect = pick("connectDomains", "connect_domains");
  const resource = pick("resourceDomains", "resource_domains");
  const frame = pick("frameDomains", "frame_domains");
  const baseUri = pick("baseUriDomains", "base_uri_domains");
  if (!connect && !resource && !frame && !baseUri) return undefined;
  const csp: McpToolUiCsp = {};
  if (connect) csp.connectDomains = connect;
  if (resource) csp.resourceDomains = resource;
  if (frame) csp.frameDomains = frame;
  if (baseUri) csp.baseUriDomains = baseUri;
  return csp;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function readOriginList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const origins = value.map(normalizeCspOrigin).filter((item): item is string => item !== null);
  return [...new Set(origins)];
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
