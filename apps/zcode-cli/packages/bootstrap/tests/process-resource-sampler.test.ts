import { zcodeProcessResourceSampleSchema } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
  createZCodeProcessResourceSampler,
  type ProcessMemoryUsageSnapshot,
} from "../src/process-resource-sampler.js";

const memoryUsage: ProcessMemoryUsageSnapshot = {
  rss: 64 * 1024 * 1024,
  heapTotal: 32 * 1024 * 1024,
  heapUsed: 20 * 1024 * 1024,
  external: 4 * 1024 * 1024,
  arrayBuffers: 1024 * 1024,
};

describe("createZCodeProcessResourceSampler", () => {
  it("每 60 秒按差分计算 CPU 核心数、整机百分比和 RSS，并把完整内存快照作为第二参数交给 onSample", () => {
    const onSample = vi.fn();
    const unref = vi.fn();
    let scheduled: (() => void) | undefined;
    const cpuSnapshots = [
      { user: 0, system: 0 },
      { user: 2_000_000, system: 500_000 },
    ];
    const monotonicSnapshots = [0n, 1_000_000_000n];
    const sampler = createZCodeProcessResourceSampler({
      arch: "arm64",
      logicalCpuCount: 8,
      onSample,
      platform: "darwin",
      readCpuUsage: () => cpuSnapshots.shift()!,
      readMonotonicTimeNs: () => monotonicSnapshots.shift()!,
      readMemoryUsage: () => memoryUsage,
      readTotalMemoryBytes: () => 16 * 1024 ** 3,
      readUptimeSeconds: () => 12 * 60 + 20,
      instanceToken: "test-instance-token",
      timer: {
        clearInterval: vi.fn(),
        setInterval(callback, intervalMs) {
          expect(intervalMs).toBe(ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS);
          scheduled = callback;
          return { unref };
        },
      },
    });

    sampler.start();
    expect(unref).toHaveBeenCalledOnce();
    scheduled?.();

    // 05：同一次读数除 rss 外还给出 heap、运行时长与运行机内存，供 main 的 cli 角色事件使用；
    // heap 细分仍经第二参数进入本地诊断日志。
    expect(onSample).toHaveBeenCalledOnce();
    expect(onSample.mock.calls[0]?.[0]).toEqual({
      arch: "arm64",
      cpuCores: 2.5,
      cpuPercent: 31.25,
      heapUsedKb: 20_480,
      instanceToken: "test-instance-token",
      intervalMs: 1_000,
      logicalCpuCount: 8,
      platform: "darwin",
      rssKb: 65_536,
      totalMemoryGb: 16,
      uptimeMinutes: 12,
    });
    expect(onSample.mock.calls[0]?.[1]).toBe(memoryUsage);
    // CLI 是协议样本的生产方：样本必须直接通过协议 schema，否则 services 侧会整条丢弃。
    expect(() => zcodeProcessResourceSampleSchema.parse(onSample.mock.calls[0]?.[0])).not.toThrow();
  });

  it("instanceToken 在进程生命周期内不变，且不含 pid、路径等可识别内容", () => {
    const onSample = vi.fn();
    let scheduled: (() => void) | undefined;
    const cpuSnapshots = [
      { user: 0, system: 0 },
      { user: 1_000_000, system: 0 },
      { user: 2_000_000, system: 0 },
    ];
    const monotonicSnapshots = [0n, 1_000_000_000n, 2_000_000_000n];
    const sampler = createZCodeProcessResourceSampler({
      arch: "x64",
      logicalCpuCount: 4,
      onSample,
      platform: "linux",
      readCpuUsage: () => cpuSnapshots.shift()!,
      readMonotonicTimeNs: () => monotonicSnapshots.shift()!,
      readMemoryUsage: () => memoryUsage,
      timer: {
        clearInterval: vi.fn(),
        setInterval(callback) {
          scheduled = callback;
          return { unref: vi.fn() };
        },
      },
    });

    sampler.start();
    scheduled?.();
    scheduled?.();

    const tokens = onSample.mock.calls.map(
      (call) => (call[0] as { instanceToken?: string }).instanceToken,
    );
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    // 只允许 URL 安全字符：路径、workspace 标识不可能出现在这里，协议 schema 也会拒绝。
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(tokens[0]).not.toContain(String(process.pid));
  });

  it("采集或上报异常只丢当前样本，后续周期仍可继续", () => {
    const onSample = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("transport closed");
      })
      .mockImplementation(() => undefined);
    let scheduled: (() => void) | undefined;
    const cpuSnapshots = [
      { user: 0, system: 0 },
      { user: 1_000_000, system: 0 },
      new Error("cpu unavailable"),
      { user: 3_000_000, system: 0 },
    ];
    const monotonicSnapshots = [0n, 1_000_000_000n, 3_000_000_000n];
    const sampler = createZCodeProcessResourceSampler({
      arch: "x64",
      logicalCpuCount: 4,
      onSample,
      platform: "linux",
      readCpuUsage: () => {
        const next = cpuSnapshots.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      readMonotonicTimeNs: () => monotonicSnapshots.shift()!,
      readMemoryUsage: () => ({ ...memoryUsage, rss: 1024 }),
      timer: {
        clearInterval: vi.fn(),
        setInterval(callback) {
          scheduled = callback;
          return { unref: vi.fn() };
        },
      },
    });

    sampler.start();
    expect(() => scheduled?.()).not.toThrow();
    expect(() => scheduled?.()).not.toThrow();
    expect(() => scheduled?.()).not.toThrow();
    expect(onSample).toHaveBeenCalledTimes(2);
    expect(onSample.mock.calls[1]?.[0]).toMatchObject({
      cpuCores: 1,
      cpuPercent: 25,
      intervalMs: 2_000,
    });
  });

  it("readMemoryUsage 抛错时跳过当前周期且不抛出", () => {
    const onSample = vi.fn();
    let scheduled: (() => void) | undefined;
    const monotonicSnapshots = [0n, 1_000_000_000n];
    const sampler = createZCodeProcessResourceSampler({
      arch: "x64",
      logicalCpuCount: 4,
      onSample,
      platform: "linux",
      readCpuUsage: () => ({ user: 0, system: 0 }),
      readMonotonicTimeNs: () => monotonicSnapshots.shift()!,
      readMemoryUsage: () => {
        throw new Error("memoryUsage unavailable");
      },
      timer: {
        clearInterval: vi.fn(),
        setInterval(callback) {
          scheduled = callback;
          return { unref: vi.fn() };
        },
      },
    });

    sampler.start();
    expect(() => scheduled?.()).not.toThrow();
    expect(onSample).not.toHaveBeenCalled();
  });

  it("只创建一个 unref timer，stop 可幂等释放且不延长 CLI 生命周期", () => {
    const clearInterval = vi.fn();
    const handle = { unref: vi.fn() };
    const setInterval = vi.fn(() => handle);
    const sampler = createZCodeProcessResourceSampler({
      arch: "x64",
      logicalCpuCount: 1,
      onSample: vi.fn(),
      platform: "win32",
      readCpuUsage: () => ({ user: 0, system: 0 }),
      readMonotonicTimeNs: () => 0n,
      readMemoryUsage: () => memoryUsage,
      timer: { clearInterval, setInterval },
    });

    sampler.start();
    sampler.start();
    sampler.stop();
    sampler.stop();

    expect(setInterval).toHaveBeenCalledOnce();
    expect(handle.unref).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(handle);
  });

  it("unref 自身异常时仍保留 timer owner，stop 可以回收", () => {
    const handle = {
      unref() {
        throw new Error("unref unavailable");
      },
    };
    const clearInterval = vi.fn();
    const sampler = createZCodeProcessResourceSampler({
      arch: "x64",
      logicalCpuCount: 1,
      onSample: vi.fn(),
      platform: "linux",
      readCpuUsage: () => ({ user: 0, system: 0 }),
      readMonotonicTimeNs: () => 0n,
      readMemoryUsage: () => memoryUsage,
      timer: {
        clearInterval,
        setInterval: () => handle,
      },
    });

    expect(() => sampler.start()).not.toThrow();
    sampler.stop();
    expect(clearInterval).toHaveBeenCalledWith(handle);
  });
});
