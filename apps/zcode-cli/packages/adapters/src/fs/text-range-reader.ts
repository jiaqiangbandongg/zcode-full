import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  createFileSystemError,
  type FileSystemTextEncoding,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
} from "@zcode/contracts";
import {
  createStreamingTextDecoder,
  decodeTextBuffer,
  detectLineEndings,
  detectTextEncoding,
  getUtf8CompletionBytes,
  normalizeLineEndings,
  shouldNormalizeLineEndings,
} from "./text-metadata.js";

const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024;
const ENCODING_SAMPLE_BYTES = 4096;

export async function readTextFileRangeFromNode(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  throwIfAborted(signal);
  assertWithinMaxBytes(request.path, info.size, request.maxBytes);

  if (info.size <= FAST_PATH_MAX_BYTES) {
    return readRangeFast(request, info, signal);
  }

  return readRangeStreaming(request, info, signal);
}

function assertWithinMaxBytes(path: string, sizeBytes: number, maxBytes: number | undefined): void {
  if (maxBytes === undefined || sizeBytes <= maxBytes) return;
  throw createFileSystemError({
    code: "too_large",
    path,
    message: `File content (${formatFileSize(sizeBytes)}) exceeds maximum allowed size (${formatFileSize(maxBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
  });
}

async function readRangeFast(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  throwIfAborted(signal);
  const buffer = await readFile(request.path);
  throwIfAborted(signal);
  const decoded = decodeTextBuffer({
    buffer,
    encoding: request.encoding,
    path: request.path,
  });
  const encoding = decoded.encoding;
  const rawContent = decoded.content;
  const isText = shouldNormalizeLineEndings(encoding);
  const normalized = isText ? normalizeLineEndings(rawContent) : rawContent;
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  const offsetLine = normalizeOffsetLine(request.offsetLine);
  const selectedLines = selectLines(lines, offsetLine, request.limitLines);

  return {
    path: request.path,
    content: selectedLines.join("\n"),
    encoding,
    lineEndings: isText ? detectLineEndings(rawContent) : undefined,
    bytesRead: buffer.byteLength,
    sizeBytes: info.size,
    truncated: false,
    startLine: offsetLine + 1,
    lineCount: selectedLines.length,
    totalLines: lines.length,
    revision: {
      id: revisionId(info.mtimeMs, info.size),
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    },
  };
}

async function readRangeStreaming(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  const encoding = request.encoding ?? (await detectEncodingFromHead(request.path, signal));
  const decoder = createStreamingTextDecoder(encoding);
  const selectedLines: string[] = [];
  const offsetLine = normalizeOffsetLine(request.offsetLine);
  const limitLines = normalizeLimitLines(request.limitLines);
  let carry = "";
  let lineIndex = 0;
  let bytesRead = 0;
  let crlfCount = 0;
  let lfCount = 0;
  let sawAnyBytes = false;

  const stream = createReadStream(request.path);
  const abort = (): void => {
    stream.destroy(createAbortError(request.path));
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sawAnyBytes = sawAnyBytes || buffer.byteLength > 0;
      bytesRead += buffer.byteLength;
      const text = decoder.write(buffer);
      const parts = `${carry}${text}`.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        const normalized = normalizeCompletedLine(part);
        if (part.endsWith("\r")) crlfCount += 1;
        else lfCount += 1;
        if (shouldSelectLine(lineIndex, offsetLine, limitLines, selectedLines.length)) {
          selectedLines.push(normalized);
        }
        lineIndex += 1;
      }
    }

    const finalText = decoder.end();
    if (finalText.length > 0) {
      carry += finalText;
    }
    if (sawAnyBytes) {
      const normalized = normalizeCompletedLine(carry);
      if (shouldSelectLine(lineIndex, offsetLine, limitLines, selectedLines.length)) {
        selectedLines.push(normalized);
      }
      lineIndex += 1;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  return {
    path: request.path,
    content: selectedLines.join("\n"),
    encoding,
    lineEndings: crlfCount > lfCount ? "CRLF" : "LF",
    bytesRead,
    sizeBytes: info.size,
    truncated: false,
    startLine: offsetLine + 1,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    revision: {
      id: revisionId(info.mtimeMs, info.size),
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    },
  };
}

async function detectEncodingFromHead(
  path: string,
  signal?: AbortSignal,
): Promise<FileSystemTextEncoding> {
  throwIfAborted(signal);
  const handle = await open(path, "r");
  try {
    let sample = Buffer.alloc(ENCODING_SAMPLE_BYTES);
    let totalBytesRead = 0;
    while (totalBytesRead < sample.byteLength) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(
        sample,
        totalBytesRead,
        sample.byteLength - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
      if (totalBytesRead === ENCODING_SAMPLE_BYTES) {
        // 样本可能切在 UTF-8 字符中间；只补足当前候选，固定扩样会再次切开后一个字符。
        const missingBytes = getUtf8CompletionBytes(sample);
        if (missingBytes > 0) sample = Buffer.concat([sample, Buffer.alloc(missingBytes)]);
      }
    }
    throwIfAborted(signal);
    return detectTextEncoding(sample.subarray(0, totalBytesRead), path);
  } finally {
    await handle.close();
  }
}

function normalizeOffsetLine(offsetLine: number | undefined): number {
  return Math.max(0, Math.trunc(offsetLine ?? 0));
}

function normalizeLimitLines(limitLines: number | undefined): number | undefined {
  if (limitLines === undefined) return undefined;
  return Math.max(0, Math.trunc(limitLines));
}

function selectLines(
  lines: string[],
  offsetLine: number,
  limitLines: number | undefined,
): string[] {
  const limit = normalizeLimitLines(limitLines);
  return limit === undefined
    ? lines.slice(offsetLine)
    : lines.slice(offsetLine, offsetLine + limit);
}

function shouldSelectLine(
  lineIndex: number,
  offsetLine: number,
  limitLines: number | undefined,
  selectedCount: number,
): boolean {
  if (lineIndex < offsetLine) return false;
  return limitLines === undefined || selectedCount < limitLines;
}

function normalizeCompletedLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatUnit(bytes / 1024)}KB`;
  return `${formatUnit(bytes / (1024 * 1024))}MB`;
}

function formatUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError("file range read");
}

function createAbortError(path: string): Error {
  const error = new Error(`File system operation was cancelled: ${path}`);
  error.name = "AbortError";
  return error;
}
