import {
  CoreErrorType,
  READ_DEFAULT_MAX_LINES,
  READ_MAX_FILE_SIZE_BYTES,
  READ_MAX_OUTPUT_TOKENS,
  createCoreError,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type ReadTextOutput,
  type TraceContext,
} from "@zcode/contracts";

import { estimateTokens } from "../../context/utils.js";

const EMPTY_FILE_REMINDER = formatReadToolResultWarning(
  "Warning: the file exists but the contents are empty.",
);
const READ_TOKEN_BUDGET_PARTIAL_TARGET = Math.floor(READ_MAX_OUTPUT_TOKENS * 0.85);

export interface ReadTextFileForModelOptions {
  abortSignal?: AbortSignal;
  allowPartialFallback?: boolean;
  filePath: string;
  fileSystemPort: FileSystemPort;
  limit?: number;
  onRead?: (read: FileSystemReadTextRangeResult) => void;
  offset?: number;
  trace?: TraceContext;
}

export async function readTextFileForModel({
  abortSignal,
  allowPartialFallback,
  filePath,
  fileSystemPort,
  limit,
  onRead,
  offset,
  trace,
}: ReadTextFileForModelOptions): Promise<ReadTextOutput> {
  const limitProvided = limit !== undefined;
  const read = await fileSystemPort.readTextFileRange(
    {
      path: filePath,
      offsetLine: toRangeOffsetLine(offset),
      limitLines: limit,
      maxBytes: limitProvided ? undefined : READ_MAX_FILE_SIZE_BYTES,
      trace,
    },
    { signal: abortSignal },
  );
  onRead?.(read);

  return readTextRangeResultToOutput({
    allowPartialFallback: allowPartialFallback ?? isInitialWholeFileRead(offset, limit),
    filePath,
    offset,
    read,
  });
}

export function formatReadTextOutput(output: ReadTextOutput): string {
  const partialViewPrefix = output.partialViewNotice
    ? `${formatReadToolResultWarning(output.partialViewNotice)}\n\n`
    : "";

  if (!output.content) {
    const warning =
      output.totalLines === 0
        ? EMPTY_FILE_REMINDER
        : formatReadToolResultWarning(
            `Warning: the file exists but is shorter than the provided offset (${output.startLine}). The file has ${output.totalLines} lines.`,
          );
    return `${partialViewPrefix}${warning}`;
  }

  // 成功文本结果的模型可见契约只包含条件提醒与带行号正文；
  // 历史安全提醒不属于当前 tool result 路径。
  return `${partialViewPrefix}${addReadLineNumbers({
    content: output.content,
    startLine: output.startLine,
  })}`;
}

export function addReadLineNumbers({
  content,
  startLine,
}: {
  content: string;
  startLine: number;
}): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + startLine}\t${line}`)
    .join("\n");
}

function formatReadToolResultWarning(body: string): string {
  return `<system-reminder>${body}</system-reminder>`;
}

function toRangeOffsetLine(offset: number | undefined): number {
  if (offset === undefined || offset <= 1) return 0;
  return offset - 1;
}

function isInitialWholeFileRead(offset: number | undefined, limit: number | undefined): boolean {
  return (offset === undefined || offset <= 1) && limit === undefined;
}

function readTextRangeResultToOutput({
  allowPartialFallback,
  filePath,
  offset,
  read,
}: {
  allowPartialFallback: boolean;
  filePath: string;
  offset?: number;
  read: FileSystemReadTextRangeResult;
}): ReadTextOutput {
  const tokenCount = estimateTokens(read.content);
  if (tokenCount > READ_MAX_OUTPUT_TOKENS) {
    if (!allowPartialFallback) {
      throwReadOutputTokenBudgetError(tokenCount, filePath);
    }
    const fallback = createTokenCapPartialView(read, tokenCount);
    if (fallback) return { filePath, type: "text", ...fallback };
    throwReadOutputTokenBudgetError(tokenCount, filePath);
  }

  return normalizeReadTextOutput({
    type: "text",
    filePath,
    content: read.content,
    numLines: read.lineCount,
    startLine: offset === 0 ? 0 : read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    truncated: read.truncated,
  });
}

function normalizeReadTextOutput(output: ReadTextOutput): ReadTextOutput {
  if (
    output.content.length === 0 &&
    output.numLines === 0 &&
    output.startLine === 1 &&
    output.totalLines === 0
  ) {
    return {
      ...output,
      numLines: 1,
      totalLines: 1,
    };
  }
  return output;
}

function createTokenCapPartialView(
  read: FileSystemReadTextRangeResult,
  tokenCount: number,
): Omit<ReadTextOutput, "filePath" | "type"> | undefined {
  const lines = read.content.split(/\r?\n/);
  if (lines.length === 0) return undefined;

  const lineCount = findLargestPrefixWithinTokenBudget(lines);
  if (lineCount > 0) {
    const content = lines.slice(0, lineCount).join("\n");
    const startLine = read.startLine;
    const endLine = startLine + lineCount - 1;
    const nextOffset = endLine + 1;
    return {
      content,
      numLines: lineCount,
      startLine,
      totalLines: read.totalLines,
      sizeBytes: read.sizeBytes,
      bytesRead: read.bytesRead,
      truncated: true,
      truncatedByTokenCap: true,
      partialViewNotice: [
        `The file is too large to display in full (${tokenCount} estimated tokens, limit ${READ_MAX_OUTPUT_TOKENS}).`,
        `Showing a partial view of lines ${startLine}-${endLine} of ${read.totalLines}.`,
        `Use Read with offset ${nextOffset} and limit ${READ_DEFAULT_MAX_LINES} to continue, or use a search tool to find a specific section.`,
      ].join(" "),
    };
  }

  const charCount = findLargestPrefixCharsWithinTokenBudget(read.content);
  if (charCount <= 0) return undefined;
  return {
    content: read.content.slice(0, charCount),
    numLines: 1,
    startLine: read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    truncated: true,
    truncatedByTokenCap: true,
    partialViewNotice: [
      `The file is too large to display in full (${tokenCount} estimated tokens, limit ${READ_MAX_OUTPUT_TOKENS}).`,
      "Showing a partial view of the first line because the first line alone exceeds the token budget.",
      "Use Read with a smaller range or use a search tool to find a specific section.",
    ].join(" "),
  };
}

function findLargestPrefixWithinTokenBudget(lines: readonly string[]): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(lines.slice(0, mid).join("\n")) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function findLargestPrefixCharsWithinTokenBudget(content: string): number {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(content.slice(0, mid)) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function throwReadOutputTokenBudgetError(tokenCount: number, filePath: string): never {
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${READ_MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    {
      context: {
        code: "read_output_too_many_tokens",
        filePath,
        maxTokens: READ_MAX_OUTPUT_TOKENS,
        tokenCount,
      },
      recoverable: true,
    },
  );
}
