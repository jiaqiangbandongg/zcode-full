import {
  MCP_TOOL_META_TIMEOUT_MAX_MS,
  MCP_TOOL_META_TIMEOUT_MIN_MS,
  type JsonSchema,
  type McpToolAnnotations,
  type McpToolDescriptor,
} from "@zcode/contracts";
import { normalizeMcpToolUiMeta, readMcpToolVisibility } from "@zcode/shared/mcp-apps";

export function normalizeMcpToolDescriptor(
  serverName: string,
  tool: unknown,
  timeoutMs?: number,
  official?: boolean,
): McpToolDescriptor {
  const record = isRecord(tool) ? tool : {};
  const toolName = typeof record.name === "string" ? record.name : "unknown";
  // 插件 UI：tools/list 的 `_meta` 只在这里读一次，归一化成 descriptor.ui；下游不再碰原始 _meta。
  const ui = normalizeMcpToolUiMeta(record._meta);
  return {
    serverName,
    toolName,
    name: `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`,
    description: typeof record.description === "string" ? record.description : undefined,
    // 工具级 `_meta.timeoutMs`（A8）覆盖服务器级超时：长任务（下载引擎、渲染）按工具声明，上限 30 分钟。
    timeoutMs: readToolMetaTimeoutMs(record._meta) ?? timeoutMs,
    inputSchema: normalizeInputSchema(record.inputSchema),
    outputSchema: isRecord(record.outputSchema) ? (record.outputSchema as JsonSchema) : undefined,
    annotations: normalizeAnnotations(record.annotations),
    // 只有 http 官方 MCP 的 tool error 标识才被信任——那种形态的响应来自已校验 origin 的
    // ZCode 后端，插件伪造不了（判据与代价见 mcp.port.ts 的 official 字段说明）。
    ...(official ? { official: true } : {}),
    // 可见性独立于 UI 呈现——没有 resourceUri 的 app-only 数据工具也不能进模型工具表。
    visibility: readMcpToolVisibility(record._meta),
    ...(ui ? { ui } : {}),
  };
}

function readToolMetaTimeoutMs(meta: unknown): number | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta.timeoutMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < MCP_TOOL_META_TIMEOUT_MIN_MS) return undefined;
  return Math.min(Math.floor(value), MCP_TOOL_META_TIMEOUT_MAX_MS);
}

function normalizeInputSchema(schema: unknown): JsonSchema {
  if (!isRecord(schema)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
  };
}

function normalizeAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (!isRecord(value)) return undefined;
  return {
    readOnlyHint: typeof value.readOnlyHint === "boolean" ? value.readOnlyHint : undefined,
    destructiveHint: typeof value.destructiveHint === "boolean" ? value.destructiveHint : undefined,
    idempotentHint: typeof value.idempotentHint === "boolean" ? value.idempotentHint : undefined,
    openWorldHint: typeof value.openWorldHint === "boolean" ? value.openWorldHint : undefined,
  };
}

function sanitizeMcpName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
