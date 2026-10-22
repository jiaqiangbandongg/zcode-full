import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import {
  createFileSystemError,
  type FileSystemLineEndings,
  type FileSystemTextEncoding,
} from "@zcode/contracts";
import iconv from "iconv-lite";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const LEGACY_CHINESE_ENCODINGS = ["gb2312", "gbk", "gb18030"] as const;
const BINARY_CONTROL_BYTE_THRESHOLD = 0.3;
const MAX_DETECTION_TRAILING_DROP_BYTES = 3;
const MAX_UTF8_SEQUENCE_BYTES = 4;
const NON_TEXT_ENCODINGS = new Set(["base64", "base64url", "hex"]);

type LegacyChineseEncoding = (typeof LEGACY_CHINESE_ENCODINGS)[number];

interface DecodedTextBuffer {
  content: string;
  encoding: FileSystemTextEncoding;
}

interface StreamingTextDecoder {
  write(buffer: Buffer): string;
  end(): string;
}

export function detectTextEncoding(buffer: Buffer, path?: string): FileSystemTextEncoding {
  if (buffer.length >= 3 && bytesStartWith(buffer, UTF8_BOM)) {
    return "utf8";
  }
  if (buffer.length >= 2 && bytesStartWith(buffer, UTF16LE_BOM)) {
    return "utf16le";
  }
  if (looksLikeBinary(buffer)) {
    throw createUnsupportedTextEncodingError(path);
  }
  if (isValidUtf8(buffer)) {
    return "utf8";
  }
  for (const encoding of LEGACY_CHINESE_ENCODINGS) {
    if (roundTripsWithOptionalTrailingDrop(buffer, encoding)) {
      return encoding;
    }
  }
  throw createUnsupportedTextEncodingError(path);
}

export function decodeTextBuffer(request: {
  buffer: Buffer;
  encoding?: FileSystemTextEncoding;
  path?: string;
}): DecodedTextBuffer {
  const encoding = request.encoding ?? detectTextEncoding(request.buffer, request.path);
  return {
    content: decodeBufferWithEncoding(request.buffer, encoding),
    encoding,
  };
}

export function encodeTextContent(request: {
  content: string;
  encoding?: FileSystemTextEncoding;
  path?: string;
}): Buffer {
  const encoding = request.encoding ?? "utf8";
  if (isLegacyChineseEncoding(encoding)) {
    const encoded = iconv.encode(request.content, encoding);
    assertLegacyEncodingRoundTrip({
      decoded: request.content,
      encoded,
      encoding,
      path: request.path,
    });
    return encoded;
  }
  return Buffer.from(request.content, encoding);
}

export function createStreamingTextDecoder(encoding: FileSystemTextEncoding): StreamingTextDecoder {
  if (isLegacyChineseEncoding(encoding)) {
    const decoder = iconv.getDecoder(encoding);
    return {
      write(buffer) {
        return decoder.write(buffer);
      },
      end() {
        return decoder.end() ?? "";
      },
    };
  }
  const decoder = new StringDecoder(encoding);
  return {
    write(buffer) {
      return decoder.write(buffer);
    },
    end() {
      return decoder.end();
    },
  };
}

export function shouldNormalizeLineEndings(encoding: FileSystemTextEncoding): boolean {
  return !NON_TEXT_ENCODINGS.has(normalizeEncodingName(encoding));
}

function decodeBufferWithEncoding(buffer: Buffer, encoding: FileSystemTextEncoding): string {
  if (isLegacyChineseEncoding(encoding)) {
    return iconv.decode(buffer, encoding);
  }
  return buffer.toString(encoding);
}

function assertLegacyEncodingRoundTrip(request: {
  decoded: string;
  encoded: Buffer;
  encoding: LegacyChineseEncoding;
  path?: string;
}): void {
  if (iconv.decode(request.encoded, request.encoding) === request.decoded) return;
  throw createFileSystemError({
    code: "unsupported",
    path: request.path,
    message: `Content cannot be encoded as ${request.encoding}${
      request.path ? `: ${request.path}` : ""
    }`,
  });
}

function roundTripsWithOptionalTrailingDrop(
  buffer: Buffer,
  encoding: LegacyChineseEncoding,
): boolean {
  if (buffer.length === 0) return true;
  for (
    let drop = 0;
    drop <= Math.min(MAX_DETECTION_TRAILING_DROP_BYTES, buffer.length);
    drop += 1
  ) {
    const candidate = drop === 0 ? buffer : buffer.subarray(0, buffer.length - drop);
    if (candidate.length === 0) continue;
    const decoded = iconv.decode(candidate, encoding);
    const encoded = iconv.encode(decoded, encoding);
    if (encoded.equals(candidate)) return true;
  }
  return false;
}

export function getUtf8CompletionBytes(buffer: Buffer): number {
  // 这里只计算尾部候选所缺的字节；补齐后仍须严格校验，不能据此确认编码。
  let start = buffer.length - 1;
  const earliestStart = Math.max(0, buffer.length - MAX_UTF8_SEQUENCE_BYTES);
  while (start > earliestStart && (buffer[start]! & 0xc0) === 0x80) start -= 1;
  const lead = buffer[start];
  if (lead === undefined) return 0;
  const sequenceBytes =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  return Math.max(0, sequenceBytes - (buffer.length - start));
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    // stream 模式会把 GBK 的 D6 暂存为 UTF-8 候选；必须补齐后严格校验，拒绝 D6 D0 等非法序列。
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function looksLikeBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let controlBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      controlBytes += 1;
    }
  }
  return controlBytes / buffer.length > BINARY_CONTROL_BYTE_THRESHOLD;
}

function bytesStartWith(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

function isLegacyChineseEncoding(
  encoding: FileSystemTextEncoding,
): encoding is LegacyChineseEncoding {
  return LEGACY_CHINESE_ENCODINGS.includes(encoding as LegacyChineseEncoding);
}

function normalizeEncodingName(encoding: FileSystemTextEncoding): string {
  return encoding.toLowerCase();
}

function createUnsupportedTextEncodingError(path?: string): Error {
  return createFileSystemError({
    code: "unsupported",
    path,
    message: `Unsupported or binary text encoding${path ? `: ${path}` : ""}`,
  });
}

export function detectLineEndings(content: string): FileSystemLineEndings {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    if (index > 0 && content[index - 1] === "\r") {
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}

export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

export function applyRequestedLineEndings(
  content: string,
  lineEndings: FileSystemLineEndings | undefined,
): string {
  if (lineEndings === undefined) {
    return content;
  }
  const normalized = normalizeLineEndings(content);
  return lineEndings === "CRLF" ? normalized.split("\n").join("\r\n") : normalized;
}
