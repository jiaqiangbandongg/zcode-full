/**
 * cron scheduler 进程自身的资源遥测。
 *
 * scheduler 之前完全没有采样，本模块新增它唯一的一个 unref 定时器：每 60 秒读一次
 * `process.cpuUsage()` 与 `process.memoryUsage()`，经 parentPort 把样本发给 main，
 * 成为 scheduler 角色事件的 heap 来源。读数或发送失败只丢当前样本，不影响派发主循环。
 * 零外部进程；定时器 unref，不延长进程寿命。
 */

import {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSamplerOptions,
} from "@zcode/shared/node";
import type { SchedulerToMainMessage } from "./schedulerProtocol.js";

interface SchedulerResourceTelemetryTimerHandle {
  unref?(): void;
}

export interface StartSchedulerResourceTelemetryOptions extends NodeSelfResourceSamplerOptions {
  /** parentPort 的发送口；parentPort 不可用时调用方传一个 no-op。 */
  postMessage: (message: SchedulerToMainMessage) => void;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): SchedulerResourceTelemetryTimerHandle;
    clearInterval(handle: SchedulerResourceTelemetryTimerHandle): void;
  };
}

export interface SchedulerResourceTelemetry {
  stop(): void;
}

export function startSchedulerResourceTelemetry(
  options: StartSchedulerResourceTelemetryOptions,
): SchedulerResourceTelemetry {
  const sampler = createNodeSelfResourceSampler(options);
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: SchedulerResourceTelemetryTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };

  const sampleNow = (): void => {
    try {
      const sample = sampler.sample(readMemoryUsage());
      if (!sample) {
        return;
      }
      options.postMessage({ type: "scheduler-resource-sample", sample });
    } catch {
      // 读数异常、parentPort 不可用或 postMessage 抛错时只丢当前样本。
    }
  };

  let handle: SchedulerResourceTelemetryTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // unref 不可用时仍保留 handle 供 stop 回收。
  }

  return {
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      try {
        timer.clearInterval(current);
      } catch {
        // 清理失败不能阻塞 scheduler 既有退出流程。
      }
    },
  };
}
