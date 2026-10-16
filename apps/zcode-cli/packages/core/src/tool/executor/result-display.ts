import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RespondToCoordinatorOutputSchema,
  MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS,
  MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  CUA_TARGET_APP_DISPLAY_META_KEY,
  cuaTargetAppDisplaySchema,
  nodeReplCuaAppDisplaySchema,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageOutputSchema,
  TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS,
  TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputResultSchema,
  TASK_STOP_TOOL_NAME,
  TaskStopOutputSchema,
  type DiffHunk,
  type NodeReplCuaAppDisplay,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import { createBashResultDisplay } from "./bash-result-display.js";
import { countPatchLines } from "../diff.js";
import { boundDisplayText } from "./display-text.js";
import { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { createWorkflowObservationDisplay } from "./workflow-observation-display.js";

// 拆到 create-workflow-display.ts 后保持既有导出面（handlers/create-workflow.ts 仍从这里 import）。
export { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { isRecord } from "./utils.js";
import { parseOfficialMcpToolError, type OfficialMcpToolErrorCode } from "@zcode/shared";
import {
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_WIDGET_META_MAX_BYTES,
  type McpToolDisplayUi,
  type McpToolUiDescriptor,
} from "@zcode/shared/mcp-apps";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "@zcode/zcode-cua/request-access-contract";

const MAX_DISPLAY_DIFF_HUNKS = 8;
const MAX_DISPLAY_DIFF_LINES = 160;
const MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES = 4 * 1024;
const MAX_TASK_STOP_DISPLAY_FIELD_BYTES = 16 * 1024;
export const MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES = 200 * 1024;
const MAX_NODE_REPL_DISPLAY_IMAGES = 2;

export interface McpToolDisplayMetadata {
  serverName: string;
  toolName: string;
  description?: string;
  official?: boolean;
  pluginId?: string;
  ui?: McpToolUiDescriptor;
}

export function createMcpToolDisplay(
  metadata: McpToolDisplayMetadata | undefined,
  output?: unknown,
): ToolResultDisplayPayload | undefined {
  if (!metadata) return undefined;
  const serverName = boundMcpDisplayText(metadata.serverName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  const toolName = boundMcpDisplayText(metadata.toolName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  if (!serverName || !toolName) return undefined;
  const description = metadata.description
    ? boundMcpDisplayText(metadata.description, MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS)
    : undefined;
  const unavailable = metadata.official ? readOfficialMcpUnavailable(output) : undefined;
  const ui = createMcpToolDisplayUi(metadata, output);
  return {
    kind: "mcp_tool",
    serverName,
    toolName,
    ...(description ? { description } : {}),
    ...(unavailable ? { unavailable } : {}),
    ...(ui ? { ui } : {}),
  };
}

/**
 * MCP App 元数据投影。任何 MCP server 的工具只要声明了 ui 资源就存在（归属看 serverName）；
 * pluginId 只做展示 / 键位，非插件 server 用 serverName 顶替。structuredContent / _meta 以 JSON 文本
 * 进入持久化 metadata，超限截断并置 truncated，UI 据此提示"结构化结果被截断"。
 */
function createMcpToolDisplayUi(
  metadata: McpToolDisplayMetadata,
  output: unknown,
): McpToolDisplayUi | undefined {
  if (!metadata.ui) return undefined;
  const pluginId = boundMcpDisplayText(
    metadata.pluginId ?? metadata.serverName,
    MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  );
  if (!pluginId) return undefined;
  const record = isRecord(output) ? output : undefined;
  // 三个 JSON 字段都按 UTF-8 字节封顶；超限整个省略（不产生半截 JSON），记 truncatedBytes。
  const structured = boundJsonText(
    record?.structuredContent,
    MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  );
  const meta = boundJsonText(record?._meta, MCP_APPS_WIDGET_META_MAX_BYTES);
  const content = boundJsonText(
    Array.isArray(record?.content) ? record.content : undefined,
    MCP_APPS_CONTENT_MAX_BYTES,
  );
  const dropped = [structured, meta, content].filter(
    (item): item is { truncated: true; bytes: number } => item?.truncated === true,
  );
  const truncatedBytes = dropped.reduce((sum, item) => sum + item.bytes, 0);
  return {
    pluginId,
    resourceUri: metadata.ui.resourceUri,
    ...(metadata.ui.preferredDisplayMode
      ? { preferredDisplayMode: metadata.ui.preferredDisplayMode }
      : {}),
    ...(metadata.ui.prefersBorder !== undefined
      ? { prefersBorder: metadata.ui.prefersBorder }
      : {}),
    ...(metadata.ui.csp ? { csp: metadata.ui.csp } : {}),
    ...(structured && !structured.truncated ? { structuredContent: structured.text } : {}),
    ...(meta && !meta.truncated ? { widgetMeta: meta.text } : {}),
    ...(content && !content.truncated ? { content: content.text } : {}),
    ...(dropped.length > 0 ? { truncated: true, truncatedBytes } : {}),
    // H06：MCP isError 的调用在 v4 行上仍是 success（模型视角已完成），页面与面板要靠这个字段区分。
    ...(record?.isError === true ? { isError: true as const } : {}),
    ...(metadata.ui.surface ? { surface: metadata.ui.surface } : {}),
    // 4b-1：只投影 true；false / 缺省都不占字段。
    ...(metadata.ui.showInline === true ? { showInline: true as const } : {}),
  };
}

/** JSON 文本按 UTF-8 字节封顶：≤ 上限返回文本，超限只返回字节数（不截断字符串）。 */
function boundJsonText(
  value: unknown,
  maxBytes: number,
): { text: string; truncated: false } | { truncated: true; bytes: number } | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof text !== "string") return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  return { truncated: true, bytes };
}

/**
 * 官方 Server MCP 在配额耗尽 / 无 Coding Plan 时把结构化标识渲染进 tool error content 的
 * JSON 文本（服务端 `ToolError.Error()`）。这里只读该标识，不解析普通错误文案。
 *
 * 仅在 `metadata.official` 为真时才会走到，而该标记只对 **http** 官方 MCP 置位——那种形态的
 * 响应来自已校验 origin 的 ZCode 后端。stdio 官方 MCP 与第三方 MCP 塞同样的 payload 一律忽略：
 * 它们的结果由插件进程自己产出，可以伪造一条 Coding Plan 提示误导用户去购买。
 */
function readOfficialMcpUnavailable(
  output: unknown,
): { code: OfficialMcpToolErrorCode } | undefined {
  if (!isRecord(output) || output.isError !== true || !Array.isArray(output.content)) {
    return undefined;
  }
  for (const block of output.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const parsed = parseOfficialMcpToolError(block.text);
    if (parsed) return { code: parsed.code };
  }
  return undefined;
}

export function createToolResultDisplay(
  toolName: string,
  output: unknown,
  options?: {
    officialCua?: boolean;
    mcp?: McpToolDisplayMetadata;
  },
): ToolResultDisplayPayload | undefined {
  if (toolName === "Bash") return createBashResultDisplay(output);

  const cuaToolName = readCuaToolName(toolName);
  if (cuaToolName) {
    return createCuaToolResultDisplay(cuaToolName, output, options?.officialCua === true);
  }

  const nodeReplDisplay = createNodeReplDisplay(toolName, output);
  if (nodeReplDisplay) return nodeReplDisplay;

  const createWorkflow = createCreateWorkflowDisplay(toolName, output);
  if (createWorkflow) return createWorkflow;

  const workflowObservation = createWorkflowObservationDisplay(toolName, output);
  if (workflowObservation) return workflowObservation;

  if (options?.mcp) {
    // 结果级构造：官方 MCP 的不可用标识只能从本次结果里读，因此把 output 一起传进去。
    return createMcpToolDisplay(options.mcp, output);
  }

  if (toolName === SEND_MESSAGE_TOOL_NAME) {
    const parsed = SendMessageOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    // display 不经过 tool result budget，必须在进入实时事件和持久化 metadata 前单独限长。
    const error =
      parsed.data.error === undefined
        ? undefined
        : boundDisplayText(parsed.data.error, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    const message =
      parsed.data.message === undefined
        ? undefined
        : boundDisplayText(parsed.data.message, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    return {
      kind: "local_agent_message",
      status: parsed.data.status,
      ...(error !== undefined ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  if (toolName === TASK_STOP_TOOL_NAME) {
    const parsed = TaskStopOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const command =
      parsed.data.command === undefined
        ? undefined
        : boundDisplayText(parsed.data.command, MAX_TASK_STOP_DISPLAY_FIELD_BYTES);
    const message = boundDisplayText(
      compactTaskStopDisplayMessage(parsed.data),
      MAX_TASK_STOP_DISPLAY_FIELD_BYTES,
    );
    const truncated = command?.truncated === true || message.truncated;
    return {
      kind: "task_stop",
      taskId: parsed.data.task_id,
      taskType: parsed.data.task_type,
      ...(command !== undefined ? { command: command.value } : {}),
      message: message.value,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === TASK_OUTPUT_TOOL_NAME) {
    const parsed = TaskOutputResultSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const taskStatus = parsed.data.task?.status
      .trim()
      .slice(0, TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS);
    const fullOutput = parsed.data.task?.output.trimEnd();
    const hasOutput = fullOutput !== undefined && fullOutput.trim().length > 0;
    const truncated = hasOutput && fullOutput.length > TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS;

    // UI display 是独立于 provider content 的有界投影；禁止把完整 TaskOutput XML
    // 或结果对象塞进实时事件和持久化 metadata。
    return {
      kind: "task_output",
      retrievalStatus: parsed.data.retrieval_status,
      ...(taskStatus ? { taskStatus } : {}),
      ...(hasOutput ? { output: fullOutput.slice(0, TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS) } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === RESPOND_TO_COORDINATOR_TOOL_NAME) {
    const parsed = RespondToCoordinatorOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    return {
      kind: "respond_to_coordinator",
      status: parsed.data.status,
    };
  }

  if (!isRecord(output)) return undefined;
  const filePath = output.filePath;
  const structuredPatch = output.structuredPatch;
  if (typeof filePath !== "string" || !Array.isArray(structuredPatch)) {
    return undefined;
  }

  const hunks = structuredPatch.filter(isDiffHunk);
  if (hunks.length === 0) return undefined;

  const { additions, deletions } = countPatchLines(hunks);
  const { patch: boundedPatch, truncated } = boundDiffHunks(hunks);
  return {
    kind: "file_diff",
    filePath,
    additions,
    deletions,
    structuredPatch: boundedPatch,
    truncated,
  };
}

function boundMcpDisplayText(value: string, maxChars: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bounded = trimmed.slice(0, maxChars);
  // MCP discovery 是外部输入，直接 slice 可能在 UTF-16 surrogate pair
  // 中间截断，生成无法稳定跨事件、持久化和 replayable snapshot 的字符串。
  // 若边界落在高位 surrogate 后，丢弃这个半字符，保证 display 始终可安全序列化。
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

const MAX_CUA_DISPLAY_FIELD_BYTES = 32 * 1024;
const MAX_CUA_INLINE_MEDIA_BYTES = 256 * 1024;
const MAX_CUA_INLINE_MEDIA_TOTAL_BYTES = 512 * 1024;

function readCuaToolName(toolName: string): string | undefined {
  // 兼容两种 CUA 工具命名：直接的 `mcp__computer_use__<action>` 与 plugin
  // 命名空间形式 `mcp__plugin_zcode-cua_computer-use__<action>`。
  // 归一化（小写 + `-`→`_`）后：名字包含 `computer_use`，且 action 是最后一个 `__` 之后的子串。
  const normalized = toolName.trim().toLowerCase().replaceAll("-", "_");
  if (!normalized.includes("computer_use")) return undefined;
  const lastSep = normalized.lastIndexOf("__");
  if (lastSep === -1) return undefined;
  const action = normalized.slice(lastSep + "__".length);
  return action.length > 0 ? action : undefined;
}

function createCuaToolResultDisplay(
  toolName: string,
  output: unknown,
  officialCua: boolean,
): ToolResultDisplayPayload {
  const result = isRecord(output) ? output : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  const structuredContent = result.structuredContent;
  const structuredRecord = isRecord(structuredContent) ? structuredContent : undefined;
  const errorRecord = isRecord(structuredRecord?.error) ? structuredRecord.error : undefined;
  const structuredJson =
    structuredContent === undefined
      ? undefined
      : boundDisplayText(safeJson(structuredContent), MAX_CUA_DISPLAY_FIELD_BYTES);
  const boundedText = text ? boundDisplayText(text, MAX_CUA_DISPLAY_FIELD_BYTES) : undefined;
  // artifact URI 只在 Agent 本地可读，直接投影会让多端 UI 收到无法渲染的媒体。
  // 在受控读取 API 建立前，display 只承载可直接渲染的内联图片。
  const media: Array<{ mimeType: string; data: string }> = [];
  let inlineMediaBytes = 0;
  let mediaTruncated = false;
  for (const item of content) {
    if (!isRecord(item)) continue;
    let projectedMedia: { mimeType: string; data: string } | undefined;
    let decodedBytes = 0;
    if (
      item.type === "image" &&
      typeof item.mimeType === "string" &&
      typeof item.data === "string"
    ) {
      decodedBytes = Buffer.byteLength(item.data, "base64");
      projectedMedia = { mimeType: item.mimeType, data: item.data };
    }
    if (!projectedMedia) continue;
    // media 配额只约束真实媒体，前置 text block 不能吞掉截图位置。
    if (media.length >= 4) {
      mediaTruncated = true;
      break;
    }
    if (
      decodedBytes > MAX_CUA_INLINE_MEDIA_BYTES ||
      inlineMediaBytes + decodedBytes > MAX_CUA_INLINE_MEDIA_TOTAL_BYTES
    ) {
      mediaTruncated = true;
      continue;
    }
    inlineMediaBytes += decodedBytes;
    media.push(projectedMedia);
  }
  const truncated =
    mediaTruncated || structuredJson?.truncated === true || boundedText?.truncated === true;
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const targetApp = officialCua
    ? cuaTargetAppDisplaySchema.safeParse(meta?.[CUA_TARGET_APP_DISPLAY_META_KEY])
    : undefined;
  const permissionStatus =
    officialCua && toolName === "request_access"
      ? cuaRequestAccessStatusSchema.safeParse(meta?.[CUA_REQUEST_ACCESS_STATUS_META_KEY])
      : undefined;

  // MCP modelContent 会把 structuredContent 展平成文本；在展平前生成独立、有限长的
  // display，才能让实时事件和历史会话稳定区分 CUA 错误与结构化结果。
  return {
    kind: "cua",
    schemaVersion: 1,
    toolName,
    status: result.isError === true ? "failed" : "success",
    ...(structuredJson ? { structuredContent: structuredJson.value } : {}),
    ...(boundedText ? { text: boundedText.value } : {}),
    ...(typeof errorRecord?.code === "string" ? { errorCode: errorRecord.code } : {}),
    ...(typeof errorRecord?.suggested_action === "string"
      ? { suggestedAction: errorRecord.suggested_action }
      : {}),
    ...(targetApp?.success ? { targetApp: targetApp.data } : {}),
    ...(permissionStatus?.success ? { permissionStatus: permissionStatus.data } : {}),
    ...(media.length > 0 ? { media } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

/**
 * 读取宿主写入的 CUA 目标应用身份。
 *
 * 只认 `zcode/nodeReplCuaApp`：producer 自己的 `zcode.cua/app-associations-v1` 也可能出现在
 * `_meta` 里，但那个键经模型可写的 `nodeRepl.setResponseMeta` /
 * `nodeRepl.emitStructuredResult` 同样能到达，宿主已在 toMcpRunResult 里把它删掉。这里不做
 * 第二次兜底解析，避免把已经判定为不可信的来源重新接回展示面。
 */
function readNodeReplCuaApp(output: Record<string, unknown>): NodeReplCuaAppDisplay | undefined {
  const meta = isRecord(output._meta) ? output._meta : undefined;
  const parsed = nodeReplCuaAppDisplaySchema.safeParse(
    meta?.[ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

function createNodeReplDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== "js" && toolName !== "mcp__node_repl__js") return undefined;
  if (!isRecord(output)) return undefined;

  const candidates = [
    ...(Array.isArray(output.images) ? output.images : []),
    ...(Array.isArray(output.content) ? output.content : []),
  ];
  const images: Array<{ base64: string; mimeType: string }> = [];
  let truncated = false;

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const mimeType = candidate.mimeType;
    const encoded = candidate.base64 ?? candidate.data;
    if (
      typeof mimeType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/iu.test(mimeType) ||
      typeof encoded !== "string"
    ) {
      continue;
    }
    const base64 = encoded.startsWith("data:")
      ? encoded.slice(Math.max(0, encoded.indexOf(",") + 1))
      : encoded;
    if (
      base64.length === 0 ||
      Buffer.byteLength(base64, "utf8") > MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES
    ) {
      truncated = true;
      continue;
    }
    if (images.length >= MAX_NODE_REPL_DISPLAY_IMAGES) {
      truncated = true;
      continue;
    }
    images.push({ base64, mimeType });
  }

  // 纯动作 cell（点击、输入）没有截图，但仍要把 App 身份投影给工具卡的 leading icon；
  // 因此不能再以「有图」作为产出 display 的唯一条件。
  const app = readNodeReplCuaApp(output);
  if (images.length === 0 && !app) return undefined;
  return {
    kind: "node_repl_images",
    ...(images.length > 0 ? { images } : {}),
    ...(app ? { app } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function compactTaskStopDisplayMessage(output: {
  command?: string;
  message: string;
  task_id: string;
}): string {
  if (output.command === undefined) {
    return output.message;
  }

  // TaskStop 的标准成功文案会把 command 再拼进括号；display 已有
  // 独立 command 字段，结果行只保留停止结论。
  const standardMessage = `Successfully stopped task: ${output.task_id} (${output.command})`;
  return output.message === standardMessage
    ? `Successfully stopped task: ${output.task_id}`
    : output.message;
}

function isDiffHunk(value: unknown): value is DiffHunk {
  if (!isRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

function boundDiffHunks(hunks: DiffHunk[]): { patch: DiffHunk[]; truncated: boolean } {
  const bounded: DiffHunk[] = [];
  let remainingLines = MAX_DISPLAY_DIFF_LINES;
  let truncated = hunks.length > MAX_DISPLAY_DIFF_HUNKS;

  for (const hunk of hunks.slice(0, MAX_DISPLAY_DIFF_HUNKS)) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    const lines = hunk.lines.slice(0, remainingLines);
    bounded.push({ ...hunk, lines });
    remainingLines -= lines.length;
    if (lines.length < hunk.lines.length) {
      truncated = true;
      break;
    }
  }

  return { patch: bounded, truncated };
}
