import { z } from "zod";

/**
 * App-Provided Tools（MCP Apps 规范「App-Provided Tools」）：页面在 `ui/initialize` 声明 `tools` 能力后，
 * 宿主 `tools/list` 发现页面工具、登记到 agent 暴露给模型；模型调用经"实例信箱"（live-only 投影增量
 * `pluginUi.appToolCall`，按 scopeId + generation 投递）到达渲染端，页面 `tools/call` 执行后回传。
 * 这里只有限额、描述符归一化与模型侧命名；纯 domain，零 IO。
 */

/** 每个页面实例最多登记的工具数（规范推荐值）。 */
export const MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE = 50;
export const MCP_APPS_APP_TOOL_NAME_MAX_CHARS = 128;
export const MCP_APPS_APP_TOOL_TITLE_MAX_CHARS = 256;
export const MCP_APPS_APP_TOOL_DESCRIPTION_MAX_CHARS = 4096;
/** inputSchema / outputSchema 序列化后的上限（UTF-8 字节）。 */
export const MCP_APPS_APP_TOOL_SCHEMA_MAX_BYTES = 64 * 1024;
/** 渲染端认领待执行调用的期限；超时视为页面未运行（信箱投递不重发）。 */
export const MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS = 5_000;
/** 认领后页面执行 tools/call 的期限（规范推荐值）。 */
export const MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS = 30_000;
/** 单次结果序列化上限（规范推荐值）。 */
export const MCP_APPS_APP_TOOL_RESULT_MAX_BYTES = 10 * 1024 * 1024;
/** 模型调用参数进信箱前的上限；超限直接以错误结束，不下发。 */
export const MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES = 1024 * 1024;
/** list_changed 触发的重新登记最小间隔。 */
export const MCP_APPS_APP_TOOLS_REFRESH_INTERVAL_MS = 1_000;
export const MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS = 4096;
export const MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS = 128;
/** 模型侧名字前缀：与 server 工具的 `mcp__` 天然不冲突。 */
export const MCP_APPS_APP_TOOL_MODEL_NAME_PREFIX = "app__";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/** 与 agent 的 MCP 工具名同一清洗规则：非 `[A-Za-z0-9_-]` 替换为 `_` 并合并连续下划线。 */
export function sanitizeMcpAppsModelNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

/** 模型侧名字 `app__<server>__<tool>`。 */
export function buildMcpAppsAppToolModelName(serverName: string, toolName: string): string {
  return `${MCP_APPS_APP_TOOL_MODEL_NAME_PREFIX}${sanitizeMcpAppsModelNamePart(serverName)}__${sanitizeMcpAppsModelNamePart(toolName)}`;
}

const objectSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value.type === "object", { message: "schema type must be object" })
  .refine((value) => utf8Bytes(JSON.stringify(value)) <= MCP_APPS_APP_TOOL_SCHEMA_MAX_BYTES, {
    message: "schema is too large",
  });

export const mcpAppsAppToolAnnotationsSchema = z.strictObject({
  title: z.string().max(MCP_APPS_APP_TOOL_TITLE_MAX_CHARS).optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type McpAppsAppToolAnnotations = z.infer<typeof mcpAppsAppToolAnnotationsSchema>;

export const mcpAppsAppToolDescriptorSchema = z.strictObject({
  name: z.string().min(1).max(MCP_APPS_APP_TOOL_NAME_MAX_CHARS),
  title: z.string().max(MCP_APPS_APP_TOOL_TITLE_MAX_CHARS).optional(),
  description: z.string().max(MCP_APPS_APP_TOOL_DESCRIPTION_MAX_CHARS).optional(),
  inputSchema: objectSchemaSchema,
  outputSchema: objectSchemaSchema.optional(),
  annotations: mcpAppsAppToolAnnotationsSchema.optional(),
});
export type McpAppsAppToolDescriptor = z.infer<typeof mcpAppsAppToolDescriptorSchema>;

const ANNOTATION_BOOLEAN_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

/**
 * 渲染端用：把页面 `tools/list` 的结果收窄成可登记的描述符。不合规的项跳过（不让整次登记失败），
 * 超过 50 个只取前 50 个；返回被跳过的名字与原因供日志。
 */
export function normalizeMcpAppsAppTools(tools: readonly unknown[]): {
  tools: McpAppsAppToolDescriptor[];
  skipped: Array<{ name: string | null; reason: string }>;
} {
  const accepted: McpAppsAppToolDescriptor[] = [];
  const skipped: Array<{ name: string | null; reason: string }> = [];
  const seen = new Set<string>();
  for (const raw of tools) {
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const name = typeof record?.name === "string" ? record.name : null;
    if (accepted.length >= MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE) {
      skipped.push({ name, reason: "limit" });
      continue;
    }
    if (!record || name === null) {
      skipped.push({ name, reason: "invalid" });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, reason: "duplicate" });
      continue;
    }
    const rawAnnotations =
      record.annotations && typeof record.annotations === "object"
        ? (record.annotations as Record<string, unknown>)
        : null;
    const annotations: Record<string, unknown> = {};
    if (typeof rawAnnotations?.title === "string") annotations.title = rawAnnotations.title;
    for (const key of ANNOTATION_BOOLEAN_KEYS) {
      if (typeof rawAnnotations?.[key] === "boolean") annotations[key] = rawAnnotations[key];
    }
    const candidate = {
      name,
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      inputSchema: record.inputSchema,
      ...(record.outputSchema !== undefined ? { outputSchema: record.outputSchema } : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    };
    const parsed = mcpAppsAppToolDescriptorSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped.push({ name, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    seen.add(name);
    accepted.push(parsed.data);
  }
  return { tools: accepted, skipped };
}

/** 页面 `tools/call` 的结果（MCP CallToolResult 形状，字段集宽松：content 项原样保留）。 */
export const mcpAppsAppToolCallResultSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type McpAppsAppToolCallResult = z.infer<typeof mcpAppsAppToolCallResultSchema>;

/** 信箱里的一次待执行调用：按 (scopeId, generation) 投递给唯一实例。 */
export interface McpAppsAppToolCallRequest {
  activity?: boolean;
  cancelled?: boolean;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}
