import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

/**
 * 只提取这些键（或前缀），避免把 dump 里的其它字符串当注解误报。
 * `v8-oom-*` 是 V8 在 FatalProcessOutOfMemory 时写入 crashpad 的堆快照注解；
 * process_type / ptype / pid / renderer_foreground 来自 Chromium 的 simple annotations。
 */
const ANNOTATION_KEY_PREFIXES = [
  "v8-oom-",
  "process_type",
  "ptype",
  "pid",
  "renderer_foreground",
] as const;
const MAX_ANNOTATION_KEY_LENGTH = 64;
const MAX_ANNOTATION_VALUE_LENGTH = 64 * 1024;
/** 超过这个大小的 dump 不在主进程同步读取解析。 */
export const CRASH_DUMP_ANNOTATION_MAX_BYTES = 64 * 1024 * 1024;

const CODE_CAGE_EXHAUSTED_THRESHOLD_BYTES = 4 * 1024 * 1024;
const JS_HEAP_EXHAUSTED_THRESHOLD_BYTES = 1024 * 1024 * 1024;
const STACK_HEAD_LINES = 8;
const STACK_LINE_MAX_LENGTH = 160;
const GC_MESSAGE_MAX_LENGTH = 240;
const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
};

export type CrashDumpAnnotations = Record<string, string>;

export type CrashDumpOomKind = "code_space_exhausted" | "js_heap_exhausted" | "unknown";

export interface CrashDumpV8OomSummary {
  processType: string | null;
  location: string;
  /**
   * code_space_exhausted：256MB JIT 代码区（code cage）用尽，old-space 通常还有大量空闲，
   * 典型来源是长期持有的巨型正则原生代码；js_heap_exhausted：普通 JS 堆撞上限。
   */
  oomKind: CrashDumpOomKind;
  isMainIsolate: boolean | null;
  isolateCount: number | null;
  oldSpaceBytes: number | null;
  oldSpaceCapacityBytes: number | null;
  codeSpaceBytes: number | null;
  codeLargeObjectSpaceBytes: number | null;
  codeCageSizeBytes: number | null;
  codeCageFreeBytes: number | null;
  codeCageLastAllocStatus: string | null;
  mainCageFreeBytes: number | null;
  mainCageLastAllocStatus: string | null;
  trustedCageFreeBytes: number | null;
  memoryAllocatorBytes: number | null;
  mallocedPeakBytes: number | null;
  stackHead: string[];
  lastGcMessage: string | null;
}

function isPrintableAscii(byte: number): boolean {
  return byte >= 0x21 && byte <= 0x7e;
}

function alignUp4(offset: number): number {
  return (offset + 3) & ~3;
}

function isReadableText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) {
      return false;
    }
  }
  return true;
}

function readAnnotationAt(buffer: Buffer, index: number): { key: string; value: string } | null {
  if (index < 4) {
    return null;
  }
  let end = index;
  while (end < buffer.length && end - index < MAX_ANNOTATION_KEY_LENGTH && buffer[end] !== 0) {
    if (!isPrintableAscii(buffer[end]!)) {
      return null;
    }
    end += 1;
  }
  if (end >= buffer.length || buffer[end] !== 0) {
    return null;
  }
  const keyLength = end - index;
  if (keyLength === 0 || buffer.readUInt32LE(index - 4) !== keyLength) {
    return null;
  }
  const valueLengthOffset = alignUp4(end + 1);
  if (valueLengthOffset + 4 > buffer.length) {
    return null;
  }
  const valueLength = buffer.readUInt32LE(valueLengthOffset);
  const valueStart = valueLengthOffset + 4;
  if (valueLength > MAX_ANNOTATION_VALUE_LENGTH || valueStart + valueLength > buffer.length) {
    return null;
  }
  let valueEnd = valueStart + valueLength;
  while (valueEnd > valueStart && buffer[valueEnd - 1] === 0) {
    valueEnd -= 1;
  }
  const value = buffer.toString("utf8", valueStart, valueEnd);
  if (!isReadableText(value)) {
    return null;
  }
  return { key: buffer.toString("latin1", index, end), value };
}

/**
 * Crashpad 把注解写成 MinidumpUTF8String(name) + MinidumpByteArray(value)，两者都是
 * `u32 长度 + 内容`（UTF8String 额外带 NUL 结尾），按 4 字节对齐；simple annotations 的
 * key/value 也是同样的 UTF8String 布局。这里不解析完整 minidump 目录，只按已知键名定位并
 * 校验长度前缀，格式对不上就跳过，绝不抛出。同一个键只取第一次出现的值。
 */
export function extractCrashDumpAnnotations(dump: Uint8Array): CrashDumpAnnotations {
  const buffer = Buffer.isBuffer(dump)
    ? dump
    : Buffer.from(dump.buffer, dump.byteOffset, dump.byteLength);
  const annotations: CrashDumpAnnotations = {};
  for (const prefix of ANNOTATION_KEY_PREFIXES) {
    const needle = Buffer.from(prefix, "latin1");
    let from = 0;
    while (from < buffer.length) {
      const index = buffer.indexOf(needle, from);
      if (index < 0) {
        break;
      }
      from = index + 1;
      const entry = readAnnotationAt(buffer, index);
      if (entry && !(entry.key in annotations)) {
        annotations[entry.key] = entry.value;
      }
    }
  }
  return annotations;
}

