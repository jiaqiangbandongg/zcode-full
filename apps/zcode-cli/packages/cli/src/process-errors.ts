import { randomUUID } from "node:crypto";
import {
  ZCODE_PROCESS_DIAGNOSTIC_PREFIX,
  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
  type ZCodeProcessDiagnostic,
} from "@zcode/shared/process-diagnostic";

export interface CliProcessErrorBoundaryTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface CliProcessErrorBoundaryOptions {
  onFatal: (reason: unknown) => void;
  target?: CliProcessErrorBoundaryTarget;
  stderr?: {
    write(chunk: string): unknown;
  };
}

interface MonitoredException {
  error: unknown;
  origin: string;
}

/**
 * 为协议型 CLI 安装最后一道进程级异常边界。
 *
 * 先保留一次诊断，再交给入口 lifecycle 有界关闭。未知异常不能继续保活接单，
 * 更不能把坏 stderr 的写入失败递归报告；调用方必须先安装 stderr 输出边界。
 */
export function installCliProcessErrorBoundary(
  options: CliProcessErrorBoundaryOptions,
): () => void {
  const target = options.target ?? (process as unknown as CliProcessErrorBoundaryTarget);
  const stderr = options.stderr ?? process.stderr;
  let monitoredException: MonitoredException | undefined;
  let fatal = false;
  const reportFatal = (
    kind: "uncaughtException" | "unhandledRejection",
    origin: string,
    reason: unknown,
  ) => {
    if (fatal) return;
    fatal = true;
    writeProcessErrorDiagnostic(stderr, kind, origin, reason);
    options.onFatal(reason);
  };

  const onUncaughtExceptionMonitor = (error: unknown, origin: unknown): void => {
    monitoredException = {
      error,
      origin: typeof origin === "string" ? origin : "uncaughtException",
    };
  };
  const onUncaughtException = (error: unknown): void => {
    const matchingMonitor = monitoredException?.error === error ? monitoredException : undefined;
    const origin = matchingMonitor ? matchingMonitor.origin : "uncaughtException";
    monitoredException = undefined;
    // Node strict 模式先触发 uncaughtException，处理后再触发 unhandledRejection。
    // 统一由 rejection listener 报告，避免同一 Promise 错误生成两个不同 errorId。
    if (origin === "unhandledRejection") return;
    reportFatal("uncaughtException", origin, error);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    monitoredException = undefined;
    reportFatal("unhandledRejection", "unhandledRejection", reason);
  };

  target.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
  target.on("uncaughtException", onUncaughtException);
  target.on("unhandledRejection", onUnhandledRejection);

  return () => {
    target.off("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
    target.off("uncaughtException", onUncaughtException);
    target.off("unhandledRejection", onUnhandledRejection);
    monitoredException = undefined;
  };
}

function writeProcessErrorDiagnostic(
  stderr: { write(chunk: string): unknown },
  kind: "uncaughtException" | "unhandledRejection",
  origin: string,
  reason: unknown,
): void {
  try {
    const detail = formatProcessError(reason).slice(0, ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS);
    const diagnostic: ZCodeProcessDiagnostic = {
      version: 1,
      errorId: randomUUID(),
      kind,
      origin: origin === "unhandledRejection" ? origin : "uncaughtException",
      name: (reason instanceof Error ? reason.name || "Error" : "Error").slice(
        0,
        ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
      ),
      message: (reason instanceof Error ? reason.message : detail).slice(
        0,
        ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
      ),
      ...(reason instanceof Error && reason.stack ? { stack: detail } : {}),
      occurredAt: Date.now(),
    };
    // 根因：进程存活时旧 stderr 只进 debug，Electron SDK 无法捕获子进程异常。
    // 增加单行结构化事件供 Host 立即转发，保留可读文本兼容旧 Host 和 crash tail。
    stderr.write(
      `${ZCODE_PROCESS_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}\n[zcode] process error kind=${kind} origin=${origin}\n${detail}\n`,
    );
  } catch {
    // 诊断输出不能再次击穿进程级异常边界。
  }
}

function formatProcessError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack || `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    const serialized = JSON.stringify(reason);
    return serialized === undefined ? String(reason) : serialized;
  } catch {
    return String(reason);
  }
}
