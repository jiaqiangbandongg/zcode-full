/* eslint-disable max-lines -- 导出日志流程涉及文件收集、脱敏与打包，集中维护便于排查与一致性 */
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

import {
  createFeedbackDiagnosticArchive,
  getAppConfigDir,
  getExportLogDir as getDefaultExportLogDir,
  getExportLogStageDir as getDefaultExportLogStageDir,
  getFeedbackLogArchiveDir as getDefaultFeedbackLogArchiveDir,
} from "@zcode/services/node";
import { createAboutSnapshot, formatAboutDetail, readBuildMetadata } from "./about.js";
import { logger } from "./logger.js";

function getZCodeDataDir() {
  return getAppConfigDir();
}

function getZCodeCliDir() {
  return join(homedir(), ".zcode", "cli");
}

function getZCodeCliLogDir() {
  return join(getZCodeCliDir(), "log");
}

/**
 * Computer Use Helper 的运行目录。macOS 上 Helper 由 LaunchServices 启动，stderr 被系统丢弃，
 * 所以它把生命周期与后台输入诊断 tee 到 `<socket>.exit.log`（见 zcode-cua
 * helperExitLogPathFor）。同目录下还有 `.tokens` broker 凭据，收集时必须按文件名白名单。
 */
function getCuaHelperRunDir() {
  return join(homedir(), ".zcode", "computer-use", "run");
}

function isCuaHelperDiagnosticFileName(fileName: string): boolean {
  return fileName.endsWith(".exit.log");
}

interface LogArchiveFileEntry {
  absolutePath: string;
  archivePath: string;
}

interface LogArchiveArtifacts {
  files: LogArchiveFileEntry[];
  aboutContent: string;
}

interface CreateLogArchiveArtifactsOptions {
  now?: () => Date;
  lookbackDays?: number;
}

interface LogArchiveSkippedFileEntry {
  absolutePath: string;
  archivePath: string;
  error: string;
}

interface ExportLogsDependencies {
  now?: () => Date;
  getZCodeDataDir?: () => string;
  getExportLogStageDir?: () => string;
  getExportLogDir?: () => string;
  createLogArchiveArtifacts?: (
    sourceDir: string,
    options?: CreateLogArchiveArtifactsOptions,
  ) => Promise<LogArchiveArtifacts>;
  writeLogArchiveZip?: (
    outputPath: string,
    artifacts: LogArchiveArtifacts,
    options?: WriteLogArchiveZipOptions,
  ) => Promise<void>;
  writeLogArchiveDirectory?: (outputPath: string, artifacts: LogArchiveArtifacts) => Promise<void>;
  showItemInFolder?: (path: string) => Promise<void> | void;
}

interface WriteLogArchiveZipOptions {
  stageRootDir?: string;
}

interface CreateFeedbackLogArchiveFromExportLogsOptions {
  now?: () => Date;
  outputRootDir?: string;
  stageRootDir?: string;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

function formatTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function normalizeArchivePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function escapeRegExp(path: string): string {
  return path.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeArchivePath(pattern);
  return new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
}

/**
 * Glob patterns to exclude from the exported log archive.
 * Each pattern is relative to the source directory being archived.
 */
const ZIP_EXCLUDE_PATTERNS: string[] = [];

const ZIP_EXCLUDE_REGEXES = ZIP_EXCLUDE_PATTERNS.map(globPatternToRegExp);
const RETIRED_ACP_RUNTIME_ARCHIVE_PATHS = [
  "acp-auth",
  "acp-config",
  "acp-stream-diagnostics",
  "acp-traffic-proxy",
] as const;
const HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS = ["dev"] as const;
const DOCSHOT_ARCHIVE_PATH_PREFIXES = ["docshot-backup-"] as const;
const DOCSHOT_ARCHIVE_PATHS = ["docshot-assets"] as const;
const NON_LOG_STATE_ARCHIVE_PATHS = [
  "agent-config",
  "certs",
  "repo-snapshots",
  "repo-wiki",
  "sessions",
  "session-bindings",
  "checkpoints",
] as const;
const SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES = new Set(["credentials.json", ".credentials.json"]);
const EXCLUDED_ARCHIVE_DIRECTORY_NAMES = new Set(["debug"]);
const DEFAULT_LOG_EXPORT_LOOKBACK_DAYS = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const REDACTED_PLACEHOLDER = "***REDACTED***";
// 敏感键名“族”：只要键名里包含这些子串就视为敏感（兜底通配），
// 从而覆盖自定义命名（如 db_password、my_secret、x-conn-string 等）而不必逐个精确列举。
// 注意：`token` / `auth` 等是宽松子串，配合下方白名单排除误伤项（如 input_tokens、author）。
const SENSITIVE_KEY_SUBSTRING_PATTERN = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "credential",
  "api(?:_|-)?key",
  "access(?:_|-)?key",
  "private(?:_|-)?key",
  "auth",
  "cookie",
  "dsn",
  "conn(?:ection)?(?:_|-)?str(?:ing)?",
  "database(?:_|-)?url",
  "db(?:_|-)?url",
].join("|");
const SENSITIVE_KEY_NAME_REGEX = new RegExp(`(?:${SENSITIVE_KEY_SUBSTRING_PATTERN})`, "i");
// 白名单：命中敏感子串但实际并非密钥的常见键名，避免脱掉排障需要的上下文。
// 不能把任意 "*_tokens" 都白名单化，否则 access_tokens/session_tokens 会被原样导出；
// max_tokens/budget_tokens 是模型输出与思考预算，不是凭据，需保留用于判断 provider 请求是否撞限；
// 因此这里只放行明确的 LLM token 计数/预算字段，以及 author/authority 这类含 "auth" 的普通词。
const NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX =
  /^(?:public(?:_|-)?key|keywords?|tokenizer|token(?:_|-)?count|(?:prompt|completion|total|input|output|cached|reasoning|max|budget|accepted(?:_|-)?prediction|rejected(?:_|-)?prediction|tool(?:_|-)?use(?:_|-)?prompt)(?:_|-)?tokens|author(?:s|ity|ed)?)$/i;

