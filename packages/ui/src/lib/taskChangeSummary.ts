import type {
  ZCodePersistedFileChange,
  ZCodeTaskChangeSummary,
  ZCodeTaskChangedFileSummary,
  ZCodeTaskMeta,
} from "@zcode/shared";
import { computeLineChangeStat } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";

interface TaskChangeSummaryIntl {
  formatMessage: (
    desc: { id: string },
    values?: Record<string, string>,
  ) => string;
}

interface AggregatedFileChange {
  path: string;
  originalContent: string | null;
  finalContent: string;
  writeCount: number;
  lastTurnIndex: number;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

export function getTaskChangeSummary(
  task: Pick<ZCodeTaskMeta, "changeSummary"> | null | undefined,
): ZCodeTaskChangeSummary | null {
  if (!task?.changeSummary || task.changeSummary.files.length === 0) {
    return null;
  }

  return task.changeSummary;
}

function formatTaskChangeStats(
  summary: ZCodeTaskChangeSummary,
  intl: TaskChangeSummaryIntl,
): string {
  return intl.formatMessage(
    { id: "taskList.changeStats" },
    {
      added: String(summary.added),
      removed: String(summary.removed),
    },
  );
}

export function formatTaskTitleWithChanges(
  title: string,
  summary: ZCodeTaskChangeSummary | null,
  intl: TaskChangeSummaryIntl,
): string {
  if (!summary) {
    return title;
  }

  return `${title} (${formatTaskChangeStats(summary, intl)})`;
}

export function toWorkspaceRelativePath(
  workspacePath: string,
  filePath: string,
): string {
  const normalizedWorkspacePath = trimTrailingSeparators(
    workspacePath.replace(/\\/g, "/"),
  );
  const normalizedFilePath = filePath.replace(/\\/g, "/");

  if (normalizedFilePath === normalizedWorkspacePath) {
    return getPathLeaf(filePath);
  }

  const exactPrefix = `${normalizedWorkspacePath}/`;
  if (normalizedFilePath.startsWith(exactPrefix)) {
    return normalizedFilePath.slice(exactPrefix.length) || getPathLeaf(filePath);
  }

  // Windows 路径在不同来源下大小写可能不一致，这里做一次只用于比较的降级匹配。
  const caseInsensitivePrefix = exactPrefix.toLowerCase();
  if (normalizedFilePath.toLowerCase().startsWith(caseInsensitivePrefix)) {
    return normalizedFilePath.slice(exactPrefix.length) || getPathLeaf(filePath);
  }

  return normalizedFilePath;
}

export function formatTaskChangedFileLabel(
  workspacePath: string,
  file: ZCodeTaskChangedFileSummary,
): string {
  const relativePath = toWorkspaceRelativePath(workspacePath, file.path);
  const statParts: string[] = [];
  if (file.added > 0) {
    statParts.push(`+${file.added}`);
  }
  if (file.removed > 0) {
    statParts.push(`-${file.removed}`);
  }

  return statParts.length > 0
    ? `${relativePath} ${statParts.join(" ")}`
    : relativePath;
}

export function buildPerTurnFileChangeMap(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): Map<number, ZCodePersistedFileChange> {
  const result = new Map<number, ZCodePersistedFileChange>();
  if (!fileChanges || fileChanges.length === 0) {
    return result;
  }

  for (const turn of fileChanges) {
    if (turn.snapshots.length === 0) {
      continue;
    }

    result.set(turn.turnIndex, turn);
  }

  return result;
}

export function buildTaskChangeSummary(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): ZCodeTaskChangeSummary | null {
  if (!fileChanges || fileChanges.length === 0) {
    return null;
  }

  const changedFileMap = new Map<string, AggregatedFileChange>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
        existing.finalContent = snapshot.afterContent;
        existing.writeCount += snapshot.writeCount;
        existing.lastTurnIndex = turn.turnIndex;
        continue;
      }

