// ============================================================
// Glob Tool Handler
// ============================================================

import { isAbsolute, relative, sep } from "node:path";
import {
  CoreErrorType,
  GlobInputJsonSchema,
  GlobInputSchema,
  GlobOutputJsonSchema,
  GlobOutputSchema,
  createCoreError,
  type GlobInput,
  type GlobOutput,
  type TraceContext,
} from "@zcode/contracts";
import { resolveToolWorkingDirectory, resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_GLOB_RESULTS = 100;
const MAX_GLOB_MODEL_BYTES = 100_000;
const GLOB_TOOL_DESCRIPTION =
  'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.';

export const globHandler: ToolHandler = async (input, context) => {
  const { pattern, path } = GlobInputSchema.parse(input) as GlobInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Glob tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Glob",
        },
        recoverable: false,
      },
    );
  }

  const searchPath = path
    ? resolveWorkspacePath({
        inputPath: path,
        operation: "read",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      })
    : resolveToolWorkingDirectory(undefined, {
        operation: "read",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });

  const result = await fileSystemPort.searchFiles(
    {
      path: searchPath,
      pattern,
      maxResults: MAX_GLOB_RESULTS,
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sessionId: context.sessionId,
        turnId: context.turnId,
      } as unknown as TraceContext,
    },
    { signal: context.abortSignal },
  );

  const filenames = result.files.map((filePath) =>
    toDisplayPath(filePath, context.workingDirectory),
  );

  return {
    durationMs: result.durationMs,
    numFiles: filenames.length,
    filenames,
    truncated: result.truncated,
  } satisfies GlobOutput;
};

export const globToolEntry: ToolEntry = {
  capability: "Find files by glob pattern through the file-system adapter without reading file contents",
  metadata: {
    name: "Glob",
    description: GLOB_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_GLOB_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: globHandler,
  inputSchema: GlobInputJsonSchema,
  outputSchema: GlobOutputJsonSchema,
  runtimeInputSchema: GlobInputSchema,
  runtimeOutputSchema: GlobOutputSchema,
  formatModelContent: formatGlobModelContent,
  permission: {
    permission: "read",
    reason: "Glob only lists file paths and has no external side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path", "input"],
    alwaysAllowPatternSources: ["path", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_GLOB_MODEL_BYTES,
    maxModelBytes: MAX_GLOB_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_GLOB_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Glob was cancelled before file matches were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatGlobModelContent(output: unknown): string {
  const result = output as GlobOutput;
  const filenames = result.filenames ?? [];
  if (filenames.length === 0) return "No files found";

  const lines = [...filenames];
  if (result.truncated) {
    lines.push("(Results are truncated. Consider using a more specific path or pattern.)");
  }
  return lines.join("\n");
}

function toDisplayPath(filePath: string, workingDirectory: string): string {
  const relativePath = relative(workingDirectory, filePath);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath.split(sep).join("/");
  }
  return filePath;
}
