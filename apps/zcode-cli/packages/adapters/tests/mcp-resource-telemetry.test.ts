import { spawn } from "node:child_process";
import { once } from "node:events";
import type { ZCodeMcpResourceSample } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpTelemetryTracker } from "../src/mcp/telemetry.js";
import type { ProcessProbe } from "../src/device/process-probe.js";

afterEach(() => vi.useRealTimers());

describe("MCP 五分钟资源采样", () => {
  it("PRT-013: 一次探针覆盖全部活跃根，按 MCP ID 合并进程树并计算相邻 CPU 差分", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sampleProcessTrees = vi
      .fn()
      .mockResolvedValueOnce(
        new Map([
          [
            101,
            [
              { pid: 101, rssKb: 100, cpuTimeMs: 1000 },
              { pid: 111, rssKb: 200, cpuTimeMs: 2000 },
            ],
          ],
          [102, [{ pid: 102, rssKb: 400, cpuTimeMs: 3000 }]],
        ]),
      )
      .mockResolvedValueOnce(
        new Map([
          [
            101,
            [
              { pid: 101, rssKb: 120, cpuTimeMs: 31_000 },
              { pid: 111, rssKb: 250, cpuTimeMs: 62_000 },
            ],
          ],
          [102, [{ pid: 102, rssKb: 500, cpuTimeMs: 93_000 }]],
        ]),
      );
    const probe: ProcessProbe = {
      sampleProcessTrees,
      sampleProcessGroup: vi.fn(),
      reset: vi.fn(),
      treeScope: "process_tree",
    };
    const onResourceSamples = vi.fn();
    const tracker = createMcpTelemetryTracker({
      idSalt: "salt",
      onEvent: vi.fn(),
      onResourceSamples,
      processProbe: probe,
      platform: "linux",
      arch: "x64",
      logicalCpuCount: 4,
      totalMemoryGb: 16,
    });
    for (const pid of [101, 102]) {
      tracker.registerConnection({
        connectionId: String(pid),
        isolation: "session",
        serverName: "node_repl",
      });
      tracker.recordProcessStarted({ connectionId: String(pid), pid });
    }
    tracker.registerConnection({ connectionId: "http", isolation: "session", serverName: "http" });
    tracker.start();
    tracker.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sampleProcessTrees).toHaveBeenCalledExactlyOnceWith([101, 102]);
    expect(onResourceSamples).toHaveBeenLastCalledWith([
      expect.objectContaining({
        mcpId: "builtin:node_repl",
        processCount: 3,
        rssKbTotal: 700,
        rssKbMaxProcess: 400,
        cpuTimeMsDelta: 0,
        intervalMs: 300_000,
        uptimeMinutes: 5,
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 4,
        totalMemoryGb: 16,
      }),
    ]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(onResourceSamples).toHaveBeenLastCalledWith([
      expect.objectContaining({
        processCount: 3,
        rssKbTotal: 870,
        rssKbMaxProcess: 500,
        cpuTimeMsDelta: 180_000,
        intervalMs: 300_000,
        uptimeMinutes: 10,
      }),
    ]);
    tracker.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sampleProcessTrees).toHaveBeenCalledTimes(2);
  });
  it("采样期间重启的旧进程结果丢弃，同一时刻只允许一次在途采样", async () => {
    let finish!: (
      value: ReadonlyMap<number, readonly { pid: number; rssKb: number; cpuTimeMs: number }[]>,
    ) => void;
    const sampleProcessTrees = vi.fn(
      () =>
        new Promise<
          ReadonlyMap<number, readonly { pid: number; rssKb: number; cpuTimeMs: number }[]>
        >((resolve) => {
          finish = resolve;
        }),
    );
    const onResourceSamples = vi.fn();
    const tracker = createMcpTelemetryTracker({
      idSalt: "salt",
      onEvent: vi.fn(),
      onResourceSamples,
      processProbe: {
        sampleProcessTrees,
        sampleProcessGroup: vi.fn(),
        reset: vi.fn(),
        treeScope: "process_tree",
      },
    });
    tracker.registerConnection({
      connectionId: "a",
      isolation: "session",
      serverName: "node_repl",
    });
    tracker.recordProcessStarted({ connectionId: "a", pid: 101 });
    const pending = tracker.sampleNow();
    await tracker.sampleNow();
    expect(sampleProcessTrees).toHaveBeenCalledTimes(1);
    tracker.recordProcessCrashed({ connectionId: "a", exitCode: 1, signal: null });
    tracker.recordProcessStarted({ connectionId: "a", pid: 102 });
    finish(new Map([[101, [{ pid: 101, rssKb: 100, cpuTimeMs: 1000 }]]]));
    await pending;
    expect(onResourceSamples).not.toHaveBeenCalled();
    const stopping = tracker.sampleNow();
    tracker.stop();
    finish(new Map([[102, [{ pid: 102, rssKb: 100, cpuTimeMs: 1000 }]]]));
    await stopping;
    expect(onResourceSamples).not.toHaveBeenCalled();
  });

  it("失败窗口无通知，下一次成功重建基线；Windows 无 CPU 时间时为零", async () => {
    let now = 300000;
    const sampleProcessTrees = vi
      .fn()
      .mockResolvedValueOnce(new Map([[101, [{ pid: 101, rssKb: 100, cpuTimeMs: 1000 }]]]))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(new Map([[101, [{ pid: 101, rssKb: 200, cpuTimeMs: 901000 }]]]))
      .mockResolvedValueOnce(new Map([[101, [{ pid: 101, rssKb: 300 }]]]));
    const onResourceSamples = vi.fn();
    const tracker = createMcpTelemetryTracker({
      idSalt: "salt",
      onEvent: vi.fn(),
      onResourceSamples,
      now: () => now,
      processProbe: {
        sampleProcessTrees,
        sampleProcessGroup: vi.fn(),
        reset: vi.fn(),
        treeScope: "direct_process",
      },
    });
    tracker.registerConnection({
      connectionId: "a",
      isolation: "session",
      serverName: "node_repl",
    });
    tracker.recordProcessStarted({ connectionId: "a", pid: 101 });
    await tracker.sampleNow();
    now += 300000;
    await tracker.sampleNow();
    expect(onResourceSamples).toHaveBeenCalledTimes(1);
    now += 300000;
    await tracker.sampleNow();
    expect(onResourceSamples).toHaveBeenLastCalledWith([
      expect.objectContaining({ cpuTimeMsDelta: 0 }),
    ]);
    now += 300000;
    await tracker.sampleNow();
    expect(onResourceSamples).toHaveBeenLastCalledWith([
      expect.objectContaining({ cpuTimeMsDelta: 0, rssKbTotal: 300 }),
    ]);
  });

  it("运行时烟测：真实 Node 子进程的 RSS 与 CPU 时间经探针到 tracker", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      process.on('message', () => {
        const until = performance.now() + 150;
        while (performance.now() < until) Math.sqrt(Math.random());
        process.send('done');
      });
      process.send('ready');
    `,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const batches: ZCodeMcpResourceSample[][] = [];
    const tracker = createMcpTelemetryTracker({
      idSalt: "runtime-smoke",
      onEvent: vi.fn(),
      onResourceSamples: (samples) => batches.push(samples),
    });
    try {
      await once(child, "message");
      if (!child.pid) throw new Error("child pid missing");
      tracker.registerConnection({
        connectionId: "runtime",
        isolation: "session",
        serverName: "node_repl",
      });
      tracker.recordProcessStarted({ connectionId: "runtime", pid: child.pid });
      await tracker.sampleNow();
      const done = once(child, "message");
      child.send("burn");
      await done;
      await tracker.sampleNow();
      expect(batches).toHaveLength(2);
      expect(batches[0]?.[0]?.cpuTimeMsDelta).toBe(0);
      expect(batches[1]?.[0]?.rssKbTotal).toBeGreaterThan(0);
      if (process.platform !== "win32") expect(batches[1]?.[0]?.cpuTimeMsDelta).toBeGreaterThan(0);
    } finally {
      tracker.stop();
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  it("定时器创建或清理失败不能改变 MCP 生命周期", () => {
    const tracker = createMcpTelemetryTracker({
      idSalt: "timer-failure",
      onEvent: vi.fn(),
      timer: {
        setInterval: () => {
          throw new Error("timer unavailable");
        },
        clearInterval() {},
      },
    });
    expect(() => tracker.start()).not.toThrow();
    const stopping = createMcpTelemetryTracker({
      idSalt: "timer-failure",
      onEvent: vi.fn(),
      timer: {
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {
          throw new Error("timer unavailable");
        },
      },
    });
    stopping.start();
    expect(() => stopping.stop()).not.toThrow();
  });
});
