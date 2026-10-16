import { open } from "node:fs/promises";
import type { BackgroundExecutionSnapshot, TaskOutputTask } from "@zcode/contracts";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { ToolExecutionContext } from "../types.js";

export interface ProjectBashTaskOptions {
  readOutputFile: (path: string | undefined) => Promise<TaskOutputFileRead>;
  runningOutputPrefixBytes: number;
}

export interface TaskOutputFileRead {
  available: boolean;
  content: string;
  truncated: boolean;
}

interface BashOutputPart {
  content: string;
  path?: string;
}

export async function projectBashTask(
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
  options: ProjectBashTaskOptions,
): Promise<TaskOutputTask> {
  const snapshot = await context.executionPort?.getBackgroundTask?.(task.taskId);
  const projected = snapshot
    ? await projectBashSnapshot(snapshot, task, context, options)
    : await projectFallbackTaskFile(task.outputFile, options);

  return {
    task_id: task.taskId,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output: projected.output,
    exitCode: snapshot?.result?.exitCode ?? task.exitCode ?? null,
    ...(projected.outputFile ? { outputFile: projected.outputFile } : {}),
  };
}

async function projectBashSnapshot(
  snapshot: BackgroundExecutionSnapshot,
  task: RuntimeTaskSnapshot,
  context: ToolExecutionContext,
  options: ProjectBashTaskOptions,
): Promise<{ output: string; outputFile?: string }> {
  const stdoutPath =
    snapshot.outputPath ??
    task.outputFile ??
    snapshot.stdoutPersistedOutputPath ??
    snapshot.result?.stdout.artifactPath;
  const stderrPath = snapshot.stderrPersistedOutputPath ?? snapshot.result?.stderr.artifactPath;
  const readOutputFile =
    task.status === "running"
      ? (path: string | undefined) =>
          readRunningBashOutputFile(path, context, options.runningOutputPrefixBytes)
      : options.readOutputFile;

  const stdout = await readBashOutputPart(
    stdoutPath,
    snapshot.result?.stdout.text ?? snapshot.stdoutTail ?? "",
    readOutputFile,
  );
  const stderr =
    stderrPath && stderrPath === stdout.path
      ? { content: "", path: stderrPath }
      : await readBashOutputPart(
          stderrPath,
          snapshot.result?.stderr.text ?? snapshot.stderrTail ?? "",
          readOutputFile,
        );

  const output = [stdout.content, stderr.content].filter((part) => part.length > 0).join("\n");
  const outputFile =
    stdout.path && (!stderr.content || stderr.path === stdout.path)
      ? stdout.path
      : !stdout.content && stderr.path
        ? stderr.path
        : undefined;

  return {
    output,
    ...(outputFile ? { outputFile } : {}),
  };
}

async function readBashOutputPart(
  path: string | undefined,
  fallback: string,
  readOutputFile: ProjectBashTaskOptions["readOutputFile"],
): Promise<BashOutputPart> {
  const read = await readOutputFile(path);
  if (read.available) {
    return {
      content: read.content,
      ...(path ? { path } : {}),
    };
  }
  return { content: fallback };
}

async function projectFallbackTaskFile(
  outputFile: string | undefined,
  options: ProjectBashTaskOptions,
): Promise<{ output: string; outputFile?: string }> {
  const read = await options.readOutputFile(outputFile);
  return {
    output: read.content,
    ...(outputFile && read.available ? { outputFile } : {}),
  };
}

async function readRunningBashOutputFile(
  outputFile: string | undefined,
  context: ToolExecutionContext,
  maxBytes: number,
): Promise<TaskOutputFileRead> {
  // 运行中 Bash 复用通用 8 MiB 尾读后，模型会看到输出末尾；
  // 这里固定读取文件头部 30000 bytes，再交给 TaskOutput 应用最终字符预算。
  if (!outputFile) {
    return { available: false, content: "", truncated: false };
  }

  try {
    throwIfAborted(context.abortSignal);
    const handle = await open(outputFile, "r");
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, maxBytes);
      if (bytesToRead === 0) {
        return { available: true, content: "", truncated: false };
      }

      const buffer = Buffer.allocUnsafe(bytesToRead);
      let bytesRead = 0;
      while (bytesRead < bytesToRead) {
        const read = await handle.read(buffer, bytesRead, bytesToRead - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      throwIfAborted(context.abortSignal);

      return {
        available: true,
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: stat.size > bytesRead,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (context.abortSignal.aborted) throwIfAborted(context.abortSignal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { available: false, content: "", truncated: false };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new DOMException("Task output wait aborted", "AbortError");
}
