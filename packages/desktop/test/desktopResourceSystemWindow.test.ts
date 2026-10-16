import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARMS_CUSTOM_EVENT_PROPERTY_LIMIT } from "@zcode/shared";

/**
 * 设备级 `perf_system_window`（票 02，spec：docs/monitoring/process-resource-telemetry.md）。
 *
 * 测试缝与 01 一致：伪造 `getAppMetrics`、`os` 整机指标、时钟与 `armsRum.sendCustom` 间谍，
 * 推进 tick 与 flush 后断言事件名、value、属性集合与属性数，不测内部数据结构。
 */

const execFileSyncMock = vi.fn();
const execFileMock = vi.fn();
const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const execMock = vi.fn();
const sendCustomMock = vi.fn();
const getAppMetricsMock = vi.fn(() => [] as unknown[]);
const getAllWebContentsMock = vi.fn(() => [] as unknown[]);
const getAllWindowsMock = vi.fn(() => [] as unknown[]);

let logicalCpuCount = 8;
let totalMemoryBytes = 16 * 1024 ** 3;
/** 整机 CPU 忙比例；累计时间由 Date.now() 推导，同一个 tick 内多次调用得到同一快照。 */
let systemBusyRatio = 0.5;
let readFreeMemoryBytes: () => number = () => 8 * 1024 ** 3;

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const cpus = (): unknown[] => {
    const elapsedMs = Date.now();
    const busy = elapsedMs * systemBusyRatio;
    return Array.from({ length: logicalCpuCount }, () => ({
      model: "fake",
      speed: 2_400,
      times: { user: busy, nice: 0, sys: 0, idle: elapsedMs - busy, irq: 0 },
    }));
  };
  const totalmem = (): number => totalMemoryBytes;
  const freemem = (): number => readFreeMemoryBytes();
  return {
    ...actual,
    cpus,
    totalmem,
    freemem,
    default: { ...actual, cpus, totalmem, freemem },
  };
});

vi.mock("electron", () => ({
  app: {
    getAppMetrics: getAppMetricsMock,
    getPath: vi.fn((name: string) => (name === "userData" ? "/tmp/zcode-user" : "/tmp")),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp/zcode-app"),
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  webContents: {
    getAllWebContents: getAllWebContentsMock,
  },
}));

vi.mock("../src/main/logger.js", () => ({
  // 与 01 的单测同因：resourceManagerWindow 在导入时会加载真实 logger，隔离无关的日志 IO。
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@arms/rum-electron", () => ({
  default: {
    sendCustom: sendCustomMock,
    setConfig: vi.fn(),
  },
}));

const MAIN_PID = process.pid;
const MAIN_WINDOW_WC_ID = 11;
const MAIN_WINDOW_PID = 201;
const GUEST_WC_ID = 12;
const GUEST_PID = 202;
const GPU_PID = 203;
const HOST_PID = 204;
const SCHEDULER_PID = 205;
const OTHER_PID = 206;
const SAMPLE_INTERVAL_MS = 10_000;
const REPORT_INTERVAL_MS = 300_000;
const SYSTEM_WINDOW_EVENT = "perf_system_window";

interface FakeMetric {
  pid: number;
  type: string;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
  creationTime?: number;
}

function metric(pid: number, type: string, cpu: number, workingSetKb: number): FakeMetric {
  return {
    pid,
    type,
    cpu: { percentCPUUsage: cpu },
    memory: { workingSetSize: workingSetKb },
  };
}

function fakeWebContents(id: number, pid: number, type: string): unknown {
  return {
    id,
    isDestroyed: () => false,
    getOSProcessId: () => pid,
    getType: () => type,
    getTitle: () => `wc-${id}`,
    getURL: () => "about:blank",
  };
}

/** 与 PRT-001 角色用例同一套七类进程 fixture，确保应用总量覆盖全部 Chromium 角色。 */
async function registerAllChromiumRoles(): Promise<() => void> {
  const {
    registerHostProcess,
    registerMainApplicationWindow,
    registerSchedulerProcess,
    unregisterHostProcess,
    unregisterMainApplicationWindow,
    unregisterSchedulerProcess,
  } = await import("../src/main/resourceManagerWindow.js");

  const scheduler = { pid: SCHEDULER_PID } as never;
  registerHostProcess("local-1", { pid: HOST_PID } as never);
  registerSchedulerProcess(scheduler);
  registerMainApplicationWindow(MAIN_WINDOW_WC_ID);
  getAllWebContentsMock.mockReturnValue([
    fakeWebContents(MAIN_WINDOW_WC_ID, MAIN_WINDOW_PID, "window"),
    fakeWebContents(GUEST_WC_ID, GUEST_PID, "webview"),
  ]);

  return () => {
    unregisterHostProcess("local-1");
    unregisterSchedulerProcess(scheduler);
    unregisterMainApplicationWindow(MAIN_WINDOW_WC_ID);
  };
}

async function loadTelemetry() {
  return import("../src/main/desktopResourceTelemetry.js");
}

function armsEvents(name: string): Array<{
  name: string;
  group: string;
  value: number;
  properties: Record<string, string>;
}> {
  return sendCustomMock.mock.calls
    .map(
      ([event]) =>
        event as {
          name: string;
          group: string;
          value: number;
          properties: Record<string, string>;
        },
    )
    .filter((event) => event.name === name);
}

function systemWindowEvents() {
  return armsEvents(SYSTEM_WINDOW_EVENT);
}

async function startTelemetry(options?: {
  reportIntervalMs?: number;
  readSelfClockMs?: () => number;
}) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const module = await loadTelemetry();
  module.configureDesktopResourceTelemetry({
    deviceMid: "prt-002-device",
    platform: "darwin",
    appVersion: "3.6.1-test",
    armsEnv: "test",
  });
  module.registerDesktopResourceTelemetry(logger, {
    reportIntervalMs: options?.reportIntervalMs ?? REPORT_INTERVAL_MS,
    ...(options?.readSelfClockMs ? { readSelfClockMs: options.readSelfClockMs } : {}),
  });
  return { ...module, logger };
}

