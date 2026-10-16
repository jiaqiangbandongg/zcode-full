import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  cliProcessResourceSampleSource,
  ingestCliResourceSample,
} from "@desktop/main/processResourceCliSource";
import { PROCESS_RESOURCE_SAMPLE_SOURCES } from "@desktop/main/processResourceSampleSourceRegistry";
import {
  collectExternalAppResourceTotals,
  recordExternalAppResourceSample,
  resetExternalAppResourceSamples,
} from "@desktop/main/processResourceExternalAppSamples";
import type { ProcessRoleSample } from "@desktop/main/processResourceWindowAggregator";
import { ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS } from "@zcode/shared";

const CLI_PERIOD_MS = ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS;

function cliSample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: "darwin",
    arch: "arm64",
    logicalCpuCount: 10,
    intervalMs: CLI_PERIOD_MS,
    cpuCores: 0.5,
    cpuPercent: 5,
    rssKb: 200_000,
    heapUsedKb: 40_000,
    uptimeMinutes: 8,
    totalMemoryGb: 32,
    instanceToken: "chat-instance-0001",
    lane: "chat",
    ...overrides,
  };
}

/**
 * ingest 用 `Date.now()` 记到达时刻、tick 用 `context.now`，生产里两者是同一墙钟，
 * 因此测试必须让假时钟同时驱动两边，否则「有没有新读数」的判定会被时钟错位掩盖。
 */
function ingestAt(
  now: number,
  sample: unknown,
  runtimeSurface: "local" | "remote" = "local",
): void {
  vi.setSystemTime(now);
  ingestCliResourceSample(sample, runtimeSurface);
}

function collect(
  run: (context: Parameters<NonNullable<typeof cliProcessResourceSampleSource.sample>>[0]) => void,
  now: number,
): ProcessRoleSample[] {
  vi.setSystemTime(now);
  const samples: ProcessRoleSample[] = [];
  run({
    now,
    addRoleSample: (sample) => samples.push(sample),
    addRoleHeapSample: () => {},
    addAppProcessTotals: () => {},
  });
  return samples;
}

/** main 的 10 秒 tick。 */
function tickAt(now = 0): ProcessRoleSample[] {
  return collect((context) => cliProcessResourceSampleSource.sample?.(context), now);
}

/** 正常退出时的残窗补交。 */
function flushAt(now = 0): ProcessRoleSample[] {
  return collect((context) => cliProcessResourceSampleSource.flushPending?.(context), now);
}

