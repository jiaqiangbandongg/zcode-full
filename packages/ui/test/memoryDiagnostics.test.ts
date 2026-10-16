import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDiagnosticsRegistry } from "@zcode/shared";
import {
  readRendererHeapSnapshot,
  startMemoryDiagnosticsLogger,
} from "../src/lib/memoryDiagnostics.js";

describe("startMemoryDiagnosticsLogger", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("60s 采样：首次写盘，无变化不写，计数器变化再写；stop 后不再采样", () => {
    vi.useFakeTimers();
    const registry = createMemoryDiagnosticsRegistry();
    let cacheSize = 1;
    registry.register("shiki", () => ({ tokensCache: cacheSize }));
    const write = vi.fn();
    let nowMs = 0;
    const handle = startMemoryDiagnosticsLogger({
      registry,
      write,
      now: () => nowMs,
      readHeap: () => ({ usedJSHeapSize: 50 * 1024 * 1024, totalJSHeapSize: 80 * 1024 * 1024 }),
    });

    nowMs = 60_000;
    vi.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toBe(
      "[memory] role=renderer reason=first heapUsedKb=51200 heapTotalKb=81920 shiki.tokensCache=1",
    );

    nowMs = 120_000;
    vi.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledOnce();

    cacheSize = 2;
    nowMs = 180_000;
    vi.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]).toContain("reason=changed");

    handle.stop();
    cacheSize = 3;
    nowMs = 240_000;
    vi.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("performance.memory 缺失时省略 heap 字段，仅按计数器门控", () => {
    const registry = createMemoryDiagnosticsRegistry();
    registry.register("xterm", () => ({ sessions: 0 }));
    const write = vi.fn();
    const handle = startMemoryDiagnosticsLogger({ registry, write, readHeap: () => undefined });
    expect(handle.sampleNow()).toBe(true);
    expect(write.mock.calls[0]?.[0]).toBe("[memory] role=renderer reason=first xterm.sessions=0");
    handle.stop();
  });

  it("provider 抛错只跳过自己；write 抛错只丢当前样本", () => {
    const registry = createMemoryDiagnosticsRegistry();
    registry.register("ok", () => ({ v: 1 }));
    registry.register("boom", () => {
      throw new Error("read failed");
    });
    const write = vi.fn(() => {
      throw new Error("bridge gone");
    });
    const handle = startMemoryDiagnosticsLogger({ registry, write, readHeap: () => undefined });
    expect(handle.sampleNow()).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toContain("ok.v=1");
    handle.stop();
  });

  it("PRT-021 60s tick 的同一次读数既发 heap 样本又写本地日志；无桥时 no-op", () => {
    vi.useFakeTimers();
    const registry = createMemoryDiagnosticsRegistry();
    registry.register("shiki", () => ({ tokensCache: 1 }));
    const write = vi.fn();
    const reportHeapSample = vi.fn();
    const handle = startMemoryDiagnosticsLogger({
      registry,
      write,
      reportHeapSample,
      now: () => 60_000,
      readHeap: () => ({ usedJSHeapSize: 50 * 1024 * 1024, totalJSHeapSize: 80 * 1024 * 1024 }),
    });

    vi.advanceTimersByTime(60_000);

    // 一次读数两个出口：桥拿到 heap 样本，本地诊断日志照旧按门控写出。
    expect(reportHeapSample).toHaveBeenCalledOnce();
    expect(reportHeapSample).toHaveBeenCalledWith({ heapUsedKb: 51_200 });
    expect(write.mock.calls[0]?.[0]).toContain("heapUsedKb=51200");
    handle.stop();

    // 无桥环境（Web 端与手机远控）：不注入 reportHeapSample 时只写日志，不抛错。
    const webWrite = vi.fn();
    const webHandle = startMemoryDiagnosticsLogger({
      registry,
      write: webWrite,
      now: () => 120_000,
      readHeap: () => ({ usedJSHeapSize: 50 * 1024 * 1024 }),
    });
    expect(() => webHandle.sampleNow()).not.toThrow();
    expect(webWrite).toHaveBeenCalledOnce();
    webHandle.stop();
  });

  it("PRT-021 门控不写盘的 tick 仍发 heap 样本；桥抛错不影响本地日志", () => {
    const registry = createMemoryDiagnosticsRegistry();
    registry.register("shiki", () => ({ tokensCache: 1 }));
    const write = vi.fn();
    const reportHeapSample = vi.fn(() => {
      throw new Error("bridge gone");
    });
    let nowMs = 0;
    const handle = startMemoryDiagnosticsLogger({
      registry,
      write,
      reportHeapSample,
      now: () => nowMs,
      readHeap: () => ({ usedJSHeapSize: 50 * 1024 * 1024 }),
    });

    // 桥先失败，本地日志仍要写出：遥测出口不能反过来吃掉诊断日志。
    expect(handle.sampleNow()).toBe(true);
    expect(write).toHaveBeenCalledOnce();

    // 第二次采样计数器无变化被门控挡住，heap 样本仍要按 60 秒节拍上报。
    nowMs = 60_000;
    expect(handle.sampleNow()).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(reportHeapSample).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("performance.memory 缺失时不发 heap 样本", () => {
    const registry = createMemoryDiagnosticsRegistry();
    registry.register("xterm", () => ({ sessions: 0 }));
    const reportHeapSample = vi.fn();
    const handle = startMemoryDiagnosticsLogger({
      registry,
      write: vi.fn(),
      reportHeapSample,
      readHeap: () => undefined,
    });

    expect(handle.sampleNow()).toBe(true);
    expect(reportHeapSample).not.toHaveBeenCalled();
    handle.stop();
  });

  it("计数器采集失败也不影响 heap 样本上报", () => {
    const reportHeapSample = vi.fn();
    const handle = startMemoryDiagnosticsLogger({
      // 本地日志的计数器是附加维度；它塌了不能把已经读到的 heap 样本一起丢掉。
      registry: {
        register: () => ({ dispose: () => {} }),
        collect: () => {
          throw new Error("counters unavailable");
        },
      },
      write: vi.fn(),
      reportHeapSample,
      readHeap: () => ({ usedJSHeapSize: 50 * 1024 * 1024 }),
    });

    expect(handle.sampleNow()).toBe(false);
    expect(reportHeapSample).toHaveBeenCalledWith({ heapUsedKb: 51_200 });
    handle.stop();
  });

  it("readRendererHeapSnapshot 只在 Chromium performance.memory 存在时返回", () => {
    vi.stubGlobal("performance", {});
    expect(readRendererHeapSnapshot()).toBeUndefined();
    vi.stubGlobal("performance", { memory: { usedJSHeapSize: 10, totalJSHeapSize: 20 } });
    expect(readRendererHeapSnapshot()).toEqual({ usedJSHeapSize: 10, totalJSHeapSize: 20 });
  });
});

describe("logger.logMemoryDiagnostics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean })
      .__ZCODE_RENDERER_DISABLE_LOGGING__;
  });

  async function importLogger() {
    vi.resetModules();
    return import("../src/logger.js");
  }

  it("MEM-010 生产构建仍经桌面桥写 info", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const bridgeLog = vi.fn();
    vi.stubGlobal("window", { zcode: { log: bridgeLog } });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const { logMemoryDiagnostics } = await importLogger();
    logMemoryDiagnostics("[memory] role=renderer reason=first");

    expect(bridgeLog).toHaveBeenCalledWith("info", ["[memory] role=renderer reason=first"]);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("无桌面桥（Web 端）且生产构建时 no-op", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("window", {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const { logMemoryDiagnostics } = await importLogger();
    logMemoryDiagnostics("[memory] role=renderer reason=first");

    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("全局禁用开关关闭时不输出", async () => {
    const bridgeLog = vi.fn();
    vi.stubGlobal("window", { zcode: { log: bridgeLog } });
    (
      globalThis as { __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean }
    ).__ZCODE_RENDERER_DISABLE_LOGGING__ = true;

    const { logMemoryDiagnostics } = await importLogger();
    logMemoryDiagnostics("[memory] role=renderer reason=first");

    expect(bridgeLog).not.toHaveBeenCalled();
  });
});