describe("desktopResourceTelemetry perf_system_window", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // 测试样本按 macOS 整机 CPU 构造，必须同步固定平台，避免 Linux 再除一次核数。
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    logicalCpuCount = 8;
    totalMemoryBytes = 16 * 1024 ** 3;
    systemBusyRatio = 0.5;
    readFreeMemoryBytes = () => 8 * 1024 ** 3;
    getAppMetricsMock.mockReset().mockReturnValue([]);
    getAllWebContentsMock.mockReset().mockReturnValue([]);
    getAllWindowsMock.mockReset().mockReturnValue([]);
    sendCustomMock.mockReset();
  });

  it("PRT-001（系统部分）30 个 tick 后 flush 发出 1 条 perf_system_window，属性数为 17", async () => {
    vi.useFakeTimers();
    const cleanupRoles = await registerAllChromiumRoles();
    // 七类进程：CPU 合计 18.75，RSS 合计 530000。
    getAppMetricsMock.mockReturnValue([
      metric(MAIN_PID, "Browser", 4, 100_000),
      metric(MAIN_WINDOW_PID, "Tab", 8, 200_000),
      metric(GUEST_PID, "Tab", 2, 50_000),
      metric(GPU_PID, "GPU", 1, 40_000),
      metric(HOST_PID, "Utility", 3, 90_000),
      metric(SCHEDULER_PID, "Utility", 0.5, 30_000),
      metric(OTHER_PID, "Utility", 0.25, 20_000),
    ]);
    const { stopDesktopResourceTelemetry } = await startTelemetry();

    try {
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const events = systemWindowEvents();
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.group).toBe("resource");
      expect(Object.keys(event?.properties ?? {})).toHaveLength(17);
      expect(Object.keys(event?.properties ?? {}).length).toBeLessThanOrEqual(
        ARMS_CUSTOM_EVENT_PROPERTY_LIMIT,
      );
      // value 是应用 CPU 均值：Chromium 体系全部角色之和。
      expect(event?.value).toBe(18.75);
      expect(event?.properties).toMatchObject({
        platform: "macos",
        app_version: "3.6.1-test",
        arms_env: "test",
        device_mid: "prt-002-device",
        arch: process.arch,
        logical_cpu_count: "8",
        total_memory_gb: "16",
        app_cpu_percent_p95: "18.75",
        app_rss_kb_total_mean: "530000",
        app_rss_kb_total_peak: "530000",
        process_count_total_peak: "7",
        system_cpu_percent_p95: "50",
        system_free_memory_kb_min: String(8 * 1024 ** 2),
        // 第一个 tick 没有 CPU 基线，因此 30 个 tick 只产生 29 个设备样本。
        sample_count: "29",
      });
      expect(Number(event?.properties.telemetry_self_ms)).toBeGreaterThanOrEqual(0);
      expect(Number(event?.properties.app_uptime_minutes)).toBeGreaterThanOrEqual(0);

      const { checkProcessResourceEventProperties } = await import("@zcode/shared");
      expect(
        checkProcessResourceEventProperties(SYSTEM_WINDOW_EVENT, event?.properties ?? {}),
      ).toMatchObject({ ok: true, count: 17 });
    } finally {
      stopDesktopResourceTelemetry();
      cleanupRoles();
      vi.useRealTimers();
    }
  });

  it("整机 CPU 由两次 os.cpus 差分得到，第一个 tick 没有基线时不产生样本", async () => {
    vi.useFakeTimers();
    systemBusyRatio = 0.25;
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const { stopDesktopResourceTelemetry } = await startTelemetry({
      reportIntervalMs: SAMPLE_INTERVAL_MS * 2,
    });

    try {
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
      expect(systemWindowEvents()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
      expect(systemWindowEvents()[0]?.properties).toMatchObject({
        system_cpu_percent_p95: "25",
        sample_count: "1",
      });
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("system_free_memory_kb_min 取窗口内最小值，app_rss_kb_total_peak 取窗口内最大值", async () => {
    vi.useFakeTimers();
    let freeMemoryReads = 0;
    readFreeMemoryBytes = () => {
      freeMemoryReads += 1;
      // 第 2 次读数是窗口内的最低点。
      return freeMemoryReads === 2 ? 1 * 1024 ** 3 : 8 * 1024 ** 3;
    };
    let appMetricReads = 0;
    getAppMetricsMock.mockImplementation(() => {
      appMetricReads += 1;
      return [metric(MAIN_PID, "Browser", 1, appMetricReads === 3 ? 400_000 : 100_000)];
    });
    const { stopDesktopResourceTelemetry } = await startTelemetry({
      reportIntervalMs: SAMPLE_INTERVAL_MS * 4,
    });

    try {
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 4);

      // 3 个设备样本（首个 tick 无基线）：RSS 100000 / 400000 / 100000。
      expect(systemWindowEvents()[0]?.properties).toMatchObject({
        sample_count: "3",
        system_free_memory_kb_min: String(1 * 1024 ** 2),
        app_rss_kb_total_peak: "400000",
        app_rss_kb_total_mean: "200000",
      });
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("外部样本入口：注入 CLI 最近样本后应用总量包含它，样本过期后不再计入", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 4, 100_000)]);
    const { stopDesktopResourceTelemetry } = await startTelemetry({
      reportIntervalMs: SAMPLE_INTERVAL_MS * 6,
    });
    const { recordExternalAppResourceSample } =
      await import("../src/main/processResourceExternalAppSamples.js");

    try {
      recordExternalAppResourceSample({
        sourceKey: "cli_chat",
        runtimeSurface: "local",
        cpuPercent: 20,
        rssKbTotal: 500_000,
        processCount: 2,
        intervalMs: 60_000,
        receivedAt: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 6);
      expect(systemWindowEvents()[0]?.properties).toMatchObject({
        app_rss_kb_total_mean: "600000",
        app_cpu_percent_p95: "24",
        process_count_total_peak: "3",
      });

      // 两个 60 秒周期内没有新样本，之后的窗口不再把它计入应用总量。
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 6 * 3);
      const lastEvent = systemWindowEvents().at(-1);
      expect(lastEvent?.properties).toMatchObject({
        app_rss_kb_total_mean: "100000",
        app_cpu_percent_p95: "4",
        process_count_total_peak: "1",
      });
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("MCP 最近 RSS 进入系统事件，远端 MCP 与下一窗口缺失样本不影响其他角色", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 4, 100_000)]);
    const { stopDesktopResourceTelemetry } = await startTelemetry({
      reportIntervalMs: SAMPLE_INTERVAL_MS * 6,
    });
    const { ingestMcpResourceSamples } =
      await import("../src/main/processResourceMcpTelemetrySource.js");
    const sample = {
      mcpId: "builtin:node_repl",
      instanceToken: "cli-instance-01",
      sampledAt: 300000,
      intervalMs: 300000,
      processCount: 2,
      rssKbTotal: 120000,
      rssKbMaxProcess: 80000,
      cpuTimeMsDelta: 30000,
      uptimeMinutes: 5,
      platform: "linux",
      arch: "x64",
      logicalCpuCount: 8,
      totalMemoryGb: 32,
    };
    try {
      ingestMcpResourceSamples([sample], "local");
      ingestMcpResourceSamples([{ ...sample, rssKbTotal: 999999 }], "remote");
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 6);
      expect(systemWindowEvents()[0]?.properties).toMatchObject({
        app_rss_kb_total_mean: "220000",
        process_count_total_peak: "3",
        app_cpu_percent_p95: "5.25",
      });
      const firstMcpCount = armsEvents("perf_process_window").filter(
        (event) => event.properties.process_role === "mcp",
      ).length;
      expect(firstMcpCount).toBe(2);
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 6);
      expect(
        armsEvents("perf_process_window").filter(
          (event) => event.properties.process_role === "mcp",
        ),
      ).toHaveLength(firstMcpCount);
      expect(systemWindowEvents()).toHaveLength(2);
      expect(
        armsEvents("perf_process_window").filter(
          (event) => event.properties.process_role === "main",
        ),
      ).toHaveLength(2);
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("CLI 角色的最近样本经外部样本入口进入应用总量", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 4, 100_000)]);
    const { stopDesktopResourceTelemetry } = await startTelemetry({
      reportIntervalMs: SAMPLE_INTERVAL_MS * 6,
    });
    const { ingestCliResourceSample } = await import("../src/main/processResourceCliSource.js");

    try {
      // 一个 chat lane 进程与一个远端进程：远端不算本机应用总量。
      ingestCliResourceSample(
        {
          platform: "darwin",
          arch: "arm64",
          logicalCpuCount: 8,
          intervalMs: 60_000,
          cpuCores: 1.6,
          cpuPercent: 20,
          rssKb: 500_000,
          instanceToken: "chat-instance-0001",
          lane: "chat",
        },
        "local",
      );
      ingestCliResourceSample(
        {
          platform: "linux",
          arch: "x64",
          logicalCpuCount: 4,
          intervalMs: 60_000,
          cpuCores: 1,
          cpuPercent: 25,
          rssKb: 900_000,
          instanceToken: "remote-instance-01",
          lane: "chat",
        },
        "remote",
      );

      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 6);
      // main 100000 KB + CLI 500000 KB；CPU 4 + 20；进程数 1 + 1。
      expect(systemWindowEvents()[0]?.properties).toMatchObject({
        app_rss_kb_total_mean: "600000",
        app_cpu_percent_p95: "24",
        process_count_total_peak: "2",
      });
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("PRT-017 telemetry_self_ms 不小于 0，且随 tick 次数单调不减", async () => {
    async function measureSelfMs(tickCount: number): Promise<number> {
      vi.resetModules();
      sendCustomMock.mockReset();
      vi.useFakeTimers();
      getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
      // 注入自证时钟：每次读数 +0.5ms，一个 tick 读两次（进入与离开），即每 tick 恰好 0.5ms。
      let selfClockMs = 0;
      const { stopDesktopResourceTelemetry } = await startTelemetry({
        reportIntervalMs: SAMPLE_INTERVAL_MS * tickCount,
        readSelfClockMs: () => {
          selfClockMs += 0.5;
          return selfClockMs;
        },
      });
      try {
        await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * tickCount);
        return Number(systemWindowEvents()[0]?.properties.telemetry_self_ms);
      } finally {
        stopDesktopResourceTelemetry();
        vi.useRealTimers();
      }
    }

    const sixTicks = await measureSelfMs(6);
    const twelveTicks = await measureSelfMs(12);
    expect(sixTicks).toBeGreaterThanOrEqual(0);
    expect(sixTicks).toBe(3);
    expect(twelveTicks).toBe(6);
    expect(twelveTicks).toBeGreaterThan(sixTicks);
  });

  it("窗口内没有设备样本时不发事件，累计的 telemetry_self_ms 顺延到下一个窗口", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    let selfClockMs = 0;
    // 窗口 = 1 个 tick：第一个窗口只有无基线的那个 tick，没有设备样本。
    const { stopDesktopResourceTelemetry } = await startTelemetry({
      reportIntervalMs: SAMPLE_INTERVAL_MS,
      readSelfClockMs: () => {
        selfClockMs += 0.5;
        return selfClockMs;
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
      expect(systemWindowEvents()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
      // 顺延的开销：窗口 1 的 tick 与 flush，加窗口 2 的 tick，共 3 段 × 0.5ms。
      expect(systemWindowEvents()[0]?.properties.telemetry_self_ms).toBe("1.5");
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("PRT-014 设备级采样在全平台都不启动外部进程", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.useFakeTimers();
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
      const { stopDesktopResourceTelemetry } = await startTelemetry();
      try {
        await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
        stopDesktopResourceTelemetry({ flushPendingWindows: true });

        expect(systemWindowEvents().length).toBeGreaterThan(0);
        // 历史事故：进程指标探针在 Windows 上每隔几秒起 PowerShell，拖慢整机。
        expect(execFileSyncMock).not.toHaveBeenCalled();
        expect(execFileMock).not.toHaveBeenCalled();
        expect(execMock).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
        expect(spawnSyncMock).not.toHaveBeenCalled();
      } finally {
        stopDesktopResourceTelemetry();
        platformSpy.mockRestore();
        vi.useRealTimers();
      }
    }
  });

  it("background_ratio 与角色事件同源", async () => {
    vi.useFakeTimers();
    let sceneTicks = 0;
    getAllWindowsMock.mockImplementation(() => {
      sceneTicks += 1;
      if (sceneTicks <= 9) {
        return [];
      }
      return [
        {
          isDestroyed: () => false,
          isFocused: () => true,
          isVisible: () => true,
          isMinimized: () => false,
        },
      ];
    });
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const { stopDesktopResourceTelemetry } = await startTelemetry();

    try {
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const roleEvent = armsEvents("perf_process_window")[0];
      expect(systemWindowEvents()[0]?.properties.background_ratio).toBe("0.3");
      expect(systemWindowEvents()[0]?.properties.background_ratio).toBe(
        roleEvent?.properties.background_ratio,
      );
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("PRT-016（系统部分）带 flush 的 stop 排空系统残窗", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 2, 1_000)]);
    const { stopDesktopResourceTelemetry } = await startTelemetry();

    try {
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 3);
      expect(systemWindowEvents()).toHaveLength(0);

      stopDesktopResourceTelemetry({ flushPendingWindows: true });
      expect(systemWindowEvents()[0]?.properties.sample_count).toBe("2");

      sendCustomMock.mockReset();
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
      expect(sendCustomMock).not.toHaveBeenCalled();
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("PRT-023（系统部分）系统事件进入共享的 E2E 捕获环", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const { enableSharedFinalArmsCustomEventE2EController } =
      await import("../src/main/desktopArmsCustomEvent.js");
    const controller = enableSharedFinalArmsCustomEventE2EController();
    const { stopDesktopResourceTelemetry } = await startTelemetry();

    try {
      controller.configure({ suppressedEventNames: [SYSTEM_WINDOW_EVENT] });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      expect(controller.read().map((entry) => entry.payload.name)).toContain(SYSTEM_WINDOW_EVENT);
      // 被抑制的事件仍进入捕获环，但不真正发往 ARMS。
      expect(systemWindowEvents()).toHaveLength(0);
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("整机 CPU 读数异常时只丢当前样本，不影响角色事件", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    // 拿不到任何 CPU 累计时间（容器里 os.cpus() 返回空数组）：差分无法给出百分比，设备样本全部丢弃。
    logicalCpuCount = 0;
    const { stopDesktopResourceTelemetry, logger } = await startTelemetry();

    try {
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      expect(systemWindowEvents()).toHaveLength(0);
      expect(armsEvents("perf_process_window").length).toBeGreaterThan(0);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });
});