      changedFileMap.set(snapshot.path, {
        path: snapshot.path,
        originalContent: snapshot.beforeContent,
        finalContent: snapshot.afterContent,
        writeCount: snapshot.writeCount,
        lastTurnIndex: turn.turnIndex,
      });
    }
  }

  if (changedFileMap.size === 0) {
    return null;
  }

  let added = 0;
  let removed = 0;
  const files: ZCodeTaskChangedFileSummary[] = Array.from(changedFileMap.values())
    .map((file) => {
      const fileStat = computeLineChangeStat(
        file.originalContent,
        file.finalContent,
      );
      added += fileStat.added;
      removed += fileStat.removed;
      return {
        path: file.path,
        added: fileStat.added,
        removed: fileStat.removed,
        writeCount: file.writeCount,
        lastTurnIndex: file.lastTurnIndex,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}

function appendPatch(current: string | undefined, patch: string | null | undefined) {
  const normalizedPatch = patch?.trim();
  if (!normalizedPatch) {
    return current;
  }

  return current ? `${current}\n${normalizedPatch}` : normalizedPatch;
}

function readRecordString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function hasUnsuccessfulToolStatus(
  toolCall: NonNullable<TaskChatMessage["toolCalls"]>[number],
): boolean {
  const status = toolCall.status.toLowerCase();
  const rawStatus = readRecordString(toolCall.raw, "status")?.toLowerCase();
  return (
    toolCall.error !== undefined ||
    status === "failed" ||
    status === "denied" ||
    status === "error" ||
    status === "cancelled" ||
    rawStatus === "failed" ||
    rawStatus === "denied" ||
    rawStatus === "error" ||
    rawStatus === "cancelled"
  );
}

export function buildToolCallChangeSummary(
  message: TaskChatMessage,
  turnIndex: number,
): {
  patchesByPath?: ReadonlyMap<string, string>;
  summary: ZCodeTaskChangeSummary | null;
} {
  if (message.role !== "assistant" || !message.toolCalls?.length) {
    return { summary: null };
  }

  const filesByPath = new Map<string, ZCodeTaskChangedFileSummary>();
  const patchesByPath = new Map<string, string>();
  for (const toolCall of message.toolCalls) {
    if (hasUnsuccessfulToolStatus(toolCall)) {
      // Bugfix: plan mode 会把被拒绝的 Write 保留成 tool call 输入，但它没有真实落盘。
      // 从 tool input 派生变更摘要时必须跳过失败/拒绝工具，否则会显示不存在的文件改动。
      continue;
    }

    const fileSummaries = readRawToolCallFileSummaries(toolCall.raw, {
      toolName: toolCall.toolName,
      kind: toolCall.kind,
      title: toolCall.title,
      input: toolCall.input,
      output: toolCall.output,
      raw: toolCall.raw,
    });
    for (const file of fileSummaries) {
      if (!file.changeStat) {
        continue;
      }

      const existing = filesByPath.get(file.path);
      filesByPath.set(file.path, {
        added: (existing?.added ?? 0) + file.changeStat.added,
        lastTurnIndex: turnIndex,
        path: file.path,
        removed: (existing?.removed ?? 0) + file.changeStat.removed,
        writeCount: (existing?.writeCount ?? 0) + 1,
      });
      const nextPatch = appendPatch(patchesByPath.get(file.path), file.patch);
      if (nextPatch) {
        patchesByPath.set(file.path, nextPatch);
      }
    }
  }

  if (filesByPath.size === 0) {
    return { summary: null };
  }

  const files = [...filesByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    patchesByPath: patchesByPath.size > 0 ? patchesByPath : undefined,
    summary: {
      added: files.reduce((total, file) => total + file.added, 0),
      fileCount: files.length,
      files,
      removed: files.reduce((total, file) => total + file.removed, 0),
    },
  };
}

export function buildTaskChangeSummaryFromToolCalls(
  messages: readonly TaskChatMessage[] | undefined,
): ZCodeTaskChangeSummary | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  const filesByPath = new Map<string, ZCodeTaskChangedFileSummary>();
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    const turnIndex =
      message.role === "assistant"
        ? (message.turnIndex ?? messageIndex)
        : messageIndex;
    const summary = buildToolCallChangeSummary(message, turnIndex).summary;
    if (!summary) {
      continue;
    }

    for (const file of summary.files) {
      const existing = filesByPath.get(file.path);
      if (!existing) {
        filesByPath.set(file.path, { ...file });
        continue;
      }

      filesByPath.set(file.path, {
        path: file.path,
        added: existing.added + file.added,
        removed: existing.removed + file.removed,
        writeCount: existing.writeCount + file.writeCount,
        lastTurnIndex: Math.max(existing.lastTurnIndex, file.lastTurnIndex),
      });
    }
  }

  if (filesByPath.size === 0) {
    return null;
  }

  let added = 0;
  let removed = 0;
  const files = Array.from(filesByPath.values())
    .map((file) => {
      added += file.added;
      removed += file.removed;
      return file;
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}

export function buildTurnChangeSummary(
  turn: ZCodePersistedFileChange | null | undefined,
): ZCodeTaskChangeSummary | null {
  if (!turn || turn.snapshots.length === 0) {
    return null;
  }

  // 调用方需要严格只显示当前轮的文件摘要。
  // 这里把单轮摘要计算抽成独立 helper，只从传入的当前轮快照重算，
  // 避免任何 task/session 级聚合误传进来时把历史轮次文件一起展示出来。
  const filesByPath = new Map<
    string,
    {
      beforeContent: string | null;
      afterContent: string;
      writeCount: number;
    }
  >();

  for (const snapshot of turn.snapshots) {
    const existing = filesByPath.get(snapshot.path);
    if (existing) {
      existing.afterContent = snapshot.afterContent;
      existing.writeCount += snapshot.writeCount;
      continue;
    }

    filesByPath.set(snapshot.path, {
      beforeContent: snapshot.beforeContent,
      afterContent: snapshot.afterContent,
      writeCount: snapshot.writeCount,
    });
  }

  let added = 0;
  let removed = 0;
  const files: ZCodeTaskChangedFileSummary[] = Array.from(filesByPath.entries())
    .map(([path, snapshot]) => {
      const fileStat = computeLineChangeStat(
        snapshot.beforeContent,
        snapshot.afterContent,
      );
      added += fileStat.added;
      removed += fileStat.removed;
      return {
        path,
        added: fileStat.added,
        removed: fileStat.removed,
        writeCount: snapshot.writeCount,
        lastTurnIndex: turn.turnIndex,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}

/**
 * 从 fileChanges 中按轮次构建 per-turn 文件变更摘要。
 * 用于在每条 assistant 消息下方显示该轮的文件改动。
 */
export function buildPerTurnChangeSummaries(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): Map<number, ZCodeTaskChangeSummary> {
  const result = new Map<number, ZCodeTaskChangeSummary>();
  if (!fileChanges || fileChanges.length === 0) {
    return result;
  }

  for (const turn of fileChanges) {
    const summary = buildTurnChangeSummary(turn);
    if (!summary) {
      continue;
    }

    result.set(turn.turnIndex, summary);
  }

  return result;
}
