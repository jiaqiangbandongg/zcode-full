/* oxlint-disable eslint(max-lines) -- Claude 原生日志解析需要集中维护用户轮次、assistant 自愈和 system warning 归因，拆分会让同一日志语义分散。 */
import { stat } from "node:fs/promises";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";
import { readJsonLinesFile } from "#src/session/claude-native/sessionHistoryJsonl.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import {
  isObjectRecord,
  readTrimmedString,
} from "#src/session/claude-native/jsonLineRecord.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";

const IDE_OPENED_FILE_TAG_RE = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi;
const COMMAND_TAG_BLOCK_RE =
  /<(?:local-command|command)-[^>]+>[\s\S]*?<\/(?:local-command|command)-[^>]+>/gi;
const COMMAND_DIAGNOSTIC_TAG_RE = /<\/?(?:local-command|command)-[^>]+>/gi;

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.trunc(value);
    }
    if (value > 1_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue)) {
    return toTimestampMs(numericValue);
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readEntryTimestamp(entry: JsonLineRecord): number | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  const candidates = [
    entry.timestamp,
    entry.createdAt,
    entry.updatedAt,
    entry.created_at,
    entry.updated_at,
    entry.time,
    message?.timestamp,
    message?.createdAt,
    message?.updatedAt,
    request?.timestamp,
  ];

  for (const candidate of candidates) {
    const timestamp = toTimestampMs(candidate);
    if (timestamp !== undefined) {
      return timestamp;
    }
  }

  return undefined;
}

function readEntryWorkspacePath(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return (
    readTrimmedString(entry.cwd) ??
    readTrimmedString(message?.cwd) ??
    readTrimmedString(request?.cwd)
  );
}

function readEntryModel(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return readTrimmedString(entry.model) ?? readTrimmedString(message?.model);
}

function isClaudeNativeSidechainEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return entry.isSidechain === true || message?.isSidechain === true || request?.isSidechain === true;
}

export function hasClaudeNativeSidechainMarker(entries: readonly JsonLineRecord[]): boolean {
  return entries.some(isClaudeNativeSidechainEntry);
}

function readAssistantStopReason(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return (
    readTrimmedString(message?.stop_reason) ??
    readTrimmedString(message?.stopReason) ??
    readTrimmedString(entry.stop_reason) ??
    readTrimmedString(entry.stopReason)
  );
}

function isTerminalAssistantStopReason(stopReason: string | undefined): boolean {
  return Boolean(stopReason && stopReason !== "tool_use");
}

function sanitizeClaudeVisibleText(text: string): string {
  return text
    .replace(IDE_OPENED_FILE_TAG_RE, " ")
    .replace(COMMAND_TAG_BLOCK_RE, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

function sanitizeClaudeDiagnosticText(text: string): string {
  return text.replace(COMMAND_DIAGNOSTIC_TAG_RE, " ").replace(/\r\n/g, "\n").trim();
}

export function stripClaudeNativeSyntheticNoResponsePlaceholderText(text: string): string {
  return text
    .trimEnd()
    .replace(/(?:\n+\s*)?No response requested\.$/u, "")
    .trimEnd();
}

function isClaudeNativeSyntheticPlaceholderEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  // Claude Code 会把 SDK 自己生成的控制占位也写成 assistant，
  // 例如 model=<synthetic> 的 "No response requested."。这种占位没有用户可见价值，
  // 但 API Error / 登录错误本身是用户在 Claude 里看到的 assistant 气泡，导入时必须保留。
  return (
    readEntryModel(entry) === "<synthetic>" &&
    entry.isApiErrorMessage !== true &&
    message?.isApiErrorMessage !== true
  );
}

function extractTextField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!isObjectRecord(value)) {
    return "";
  }

  return readTrimmedString(value.text) ?? readTrimmedString(value.content) ?? "";
}

