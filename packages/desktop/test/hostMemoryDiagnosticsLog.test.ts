import { describe, expect, it, vi } from "vitest";
import { startHostMemoryDiagnosticsLog } from "../src/host/hostMemoryDiagnosticsLog.js";

const usage = (heapUsed: number): NodeJS.MemoryUsage => ({
  rss: 200 * 1024 * 1024,
  heapTotal: 100 * 1024 * 1024,
  heapUsed,
  external: 10 * 1024 * 1024,
  arrayBuffers: 1024 * 1024,
});

describe("startHostMemoryDiagnosticsLog", () => {
  it("MEM-008 按 60s 节拍采样，首次写盘、无变化不写、计数器变化再写；stop 后不再输出", () => {
    const info = vi.fn();
    let tick: (() => void) | undefined;
    const clearInterval = vi.fn();
    let nowMs = 0;
    let counters: Record<string, number> = { "terminal.open": 1 };
    const log = startHostMemoryDiagnosticsLog({
      logger: { info },
      collectCounters: () => counters,
      readMemoryUsage: () => usage(50 * 1024 * 1024),
      now: () => nowMs,
      timer: {
        setInterval(callback, intervalMs) {
          expect(intervalMs).toBe(60_000);
          tick = callback;
          return { unref: vi.fn() };
        },
        clearInterval,
      },
    });

    nowMs = 60_000;
    tick?.();
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toBe(
      "[memory] role=utility_host reason=first rssKb=204800 heapUsedKb=51200 heapTotalKb=102400 externalKb=10240 arrayBuffersKb=1024 terminal.open=1",
    );

    nowMs = 120_000;
    tick?.();
    expect(info).toHaveBeenCalledOnce();

    counters = { "terminal.open": 2 };
    nowMs = 180_000;
    tick?.();
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1]?.[0]).toContain("reason=changed");
    expect(info.mock.calls[1]?.[0]).toContain("terminal.open=2");

    log.stop();
    log.stop();
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it("计数器读取抛错时只丢当前样本，不抛出也不写盘", () => {
    const info = vi.fn();
    const log = startHostMemoryDiagnosticsLog({
      logger: { info },
      collectCounters: () => {
        throw new Error("services disposed");
      },
      readMemoryUsage: () => usage(1024),
      timer: { setInterval: () => ({ unref: vi.fn() }), clearInterval: vi.fn() },
    });

    expect(log.sampleNow()).toBe(false);
    expect(info).not.toHaveBeenCalled();
    log.stop();
  });
});
