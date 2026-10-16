import { z } from "zod";
import {
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_WIDGET_META_MAX_BYTES,
} from "./contract.js";

/**
 * 以下 schema 是 mcp-apps-protocol 的运行时校验面：只覆盖 ZCode 自己的投影 / 元数据形状。
 * 页面 ↔ 宿主的 `ui/*` 参数由官方 SDK（`McpUi*Schema`）校验，这里不重复。类型见 contract.ts。
 */

export const mcpAppsDisplayModeSchema = z.enum(["inline", "fullscreen", "pip"]);
export const mcpAppsToolVisibilitySchema = z.enum(["model", "app"]);
/** 面板 id。 */
export const mcpAppsSurfaceIdSchema = z
  .string()
  .min(1)
  .max(MCP_APPS_SURFACE_ID_MAX_CHARS)
  .regex(MCP_APPS_SURFACE_ID_PATTERN);

export const mcpToolUiCspSchema = z
  .object({
    connectDomains: z.array(z.string().min(1).max(512)).optional(),
    resourceDomains: z.array(z.string().min(1).max(512)).optional(),
    frameDomains: z.array(z.string().min(1).max(512)).optional(),
    baseUriDomains: z.array(z.string().min(1).max(512)).optional(),
  })
  .strict();

/** 资源级 `_meta["zcode/csp"]` 归一化后的形状（只有为 true 的键）。 */
export const mcpAppCspRelaxationsSchema = z
  .object({ unsafeEval: z.boolean().optional(), wasmUnsafeEval: z.boolean().optional() })
  .strict();

export const mcpToolUiDescriptorSchema = z
  .object({
    resourceUri: z.string().min(1).max(MCP_APPS_RESOURCE_URI_MAX_CHARS),
    visibility: z.array(mcpAppsToolVisibilitySchema).optional(),
    preferredDisplayMode: mcpAppsDisplayModeSchema.optional(),
    csp: mcpToolUiCspSchema.optional(),
    prefersBorder: z.boolean().optional(),
    surface: mcpAppsSurfaceIdSchema.optional(),
    showInline: z.boolean().optional(),
  })
  .strict();

/**
 * `display.ui`：agent 投影到 ToolCallRow.display 的插件 UI 元数据。
 * contracts 与 zcode-protocol-v4 两处 strict schema 都从这里复用，避免三份手写不同步。
 */
export const mcpToolDisplayUiSchema = z
  .object({
    pluginId: z.string().min(1).max(256),
    resourceUri: z.string().min(1).max(MCP_APPS_RESOURCE_URI_MAX_CHARS),
    preferredDisplayMode: mcpAppsDisplayModeSchema.optional(),
    prefersBorder: z.boolean().optional(),
    csp: mcpToolUiCspSchema.optional(),
    // 上限按 UTF-8 字节由 agent 侧保证；这里的 max 按字符数只是兜底（字符数 ≤ 字节数）。
    structuredContent: z.string().max(MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES).optional(),
    widgetMeta: z.string().max(MCP_APPS_WIDGET_META_MAX_BYTES).optional(),
    /** 原始 `content` 数组的 JSON 文本（≤ 32 KiB），页面 tool-result 用它而不是拼接的纯文本。 */
    content: z.string().max(MCP_APPS_CONTENT_MAX_BYTES).optional(),
    truncated: z.boolean().optional(),
    /** 被省略字段的 UTF-8 字节数之和。 */
    truncatedBytes: z.number().int().nonnegative().optional(),
    /** MCP 结果 `isError: true`（调用本身完成、工具报错）；页面 tool-result 带 isError，面板不用它覆盖上一份成功快照。 */
    isError: z.literal(true).optional(),
    /** 工具级强制常驻（`openai/widgetShowCodexWidgetInline`），卡片不进折叠区。 */
    showInline: z.literal(true).optional(),
    // 所属面板；contracts 侧 mcpToolDisplayUiPayloadSchema 同步。
    surface: mcpAppsSurfaceIdSchema.optional(),
  })
  .strict();
export type McpToolDisplayUi = z.infer<typeof mcpToolDisplayUiSchema>;
