/**
 * Host 进程自身的资源遥测。
 *
 * 复用内存诊断日志既有的 60 秒定时器：一次 `process.memoryUsage()` 读数两个出口——
 * 本地 `[memory] role=utility_host` 日志行按既有门控写出，同一次读数换算成
 * `HostResourceSample` 经 parentPort 发给 main，成为 host 角色事件的 heap 来源。
 * 进程内因此仍然只有一个遥测定时器；任何一步失败只丢当前样本，Host 服务不受影响。
 */

import { HostResponseTypes } from "@zcode/shared";
import {
  createNodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "@zcode/shared/node";
import {
  startHostMemoryDiagnosticsLog,
  type StartHostMemoryDiagnosticsLogOptions,
} from "./hostMemoryDiagnosticsLog.js";

export interface StartHostSelfResourceTelemetryOptions
  extends
    Omit<StartHostMemoryDiagnosticsLogOptions, "onMemoryUsage">,
    NodeSelfResourceSamplerOptions {
  /**
   * parentPort 的发送口。Host 在非 utilityProcess 环境（本地调试）下没有 parentPort，
   * 此时只写本地日志、不发样本。
   */
  postMessage?: ((message: unknown) => void) | undefined;
}

export interface HostSelfResourceTelemetry {
  /** 立即采样一次（供测试与手动触发），返回本地日志是否写盘。 */
  sampleNow(): boolean;
  stop(): void;
}

export function startHostSelfResourceTelemetry(
  options: StartHostSelfResourceTelemetryOptions,
): HostSelfResourceTelemetry {
  const sampler = createNodeSelfResourceSampler(options);
  const postMessage = options.postMessage;

  // 逐项传递而不是整份 spread：采样器专属选项（readCpuUsage 等）不该漏进诊断日志模块。
  return startHostMemoryDiagnosticsLog({
    logger: options.logger,
    collectCounters: options.collectCounters,
    readMemoryUsage: options.readMemoryUsage,
    now: options.now,
    intervalMs: options.intervalMs,
    timer: options.timer,
    onMemoryUsage: (memoryUsage) => {
      if (!postMessage) {
        return;
      }
      const sample = sampler.sample(memoryUsage);
      if (!sample) {
        return;
      }
      try {
        postMessage({ type: HostResponseTypes.HostResourceSample, sample });
      } catch {
        // main 已退出或 IPC 不可用时只丢当前样本。
      }
    },
  });
}
