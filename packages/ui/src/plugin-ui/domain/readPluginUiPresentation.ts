import { mcpToolDisplayUiSchema } from "@zcode/shared/mcp-apps";
import type { PluginUiPresentation } from "../contract.js";

/**
 * 从 ToolCallRow 的 legacy raw.display 读出插件 UI 呈现信息。display.ui 由 agent 投影、经 strict schema
 * 校验持久化；这里再校验一次是为了防御旧快照或手改数据，失败即回退到普通 McpToolCallBlock。
 */
export function readPluginUiPresentation(raw: unknown): PluginUiPresentation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const display = (raw as { display?: unknown }).display;
  if (typeof display !== "object" || display === null) return null;
  const record = display as Record<string, unknown>;
  if (record.kind !== "mcp_tool" || typeof record.serverName !== "string") return null;
  const parsed = mcpToolDisplayUiSchema.safeParse(record.ui);
  if (!parsed.success) return null;
  return { serverName: record.serverName, ...parsed.data };
}

/** 解析 display.ui 里以 JSON 文本持久化的 structuredContent / widgetMeta；非法 JSON 视为缺失。 */
export function parseJsonText(text: string | undefined): unknown {
  if (typeof text !== "string" || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
