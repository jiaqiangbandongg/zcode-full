/**
 * MCP Apps 宿主侧契约的第二半：ui/download-file 项、tool-input / tool-result 载荷、宿主提供的 titleBar 与样式变量。
 * hostInfo / hostCapabilities / hostContext 直接用官方 SDK 的 `McpUiHostCapabilities` / `McpUiHostContext`，不再重复定义。
 */

/**
 * `ui/download-file { contents }` 的一项——MCP 标准的 EmbeddedResource（内联 text / blob）
 * 或 ResourceLink（只有 uri，宿主经同插件 server `resources/read` 取内容）。
 */
export type McpAppsDownloadFileItem =
  | {
      type: "resource";
      resource: { uri: string; name?: string; mimeType?: string; text?: string; blob?: string };
    }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };
/** 单次 ui/download-file 的项数上限与单个文件解码后上限（与桌面 saveFile 的 50 MiB 同值）。 */
export const MCP_APPS_DOWNLOAD_FILE_MAX_ITEMS = 16;
export const MCP_APPS_DOWNLOAD_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** MCP 内容块（text / image / resource…）；宿主只透传，不解释非 text 块。 */
export type McpAppsContentBlock = Record<string, unknown>;

/** `ui/notifications/tool-input` 与 `tool-result` 的载荷（与官方 SDK 通知参数同形）。 */
export interface McpAppsToolInputPayload {
  arguments?: Record<string, unknown>;
}
export interface McpAppsToolResultPayload {
  content?: McpAppsContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** 宿主画在页面视口上方的面板头部；只在 fullscreen 给出（hostContext 允许附加键）。 */
export interface McpAppsHostTitleBar {
  height: number;
  leftInset: number;
  viewportLeftInset: number;
}
/** MCP Apps 标准样式变量（键名见官方 `McpUiStyleVariableKey`），值是页面可直接使用的 CSS 文本。 */
export type McpAppsStyleVariables = Record<string, string>;
