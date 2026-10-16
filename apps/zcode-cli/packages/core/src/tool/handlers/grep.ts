// ============================================================
// Grep Tool Handler
// ============================================================

import { isAbsolute, relative, sep } from "node:path";
import {
  CoreErrorType,
  GrepInputJsonSchema,
  GrepInputSchema,
  GrepOutputJsonSchema,
  GrepOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type FileSystemSearchTextEntry,
  type FileSystemSearchTextResult,
  type GrepInput,
  type GrepOutput,
  type TraceContext,
} from "@zcode/contracts";
import { resolveToolWorkingDirectory, resolveWorkspacePath } from "../path-policy.js";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_GREP_MODEL_BYTES = 20_000;
const DEFAULT_GREP_TIMEOUT_MS = 30_000;
const GREP_TOOL_DESCRIPTION = `Content search built on ripgrep. Prefer this over \`grep\`/\`rg\` via Bash — results integrate with the permission UI and file links.

- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Ripgrep, not grep — escape literal braces (\`interface\\{\\}\`).
- Filter with \`glob\` (e.g. "**/*.tsx") or \`type\` (e.g. "js", "py", "rust").
- \`output_mode\`: "content" (matching lines), "files_with_matches" (paths only, default), or "count".
- \`multiline: true\` for patterns that span lines.`;

export const grepHandler: ToolHandler = async (input, context) => {
  const parsed = GrepInputSchema.parse(input) as GrepInput;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Grep tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Grep",
        },
        recoverable: false,
      },
    );
  }

  const searchPath = parsed.path
    ? resolveWorkspacePath({
        inputPath: parsed.path,
        operation: "read",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      })
    : resolveToolWorkingDirectory(undefined, {
        operation: "read",
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });

  const contextLines = parsed.context ?? parsed["-C"];
  let result: FileSystemSearchTextResult;
  try {
    result = await fileSystemPort.searchText(
      {
        path: searchPath,
        pattern: parsed.pattern,
        glob: parsed.glob,
        outputMode: parsed.output_mode,
        beforeContext: parsed["-B"] ?? contextLines,
        afterContext: parsed["-A"] ?? contextLines,
        context: contextLines,
        showLineNumbers: parsed["-n"],
        onlyMatching: parsed["-o"],
        ignoreCase: parsed["-i"],
        type: parsed.type,
        headLimit: parsed.head_limit,
        offset: parsed.offset,
        multiline: parsed.multiline,
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
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "cancelled") {
      throw createCoreError(CoreErrorType.ToolCancelled, "Grep was cancelled", {
        cause: error,
        context: {
          path: searchPath,
          toolCallId: context.toolCallId,
          toolName: "Grep",
        },
        recoverable: true,
      });
    }
    throw error;
  }

  const filenames = result.files.map((filePath) =>
    toDisplayPath(filePath, context.workingDirectory),
  );
  const showLineNumbers = parsed["-n"] ?? true;

  const output: GrepOutput = {
    mode: result.mode,
    durationMs: result.durationMs,
    numFiles: filenames.length,
    filenames: result.mode === "files_with_matches" ? filenames : [],
    truncated: result.truncated,
    appliedLimit: result.appliedLimit,
    appliedOffset: result.appliedOffset,
  };

  if (result.mode === "content") {
    output.content = result.entries
      .map((entry) => formatContentEntry(entry, context.workingDirectory, showLineNumbers))
      .join("\n");
    output.numLines = result.entries.length;
    output.numMatches = result.numMatches;
  } else if (result.mode === "count") {
    output.content = result.entries
      .map((entry) => `${toDisplayPath(entry.path, context.workingDirectory)}:${entry.count ?? 0}`)
      .join("\n");
    output.numMatches = result.numMatches;
  } else {
    output.numMatches = result.numMatches;
  }

  return output;
};

export const grepToolEntry: ToolEntry = {
  capability: "Search file contents with ripgrep-compatible regular expressions",
  metadata: {
    name: "Grep",
    description: GREP_TOOL_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DEFAULT_GREP_TIMEOUT_MS,
    maxOutputBytes: MAX_GREP_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: grepHandler,
  inputSchema: GrepInputJsonSchema,
  outputSchema: GrepOutputJsonSchema,
  runtimeInputSchema: GrepInputSchema,
  runtimeOutputSchema: GrepOutputSchema,
  formatModelContent: formatGrepModelContent,
  permission: {
    permission: "read",
    reason: "Grep only searches file contents and has no external side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path", "input"],
    alwaysAllowPatternSources: ["path", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_GREP_MODEL_BYTES,
    maxModelBytes: MAX_GREP_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_GREP_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: DEFAULT_GREP_TIMEOUT_MS,
    maxMs: DEFAULT_GREP_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Grep was cancelled before search results were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatGrepModelContent(output: unknown): string {
  const result = output as GrepOutput;
  const mode = result.mode ?? "files_with_matches";
  const limitInfo = formatLimitInfo(result.appliedLimit, result.appliedOffset);

  if (mode === "content") {
    const content = result.content || "No matches found";
    return limitInfo ? `${content}\n\n[Showing results with pagination = ${limitInfo}]` : content;
  }

  if (mode === "count") {
    const content = result.content || "No matches found";
    const matches = result.numMatches ?? 0;
    const files = result.numFiles ?? 0;
    const summary = `Found ${matches} total ${plural(matches, "occurrence")} across ${files} ${plural(files, "file")}.`;
    return `${content}\n\n${summary}${limitInfo ? ` with pagination = ${limitInfo}` : ""}`;
  }

  const filenames = result.filenames ?? [];
  const fileCount = result.numFiles ?? filenames.length;
  if (fileCount === 0) return "No files found";

  return `Found ${fileCount} ${plural(fileCount, "file")}${limitInfo ? ` ${limitInfo}` : ""}\n${filenames.join("\n")}`;
}

function formatLimitInfo(appliedLimit?: number, appliedOffset?: number): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset !== undefined) parts.push(`offset: ${appliedOffset}`);
  return parts.join(", ");
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function formatContentEntry(
  entry: FileSystemSearchTextEntry,
  workingDirectory: string,
  showLineNumbers: boolean,
): string {
  const path = toDisplayPath(entry.path, workingDirectory);
  if (showLineNumbers && entry.lineNumber !== undefined) {
    return `${path}:${entry.lineNumber}:${entry.text ?? ""}`;
  }
  return `${path}:${entry.text ?? ""}`;
}

function toDisplayPath(filePath: string, workingDirectory: string): string {
  const relativePath = relative(workingDirectory, filePath);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath.split(sep).join("/");
  }
  return filePath;
}
