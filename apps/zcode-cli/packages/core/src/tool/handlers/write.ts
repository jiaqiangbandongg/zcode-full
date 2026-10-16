// ============================================================
// Write Tool Handler
// ============================================================

import type { ToolHandler, ToolEntry } from "../types.js";
import {
  CoreErrorType,
  WriteInputJsonSchema,
  WriteInputSchema,
  WriteOutputJsonSchema,
  WriteOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type FileSystemReadTextResult,
  type FileSystemTextEncoding,
  type WriteInput,
  type TraceContext,
} from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import { stampMemoryOriginSessionId } from "../../memory/origin-session.js";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  createReadFileStateKey,
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
} from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import type { ReadFileStateEntry, ReadFileStateMap, ToolExecutionContext } from "../types.js";
import {
  attachToolExecutionTelemetry,
  elapsedMsSince,
  fileByteCount,
  workspaceKind,
} from "./tool-perf.js";

const WRITE_PROVIDER_DESCRIPTION = [
  "Writes a file to the local filesystem, overwriting if one exists.",
  "",
  "When to use: creating a new file, or fully replacing one you've already Read. Overwriting an existing file you haven't Read will fail. For partial changes, use Edit instead.",
].join("\n");

const WRITE_STORAGE_SUFFIX =
  " (file state is current in your context \u2014 no need to Read it back)";
const WRITE_USER_MODIFIED_NOTE = " The user modified your proposed content before accepting it.";
const WRITE_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
const WRITE_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

function formatWriteModelContent(output: unknown): string {
  if (!isRecord(output)) {
    return "The file has been written successfully.";
  }

  const filePath = typeof output.filePath === "string" ? output.filePath : "the file";
  const userModified = output.userModified === true;
  const userModifiedNote = userModified ? WRITE_USER_MODIFIED_NOTE : "";
  const storageSuffixNote = userModified ? "" : WRITE_STORAGE_SUFFIX;

  if (output.type === "create") {
    return `File created successfully at: ${filePath}${userModifiedNote}${storageSuffixNote}`;
  }

  return `The file ${filePath} has been updated successfully.${userModifiedNote}${storageSuffixNote}`;
}

export const writeHandler: ToolHandler = async (input, context) => {
  const { file_path, content } = WriteInputSchema.parse(input) as WriteInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Write tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Write",
        },
        recoverable: false,
      },
    );
  }

  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  let originalFile: string | null = null;
  let originalEncoding: FileSystemTextEncoding | undefined;
  let originalLineEndings: "LF" | "CRLF" | undefined;
  let originalRevision: FileSystemReadTextResult["revision"] | undefined;
  const readStartedAt = Date.now();
  let fsReadMs = 0;
  try {
    const read = await fileSystemPort.readTextFile(
      {
        path: filePath,
        trace: createWriteTrace(context),
      },
      { signal: context.abortSignal },
    );
    assertWritableExistingFileIsFresh(filePath, read, context.readFileState);
    originalFile = read.content;
    originalEncoding = read.encoding;
    originalLineEndings = read.lineEndings;
    originalRevision = read.revision;
    fsReadMs = elapsedMsSince(readStartedAt);
  } catch (error) {
    fsReadMs = elapsedMsSince(readStartedAt);
    if (!isFileSystemPortError(error) || error.code !== "not_found") {
      throw error;
    }
  }

  const contentToWrite = stampMemoryOriginSessionId({
    content,
    filePath,
    memoryRoot: context.memoryRoot,
    sessionId: context.sessionId,
  });
  const writeStartedAt = Date.now();
  const writeResult = await fileSystemPort.writeTextFile(
    {
      path: filePath,
      content: contentToWrite,
      encoding: originalEncoding,
      lineEndings: originalLineEndings,
      createParents: true,
      atomic: true,
      expectedRevision: originalRevision,
      trace: createWriteTrace(context),
    },
    { signal: context.abortSignal },
  );
  const fsWriteMs = elapsedMsSince(writeStartedAt);

  const readFileStateEntry = updateReadFileStateAfterWrite(
    context.readFileState,
    filePath,
    contentToWrite,
    writeResult.revision,
  );
  recordReadFileStateMetadata(context, readFileStateEntry);

  if (originalFile) {
    return attachToolExecutionTelemetry(
      {
        type: "update",
        filePath: file_path,
        content: contentToWrite,
        structuredPatch: createStructuredPatch({
          filePath: file_path,
          oldContent: originalFile,
          newContent: contentToWrite,
        }),
        originalFile,
        userModified: false,
      },
      createWritePerformanceTelemetry({
        content: contentToWrite,
        fsReadMs,
        fsWriteMs,
        context,
      }),
    );
  }

  return attachToolExecutionTelemetry(
    {
      type: "create",
      filePath: file_path,
      content: contentToWrite,
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    },
    createWritePerformanceTelemetry({
      content: contentToWrite,
      fsReadMs,
      fsWriteMs,
      context,
    }),
  );
};