function isSensitiveKeyName(keyName: string): boolean {
  if (NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX.test(keyName)) {
    return false;
  }
  return SENSITIVE_KEY_NAME_REGEX.test(keyName);
}

// 以下正则先宽松捕获“键名 + 值”，再由 isSensitiveKeyName 决定是否脱敏，
// 这样键名黑名单不再是硬编码列表，而是“敏感族 + 通配 + 白名单例外”。
const JSON_STYLE_SENSITIVE_VALUE_REGEX =
  /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\r\n}\]]+)/g;
const ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)([^\r\n#]+)/g;
const HEADER_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9-]+)([ \t]*:[ \t]*)([^\r\n]+)/g;
const BEARER_TOKEN_REGEX = /(Bearer\s+)([^\s"']+)/g;
const QUERY_TOKEN_REGEX =
  /([?&](?:key|api(?:_|-)?key|access(?:_|-)?token|refresh(?:_|-)?token|token|password|passwd|pwd|secret|client(?:_|-)?secret|auth(?:_|-)?token|session(?:_|-)?token)=)([^&#\s]+)/gi;
// 按“值形态”脱敏：连接串 scheme://user:pass@host 里的凭据部分，
// 不依赖键名即可覆盖 postgres/mysql/mongodb/redis/amqp 等数据库连接信息。保留 scheme 与 host 便于排障。
// 用户名段允许为空以覆盖 redis://:password@host；口令段贪婪匹配到最后一个 @（host 段不含 @），
// 这样口令里含裸 @（如 P@ssw0rd）也能整段脱敏，不残留片段。
const CONNECTION_STRING_CREDENTIALS_REGEX =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]*):([^/\s]+)@(?=[^@/\s])/gi;
const TEXT_DETECTION_SAMPLE_BYTES = 64 * 1024;
const EMPTY_BOM = Buffer.alloc(0);

type SupportedTextEncoding = "utf-8" | "utf-16le" | "utf-16be";

interface TextFileEncodingInfo {
  encoding: SupportedTextEncoding;
  bomLength: number;
  bomBytes: Buffer;
}

interface TextDecodingScore {
  preferredCharRatio: number;
  invalidCharRatio: number;
}

function redactValue(rawValue: string): string {
  const leadingSpaces = rawValue.match(/^\s*/)?.[0] ?? "";
  const trailingSpaces = rawValue.match(/\s*$/)?.[0] ?? "";
  const core = rawValue.trim();
  const quote =
    core.startsWith('"') && core.endsWith('"')
      ? '"'
      : core.startsWith("'") && core.endsWith("'")
        ? "'"
        : "";
  const redacted = quote ? `${quote}${REDACTED_PLACEHOLDER}${quote}` : REDACTED_PLACEHOLDER;
  return `${leadingSpaces}${redacted}${trailingSpaces}`;
}

function redactHeaderValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+.+$/i, `Bearer ${REDACTED_PLACEHOLDER}`);
  }
  return REDACTED_PLACEHOLDER;
}

