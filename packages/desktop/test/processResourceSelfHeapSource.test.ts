import { describe, expect, it } from "vitest";
import { PROCESS_RESOURCE_SAMPLE_SOURCES } from "@desktop/main/processResourceSampleSourceRegistry";
import {
  ingestHostSelfResourceSample,
  ingestSchedulerSelfResourceSample,
  selfHeapProcessResourceSampleSource,
} from "@desktop/main/processResourceSelfHeapSource";
import type { ProcessResourceRole } from "@zcode/shared";

interface Collected {
  heapSamples: Array<[ProcessResourceRole, number]>;
  roleSamples: number;
}

function runSample(): Collected {
  const collected: Collected = { heapSamples: [], roleSamples: 0 };
  selfHeapProcessResourceSampleSource.sample?.({
    now: 0,
    addRoleSample: () => {
      collected.roleSamples += 1;
    },
    addRoleHeapSample: (role, heapUsedKb) => collected.heapSamples.push([role, heapUsedKb]),
    addAppProcessTotals: () => {},
  });
  return collected;
}

const sample = (heapUsedKb: number) => ({ cpuPercent: 1.5, rssKb: 380_000, heapUsedKb });

describe("processResourceSelfHeapSource", () => {
  it.each([
    [900_000, 100_000],
    [100_000, 900_000],
  ])("PRT-035 多 Host heap 按最大值聚合，不依赖到达顺序 %j", (first, second) => {
    selfHeapProcessResourceSampleSource.reset?.();
    ingestHostSelfResourceSample(sample(first));
    ingestHostSelfResourceSample(sample(second));
    expect(runSample().heapSamples).toEqual([["host", 900_000]]);
    expect(runSample().heapSamples).toEqual([]);
  });

  it("host 与 scheduler 的样本各自只贡献 heap，不额外开角色样本", () => {
    ingestHostSelfResourceSample(sample(92_160));
    ingestSchedulerSelfResourceSample(sample(24_576));

    const collected = runSample();

    expect(collected.heapSamples).toEqual([
      ["host", 92_160],
      ["scheduler", 24_576],
    ]);
    // CPU 与 RSS 由 main 的 getAppMetrics 负责，自采样本不再重复开角色样本。
    expect(collected.roleSamples).toBe(0);
  });

  it("一次自采读数只贡献一个 heap 样本，下一个 tick 不拿旧值充当当前事实", () => {
    ingestHostSelfResourceSample(sample(92_160));

    expect(runSample().heapSamples).toEqual([["host", 92_160]]);
    expect(runSample().heapSamples).toEqual([]);
  });

  it("字段缺失、类型错误或非对象的样本在 main 入口被丢弃且不抛错", () => {
    for (const invalid of [
      undefined,
      null,
      "sample",
      {},
      { cpuPercent: 1, rssKb: 100 },
      { cpuPercent: 1, rssKb: 100, heapUsedKb: "512" },
      { cpuPercent: 1, rssKb: 100, heapUsedKb: Number.NaN },
      { cpuPercent: 1, rssKb: 100, heapUsedKb: -1 },
      { cpuPercent: 1, rssKb: 100, heapUsedKb: 512, pid: 4_321 },
    ]) {
      expect(() => ingestHostSelfResourceSample(invalid)).not.toThrow();
      expect(() => ingestSchedulerSelfResourceSample(invalid)).not.toThrow();
    }

    expect(runSample().heapSamples).toEqual([]);
  });

  it("reset 丢弃尚未交付的样本", () => {
    ingestHostSelfResourceSample(sample(92_160));
    selfHeapProcessResourceSampleSource.reset?.();

    expect(runSample().heapSamples).toEqual([]);
  });

  it("已注册进来源注册表", () => {
    expect(PROCESS_RESOURCE_SAMPLE_SOURCES.map((source) => source.id)).toContain(
      selfHeapProcessResourceSampleSource.id,
    );
  });

  it("投递抛错时待交付样本已经清空，下一个 tick 不重复投递旧值", () => {
    ingestHostSelfResourceSample(sample(92_160));

    expect(() =>
      selfHeapProcessResourceSampleSource.sample?.({
        now: 0,
        addRoleSample: () => {},
        addRoleHeapSample: () => {
          throw new Error("aggregator failed");
        },
        addAppProcessTotals: () => {},
      }),
    ).toThrow();

    expect(runSample().heapSamples).toEqual([]);
  });
});
