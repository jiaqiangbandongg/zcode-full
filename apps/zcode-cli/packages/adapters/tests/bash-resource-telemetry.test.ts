import { afterEach, describe, expect, it, vi } from "vitest";
import { zcodeToolExecResourceSchema } from "@zcode/shared";
import { createBashResourceTelemetry } from "../src/exec/bash-resource-telemetry.js";
import { createProcessProbe } from "../src/device/process-probe.js";

afterEach(() => vi.useRealTimers());

describe("Bash 慢命令采样", () => {
  it("相同指标的不同命令各有完成标识，同一命令重复 finish 只发一次", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    const options = {
      platform: "win32" as const,
      onComplete,
      readContext: () => ({ cliRssKb: 1024, systemFreeMemoryKb: 2048 }),
    };
    const first = createBashResourceTelemetry(options);
    const second = createBashResourceTelemetry(options);
    await vi.advanceTimersByTimeAsync(40_000);

    first.finish("completed");
    first.finish("killed");
    second.finish("completed");

    expect(onComplete).toHaveBeenCalledTimes(2);
    const firstSample = onComplete.mock.calls[0]?.[0];
    const secondSample = onComplete.mock.calls[1]?.[0];
    expect(firstSample).toMatchObject({ completionToken: expect.any(String) });
    expect(secondSample).toMatchObject({ completionToken: expect.any(String) });
    expect(zcodeToolExecResourceSchema.parse(firstSample)).toEqual(firstSample);
    expect(zcodeToolExecResourceSchema.parse(secondSample)).toEqual(secondSample);
    expect(firstSample.completionToken).not.toBe(secondSample.completionToken);
    expect({ ...firstSample, completionToken: undefined }).toEqual({
      ...secondSample,
      completionToken: undefined,
    });
  });

  it("错相位命令不提前采样，共享 tick 不补采积压", async () => {
    vi.useFakeTimers();
    const probe = { sampleProcessGroup: vi.fn().mockResolvedValue([{ pid: 10, rssKb: 100 }]) };
    const first = createBashResourceTelemetry({
      platform: "linux",
      processGroupId: 10,
      probe,
      onComplete: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(500);
    const second = createBashResourceTelemetry({
      platform: "linux",
      processGroupId: 20,
      probe,
      onComplete: vi.fn(),
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(14500);
    expect(probe.sampleProcessGroup.mock.calls).toEqual([[10]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.sampleProcessGroup.mock.calls).toEqual([[10], [20]]);
    await vi.advanceTimersByTimeAsync(14000);
    expect(probe.sampleProcessGroup.mock.calls).toEqual([[10], [20], [10]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.sampleProcessGroup.mock.calls).toEqual([[10], [20], [10], [20]]);
    first.finish("completed");
    second.finish("completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("多条 Bash 共用既有轮询器，短命令退出不会重置其他命令的采样节拍", async () => {
    vi.useFakeTimers();
    const sampleProcessGroup = vi.fn().mockResolvedValue([{ pid: 10, rssKb: 100 }]);
    const options = {
      platform: "linux" as const,
      processGroupId: 10,
      probe: { sampleProcessGroup },
      onComplete: vi.fn(),
    };
    const first = createBashResourceTelemetry(options);
    const second = createBashResourceTelemetry(options);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    first.finish("completed");
    await vi.advanceTimersByTimeAsync(25000);
    expect(sampleProcessGroup).toHaveBeenCalledTimes(2);
    second.finish("completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("PRT-012: Windows 无定时探针，40 秒结束只带零成本属性", async () => {
    vi.useFakeTimers();
    const execFile = vi.fn();
    const onComplete = vi.fn();
    const sampler = createBashResourceTelemetry({
      platform: "win32",
      processGroupId: 123,
      probe: createProcessProbe({ platform: "win32", execFile }),
      onComplete,
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(40000);
    sampler.finish("completed");
    expect(execFile).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      completionToken: expect.any(String),
      platform: "win32",
      toolName: "bash",
      durationMs: 40000,
      exitKind: "completed",
      sampleCount: 0,
      cliRssKb: expect.any(Number),
      systemFreeMemoryKb: expect.any(Number),
    });
  });

  it("最多尝试 20 次，长命令仍在结束时报告且计时器释放", async () => {
    vi.useFakeTimers();
    const sampleProcessGroup = vi.fn().mockResolvedValue([{ pid: 10, rssKb: 100, cpuTimeMs: 200 }]);
    const onComplete = vi.fn();
    const sampler = createBashResourceTelemetry({
      platform: "linux",
      processGroupId: 10,
      probe: { sampleProcessGroup },
      onComplete,
    });
    await vi.advanceTimersByTimeAsync(600000);
    expect(sampleProcessGroup).toHaveBeenCalledTimes(20);
    expect(vi.getTimerCount()).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
    sampler.finish("timeout");
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleCount: 20,
        exitKind: "timeout",
        durationMs: 600000,
        treeCpuTimeMs: 200,
      }),
    );
  });

  it("探针抛错、空样本与超时只丢样本，完成回调抛错不外溢", async () => {
    vi.useFakeTimers();
    const sampleProcessGroup = vi
      .fn()
      .mockRejectedValueOnce(new Error("probe failed"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined);
    const onComplete = vi.fn(() => {
      throw new Error("closed");
    });
    const sampler = createBashResourceTelemetry({
      platform: "linux",
      processGroupId: 10,
      probe: { sampleProcessGroup },
      onComplete,
    });
    await vi.advanceTimersByTimeAsync(45000);
    expect(() => sampler.finish("error")).not.toThrow();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleCount: 0,
        treeRssKbPeak: 0,
        treeCpuTimeMs: 0,
        exitKind: "error",
      }),
    );
  });

  it("采样不重叠，结束不等待在途探针，迟到结果丢弃", async () => {
    vi.useFakeTimers();
    let resolve!: (rows: { pid: number; rssKb: number; cpuTimeMs: number }[]) => void;
    const sampleProcessGroup = vi.fn(
      () =>
        new Promise<{ pid: number; rssKb: number; cpuTimeMs: number }[]>((done) => {
          resolve = done;
        }),
    );
    const onComplete = vi.fn();
    const sampler = createBashResourceTelemetry({
      platform: "linux",
      processGroupId: 10,
      probe: { sampleProcessGroup },
      onComplete,
    });
    await vi.advanceTimersByTimeAsync(40000);
    expect(sampleProcessGroup).toHaveBeenCalledTimes(1);
    sampler.finish("killed");
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ sampleCount: 0, exitKind: "killed" }),
    );
    resolve([{ pid: 10, rssKb: 1000, cpuTimeMs: 2000 }]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0].sampleCount).toBe(0);
  });
  it("PRT-011: 40 秒命令在 15/30 秒采样，退出只发一次；5 秒命令不发", async () => {
    vi.useFakeTimers();
    const sampleProcessGroup = vi
      .fn()
      .mockResolvedValueOnce([
        { pid: 10, rssKb: 100, cpuTimeMs: 1000 },
        { pid: 11, rssKb: 200, cpuTimeMs: 2000 },
      ])
      .mockResolvedValueOnce([{ pid: 10, rssKb: 200, cpuTimeMs: 4000 }]);
    const onComplete = vi.fn();
    const options = {
      processGroupId: 10,
      platform: "linux" as const,
      probe: { sampleProcessGroup },
      onComplete,
      readContext: () => ({ cliRssKb: 1024, systemFreeMemoryKb: 2048 }),
    };
    const short = createBashResourceTelemetry(options);
    await vi.advanceTimersByTimeAsync(5000);
    short.finish("completed");
    expect(onComplete).not.toHaveBeenCalled();
    const slow = createBashResourceTelemetry(options);
    await vi.advanceTimersByTimeAsync(14999);
    expect(sampleProcessGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sampleProcessGroup).toHaveBeenCalledExactlyOnceWith(10);
    await vi.advanceTimersByTimeAsync(15000);
    expect(sampleProcessGroup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000);
    slow.finish("completed");
    slow.finish("killed");
    await vi.advanceTimersByTimeAsync(15000);
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({
      completionToken: expect.any(String),
      platform: "linux",
      toolName: "bash",
      durationMs: 40000,
      exitKind: "completed",
      treeRssKbPeak: 300,
      treeCpuTimeMs: 6000,
      sampleCount: 2,
      cliRssKb: 1024,
      systemFreeMemoryKb: 2048,
    });
    expect(sampleProcessGroup).toHaveBeenCalledTimes(2);
  });
});
