import { describe, expect, it, vi } from "vitest";
import {
  runProcessResourceDeviceSampleSources,
  runProcessResourceSampleSources,
  resetProcessResourceSampleSources,
  type ProcessResourceSampleSource,
} from "@desktop/main/processResourceSampleSources";
import type { DeviceResourceSample } from "@desktop/main/processResourceSystemWindowAggregator";
import { PROCESS_RESOURCE_SAMPLE_SOURCES } from "@desktop/main/processResourceSampleSourceRegistry";
import type { ProcessRoleSample } from "@desktop/main/processResourceWindowAggregator";

function fixedSource(id: string, role: ProcessRoleSample["role"]): ProcessResourceSampleSource {
  return {
    id,
    sample(context) {
      context.addRoleSample({
        role,
        cpuPercent: 1,
        rssKbTotal: 10,
        rssKbMaxProcess: 10,
        processCount: 1,
        uptimeMinutes: 0,
      });
    },
  };
}

describe("processResourceSampleSources", () => {
  it("按注册表顺序采集全部来源的样本", () => {
    const samples: ProcessRoleSample[] = [];
    runProcessResourceSampleSources([fixedSource("a", "main"), fixedSource("b", "host")], {
      now: 0,
      addRoleSample: (sample) => samples.push(sample),
      addRoleHeapSample: () => {},
      addAppProcessTotals: () => {},
    });

    expect(samples.map((sample) => sample.role)).toEqual(["main", "host"]);
  });

  it("新增一个来源不改变已有来源的产出", () => {
    const existing = fixedSource("existing", "main");
    const before: ProcessRoleSample[] = [];
    runProcessResourceSampleSources([existing], {
      now: 0,
      addRoleSample: (sample) => before.push(sample),
      addRoleHeapSample: () => {},
      addAppProcessTotals: () => {},
    });

    const after: ProcessRoleSample[] = [];
    runProcessResourceSampleSources([existing, fixedSource("added", "scheduler")], {
      now: 0,
      addRoleSample: (sample) => after.push(sample),
      addRoleHeapSample: () => {},
      addAppProcessTotals: () => {},
    });

    expect(after.filter((sample) => sample.role === "main")).toEqual(before);
    expect(after.map((sample) => sample.role)).toEqual(["main", "scheduler"]);
  });

  it("单个来源抛错只丢它自己的样本，其余来源照常产出", () => {
    const onError = vi.fn();
    const samples: ProcessRoleSample[] = [];
    const broken: ProcessResourceSampleSource = {
      id: "broken",
      sample() {
        throw new Error("probe failed");
      },
    };

    expect(() =>
      runProcessResourceSampleSources([broken, fixedSource("healthy", "gpu")], {
        now: 0,
        addRoleSample: (sample) => samples.push(sample),
        addRoleHeapSample: () => {},
        addAppProcessTotals: () => {},
        onError,
      }),
    ).not.toThrow();

    expect(samples.map((sample) => sample.role)).toEqual(["gpu"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("broken");
  });

  it("reset 逐个调用来源的 reset，抛错不打断其他来源", () => {
    const resetA = vi.fn();
    const resetC = vi.fn();
    resetProcessResourceSampleSources([
      { id: "a", reset: resetA },
      {
        id: "b",
        reset: () => {
          throw new Error("reset failed");
        },
      },
      { id: "c", reset: resetC },
    ]);

    expect(resetA).toHaveBeenCalledTimes(1);
    expect(resetC).toHaveBeenCalledTimes(1);
  });

  it("第二阶段拿到第一阶段的精确合计，单个来源抛错只丢它自己的设备样本", () => {
    const onError = vi.fn();
    const deviceSamples: DeviceResourceSample[] = [];
    const broken: ProcessResourceSampleSource = {
      id: "broken-device",
      sampleDevice() {
        throw new Error("device probe failed");
      },
    };
    const healthy: ProcessResourceSampleSource = {
      id: "healthy-device",
      sampleDevice(context) {
        context.addDeviceSample({
          systemCpuPercent: 10,
          systemFreeMemoryKb: 1_000,
          appCpuPercent: context.appProcessTotals?.cpuPercent ?? 0,
          appRssKbTotal: context.appProcessTotals?.rssKbTotal ?? 0,
          appProcessCount: context.appProcessTotals?.processCount ?? 0,
        });
      },
    };

    expect(() =>
      runProcessResourceDeviceSampleSources([broken, healthy], {
        now: 0,
        appProcessTotals: { cpuPercent: 7, rssKbTotal: 700, processCount: 3 },
        addDeviceSample: (sample) => deviceSamples.push(sample),
        onError,
      }),
    ).not.toThrow();

    expect(deviceSamples).toEqual([
      {
        systemCpuPercent: 10,
        systemFreeMemoryKb: 1_000,
        appCpuPercent: 7,
        appRssKbTotal: 700,
        appProcessCount: 3,
      },
    ]);
    expect(onError.mock.calls[0]?.[0]).toBe("broken-device");
  });

  it("注册表里的来源 id 唯一", () => {
    const ids = PROCESS_RESOURCE_SAMPLE_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("chromium");
    expect(ids).toContain("system");
    expect(ids).toContain("self_heap");
  });
});