/**
 * 超过大小上限的 dump 不在主进程同步读取；读取或解析失败一律返回空对象，
 * 取证信息缺失不能阻断 dump 归档。
 */
export function readCrashDumpAnnotationsFromFile(
  dumpPath: string,
  sizeBytes: number,
): CrashDumpAnnotations {
  if (sizeBytes > CRASH_DUMP_ANNOTATION_MAX_BYTES) {
    return {};
  }
  try {
    return extractCrashDumpAnnotations(readFileSync(dumpPath));
  } catch {
    return {};
  }
}

/** 解析 V8 注解里的 "284.93MB" / "0B" / "1023.94KB" 这类大小文本，单位按 1024 进位。 */
export function parseV8SizeAnnotation(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)\s*$/i.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = SIZE_UNITS[match[2]!.toUpperCase()];
  if (!Number.isFinite(amount) || unit === undefined) {
    return null;
  }
  return Math.round(amount * unit);
}

function parseIntegerAnnotation(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanAnnotation(value: string | undefined): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function resolveOomKind(summary: {
  codeCageSizeBytes: number | null;
  codeCageFreeBytes: number | null;
  codeCageLastAllocStatus: string | null;
  mainCageLastAllocStatus: string | null;
  oldSpaceBytes: number | null;
}): CrashDumpOomKind {
  if (
    (summary.codeCageLastAllocStatus && /ran out/i.test(summary.codeCageLastAllocStatus)) ||
    (summary.codeCageSizeBytes !== null &&
      summary.codeCageFreeBytes !== null &&
      summary.codeCageFreeBytes < CODE_CAGE_EXHAUSTED_THRESHOLD_BYTES)
  ) {
    return "code_space_exhausted";
  }
  if (
    (summary.mainCageLastAllocStatus && summary.mainCageLastAllocStatus !== "success") ||
    (summary.oldSpaceBytes !== null && summary.oldSpaceBytes >= JS_HEAP_EXHAUSTED_THRESHOLD_BYTES)
  ) {
    return "js_heap_exhausted";
  }
  return "unknown";
}

/** 没有 `v8-oom-location` 说明不是 V8 OOM（例如 GPU/native 崩溃），返回 null。 */
export function summarizeCrashDumpAnnotations(
  annotations: CrashDumpAnnotations,
): CrashDumpV8OomSummary | null {
  const location = annotations["v8-oom-location"];
  if (!location) {
    return null;
  }
  const codeCageSizeBytes = parseV8SizeAnnotation(annotations["v8-oom-code-cage-size"]);
  const codeCageFreeBytes = parseV8SizeAnnotation(annotations["v8-oom-code-cage-free-size"]);
  const codeCageLastAllocStatus = annotations["v8-oom-code-cage-last-alloc-status"] ?? null;
  const mainCageLastAllocStatus = annotations["v8-oom-main-cage-last-alloc-status"] ?? null;
  const oldSpaceBytes = parseV8SizeAnnotation(annotations["v8-oom-old-space-size"]);
  const stackLines = (annotations["v8-oom-stack"] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const gcLines = (annotations["v8-oom-last-few-messages"] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastGcLine = gcLines.at(-1);

  return {
    processType: annotations.process_type ?? annotations.ptype ?? null,
    location,
    oomKind: resolveOomKind({
      codeCageSizeBytes,
      codeCageFreeBytes,
      codeCageLastAllocStatus,
      mainCageLastAllocStatus,
      oldSpaceBytes,
    }),
    isMainIsolate: parseBooleanAnnotation(annotations["v8-oom-is-main-isolate"]),
    isolateCount: parseIntegerAnnotation(annotations["v8-oom-isolate-count"]),
    oldSpaceBytes,
    oldSpaceCapacityBytes: parseV8SizeAnnotation(annotations["v8-oom-old-space-capacity"]),
    codeSpaceBytes: parseV8SizeAnnotation(annotations["v8-oom-code-space-size"]),
    codeLargeObjectSpaceBytes: parseV8SizeAnnotation(annotations["v8-oom-code-lo-space-size"]),
    codeCageSizeBytes,
    codeCageFreeBytes,
    codeCageLastAllocStatus,
    mainCageFreeBytes: parseV8SizeAnnotation(annotations["v8-oom-main-cage-free-size"]),
    mainCageLastAllocStatus,
    trustedCageFreeBytes: parseV8SizeAnnotation(annotations["v8-oom-trusted-cage-free-size"]),
    memoryAllocatorBytes: parseV8SizeAnnotation(annotations["v8-oom-memory-allocator-size"]),
    mallocedPeakBytes: parseV8SizeAnnotation(annotations["v8-oom-malloced-peak-memory"]),
    stackHead: stackLines
      .slice(0, STACK_HEAD_LINES)
      .map((line) => truncate(line, STACK_LINE_MAX_LENGTH)),
    lastGcMessage: lastGcLine ? truncate(lastGcLine, GC_MESSAGE_MAX_LENGTH) : null,
  };
}