describe("processResourceCliSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    cliProcessResourceSampleSource.reset?.();
    resetExternalAppResourceSamples();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("PRT-007 chat lane 的两个进程聚合为 cli_chat，plugin lane 归 cli_aux", () => {
    ingestAt(0, cliSample({ instanceToken: "chat-instance-0001", cpuPercent: 5, rssKb: 200_000 }));
    ingestAt(
      0,
      cliSample({
        instanceToken: "chat-instance-0002",
        cpuPercent: 7,
        rssKb: 300_000,
        heapUsedKb: 90_000,
        uptimeMinutes: 12,
      }),
    );
    ingestAt(
      0,
      cliSample({
        lane: "plugin",
        instanceToken: "aux-instance-0001",
        cpuPercent: 1,
        rssKb: 90_000,
      }),
    );

    expect(tickAt()).toEqual([
      {
        role: "cli_chat",
        runtimeSurface: "local",
        cpuPercent: 12,
        rssKbTotal: 500_000,
        rssKbMaxProcess: 300_000,
        processCount: 2,
        uptimeMinutes: 12,
        // 多进程角色的 heap 取每次采样的最大单进程。
        heapUsedKb: 90_000,
        hardware: { platform: "darwin", arch: "arm64", logicalCpuCount: 10, totalMemoryGb: 32 },
      },
      {
        role: "cli_aux",
        runtimeSurface: "local",
        cpuPercent: 1,
        rssKbTotal: 90_000,
        rssKbMaxProcess: 90_000,
        processCount: 1,
        uptimeMinutes: 8,
        heapUsedKb: 40_000,
        hardware: { platform: "darwin", arch: "arm64", logicalCpuCount: 10, totalMemoryGb: 32 },
      },
    ]);
  });

  it("mcp-status lane 与 plugin 合并进同一条 cli_aux", () => {
    ingestAt(
      0,
      cliSample({ lane: "mcp-status", instanceToken: "aux-mcp-status-01", rssKb: 100_000 }),
    );
    ingestAt(0, cliSample({ lane: "plugin", instanceToken: "aux-plugin-01", rssKb: 150_000 }));

    const samples = tickAt();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      role: "cli_aux",
      processCount: 2,
      rssKbTotal: 250_000,
      rssKbMaxProcess: 150_000,
    });
  });

  it("PRT-008 远端样本自带运行机信息，且不进入设备级应用总量", () => {
    ingestAt(
      0,
      cliSample({
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 4,
        totalMemoryGb: 8,
        instanceToken: "remote-instance-01",
      }),
      "remote",
    );

    expect(tickAt()).toEqual([
      expect.objectContaining({
        role: "cli_chat",
        runtimeSurface: "remote",
        hardware: { platform: "linux", arch: "x64", logicalCpuCount: 4, totalMemoryGb: 8 },
      }),
    ]);
    // 设备级总量只统计本机进程。
    expect(collectExternalAppResourceTotals(0)).toEqual({
      cpuPercent: 0,
      rssKbTotal: 0,
      processCount: 0,
    });
  });

  it("跑在两台不同远端机器上的同角色进程分成两条样本，RSS 不相加", () => {
    ingestAt(
      0,
      cliSample({
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 4,
        totalMemoryGb: 8,
        instanceToken: "remote-host-a",
        rssKb: 100_000,
      }),
      "remote",
    );
    ingestAt(
      0,
      cliSample({
        platform: "linux",
        arch: "arm64",
        logicalCpuCount: 16,
        totalMemoryGb: 64,
        instanceToken: "remote-host-b",
        rssKb: 900_000,
      }),
      "remote",
    );

    // 一条事件的 platform / arch / 核数 / 内存只能描述一台机器，因此按运行机分组。
    const samples = tickAt();
    expect(samples).toHaveLength(2);
    expect(samples.map((sample) => sample.rssKbTotal)).toEqual([100_000, 900_000]);
    expect(samples.map((sample) => sample.hardware?.logicalCpuCount)).toEqual([4, 16]);
    expect(samples.every((sample) => sample.processCount === 1)).toBe(true);
  });

  it("本机样本按角色喂进设备级应用总量的外部样本入口", () => {
    ingestAt(0, cliSample({ instanceToken: "chat-instance-0001" }));
    ingestAt(
      0,
      cliSample({
        lane: "plugin",
        instanceToken: "aux-instance-0001",
        cpuPercent: 1,
        rssKb: 90_000,
      }),
    );
    tickAt();

    expect(collectExternalAppResourceTotals(0)).toEqual({
      cpuPercent: 6,
      rssKbTotal: 290_000,
      processCount: 2,
    });
  });

  it("每 60 秒最多交一次，且只在有新读数时交，同一份读数不会被计入两次", () => {
    ingestAt(0, cliSample());

    expect(tickAt(0)).toHaveLength(1);
    expect(tickAt(10_000)).toHaveLength(0);
    // 60 秒到了，但 CLI 没有新读数（进程卡住或即将退出）：不能把同一份事实再计一次。
    expect(tickAt(CLI_PERIOD_MS)).toHaveLength(0);

    ingestAt(CLI_PERIOD_MS, cliSample({ rssKb: 260_000 }));
    expect(tickAt(CLI_PERIOD_MS + 10_000)[0]).toMatchObject({ rssKbTotal: 260_000 });
  });

  it("正常退出时把还没赶上 60 秒交付点的读数补交给窗口", () => {
    ingestAt(0, cliSample());
    expect(tickAt(0)).toHaveLength(1);

    // 退出发生在下一个交付点之前：这条读数只有 flushPending 能救回来。
    ingestAt(30_000, cliSample({ rssKb: 280_000 }));
    expect(tickAt(40_000)).toHaveLength(0);
    expect(flushAt(40_000)[0]).toMatchObject({ role: "cli_chat", rssKbTotal: 280_000 });

    // 已经交过的读数不会被重复排空。
    expect(flushAt(41_000)).toEqual([]);
  });

  it("同一进程的新读数覆盖旧读数，超过两个采样周期未更新的进程不再计入", () => {
    ingestAt(0, cliSample({ rssKb: 200_000 }));
    expect(tickAt(0)[0]).toMatchObject({ rssKbTotal: 200_000, processCount: 1 });

    ingestAt(CLI_PERIOD_MS, cliSample({ rssKb: 260_000 }));
    expect(tickAt(CLI_PERIOD_MS)[0]).toMatchObject({ rssKbTotal: 260_000, processCount: 1 });

    // 进程退出后不再有新读数：刚过两个采样周期条目就被丢弃，不拿旧值充当当前事实。
    expect(tickAt(CLI_PERIOD_MS * 3 + 1)).toEqual([]);
    expect(flushAt(CLI_PERIOD_MS * 3 + 1)).toEqual([]);
  });

  it("非法样本在 main 入口被丢弃且不抛错", () => {
    for (const invalid of [
      undefined,
      null,
      "sample",
      {},
      cliSample({ lane: "unknown-lane" }),
      cliSample({ instanceToken: "/Users/somebody/repo" }),
      cliSample({ cpuPercent: Number.NaN }),
      { ...cliSample(), pid: 4_321 },
      { ...cliSample(), workspacePath: "/Users/somebody/repo" },
    ]) {
      expect(() => ingestCliResourceSample(invalid, "local")).not.toThrow();
    }

    expect(tickAt()).toEqual([]);
  });

  it("旧 CLI 的样本没有新字段也能聚合，heap 与运行时长缺省不进事件", () => {
    ingestAt(0, {
      platform: "darwin",
      arch: "arm64",
      logicalCpuCount: 10,
      intervalMs: CLI_PERIOD_MS,
      cpuCores: 0.5,
      cpuPercent: 5,
      rssKb: 200_000,
    });

    expect(tickAt()).toEqual([
      {
        // 无 lane 的样本按 chat 归属：唯一来源是版本落后、还没打标的远端 server。
        role: "cli_chat",
        runtimeSurface: "local",
        cpuPercent: 5,
        rssKbTotal: 200_000,
        rssKbMaxProcess: 200_000,
        // 无 instanceToken 时无法区分进程，只能按一个进程计。
        processCount: 1,
        uptimeMinutes: 0,
        hardware: { platform: "darwin", arch: "arm64", logicalCpuCount: 10 },
      },
    ]);
  });

  it("reset 丢弃尚未交出的样本", () => {
    ingestAt(0, cliSample());
    cliProcessResourceSampleSource.reset?.();

    expect(tickAt()).toEqual([]);
  });

  it("PRT-033 本机 aux 停更后不被 chat 新读数重复交付或续期", () => {
    ingestAt(0, cliSample({ lane: "plugin", instanceToken: "aux-stopped-01", rssKb: 250_000 }));
    expect(tickAt(0)).toHaveLength(1);
    for (const now of [60_000, 120_000]) {
      ingestAt(now, cliSample({ instanceToken: "chat-active-01", rssKb: 400_000 }));
      expect(tickAt(now).map((sample) => sample.role)).toEqual(["cli_chat"]);
    }
    expect(tickAt(120_001)).toEqual([]);
    expect(collectExternalAppResourceTotals(120_001)).toMatchObject({
      rssKbTotal: 400_000,
      processCount: 1,
    });
    ingestAt(130_000, cliSample({ instanceToken: "chat-active-01", rssKb: 420_000 }));
    expect(flushAt(130_000).map((sample) => sample.role)).toEqual(["cli_chat"]);
    expect(flushAt(130_001)).toEqual([]);
  });

  it("PRT-033 错相位两组在五个周期中各交付五次", () => {
    const delivered: ProcessRoleSample[] = [];
    for (let now = 0; now <= 300_000; now += 10_000) {
      if (now < 300_000 && now % 60_000 === 0)
        ingestAt(now, cliSample({ instanceToken: "chat-active-01" }));
      if (now % 60_000 === 30_000)
        ingestAt(now, cliSample({ instanceToken: "aux-active-01", lane: "plugin" }));
      delivered.push(...tickAt(now));
    }
    expect(delivered.filter((sample) => sample.role === "cli_chat")).toHaveLength(5);
    expect(delivered.filter((sample) => sample.role === "cli_aux")).toHaveLength(5);
  });

  it("PRT-033 同组某实例到期后立即退出设备总量，不等另一个实例下次交付", () => {
    ingestAt(0, cliSample({ instanceToken: "chat-stopped-01", rssKb: 250_000 }));
    ingestAt(0, cliSample({ instanceToken: "chat-active-01", rssKb: 400_000 }));
    tickAt(0);
    for (const now of [60_000, 120_000]) {
      ingestAt(now, cliSample({ instanceToken: "chat-active-01", rssKb: 400_000 }));
      tickAt(now);
    }
    expect(collectExternalAppResourceTotals(120_000).processCount).toBe(2);
    tickAt(120_001);
    expect(collectExternalAppResourceTotals(120_001)).toMatchObject({
      rssKbTotal: 400_000,
      processCount: 1,
    });
  });

  it("PRT-033 按实例保存 CLI 后仍保留 MCP 来源的预算", () => {
    for (let index = 0; index < 64; index++) {
      ingestAt(0, cliSample({ instanceToken: `chat-instance-${index}` }));
    }
    for (let index = 0; index < 32; index++) {
      recordExternalAppResourceSample({
        sourceKey: `mcp:${index}`,
        runtimeSurface: "local",
        cpuPercent: 0,
        rssKbTotal: 1000,
        processCount: 1,
        receivedAt: 0,
        intervalMs: 300_000,
      });
    }
    expect(collectExternalAppResourceTotals(0).processCount).toBe(96);
  });

  it("PRT-034 同硬件不同环境与相同实例标识仍隔离，同环境重复转发只计一次", () => {
    const raw = cliSample({ cpuPercent: 80, rssKb: 500_000 });
    const environmentA = "a".repeat(64);
    const environmentB = "b".repeat(64);
    ingestCliResourceSample(raw, "remote", environmentA);
    ingestCliResourceSample(raw, "remote", environmentB);
    ingestCliResourceSample(raw, "remote", environmentA);
    const samples = tickAt();
    expect(samples).toHaveLength(2);
    expect(samples.map((sample) => sample.environmentKey)).toEqual([environmentA, environmentB]);
    expect(
      samples.every(
        (sample) =>
          sample.cpuPercent === 80 && sample.rssKbTotal === 500_000 && sample.processCount === 1,
      ),
    ).toBe(true);
    expect(collectExternalAppResourceTotals(0).processCount).toBe(0);
  });

  it("已注册进来源注册表", () => {
    expect(PROCESS_RESOURCE_SAMPLE_SOURCES.map((source) => source.id)).toContain(
      cliProcessResourceSampleSource.id,
    );
  });
});
