import { describe, expect, it } from "vitest";
import {
  PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW,
  ProcessResourceWindowAggregator,
  type ProcessRoleSample,
} from "@desktop/main/processResourceWindowAggregator";

function sample(overrides: Partial<ProcessRoleSample> = {}): ProcessRoleSample {
  return {
    role: "main",
    cpuPercent: 10,
    rssKbTotal: 1_000,
    rssKbMaxProcess: 1_000,
    processCount: 1,
    uptimeMinutes: 5,
    ...overrides,
  };
}

describe("ProcessResourceWindowAggregator", () => {
  it("PRT-034 同硬件不同环境独立开窗，身份不进入出口属性", async () => {
    const { buildProcessWindowEventProperties } =
      await import("@desktop/main/processResourceWindowEvent");
    const aggregator = new ProcessResourceWindowAggregator();
    const hardware = {
      platform: "linux" as const,
      arch: "x64",
      logicalCpuCount: 8,
      totalMemoryGb: 32,
    };
    for (const environmentKey of ["a".repeat(64), "b".repeat(64)]) {
      aggregator.add(
        sample({
          role: "cli_chat",
          runtimeSurface: "remote",
          cpuPercent: 80,
          environmentKey,
          hardware,
        }),
      );
    }
    const reports = aggregator.drain();
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.cpuPercentPeak).toBe(80);
      const properties = buildProcessWindowEventProperties(report, {
        deviceMid: "test",
        appVersion: "test",
        armsEnv: "test",
        desktopHardware: hardware,
      });
      expect(properties).not.toHaveProperty("environmentKey");
      expect(Object.values(properties)).not.toContain("a".repeat(64));
      expect(Object.values(properties)).not.toContain("b".repeat(64));
    }
  });

  it("每角色一条报告，CPU 给 mean / p95 / peak，内存给 mean / peak / 最大单进程", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    aggregator.add(sample({ cpuPercent: 10, rssKbTotal: 100, rssKbMaxProcess: 60 }));
    aggregator.add(sample({ cpuPercent: 30, rssKbTotal: 300, rssKbMaxProcess: 200 }));
    aggregator.add(sample({ role: "gpu", cpuPercent: 5, rssKbTotal: 50, rssKbMaxProcess: 50 }));

    const reports = aggregator.drain();
    expect(reports.map((report) => report.role)).toEqual(["main", "gpu"]);
    expect(reports[0]).toMatchObject({
      cpuPercentMean: 20,
      cpuPercentPeak: 30,
      cpuPercentP95: 30,
      rssKbTotalMean: 200,
      rssKbTotalPeak: 300,
      rssKbMaxProcessPeak: 200,
      processCountPeak: 1,
      sampleCount: 2,
    });
  });

  it("PRT-003 多进程角色的 process_count_peak 取窗口内最大值", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    aggregator.add(sample({ role: "renderer_guest", processCount: 1, rssKbTotal: 100 }));
    aggregator.add(sample({ role: "renderer_guest", processCount: 3, rssKbTotal: 600 }));
    aggregator.add(sample({ role: "renderer_guest", processCount: 2, rssKbTotal: 300 }));

    const [report] = aggregator.drain();
    expect(report?.processCountPeak).toBe(3);
    expect(report?.rssKbTotalPeak).toBe(600);
  });

  it("PRT-004 background_ratio 是窗口内后台 tick 占比", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    for (let index = 0; index < 30; index += 1) {
      aggregator.recordScene(index < 9 ? "background" : "foreground");
      aggregator.add(sample());
    }

    const [report] = aggregator.drain();
    expect(report?.backgroundRatio).toBe(0.3);
    expect(report?.sampleCount).toBe(30);
  });

  it("PRT-005 uptime_minutes 取窗口内最大值", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    aggregator.add(sample({ uptimeMinutes: 10 }));
    aggregator.add(sample({ uptimeMinutes: 90 }));

    expect(aggregator.drain()[0]?.uptimeMinutes).toBe(90);
  });

  it("PRT-018 单角色样本数被截断到 32", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    for (let index = 0; index < 40; index += 1) {
      aggregator.recordScene("foreground");
      aggregator.add(sample({ cpuPercent: index }));
    }

    const [report] = aggregator.drain();
    expect(PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW).toBe(32);
    expect(report?.sampleCount).toBe(32);
    // 截断保留最近样本，peak 反映最后一段窗口的真实峰值。
    expect(report?.cpuPercentPeak).toBe(39);
  });

  it("heap 只在有样本时输出，且与 rss 样本数解耦", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    aggregator.add(sample({ heapUsedKb: 100 }));
    aggregator.add(sample());
    aggregator.add(sample({ heapUsedKb: 300 }));
    aggregator.add(sample({ role: "gpu" }));

    const reports = aggregator.drain();
    expect(reports[0]).toMatchObject({ heapUsedKbMean: 200, heapUsedKbPeak: 300, sampleCount: 3 });
    expect(reports[1]?.heapUsedKbMean).toBeUndefined();
    expect(reports[1]?.heapUsedKbPeak).toBeUndefined();
  });

  it("mcp_id 与 runtime_surface 不同的样本分属不同窗口", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    aggregator.add(sample({ role: "mcp", mcpId: "alpha" }));
    aggregator.add(sample({ role: "mcp", mcpId: "beta" }));
    aggregator.add(sample({ role: "cli_chat", runtimeSurface: "remote" }));
    aggregator.add(sample({ role: "cli_chat" }));

    const reports = aggregator.drain();
    expect(reports).toHaveLength(4);
    expect(reports.filter((report) => report.role === "mcp").map((report) => report.mcpId)).toEqual(
      ["alpha", "beta"],
    );
  });

  it("同一角色跨多台机器时分属不同窗口，一条事件只描述一台机器", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    const hostA = { platform: "linux" as const, arch: "x64", logicalCpuCount: 4, totalMemoryGb: 8 };
    const hostB = {
      platform: "linux" as const,
      arch: "arm64",
      logicalCpuCount: 16,
      totalMemoryGb: 64,
    };
    aggregator.add(
      sample({ role: "cli_chat", runtimeSurface: "remote", hardware: hostA, rssKbTotal: 100 }),
    );
    aggregator.add(
      sample({ role: "cli_chat", runtimeSurface: "remote", hardware: hostB, rssKbTotal: 900 }),
    );

    // 两个远端 workspace 在不同机器上：RSS 不能相加，硬件维度也不能被后到的样本覆盖。
    const reports = aggregator.drain();
    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.hardware)).toEqual([hostA, hostB]);
    expect(reports.map((report) => report.rssKbTotalPeak)).toEqual([100, 900]);
  });

  it("drain 之后窗口清空，scene 计数也重置", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    aggregator.recordScene("background");
    aggregator.add(sample());
    expect(aggregator.drain()).toHaveLength(1);
    expect(aggregator.drain()).toEqual([]);

    aggregator.recordScene("foreground");
    aggregator.add(sample());
    expect(aggregator.drain()[0]?.backgroundRatio).toBe(0);
  });

  it("clear 丢弃残窗，不产生事件", () => {
    const aggregator = new ProcessResourceWindowAggregator();
    aggregator.add(sample());
    aggregator.clear();
    expect(aggregator.drain()).toEqual([]);
  });
});
