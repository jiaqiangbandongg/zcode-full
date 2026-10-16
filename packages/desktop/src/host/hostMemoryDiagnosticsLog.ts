import {
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  memoryUsageToSampleFields,
  type MemorySample,
} from "@zcode/shared";

interface HostMemoryDiagnosticsLogger {
  info(...args: unknown[]): void;
}

interface HostMemoryDiagnosticsTimerHandle {
  unref?(): void;
}

export interface StartHostMemoryDiagnosticsLogOptions {
  logger: HostMemoryDiagnosticsLogger;
  /** services 层的领域计数器（`collectServiceMemoryDiagnostics`）。 */
  collectCounters(): Record<string, number>;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  /**
   * 同一次 `memoryUsage()` 读数的第二个出口：资源遥测的 host 样本
   *
   * 与写盘门控无关——本地日志可能被门控跳过，遥测样本每 60 秒都要发；
   * 该回调抛错只丢遥测样本，不影响本地日志。
   */
  onMemoryUsage?: (memoryUsage: NodeJS.MemoryUsage) => void;
  now?: () => number;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): HostMemoryDiagnosticsTimerHandle;
    clearInterval(handle: HostMemoryDiagnosticsTimerHandle): void;
  };
}

export interface HostMemoryDiagnosticsLog {
  /** 立即采样一次（供测试与手动触发），返回是否写盘。 */
  sampleNow(): boolean;
  stop(): void;
}

/**
 * Local Host 进程自身的内存诊断日志。
 * 60s 采样、变化/心跳门控后写一行 `[memory] role=utility_host ...`，经既有 host logger
 * 转发到 Desktop 主日志；不新增 parentPort 消息类型。
 */
export function startHostMemoryDiagnosticsLog(
  options: StartHostMemoryDiagnosticsLogOptions,
): HostMemoryDiagnosticsLog {
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: HostMemoryDiagnosticsTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    let memoryUsage: NodeJS.MemoryUsage;
    try {
      memoryUsage = readMemoryUsage();
    } catch {
      // 读数失败时两个出口都没有事实可用，只丢当前样本。
      return false;
    }

    try {
      options.onMemoryUsage?.(memoryUsage);
    } catch {
      // 遥测出口失败只丢当前样本，本地诊断日志照写。
    }

    try {
      const sample: MemorySample = {
        role: "utility_host",
        ...memoryUsageToSampleFields(memoryUsage),
        counters: options.collectCounters(),
      };
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      options.logger.info(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // 诊断采样失败只丢当前样本，不能影响 Host 服务。
      return false;
    }
  };

  let handle: HostMemoryDiagnosticsTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // unref 不可用时仍保留 handle 供 stop 回收。
  }

  return {
    sampleNow,
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      timer.clearInterval(current);
    },
  };
}
