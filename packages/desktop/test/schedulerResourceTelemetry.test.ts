import { describe, expect, it, vi } from "vitest";
import { startSchedulerResourceTelemetry } from "../src/scheduler/schedulerResourceTelemetry.js";
import type { SchedulerToMainMessage } from "../src/scheduler/schedulerProtocol.js";

const usage = (): NodeJS.MemoryUsage => ({
  rss: 120 * 1024 * 1024,
  heapTotal: 40 * 1024 * 1024,
  heapUsed: 24 * 1024 * 1024,
  external: 3 * 1024 * 1024,
  arrayBuffers: 512 * 1024,
});

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] as T;
}

function startHarness(postMessage: (message: SchedulerToMainMessage) => void) {
  const setInterval = vi.fn<(callback: () => void, intervalMs: number) => { unref: () => void }>();
  const clearInterval = vi.fn();
  const unref = vi.fn();
  let tick: (() => void) | undefined;
  let intervalMs = 0;
  setInterval.mockImplementation((callback, ms) => {
    tick = callback;
    intervalMs = ms;
    return { unref };
  });

  const telemetry = startSchedulerResourceTelemetry({
    postMessage,
    readMemoryUsage: usage,
    logicalCpuCount: 4,
    // 60 秒墙钟内占用 2.4 秒 CPU → 0.04 核 → 4 核机器上 1%。
    readCpuUsage: sequence([
      { user: 0, system: 0 },
      { user: 1_800_000, system: 600_000 },
      { user: 1_800_000, system: 600_000 },
    ]),
    readMonotonicTimeNs: sequence([0n, 60_000_000_000n, 120_000_000_000n]),
    timer: { setInterval, clearInterval },
  });

  return {
    telemetry,
    setInterval,
    clearInterval,
    unref,
    get intervalMs() {
      return intervalMs;
    },
    tick: () => tick?.(),
  };
}

describe("startSchedulerResourceTelemetry", () => {
  it("PRT-022 推进 60 秒定时器后 parentPort 收到样本，且定时器已 unref", () => {
    const postMessage = vi.fn();
    const harness = startHarness(postMessage);

    harness.tick();

    // scheduler 进程只有这一个定时器承担遥测，且不延长进程寿命。
    expect(harness.setInterval).toHaveBeenCalledOnce();
    expect(harness.intervalMs).toBe(60_000);
    expect(harness.unref).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      type: "scheduler-resource-sample",
      sample: { cpuPercent: 1, rssKb: 122_880, heapUsedKb: 24_576 },
    });

    harness.telemetry.stop();
    expect(harness.clearInterval).toHaveBeenCalledOnce();
    harness.telemetry.stop();
    expect(harness.clearInterval).toHaveBeenCalledOnce();
  });

  it("postMessage 抛错时只丢当前样本，不把异常带回 scheduler 主循环", () => {
    const harness = startHarness(() => {
      throw new Error("main disconnected");
    });

    expect(() => harness.tick()).not.toThrow();
    harness.telemetry.stop();
  });

  it("进程指标读数异常时不发样本也不抛错", () => {
    const postMessage = vi.fn();
    const setInterval =
      vi.fn<(callback: () => void, intervalMs: number) => { unref: () => void }>();
    let tick: (() => void) | undefined;
    setInterval.mockImplementation((callback) => {
      tick = callback;
      return { unref: vi.fn() };
    });
    const telemetry = startSchedulerResourceTelemetry({
      postMessage,
      readMemoryUsage: () => {
        throw new Error("memoryUsage unavailable");
      },
      timer: { setInterval, clearInterval: vi.fn() },
    });

    expect(() => tick?.()).not.toThrow();
    expect(postMessage).not.toHaveBeenCalled();
    telemetry.stop();
  });
});
