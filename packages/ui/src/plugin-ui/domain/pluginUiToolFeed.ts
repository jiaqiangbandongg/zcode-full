import type { McpAppsToolResultPayload } from "@zcode/shared/mcp-apps";
import { MCP_APPS_TRUNCATED_META_KEY } from "@zcode/shared/mcp-apps";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { PluginUiPresentation } from "../contract.js";
import { parseJsonText, readPluginUiPresentation } from "./readPluginUiPresentation.js";

/** 内联卡片与侧栏共用的 legacy ChatToolCall 子集（toolCallRowAdapter 输出）。 */
export interface PluginUiLegacyToolCall {
  status: string;
  input: unknown;
  output?: unknown;
}

export function readPluginUiToolInput(
  toolCall: PluginUiLegacyToolCall | null,
): Record<string, unknown> | undefined {
  return toolCall &&
    typeof toolCall.input === "object" &&
    toolCall.input !== null &&
    !Array.isArray(toolCall.input)
    ? (toolCall.input as Record<string, unknown>)
    : undefined;
}

/** 被停止的工具不再伪装成普通结果，而是走 ui/notifications/tool-cancelled。 */
export function isPluginUiToolCancelled(toolCall: PluginUiLegacyToolCall | null): boolean {
  return toolCall?.status === "stopped";
}

/**
 * 工具行 → MCP Apps tool-result 通知载荷。legacy 状态词表：pending / in_progress / completed / failed / stopped；
 * 未完成不产出；stopped 不产出（改发 cancelled 通知）。structuredContent / widgetMeta 从 display.ui 的 JSON 文本恢复。
 */
export function buildPluginUiToolResult(
  toolCall: PluginUiLegacyToolCall | null,
  presentation: PluginUiPresentation | null,
): McpAppsToolResultPayload | undefined {
  if (!toolCall || !presentation) return undefined;
  if (toolCall.status === "pending" || toolCall.status === "in_progress") return undefined;
  if (isPluginUiToolCancelled(toolCall)) return undefined;
  const structured = parseJsonText(presentation.structuredContent);
  const meta = parseJsonText(presentation.widgetMeta);
  // H12：优先用 agent 投影的原始 content 数组（图片 / 资源块不丢）；没有时退回纯文本。
  const rawContent = parseJsonText(presentation.content);
  const content = Array.isArray(rawContent)
    ? (rawContent.filter(
        (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
      ) as Array<Record<string, unknown>>)
    : typeof toolCall.output === "string"
      ? [{ type: "text", text: toolCall.output }]
      : [];
  const baseMeta =
    typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  // H12：超限字段已被 agent 省略；页面从 _meta["zcode/truncated"].bytes 得知并可用 tools/call 重取。
  const mergedMeta = presentation.truncated
    ? { ...baseMeta, [MCP_APPS_TRUNCATED_META_KEY]: { bytes: presentation.truncatedBytes ?? 0 } }
    : baseMeta;
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(toolCall.status === "failed" || presentation.isError ? { isError: true } : {}),
    ...(Object.keys(mergedMeta).length > 0 ? { _meta: mergedMeta } : {}),
  };
}