function redactConnectionStringCredentials(rawContent: string): string {
  // postgres://admin:secret@host → postgres://***REDACTED***:***REDACTED***@host
  return rawContent.replace(
    CONNECTION_STRING_CREDENTIALS_REGEX,
    (_match, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`,
  );
}

function sanitizeSensitiveLogContent(rawContent: string): string {
  // 导出日志不能按文件原样拷贝：会把用户配置和协议日志里的 token/apiKey 一并带出。
  // 线上排障需要“保留文件结构和上下文”，但不应该泄露密钥本体；
  // 这里在导出阶段统一对常见敏感值做脱敏，字段和日志行仍完整保留，支持继续定位问题。
  // 键名不再是硬编码黑名单，而是“敏感键名族 + 子串通配 + 白名单例外”（isSensitiveKeyName），
  // 并叠加按值形态的连接串脱敏，以覆盖数据库连接串等自定义命名的敏感信息。
  return redactConnectionStringCredentials(rawContent)
    .replace(
      JSON_STYLE_SENSITIVE_VALUE_REGEX,
      (match, quote: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${quote}${keyName}${quote}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${prefix}${keyName}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      HEADER_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, headerName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(headerName)
          ? `${prefix}${headerName}${separator}${redactHeaderValue(rawValue)}`
          : match,
    )
    .replace(BEARER_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`)
    .replace(QUERY_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`);
}

function detectUtf16EncodingByNullPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let evenByteCount = 0;
  let oddByteCount = 0;
  let evenNullCount = 0;
  let oddNullCount = 0;

  for (let index = 0; index < sample.length; index += 1) {
    if (index % 2 === 0) {
      evenByteCount += 1;
      if (sample[index] === 0) {
        evenNullCount += 1;
      }
      continue;
    }

    oddByteCount += 1;
    if (sample[index] === 0) {
      oddNullCount += 1;
    }
  }

  const evenNullRatio = evenNullCount / Math.max(evenByteCount, 1);
  const oddNullRatio = oddNullCount / Math.max(oddByteCount, 1);
  const likelyUtf16Ratio = 0.3;
  const noiseThreshold = 0.1;
  if (oddNullRatio >= likelyUtf16Ratio && evenNullRatio <= noiseThreshold) {
    return "utf-16le";
  }
  if (evenNullRatio >= likelyUtf16Ratio && oddNullRatio <= noiseThreshold) {
    return "utf-16be";
  }
  return null;
}

function isLikelyAsciiTextByte(byteValue: number): boolean {
  return (
    byteValue === 0x09 ||
    byteValue === 0x0a ||
    byteValue === 0x0d ||
    (byteValue >= 0x20 && byteValue <= 0x7e)
  );
}

function isPreferredTextCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20) {
    return true;
  }
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return true;
  }
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
    return true;
  }
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) {
    return true;
  }
  if (codePoint >= 0x3000 && codePoint <= 0x303f) {
    return true;
  }
  if (codePoint >= 0xff00 && codePoint <= 0xffef) {
    return true;
  }
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) {
    return true;
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
    return true;
  }
  return false;
}

function scoreDecodedTextForEncodingDetection(decodedText: string): TextDecodingScore {
  let totalCodePointCount = 0;
  let preferredCodePointCount = 0;
  let invalidCodePointCount = 0;

  for (const character of decodedText) {
    totalCodePointCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      codePoint === 0xfffd ||
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      invalidCodePointCount += 1;
      continue;
    }
    if (isPreferredTextCodePoint(codePoint)) {
      preferredCodePointCount += 1;
    }
  }

  const denominator = Math.max(totalCodePointCount, 1);
  return {
    preferredCharRatio: preferredCodePointCount / denominator,
    invalidCharRatio: invalidCodePointCount / denominator,
  };
}

function detectUtf16EncodingByDecodedTextScore(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  const normalizedSampleLength = sample.length - (sample.length % 2);
  if (normalizedSampleLength < 4) {
    return null;
  }
  const normalizedSample = sample.subarray(0, normalizedSampleLength);

  const utf16LeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16le").decode(normalizedSample),
  );
  const utf16BeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16be").decode(normalizedSample),
  );

  const minimumPreferredCharRatio = 0.55;
  const maximumInvalidCharRatio = 0.2;
  const minimumPreferredCharRatioGap = 0.08;

  const utf16LeQualified =
    utf16LeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16LeScore.invalidCharRatio <= maximumInvalidCharRatio;
  const utf16BeQualified =
    utf16BeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16BeScore.invalidCharRatio <= maximumInvalidCharRatio;

  if (utf16LeQualified && !utf16BeQualified) {
    return "utf-16le";
  }
  if (utf16BeQualified && !utf16LeQualified) {
    return "utf-16be";
  }
  if (!utf16LeQualified && !utf16BeQualified) {
    return null;
  }

  const preferredRatioGap = Math.abs(
    utf16LeScore.preferredCharRatio - utf16BeScore.preferredCharRatio,
  );
  if (preferredRatioGap >= minimumPreferredCharRatioGap) {
    return utf16LeScore.preferredCharRatio > utf16BeScore.preferredCharRatio
      ? "utf-16le"
      : "utf-16be";
  }

  return utf16LeScore.invalidCharRatio <= utf16BeScore.invalidCharRatio ? "utf-16le" : "utf-16be";
}

function isValidUtf8Sample(sample: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function detectUtf16EncodingByAsciiPairPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let utf16LeRunLength = 0;
  let utf16BeRunLength = 0;
  let utf16LeAsciiRunScore = 0;
  let utf16BeAsciiRunScore = 0;

  // CJK 文本里会出现“单个码元低字节刚好是 0”的情况（如 U+4E00），
  // 直接统计 `0x00 + ASCII` 配对会把这些离散噪声误判成另一端字节序。
  // 这里改为统计“连续 ASCII-零字节 run”，只把成段英文 token（api key/header）作为有效信号。
  const flushRunScore = (runLength: number): number => (runLength >= 3 ? runLength : 0);

  for (let index = 0; index + 1 < sample.length; index += 2) {
    const leftByte = sample[index] ?? 0;
    const rightByte = sample[index + 1] ?? 0;

    if (rightByte === 0 && isLikelyAsciiTextByte(leftByte)) {
      utf16LeRunLength += 1;
      utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
      utf16BeRunLength = 0;
      continue;
    }
    if (leftByte === 0 && isLikelyAsciiTextByte(rightByte)) {
      utf16BeRunLength += 1;
      utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
      utf16LeRunLength = 0;
      continue;
    }

    utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
    utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
    utf16LeRunLength = 0;
    utf16BeRunLength = 0;
  }

  utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
  utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);

  const minimumAsciiRunScore = 6;
  const dominanceRatio = 1.5;
  if (
    utf16LeAsciiRunScore >= minimumAsciiRunScore &&
    utf16LeAsciiRunScore >= utf16BeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16le";
  }
  if (
    utf16BeAsciiRunScore >= minimumAsciiRunScore &&
    utf16BeAsciiRunScore >= utf16LeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16be";
  }
  return null;
}

function detectTextFileEncoding(sample: Buffer): TextFileEncodingInfo | null {
  if (sample.length === 0) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return {
      encoding: "utf-8",
      bomLength: 3,
      bomBytes: Buffer.from([0xef, 0xbb, 0xbf]),
    };
  }

  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return {
      encoding: "utf-16le",
      bomLength: 2,
      bomBytes: Buffer.from([0xff, 0xfe]),
    };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return {
      encoding: "utf-16be",
      bomLength: 2,
      bomBytes: Buffer.from([0xfe, 0xff]),
    };
  }

  if (!sample.includes(0) && isValidUtf8Sample(sample)) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  // CJK 占比高的 UTF-16 无 BOM 文本，空字节比例可能很低，
  // 仅靠 null-ratio 会被误判为“非文本”并走原样复制，导致敏感字段漏脱敏。
  // 这里增加“ASCII-零字节对”兜底检测（例如 `OPENAI_API_KEY=\r\n`），覆盖真实日志中的混合文本场景。
  const utf16Encoding =
    detectUtf16EncodingByAsciiPairPattern(sample) ??
    detectUtf16EncodingByNullPattern(sample) ??
    detectUtf16EncodingByDecodedTextScore(sample);
  if (!utf16Encoding) {
    // 无 BOM 且不含空字节的 UTF-16 文本，在纯 CJK 内容里经常出现。
    // 这类样本 UTF-8 fatal decode 会失败；此时按 UTF-8 处理会产生乱码并漏掉敏感字段匹配。
    // 兜底策略：UTF-8 合法则按 UTF-8，非法且无法识别成 UTF-16 时才视为二进制。
    if (isValidUtf8Sample(sample)) {
      return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
    }
    return null;
  }
  return { encoding: utf16Encoding, bomLength: 0, bomBytes: EMPTY_BOM };
}

async function readFileSample(
  absolutePath: string,
  sampleBytes = TEXT_DETECTION_SAMPLE_BYTES,
): Promise<Buffer> {
  const fileHandle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, sampleBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function encodeTextWithEncoding(text: string, encoding: SupportedTextEncoding): Buffer {
  if (encoding === "utf-8") {
    return Buffer.from(text, "utf-8");
  }
  if (encoding === "utf-16le") {
    return Buffer.from(text, "utf16le");
  }
  const encodedBuffer = Buffer.from(text, "utf16le");
  encodedBuffer.swap16();
  return encodedBuffer;
}

function splitByCompleteLine(content: string): {
  completeChunk: string;
  pendingChunk: string;
} {
  const lastLineFeedIndex = content.lastIndexOf("\n");
  if (lastLineFeedIndex >= 0) {
    return {
      completeChunk: content.slice(0, lastLineFeedIndex + 1),
      pendingChunk: content.slice(lastLineFeedIndex + 1),
    };
  }

  const lastCarriageReturnIndex = content.lastIndexOf("\r");
  if (lastCarriageReturnIndex >= 0 && lastCarriageReturnIndex < content.length - 1) {
    return {
      completeChunk: content.slice(0, lastCarriageReturnIndex + 1),
      pendingChunk: content.slice(lastCarriageReturnIndex + 1),
    };
  }

  return { completeChunk: "", pendingChunk: content };
}

function createSensitiveContentSanitizerTransform(encoding: SupportedTextEncoding): Transform {
  const decoder = new TextDecoder(encoding);
  let pendingChunk = "";

  return new Transform({
    transform(chunk, _chunkEncoding, callback) {
      try {
        const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const decodedChunk = decoder.decode(rawChunk, { stream: true });
        const mergedChunk = `${pendingChunk}${decodedChunk}`;
        const { completeChunk, pendingChunk: nextPendingChunk } = splitByCompleteLine(mergedChunk);
        pendingChunk = nextPendingChunk;

        if (completeChunk.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(completeChunk);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        const remainingContent = `${pendingChunk}${decoder.decode()}`;
        if (remainingContent.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(remainingContent);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

async function sanitizeTextLogFileToDestination(
  sourcePath: string,
  destinationPath: string,
  encodingInfo: TextFileEncodingInfo,
): Promise<void> {
  const readStream = createReadStream(sourcePath, {
    start: encodingInfo.bomLength,
  });
  const writeStream = createWriteStream(destinationPath);

  if (encodingInfo.bomLength > 0) {
    writeStream.write(encodingInfo.bomBytes);
  }

  await pipeline(
    readStream,
    createSensitiveContentSanitizerTransform(encodingInfo.encoding),
    writeStream,
  );
}

function isExcludedCachePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return (
    normalizedRelativePath === "Library/Caches" ||
    normalizedRelativePath.startsWith("Library/Caches/")
  );
}

function isRetiredAcpRuntimePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return RETIRED_ACP_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isHighVolumeRuntimeArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isDocshotArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  const firstSegment = normalizedRelativePath.split("/")[0] ?? "";
  if (DOCSHOT_ARCHIVE_PATHS.includes(firstSegment as (typeof DOCSHOT_ARCHIVE_PATHS)[number])) {
    return true;
  }
  return DOCSHOT_ARCHIVE_PATH_PREFIXES.some((prefix) => firstSegment.startsWith(prefix));
}

function isNonLogStateArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return NON_LOG_STATE_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isSensitiveCredentialArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  const fileName = normalizedRelativePath.split("/").at(-1) ?? "";
  return SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES.has(fileName);
}

function isExcludedDirectoryArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  return normalizedRelativePath
    .split("/")
    .some((segment) => EXCLUDED_ARCHIVE_DIRECTORY_NAMES.has(segment));
}

function isExcludedRelativePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  // 完整日志导出过去只做内容脱敏，仍会把 credentials.json 文件本身放进包。
  // 凭据存储文件不是排障日志，且不同提供商可能复用同名文件；因此在收集清单阶段按文件名跳过。
  if (isSensitiveCredentialArchivePath(normalizedRelativePath)) {
    return true;
  }
  // debug 目录通常是模型/运行时高频轨迹，不是用户要交付的日志包材料。
  // 过去显式收集 ~/.zcode/cli/debug 会把这类上下文带进手动导出和反馈完整日志，这里按目录段统一跳过。
  if (isExcludedDirectoryArchivePath(normalizedRelativePath)) {
    return true;
  }
  if (isNonLogStateArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ~/.zcode/v2/dev 保存 stdio-traffic 等高频协议流，真实机器上会累计到 GB 级。
  // 远超反馈附件的大小上限，不应随诊断包带出。
  if (isHighVolumeRuntimeArchivePath(normalizedRelativePath)) {
    return true;
  }
  // docshot 历史备份和素材目录体积可达 GB 级，
  // 且不属于用户反馈所需的诊断日志。
  if (isDocshotArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ACP runtime 目录已退役，老用户数据里仍可能残留数百 MB 抓包和旧鉴权文件。
  // 当前运行态配置已经迁到 agent-config；继续导出这些旧目录会让导出长时间无反馈，还可能带出旧代理证书私钥。
  if (isRetiredAcpRuntimePath(normalizedRelativePath)) {
    return true;
  }
  // Library/Caches 是运行时缓存，不是排障所需日志；导出它只会放大日志包。
  if (isExcludedCachePath(normalizedRelativePath)) {
    return true;
  }

  return ZIP_EXCLUDE_REGEXES.some((pattern) => pattern.test(normalizedRelativePath));
}

function shouldApplyLogExportRetention(archivePath: string): boolean {
  const normalizedArchivePath = normalizeArchivePath(archivePath);
  if (
    normalizedArchivePath.startsWith("logs/") ||
    normalizedArchivePath.startsWith(".zcode/cli/log/")
  ) {
    return true;
  }

  return false;
}

async function filterRecentLogArchiveFiles(
  files: LogArchiveFileEntry[],
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveFileEntry[]> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOG_EXPORT_LOOKBACK_DAYS;
  if (lookbackDays <= 0) {
    return files;
  }

  const now = options.now ?? (() => new Date());
  const cutoffMs = now().getTime() - lookbackDays * MILLISECONDS_PER_DAY;
  const recentFiles: LogArchiveFileEntry[] = [];

  for (const file of files) {
    if (!shouldApplyLogExportRetention(file.archivePath)) {
      recentFiles.push(file);
      continue;
    }

    const fileStats = await stat(file.absolutePath).catch(() => null);
    // 导出日志过去按目录全量打包，长时间运行后旧 diagnostics 会把日志包放大到数百 MB。
    // 这里仅对“可由时间窗口复现现场”的日志类文件按 mtime 保留近 3 天；
    // settings 等排障配置不参与过滤，避免久未修改但仍影响当前行为的配置丢失。
    if (fileStats?.isFile() && fileStats.mtimeMs >= cutoffMs) {
      recentFiles.push(file);
    }
  }

  return recentFiles;
}

function createAboutContent(): string {
  const snapshot = createAboutSnapshot({ buildMetadata: readBuildMetadata() });
  return formatAboutDetail(snapshot);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSkippedLogArchiveDirectory(
  absolutePath: string,
  archivePath: string,
  error: unknown,
): void {
  logger.warn("[export-logs] 日志目录不可读，已在导出时自动跳过", {
    absolutePath,
    archivePath,
    error: formatErrorMessage(error),
  });
}

async function walkLogArchiveDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const resolvedDir = await realpath(absoluteDir).catch(() => absoluteDir);
  if (visitedDirs.has(resolvedDir)) {
    return;
  }
  visitedDirs.add(resolvedDir);

  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch((error: unknown) => {
    // 用户目录下的日志来源可能包含被系统或第三方 CLI 限制权限的子目录。
    // 单个目录 scandir 失败时跳过该目录，避免一次 EACCES 把整个日志包导出中断。
    logSkippedLogArchiveDirectory(absoluteDir, relativeDir, error);
    return null;
  });
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));

  for (const dirent of dirents) {
    const archivePath = relativeDir ? posix.join(relativeDir, dirent.name) : dirent.name;
    if (isExcludedRelativePath(archivePath)) {
      continue;
    }

    const absolutePath = join(absoluteDir, dirent.name);
    if (dirent.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (dirent.isFile()) {
      files.push({ absolutePath, archivePath });
      continue;
    }

    if (!dirent.isSymbolicLink()) {
      continue;
    }

    const targetStats = await stat(absolutePath).catch(() => null);
    if (!targetStats) {
      continue;
    }

    // 日志目录里存在 provider 共享资源的软链入口。
    // 这里按目标类型处理并配合 realpath 去重，避免递归跟随时把同一份内容重复打进包，甚至形成循环遍历。
    if (targetStats.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (targetStats.isFile()) {
      files.push({ absolutePath, archivePath });
    }
  }
}

async function collectLogArchiveFilesFromDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const directoryStats = await stat(absoluteDir).catch(() => null);
  if (!directoryStats?.isDirectory()) {
    return;
  }

  await walkLogArchiveDirectory(absoluteDir, relativeDir, visitedDirs, files);
}

/**
 * 按文件名白名单收集单层目录，不递归。用于运行目录这类"诊断文件与凭据同放"的场景：
 * 递归收集会把 .tokens 之类的机密带进用户会转发出去的日志包，而 EXCLUDED 名单是
 * 事后补救、天然滞后。白名单则默认拒绝——目录里以后多出什么都不会跟着漏出去。
 */
async function collectLogArchiveFilesByName(
  absoluteDir: string,
  relativeDir: string,
  isCollectableFileName: (fileName: string) => boolean,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch(() => null);
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));
  for (const dirent of dirents) {
    if (!dirent.isFile() || !isCollectableFileName(dirent.name)) {
      continue;
    }
    await collectLogArchiveFile(
      join(absoluteDir, dirent.name),
      posix.join(relativeDir, dirent.name),
      files,
    );
  }
}

async function collectLogArchiveFile(
  absolutePath: string,
  archivePath: string,
  files: LogArchiveFileEntry[],
): Promise<void> {
  if (isExcludedRelativePath(archivePath)) {
    return;
  }
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats?.isFile()) {
    return;
  }
  files.push({ absolutePath, archivePath });
}

export async function collectLogArchiveFiles(sourceDir: string): Promise<LogArchiveFileEntry[]> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();
  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);
  files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  return files;
}

export async function createLogArchiveArtifacts(
  sourceDir: string,
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveArtifacts> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();

  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);

  const zcodeCliLogDir = getZCodeCliLogDir();
  // GLM / zcode-cli 的运行日志写在 ~/.zcode/cli/log，不在应用主数据目录 ~/.zcode/v2 下。
  // 如果导出日志只扫描 v2，定位 agent CLI 启动、协议或崩溃问题时会缺少最关键的原生侧日志。
  await collectLogArchiveFilesFromDirectory(
    zcodeCliLogDir,
    posix.join(".zcode", "cli", "log"),
    visitedDirs,
    files,
  );

  const zcodeCliDir = getZCodeCliDir();
  // 排查 agent CLI 问题还需要它的运行配置与模型 IO 轨迹。
  // config.json 是当前生效配置；rollout 是 model-io 调用轨迹，
  // 二者都不在 ~/.zcode/cli/log 下，需要额外收集才能完整还原现场。
  await collectLogArchiveFile(
    join(zcodeCliDir, "config.json"),
    posix.join(".zcode", "cli", "config.json"),
    files,
  );
  await collectLogArchiveFilesFromDirectory(
    join(zcodeCliDir, "rollout"),
    posix.join(".zcode", "cli", "rollout"),
    visitedDirs,
    files,
  );

  // Computer Use Helper 的结构化诊断必须进日志包：否则反馈包里
  // grep "background keyboard begin rejected" 命中 0，
  // 因为 Helper 由 LaunchServices 启动、stderr 被系统丢弃，它把诊断 tee 到
  // ~/.zcode/computer-use/run/<socket>.exit.log，既不在 app data 也不在 ~/.zcode/cli 下。
  // 同目录下有 .tokens broker 凭据，因此按文件名白名单只收 *.exit.log，不递归该目录。
  await collectLogArchiveFilesByName(
    getCuaHelperRunDir(),
    posix.join(".zcode", "computer-use", "run"),
    isCuaHelperDiagnosticFileName,
    files,
  );

  const recentFiles = await filterRecentLogArchiveFiles(files, options);
  recentFiles.sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  return {
    files: recentFiles,
    aboutContent: createAboutContent(),
  };
}

async function copyLogArchiveFilesToDirectory(
  outputPath: string,
  files: LogArchiveFileEntry[],
): Promise<LogArchiveSkippedFileEntry[]> {
  const skippedFiles: LogArchiveSkippedFileEntry[] = [];

  for (const file of files) {
    const destinationPath = join(outputPath, ...file.archivePath.split("/"));
    await mkdir(dirname(destinationPath), { recursive: true });

    const sourceStats = await stat(file.absolutePath).catch((error: unknown) => {
      skippedFiles.push({
        absolutePath: file.absolutePath,
        archivePath: file.archivePath,
        error: formatErrorMessage(error),
      });
      return null;
    });
    if (!sourceStats?.isFile()) {
      continue;
    }

    const sourceReadable = await access(file.absolutePath, constants.R_OK)
      .then(() => true)
      .catch((error: unknown) => {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        return false;
      });
    if (!sourceReadable) {
      continue;
    }

    try {
      // 这里改为“采样识别编码 + 流式脱敏”，避免全量 readFile 带来的大文件内存峰值。
      // 同时显式支持 UTF-16 文本（含 BOM/无 BOM 常见形态），防止被误判成二进制后原样泄露敏感字段。
      const sourceSample = await readFileSample(file.absolutePath);
      const textEncodingInfo = detectTextFileEncoding(sourceSample);
      if (!textEncodingInfo) {
        await copyFile(file.absolutePath, destinationPath);
      } else {
        await sanitizeTextLogFileToDestination(
          file.absolutePath,
          destinationPath,
          textEncodingInfo,
        );
      }
    } catch (error) {
      const sourceStatsAfterFailure = await stat(file.absolutePath).catch(() => null);
      const sourceReadableAfterFailure = sourceStatsAfterFailure?.isFile()
        ? await access(file.absolutePath, constants.R_OK)
            .then(() => true)
            .catch(() => false)
        : false;
      // telemetry/agent 日志文件可能在“扫描完待导出列表”之后被后台轮转、删除或改权限，
      // 软链目标也可能在这段窗口里失效。复制失败后再核一次源文件可读性；
      // 如果源头已经不可读，就把它当成坏文件跳过，避免单个 ENOENT/EACCES 让导出整体失败。
      if (!sourceReadableAfterFailure) {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        continue;
      }
      throw error;
    }
  }

  return skippedFiles;
}

function logSkippedLogArchiveFiles(skippedFiles: LogArchiveSkippedFileEntry[]): void {
  if (skippedFiles.length === 0) {
    return;
  }

  logger.warn("[export-logs] 检测到不可读日志文件，已在导出时自动跳过", {
    skippedCount: skippedFiles.length,
    skippedFiles: skippedFiles.slice(0, 10),
  });
}

export async function writeLogArchiveZip(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
  options: WriteLogArchiveZipOptions = {},
): Promise<void> {
  const stageRootDir = options.stageRootDir ?? getDefaultExportLogStageDir();
  await mkdir(stageRootDir, { recursive: true });
  const stagingDir = await mkdtemp(join(stageRootDir, "stage-"));
  try {
    // yazl.addFile 内部会再次对源路径执行 fs.stat/createReadStream。
    // 对于软链目标或正在被轮转的 telemetry 文件，这一步仍然可能异步抛错并触发未监听的 error 事件。
    // 这里先把可读文件稳定复制到临时目录，再从临时目录压缩，保证 zip 阶段只面对我们自己控制的常规文件。
    await writeLogArchiveDirectory(stagingDir, artifacts);

    const zipFile = new ZipFile();
    const stageFiles = await collectLogArchiveFiles(stagingDir);
    const outputStream = createWriteStream(outputPath);
    zipFile.once("error", (error) => {
      outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    for (const file of stageFiles) {
      zipFile.addFile(file.absolutePath, file.archivePath);
    }

    const writePromise = pipeline(zipFile.outputStream, outputStream);
    zipFile.end();
    await writePromise;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function writeLogArchiveDirectory(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
): Promise<void> {
  await mkdir(outputPath, { recursive: true });
  const skippedFiles = await copyLogArchiveFilesToDirectory(outputPath, artifacts.files);
  logSkippedLogArchiveFiles(skippedFiles);

  await writeFile(join(outputPath, "about.txt"), artifacts.aboutContent, "utf-8");
}

export async function createFeedbackLogArchiveFromExportLogs(
  sourceDir: string,
  options: CreateFeedbackLogArchiveFromExportLogsOptions = {},
): Promise<{ path: string; size: number }> {
  return createFeedbackDiagnosticArchive({
    sources: [
      { directory: join(sourceDir, "logs"), archivePrefix: "logs" },
      { directory: getZCodeCliLogDir(), archivePrefix: ".zcode/cli/log" },
      {
        directory: getZCodeCliDir(),
        archivePrefix: ".zcode/cli",
        includeFileNames: ["config.json"],
        onlyCurrentDay: false,
        contentPolicy: "cli-config",
      },
      {
        directory: join(getZCodeCliDir(), "rollout"),
        archivePrefix: ".zcode/cli/rollout",
      },
      {
        directory: getCuaHelperRunDir(),
        archivePrefix: ".zcode/computer-use/run",
        exitLogsOnly: true,
      },
    ],
    outputRootDir: options.outputRootDir ?? getDefaultFeedbackLogArchiveDir(),
    now: options.now,
    onProgress: options.onProgress,
  });
}

export async function exportLogs(
  dependencies: ExportLogsDependencies = {},
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const now = dependencies.now ?? (() => new Date());
    const getSourceDir = dependencies.getZCodeDataDir ?? getZCodeDataDir;
    const buildArtifacts = dependencies.createLogArchiveArtifacts ?? createLogArchiveArtifacts;
    const writeZip = dependencies.writeLogArchiveZip ?? writeLogArchiveZip;
    const writeDirectory = dependencies.writeLogArchiveDirectory ?? writeLogArchiveDirectory;
    const showItemInFolder =
      dependencies.showItemInFolder ??
      (async (path: string) => {
        const { shell } = await import("electron");
        shell.showItemInFolder(path);
      });
    const getStageRootDir = dependencies.getExportLogStageDir ?? getDefaultExportLogStageDir;
    const getOutputRootDir = dependencies.getExportLogDir ?? getDefaultExportLogDir;

    const sourceDir = getSourceDir();
    const timestamp = formatTimestamp(now());
    const exportBaseName = `zcode-logs-${timestamp}`;
    const outputRootDir = getOutputRootDir();
    await mkdir(outputRootDir, { recursive: true });
    const outputDir = await mkdtemp(join(outputRootDir, `${exportBaseName}-`));
    const zipPath = join(outputDir, `${exportBaseName}.zip`);
    const directoryPath = join(outputDir, exportBaseName);

    logger.info("[export-logs] 开始打包日志", {
      source: sourceDir,
      zipDest: zipPath,
      directoryDest: directoryPath,
    });
    const artifacts = await buildArtifacts(sourceDir, { now });

    try {
      await writeZip(zipPath, artifacts, { stageRootDir: getStageRootDir() });
      await showItemInFolder(zipPath);

      logger.info("[export-logs] 日志导出完成", {
        path: zipPath,
        format: "zip",
      });
      return { success: true, path: zipPath };
    } catch (zipError) {
      const zipErrorMessage = zipError instanceof Error ? zipError.message : String(zipError);

      // Windows 的压缩能力不再依赖 PowerShell/.NET，但归档写入仍可能被杀软、磁盘策略等外部因素打断。
      // 这里回退为目录导出，保证用户至少能稳定拿到原始日志，而不是直接报错。
      logger.warn("[export-logs] zip 导出失败，回退到目录导出", {
        error: zipErrorMessage,
        zipPath,
        fallbackPath: directoryPath,
      });
      await rm(zipPath, { force: true }).catch(() => {});

      try {
        await writeDirectory(directoryPath, artifacts);
      } catch (directoryError) {
        const directoryErrorMessage =
          directoryError instanceof Error ? directoryError.message : String(directoryError);
        throw new Error(`zip 导出失败：${zipErrorMessage}；目录导出失败：${directoryErrorMessage}`);
      }

      await showItemInFolder(directoryPath);
      logger.info("[export-logs] 日志导出完成", {
        path: directoryPath,
        format: "directory",
      });
      return { success: true, path: directoryPath };
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    logger.error("[export-logs] 日志导出失败", { error: message });
    return { success: false, error: message };
  }
}