function extractClaudeUserText(entry: JsonLineRecord): string | null {
  if (entry.type !== "user") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (entry.isMeta === true || message?.isMeta === true) {
    return null;
  }

  // 关键业务逻辑：这里只提取“用户真正可见的问题文本”。
  // tool_result / local-command / ide_opened_file 这些内容虽然也会混在 Claude 原生日志里，
  // 但它们属于协议噪音或 IDE 注入信息，直接写进 zcode task 会让导入后的聊天记录失真。
  const content =
    message?.content ?? (isObjectRecord(entry.request) ? entry.request.prompt : undefined);
  if (typeof content === "string") {
    const normalized = sanitizeClaudeVisibleText(content);
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((item) => {
      if (typeof item === "string") {
        const normalized = sanitizeClaudeVisibleText(item);
        return normalized.length > 0 ? [normalized] : [];
      }
      if (!isObjectRecord(item) || item.type === "tool_result") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function extractClaudeAssistantText(entry: JsonLineRecord): string | null {
  if (entry.type !== "assistant") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (isClaudeNativeSyntheticPlaceholderEntry(entry)) {
    return null;
  }

  const content = message?.content;
  if (typeof content === "string") {
    const normalized = sanitizeClaudeVisibleText(content);
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((item) => {
      if (typeof item === "string") {
        const normalized = sanitizeClaudeVisibleText(item);
        return normalized.length > 0 ? [normalized] : [];
      }
      if (!isObjectRecord(item) || item.type !== "text") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

  const text = parts.length > 0 ? parts.join("") : "";
  if (!text) {
    return null;
  }
  const visibleText = stripClaudeNativeSyntheticNoResponsePlaceholderText(text);
  return visibleText.length > 0 ? visibleText : null;
}

export function extractClaudeNativeSessionHeadInfo(entries: readonly JsonLineRecord[]): {
  workspacePath?: string;
  previewTitle?: string;
  createdAt?: number;
} {
  let workspacePath: string | undefined;

  for (const entry of entries) {
    const userText = extractClaudeUserText(entry);
    const assistantText = extractClaudeAssistantText(entry);
    // 扫描阶段不能用任意头部事件的 cwd 判定 workspace，
    // 因为 queue/progress 等前置记录可能带着更深层的临时 cwd。
    // 这里必须等到第一条“真正可见的业务消息”出现后，才把它的 cwd 视为 session 归属。
    if (!workspacePath && (userText || assistantText)) {
      workspacePath = readEntryWorkspacePath(entry);
    }
    if (!userText) {
      continue;
    }

    return {
      workspacePath,
      previewTitle: deriveSessionTitle(userText, []),
      createdAt: readEntryTimestamp(entry),
    };
  }

  return { workspacePath };
}

export function parseClaudeNativeSessionRecords(params: {
  records: readonly JsonLineRecord[];
  workspacePath: string;
  sessionId: string;
  sourcePath: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): ClaudeNativeImportedSessionSource {
  const messages: ClaudeNativeImportedSessionSource["messages"] = [];
  let detectedWorkspacePath: string | undefined;
  let firstVisibleUserTimestamp: number | undefined;
  let updatedAt = params.fallbackUpdatedAt;
  let currentTurnIndex = -1;
  let model: string | undefined;
  let pendingAssistantContent = "";
  let pendingAssistantTimestamp: number | undefined;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTimestamp = undefined;
      return;
    }

    // 关键业务逻辑：Claude 原生日志里 assistant 一轮回答可能被拆成多条事件。
    // 这里在遇到下一条可见 user turn 或文件结束时统一聚合，保证导入后的 history
    // 仍然是“用户一轮 + assistant 一轮”的最小可渲染结构。
    messages.push({
      role: "assistant",
      content: pendingAssistantContent,
      timestamp: pendingAssistantTimestamp ?? updatedAt ?? Date.now(),
      ...(model ? { model } : {}),
      turnIndex: currentTurnIndex,
    });
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
    pendingAssistantContent = "";
    pendingAssistantTimestamp = undefined;
  };

  for (const entry of params.records) {
    const userText = extractClaudeUserText(entry);
    if (!detectedWorkspacePath && userText) {
      detectedWorkspacePath = readEntryWorkspacePath(entry);
    }
    if (userText) {
      flushPendingAssistant();
      currentTurnIndex += 1;
      const timestamp = readEntryTimestamp(entry) ?? updatedAt ?? Date.now();
      // createdAt 必须优先取首条可见 user 消息，而不是文件 birthtime。
      // 原生 jsonl 的创建时间可能只是文件落盘时间，不能稳定代表用户真正发起会话的时刻。
      firstVisibleUserTimestamp ??= timestamp;
      updatedAt = timestamp;
      messages.push({
        role: "user",
        content: userText,
        timestamp,
        turnIndex: currentTurnIndex,
      });
      continue;
    }

    const assistantText = extractClaudeAssistantText(entry);
    if (!detectedWorkspacePath && assistantText) {
      detectedWorkspacePath = readEntryWorkspacePath(entry);
    }
    if (!assistantText || currentTurnIndex < 0) {
      continue;
    }

    // synthetic/API error assistant 会被正文过滤，但它也可能带
    // model=<synthetic>。导入 snapshot 的模型只能来自可见模型回复，否则续聊时会把
    // SDK 占位模型当成真实模型参与 session/load 和 set_model 决策。
    model ??= readEntryModel(entry);
    pendingAssistantContent += assistantText;
    pendingAssistantTimestamp = readEntryTimestamp(entry) ?? pendingAssistantTimestamp ?? updatedAt;
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
  }

  flushPendingAssistant();

  if (messages.length === 0) {
    throw new Error(
      `[claude-native] Claude 原生 session ${params.sessionId} 没有可导入的可见消息`,
    );
  }

  return {
    provider: "claude",
    sessionId: params.sessionId,
    workspacePath: detectedWorkspacePath ?? params.workspacePath,
    sourcePath: params.sourcePath,
    createdAt: firstVisibleUserTimestamp ?? params.fallbackCreatedAt ?? updatedAt ?? Date.now(),
    updatedAt: updatedAt ?? firstVisibleUserTimestamp ?? params.fallbackCreatedAt ?? Date.now(),
    title: deriveSessionTitle(messages.find((item) => item.role === "user")?.content ?? "", []),
    // 关键业务逻辑：provider=claude 只能说明任务最终由 Claude 续接，
    // 不能区分它是 zcode 内新建的 Claude 任务，还是从 Claude Code 原生历史迁移来的任务。
    // 这里单独写 migrationSource，后续任务列表/统计才能稳定识别迁移来源。
    migrationSource: "claudeCode",
    ...(model ? { model } : {}),
    messages,
  };
}

export interface ClaudeNativeVisibleAssistantTurn {
  turnIndex: number;
  content: string;
  terminal: boolean;
  userTimestamp?: number;
  timestamp?: number;
}

export interface ClaudeNativeUnknownCommandWarning {
  command: string;
  args?: string;
  timestamp?: number;
}

const CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS = 1_000;
const CLAUDE_NATIVE_UNKNOWN_COMMAND_ARGS_MAX_GAP_MS = 5_000;
const CLAUDE_NATIVE_UNKNOWN_COMMAND_RE = /^Unknown command:\s*(\S+)/iu;
const CLAUDE_NATIVE_UNKNOWN_SKILL_ARGS_RE = /^Args from unknown skill:\s*(.+)$/iu;

function readClaudeNativeTurnMatchTimestamp(
  turn: ClaudeNativeVisibleAssistantTurn,
): number | undefined {
  return turn.userTimestamp ?? turn.timestamp;
}

export function selectClaudeNativeVisibleAssistantTurnAfter(
  turns: readonly ClaudeNativeVisibleAssistantTurn[],
  lowerBoundMs: number,
): ClaudeNativeVisibleAssistantTurn | null {
  const minTimestamp = lowerBoundMs - CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS;
  const candidates = turns.filter((turn) => {
    const timestamp = readClaudeNativeTurnMatchTimestamp(turn);
    return timestamp !== undefined && timestamp >= minTimestamp && turn.content.trim().length > 0;
  });
  const strictCandidates = candidates.filter((turn) => {
    const timestamp = readClaudeNativeTurnMatchTimestamp(turn);
    return timestamp !== undefined && timestamp >= lowerBoundMs;
  });
  if (strictCandidates.length > 0) {
    return strictCandidates[0] ?? null;
  }

  const truncatedTimestampCandidates = candidates.filter(
    (turn) => turn.timestamp === undefined || turn.timestamp >= lowerBoundMs,
  );

  // Bugfix: Claude 原生日志 turnIndex 与 ZCode turnIndex 在 session/load、旧错误合成消息、
  // 跨 provider 续接后可能发生漂移。恢复正文时必须优先用 userTimestamp 判断 assistant
  // 归属的用户轮次，否则 session/load 追加的临近 assistant（如 No response requested）
  // 会凭较新的 assistant timestamp 混入本轮，把旧轮次 API Error 当成当前成功回复覆盖掉。
  // Bugfix: 但 Claude 原生日志的 user timestamp 可能被截断到秒级。快速连续 prompt 时，
  // 上一轮 user 也会落进 1s 容忍窗口；这时必须排除 assistant 写入时间早于本轮发送的旧轮次，
  // 并在剩余候选中取日志顺序最后一条，才是最接近当前 prompt 的可见 assistant。
  // 不向后寻找 terminal，避免当前轮还未写终态时误跳到更晚一轮的正文。
  return truncatedTimestampCandidates.at(-1) ?? null;
}

export function parseClaudeNativeVisibleAssistantTurns(
  records: readonly JsonLineRecord[],
): ClaudeNativeVisibleAssistantTurn[] {
  const turns: ClaudeNativeVisibleAssistantTurn[] = [];
  let currentTurnIndex = -1;
  let currentUserTimestamp: number | undefined;
  let pendingAssistantContent = "";
  let pendingAssistantTerminal = false;
  let pendingAssistantTimestamp: number | undefined;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTerminal = false;
      pendingAssistantTimestamp = undefined;
      return;
    }

    // 关键业务逻辑：prompt 收尾兜底不能只知道“有正文”，还要知道这一轮
    // Claude 原生日志是否已经写到 end_turn/max_tokens 等终态。否则会把 tool_use
    // 阶段的开场白误当最终回复。
    turns.push({
      turnIndex: currentTurnIndex,
      content: pendingAssistantContent,
      terminal: pendingAssistantTerminal,
      ...(currentUserTimestamp !== undefined ? { userTimestamp: currentUserTimestamp } : {}),
      ...(pendingAssistantTimestamp !== undefined ? { timestamp: pendingAssistantTimestamp } : {}),
    });
    pendingAssistantContent = "";
    pendingAssistantTerminal = false;
    pendingAssistantTimestamp = undefined;
  };

  for (const entry of records) {
    const userText = extractClaudeUserText(entry);
    if (userText) {
      flushPendingAssistant();
      currentTurnIndex += 1;
      currentUserTimestamp = readEntryTimestamp(entry);
      continue;
    }

    const assistantText = extractClaudeAssistantText(entry);
    if (!assistantText || currentTurnIndex < 0) {
      continue;
    }

    pendingAssistantContent += assistantText;
    pendingAssistantTerminal =
      pendingAssistantTerminal || isTerminalAssistantStopReason(readAssistantStopReason(entry));
    pendingAssistantTimestamp = readEntryTimestamp(entry) ?? pendingAssistantTimestamp;
  }

  flushPendingAssistant();
  return turns;
}

export async function readClaudeNativeVisibleAssistantTurnsFile(
  filePath: string,
): Promise<ClaudeNativeVisibleAssistantTurn[]> {
  const records = await readJsonLinesFile(filePath);
  return parseClaudeNativeVisibleAssistantTurns(records);
}

function extractClaudeSystemDiagnosticText(entry: JsonLineRecord): string | null {
  if (entry.type !== "system") {
    return null;
  }

  const level = readTrimmedString(entry.level);
  const subtype = readTrimmedString(entry.subtype);
  if (level !== "warning" && subtype !== "local_command") {
    return null;
  }

  const content = readTrimmedString(entry.content);
  if (content) {
    // Bugfix: Claude Code 2.1.148 会把未知 slash command 写成
    // system/local_command/info，并将错误包在 local-command-stdout 标签内。
    // 这里只剥标签保留诊断文本，避免继续落到泛化“Agent 未产生任何回复”。
    return sanitizeClaudeDiagnosticText(content);
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const messageContent = readTrimmedString(message?.content);
  return messageContent ? sanitizeClaudeDiagnosticText(messageContent) : null;
}

export function parseClaudeNativeUnknownCommandWarnings(
  records: readonly JsonLineRecord[],
): ClaudeNativeUnknownCommandWarning[] {
  const warnings: ClaudeNativeUnknownCommandWarning[] = [];

  for (const entry of records) {
    const text = extractClaudeSystemDiagnosticText(entry);
    if (!text) {
      continue;
    }

    const timestamp = readEntryTimestamp(entry);
    const unknownCommandMatch = text.match(CLAUDE_NATIVE_UNKNOWN_COMMAND_RE);
    if (unknownCommandMatch?.[1]) {
      warnings.push({
        command: unknownCommandMatch[1],
        ...(timestamp !== undefined ? { timestamp } : {}),
      });
      continue;
    }

    const argsMatch = text.match(CLAUDE_NATIVE_UNKNOWN_SKILL_ARGS_RE);
    const latest = warnings.at(-1);
    if (!argsMatch?.[1] || !latest || latest.args) {
      continue;
    }

    const latestTimestamp = latest.timestamp;
    const isSameWarningGroup =
      timestamp === undefined ||
      latestTimestamp === undefined ||
      Math.abs(timestamp - latestTimestamp) <= CLAUDE_NATIVE_UNKNOWN_COMMAND_ARGS_MAX_GAP_MS;
    if (isSameWarningGroup) {
      // Bugfix: Claude Code 对未知 slash command 会拆成两条 system warning：
      // 一条写命令名，一条写参数。这里合并后才能给 ZCode 用户展示可操作的失败原因。
      latest.args = argsMatch[1].trim();
    }
  }

  return warnings;
}

export function selectClaudeNativeUnknownCommandWarningAfter(
  warnings: readonly ClaudeNativeUnknownCommandWarning[],
  lowerBoundMs: number,
): ClaudeNativeUnknownCommandWarning | null {
  const minTimestamp = lowerBoundMs - CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS;
  const candidates = warnings.filter((warning) => {
    return warning.timestamp === undefined || warning.timestamp >= minTimestamp;
  });
  const strictCandidates = candidates.filter((warning) => {
    return warning.timestamp === undefined || warning.timestamp >= lowerBoundMs;
  });
  return strictCandidates[0] ?? candidates.at(-1) ?? null;
}

export async function readClaudeNativeUnknownCommandWarningsFile(
  filePath: string,
): Promise<ClaudeNativeUnknownCommandWarning[]> {
  const records = await readJsonLinesFile(filePath);
  return parseClaudeNativeUnknownCommandWarnings(records);
}

export async function parseClaudeNativeSessionFile(params: {
  filePath: string;
  workspacePath: string;
  sessionId: string;
  sourcePath?: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): Promise<ClaudeNativeImportedSessionSource> {
  const [records, sourceStat] = await Promise.all([
    readJsonLinesFile(params.filePath),
    stat(params.filePath),
  ]);

  return parseClaudeNativeSessionRecords({
    records,
    workspacePath: params.workspacePath,
    sessionId: params.sessionId,
    sourcePath: params.sourcePath ?? params.filePath,
    fallbackCreatedAt: params.fallbackCreatedAt ?? Math.trunc(sourceStat.birthtimeMs),
    fallbackUpdatedAt: params.fallbackUpdatedAt ?? Math.trunc(sourceStat.mtimeMs),
  });
}