export function findToolRowById(
  rows: readonly ConversationRow[],
  toolCallId: string,
): ToolCallRow | null {
  const row = rows.find(
    (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === toolCallId,
  );
  return row && row.kind === "toolCall" ? row : null;
}

/** 面板投喂快照里的一条工具行摘要。 */
export interface PluginUiSurfaceFeedEntry {
  rowId: number;
  toolCallId: string;
  status: ToolCallRow["status"];
  presentation: PluginUiPresentation;
  input: Record<string, unknown> | undefined;
}

/**
 * 面板（surface）投喂快照。`latest` 是该 surface 最新一条工具行（任意状态，投喂 tool-input、
 * 判断 cancelled）；`result` 是最后一次成功结果，running / failed / cancelled / MCP isError 不覆盖它——面板在下一次成功前
 * 一直显示上一份好结果。两者只按 rowId 单调前进，投影窗口被裁掉旧行时快照仍在。
 */
export interface PluginUiSurfaceFeed {
  latest: PluginUiSurfaceFeedEntry | null;
  result: (PluginUiSurfaceFeedEntry & { toolResult: McpAppsToolResultPayload }) | null;
}

export const EMPTY_PLUGIN_UI_SURFACE_FEED: PluginUiSurfaceFeed = { latest: null, result: null };

// v4 status → buildPluginUiToolResult 用的 legacy 词表（与 v4/toolCallRowAdapter 的 STATUS_MAP 同义，
// 这里不引 adapter：domain 只依赖协议行类型）。
const LEGACY_STATUS: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

function readSurfacePresentation(
  row: ToolCallRow,
  surfaceId: string,
  pluginId: string,
): PluginUiPresentation | null {
  const display = row.display;
  if (
    display?.kind !== "mcp_tool" ||
    display.ui?.surface !== surfaceId ||
    display.ui.pluginId !== pluginId
  )
    return null;
  return readPluginUiPresentation({ display });
}

function toSurfaceFeedEntry(
  row: ToolCallRow,
  presentation: PluginUiPresentation,
): PluginUiSurfaceFeedEntry {
  return {
    rowId: row.rowId,
    toolCallId: row.toolCallId,
    status: row.status,
    presentation,
    input: readPluginUiToolInput({ status: row.status, input: row.input }),
  };
}

/**
 * 纯归约：把一批投影行并进快照。同一 rowId 只在状态变化时更新 `latest`；`result` 在成功行首次出现时构造一次，
 * 之后同 rowId 不重建（保持引用稳定，宿主据引用判断是否重发 tool-result）。无变化时返回原对象。
 */
export function reducePluginUiSurfaceFeed(
  previous: PluginUiSurfaceFeed,
  rows: readonly ConversationRow[],
  surfaceId: string,
  pluginId: string,
  binding?: { serverName?: string; resourceUri: string },
): PluginUiSurfaceFeed {
  let latest = previous.latest;
  let result = previous.result;
  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    const presentation = readSurfacePresentation(row, surfaceId, pluginId);
    if (
      !presentation ||
      (binding &&
        (presentation.serverName !== binding.serverName ||
          presentation.resourceUri !== binding.resourceUri))
    )
      continue;
    if (
      !latest ||
      row.rowId > latest.rowId ||
      (row.rowId === latest.rowId && row.status !== latest.status)
    ) {
      latest = toSurfaceFeedEntry(row, presentation);
    }
    // MCP isError 的调用在 v4 行上是 success（模型视角已完成），对面板来说是失败：不覆盖上一份好结果。
    if (
      row.status === "success" &&
      !presentation.isError &&
      (!result || row.rowId > result.rowId)
    ) {
      const toolResult = buildPluginUiToolResult(
        { status: LEGACY_STATUS[row.status], input: row.input, output: row.output?.text },
        presentation,
      );
      if (toolResult) result = { ...toSurfaceFeedEntry(row, presentation), toolResult };
    }
  }
  return latest === previous.latest && result === previous.result ? previous : { latest, result };
}

/** 两份快照按 rowId 取新（store 合并用）：谁的行更新用谁的。 */
export function mergePluginUiSurfaceFeed(
  current: PluginUiSurfaceFeed,
  candidate: PluginUiSurfaceFeed,
): PluginUiSurfaceFeed {
  const latest =
    candidate.latest &&
    (!current.latest ||
      candidate.latest.rowId > current.latest.rowId ||
      (candidate.latest.rowId === current.latest.rowId &&
        candidate.latest.status !== current.latest.status))
      ? candidate.latest
      : current.latest;
  const result =
    candidate.result && (!current.result || candidate.result.rowId > current.result.rowId)
      ? candidate.result
      : current.result;
  return latest === current.latest && result === current.result ? current : { latest, result };
}