function createWritePerformanceTelemetry(input: {
  content: string;
  context: ToolExecutionContext;
  fsReadMs: number;
  fsWriteMs: number;
}) {
  const totalBytes = fileByteCount(input.content);
  return {
    detail: {
      kind: "filesystem" as const,
      filesystem: {
        readMs: input.fsReadMs,
        writeMs: input.fsWriteMs,
        fileCount: 1,
        totalBytes,
        maxFileBytes: totalBytes,
        workspaceKind: workspaceKind(input.context),
      },
    },
  };
}

export const writeToolEntry: ToolEntry = {
  capability: "Create or overwrite a file through the file-system adapter",
  metadata: {
    name: "Write",
    description: WRITE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: writeHandler,
  formatModelContent: formatWriteModelContent,
  inputSchema: WriteInputJsonSchema,
  outputSchema: WriteOutputJsonSchema,
  runtimeInputSchema: WriteInputSchema,
  runtimeOutputSchema: WriteOutputSchema,
  permission: {
    permission: "edit",
    reason: "Write creates or overwrites files through the file-system adapter",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 1_000_000,
    maxModelBytes: 100_000,
    strategy: "truncate",
    preview: {
      maxBytes: 100_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Write was cancelled before the file operation completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function createWriteTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

function assertWritableExistingFileIsFresh(
  filePath: string,
  currentRead: FileSystemReadTextResult,
  readFileState: ReadFileStateMap | undefined,
): void {
  const lastRead = findLatestReadFileState(readFileState, filePath);
  if (!lastRead || lastRead.isPartialView) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_NOT_READ_MESSAGE, {
      context: {
        code: "write_file_not_read",
        filePath,
      },
      recoverable: true,
    });
  }

  if (!hasReadStateChanged(lastRead, currentRead)) return;
  if (isStrictFullRead(lastRead) && lastRead.content === currentRead.content) return;

  throw createCoreError(CoreErrorType.ToolExecutionFailed, WRITE_STALE_MESSAGE, {
    context: {
      code: "write_file_stale",
      filePath,
    },
    recoverable: true,
  });
}

function hasReadStateChanged(
  lastRead: ReadFileStateEntry,
  currentRead: FileSystemReadTextResult,
): boolean {
  const currentRevisionId = currentRead.revision?.id;
  if (lastRead.revisionId && currentRevisionId && lastRead.revisionId !== currentRevisionId) {
    return true;
  }

  const currentMtimeMs = currentRead.revision?.mtimeMs;
  if (lastRead.mtimeMs !== undefined && currentMtimeMs !== undefined) {
    // 让已确认内容未变的 Write 被误判为 stale。
    const normalizedCurrentMtimeMs = normalizeReadFileStateMtimeMs(currentMtimeMs);
    const normalizedLastReadMtimeMs = normalizeReadFileStateMtimeMs(lastRead.mtimeMs);
    const mtimeAdvanced =
      normalizedCurrentMtimeMs !== undefined &&
      normalizedLastReadMtimeMs !== undefined &&
      normalizedCurrentMtimeMs > normalizedLastReadMtimeMs;
    return mtimeAdvanced || lastRead.sizeBytes !== currentRead.sizeBytes;
  }

  if (lastRead.sizeBytes !== undefined && lastRead.sizeBytes !== currentRead.sizeBytes) {
    return true;
  }

  return isStrictFullRead(lastRead) && lastRead.content !== currentRead.content;
}

function isStrictFullRead(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}

function updateReadFileStateAfterWrite(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  content: string,
  revision: FileSystemReadTextResult["revision"] | undefined,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;
  const entry: ReadFileStateEntry = {
    path: filePath,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Write",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs),
    sizeBytes: revision?.sizeBytes ?? Buffer.byteLength(content, "utf8"),
  };
  readFileState.set(createReadFileStateKey(filePath, 1, undefined), entry);
  return entry;
}

function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: "Write",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
