import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARMS_CUSTOM_EVENT_PROPERTY_LIMIT } from "@zcode/shared";

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

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const cpus = (): unknown[] => Array.from({ length: logicalCpuCount }, () => ({ times: {} }));
  const totalmem = (): number => totalMemoryBytes;
  return {
    ...actual,
    cpus,
    totalmem,
    default: { ...actual, cpus, totalmem },
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
  // Bug 根因：resourceManagerWindow 会在导入时加载真实 logger，导致 macOS 把测试中的
  // Windows E2E 日志路径当作相对目录创建；本用例只验证资源采样，隔离无关的日志 IO。
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
const REPORT_INTERVAL_MS = 300_000;

interface FakeMetric {
  pid: number;
  type: string;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
  creationTime?: number;
}

function metric(
  pid: number,
  type: string,
  cpu: number,
  workingSetKb: number,
  creationTime?: number,
): FakeMetric {
  return {
    pid,
    type,
    cpu: { percentCPUUsage: cpu },
    memory: { workingSetSize: workingSetKb },
    ...(creationTime === undefined ? {} : { creationTime }),
  };
}

/** services 打标后的 CLI 样本（lane 由 app 侧补上，CLI 协议里没有这个字段）。 */
function cliSample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: "darwin",
    arch: "arm64",
    logicalCpuCount: 10,
    intervalMs: 60_000,
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

async function loadTelemetry() {
  return import("../src/main/desktopResourceTelemetry.js");
}

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

function processWindowEvents(): Array<{
  name: string;
  value: number;
  properties: Record<string, string>;
}> {
  return sendCustomMock.mock.calls
    .map(([event]) => event as { name: string; value: number; properties: Record<string, string> })
    .filter((event) => event.name === "perf_process_window");
}

function eventForRole(role: string) {
  return processWindowEvents().find((event) => event.properties.process_role === role);
}

describe("desktopResourceTelemetry perf_process_window", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // 测试样本按 macOS 整机 CPU 构造，必须同步固定平台，避免 Linux 再除一次核数。
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    logicalCpuCount = 8;
    totalMemoryBytes = 16 * 1024 ** 3;
    getAppMetricsMock.mockReset().mockReturnValue([]);
    getAllWebContentsMock.mockReset().mockReturnValue([]);
    getAllWindowsMock.mockReset().mockReturnValue([]);
    sendCustomMock.mockReset();
  });

  it("PRT-001 七类 Chromium 进程在 30 个 tick 后各发出一条角色事件，属性数不超 20", async () => {
    vi.useFakeTimers();
    const cleanupRoles = await registerAllChromiumRoles();
    getAppMetricsMock.mockReturnValue([
      metric(MAIN_PID, "Browser", 4, 100_000),
      metric(MAIN_WINDOW_PID, "Tab", 8, 200_000),
      metric(GUEST_PID, "Tab", 2, 50_000),
      metric(GPU_PID, "GPU", 1, 40_000),
      metric(HOST_PID, "Utility", 3, 90_000),
      metric(SCHEDULER_PID, "Utility", 0.5, 30_000),
      metric(OTHER_PID, "Utility", 0.25, 20_000),
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-001-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const events = processWindowEvents();
      expect(events.map((event) => event.properties.process_role)).toEqual([
        "main",
        "renderer_main",
        "renderer_guest",
        "gpu",
        "chromium_other",
        "host",
        "scheduler",
      ]);
      for (const event of events) {
        expect(event.group).toBe("resource");
        expect(Object.keys(event.properties).length).toBeLessThanOrEqual(
          ARMS_CUSTOM_EVENT_PROPERTY_LIMIT,
        );
        expect(event.properties.sample_count).toBe("30");
        expect(event.properties.runtime_surface).toBe("local");
        expect(event.properties.logical_cpu_count).toBe("8");
        expect(event.properties.total_memory_gb).toBe("16");
      }
      expect(eventForRole("renderer_main")).toMatchObject({
        value: 8,
        properties: { cpu_percent_peak: "8", rss_kb_total_mean: "200000" },
      });
    } finally {
      stopDesktopResourceTelemetry();
      cleanupRoles();
      vi.useRealTimers();
    }
  });

  it("PRT-002 Linux 按逻辑核数归一化 CPU，darwin 与 win32 不归一化", async () => {
    async function measureRoleCpu(platform: NodeJS.Platform): Promise<number> {
      vi.resetModules();
      sendCustomMock.mockReset();
      vi.useFakeTimers();
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 80, 1_000)]);
      const logger = { info: vi.fn(), warn: vi.fn() };
      const {
        configureDesktopResourceTelemetry,
        registerDesktopResourceTelemetry,
        stopDesktopResourceTelemetry,
      } = await loadTelemetry();
      try {
        configureDesktopResourceTelemetry({
          deviceMid: "prt-002-device",
          platform,
          appVersion: "3.6.1-test",
          armsEnv: "test",
        });
        registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
        await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
        return eventForRole("main")?.value ?? Number.NaN;
      } finally {
        stopDesktopResourceTelemetry();
        platformSpy.mockRestore();
        vi.useRealTimers();
      }
    }

    expect(await measureRoleCpu("linux")).toBe(10);
    expect(await measureRoleCpu("darwin")).toBe(80);
    expect(await measureRoleCpu("win32")).toBe(80);
  });

  it("PRT-003 renderer_guest 给出总量、最大单进程与进程数", async () => {
    vi.useFakeTimers();
    const { registerMainApplicationWindow, unregisterMainApplicationWindow } =
      await import("../src/main/resourceManagerWindow.js");
    registerMainApplicationWindow(MAIN_WINDOW_WC_ID);
    getAllWebContentsMock.mockReturnValue([
      fakeWebContents(MAIN_WINDOW_WC_ID, MAIN_WINDOW_PID, "window"),
      fakeWebContents(21, 301, "webview"),
      fakeWebContents(22, 302, "webview"),
      fakeWebContents(23, 303, "webview"),
    ]);
    getAppMetricsMock.mockReturnValue([
      metric(MAIN_PID, "Browser", 1, 1_000),
      metric(301, "Tab", 1, 100),
      metric(302, "Tab", 1, 200),
      metric(303, "Tab", 1, 300),
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-003-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      expect(eventForRole("renderer_guest")?.properties).toMatchObject({
        rss_kb_total_peak: "600",
        rss_kb_max_process_peak: "300",
        process_count_peak: "3",
      });
    } finally {
      stopDesktopResourceTelemetry();
      unregisterMainApplicationWindow(MAIN_WINDOW_WC_ID);
      vi.useRealTimers();
    }
  });

  it("PRT-004 30 个 tick 中 9 个后台时 background_ratio 为 0.3", async () => {
    vi.useFakeTimers();
    let backgroundTicks = 0;
    // 前 9 个 tick 没有可见且聚焦的窗口，其余 tick 有。
    getAllWindowsMock.mockImplementation(() => {
      backgroundTicks += 1;
      if (backgroundTicks <= 9) {
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
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-004-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      expect(eventForRole("main")?.properties.background_ratio).toBe("0.3");
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("PRT-005 uptime_minutes 来自 creationTime，多进程角色取最大", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const now = Date.now();
    const { registerMainApplicationWindow, unregisterMainApplicationWindow } =
      await import("../src/main/resourceManagerWindow.js");
    registerMainApplicationWindow(MAIN_WINDOW_WC_ID);
    getAllWebContentsMock.mockReturnValue([
      fakeWebContents(MAIN_WINDOW_WC_ID, MAIN_WINDOW_PID, "window"),
      fakeWebContents(21, 301, "webview"),
      fakeWebContents(22, 302, "webview"),
    ]);
    getAppMetricsMock.mockReturnValue([
      metric(MAIN_PID, "Browser", 1, 1_000, now - 90 * 60_000),
      metric(301, "Tab", 1, 100, now - 10 * 60_000),
      metric(302, "Tab", 1, 100, now - 90 * 60_000),
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-005-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      // 采样点随时钟推进，窗口末尾的进程运行时长为 90 + 5 分钟。
      expect(Number(eventForRole("main")?.properties.uptime_minutes)).toBe(95);
      expect(Number(eventForRole("renderer_guest")?.properties.uptime_minutes)).toBe(95);
    } finally {
      stopDesktopResourceTelemetry();
      unregisterMainApplicationWindow(MAIN_WINDOW_WC_ID);
      vi.useRealTimers();
    }
  });

  it("PRT-006 main 事件带 heap 两项共 20 属性，gpu 事件无 heap 共 18 属性", async () => {
    vi.useFakeTimers();
    const memoryUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 300 * 1024 * 1024,
      heapTotal: 120 * 1024 * 1024,
      heapUsed: 90 * 1024 * 1024,
      external: 20 * 1024 * 1024,
      arrayBuffers: 2 * 1024 * 1024,
    } as NodeJS.MemoryUsage);
    getAppMetricsMock.mockReturnValue([
      metric(MAIN_PID, "Browser", 1, 1_000),
      metric(GPU_PID, "GPU", 1, 500),
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-006-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const mainEvent = eventForRole("main");
      expect(mainEvent?.properties).toMatchObject({
        heap_used_kb_mean: "92160",
        heap_used_kb_peak: "92160",
      });
      expect(Object.keys(mainEvent?.properties ?? {})).toHaveLength(20);

      const gpuEvent = eventForRole("gpu");
      expect(gpuEvent?.properties).not.toHaveProperty("heap_used_kb_mean");
      expect(gpuEvent?.properties).not.toHaveProperty("heap_used_kb_peak");
      expect(Object.keys(gpuEvent?.properties ?? {})).toHaveLength(18);
    } finally {
      stopDesktopResourceTelemetry();
      memoryUsageSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("PRT-006 host 与 scheduler 的自采 heap 进入各自角色事件，共 20 属性且不改 sample_count", async () => {
    vi.useFakeTimers();
    const cleanupRoles = await registerAllChromiumRoles();
    getAppMetricsMock.mockReturnValue([
      metric(HOST_PID, "Utility", 3, 90_000),
      metric(SCHEDULER_PID, "Utility", 0.5, 30_000),
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestHostSelfResourceSample, ingestSchedulerSelfResourceSample } =
      await import("../src/main/processResourceSelfHeapSource.js");

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-006-node-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      // 两个 utilityProcess 的 60 秒自采样本：main 只取 heap，CPU / RSS 仍来自 getAppMetrics。
      ingestHostSelfResourceSample({ cpuPercent: 2.5, rssKb: 89_000, heapUsedKb: 41_000 });
      ingestSchedulerSelfResourceSample({ cpuPercent: 0.4, rssKb: 29_000, heapUsedKb: 12_000 });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const hostEvent = eventForRole("host");
      expect(hostEvent?.properties).toMatchObject({
        heap_used_kb_mean: "41000",
        heap_used_kb_peak: "41000",
        rss_kb_total_mean: "90000",
        sample_count: "30",
      });
      expect(Object.keys(hostEvent?.properties ?? {})).toHaveLength(20);

      const schedulerEvent = eventForRole("scheduler");
      expect(schedulerEvent?.properties).toMatchObject({
        heap_used_kb_mean: "12000",
        heap_used_kb_peak: "12000",
        sample_count: "30",
      });
      expect(Object.keys(schedulerEvent?.properties ?? {})).toHaveLength(20);
    } finally {
      stopDesktopResourceTelemetry();
      cleanupRoles();
      vi.useRealTimers();
    }
  });

  it("PRT-021 主窗口 renderer 的 heap 进入 renderer_main 事件共 20 属性；非主窗口样本不参与统计", async () => {
    vi.useFakeTimers();
    const cleanupRoles = await registerAllChromiumRoles();
    getAppMetricsMock.mockReturnValue([
      metric(MAIN_WINDOW_PID, "Tab", 8, 200_000),
      metric(GUEST_PID, "Tab", 2, 50_000),
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestRendererHeapSample } =
      await import("../src/main/processResourceRendererHeapSource.js");

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-021-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      // 主窗口 renderer 的 60 秒读数经 preload 桥送到；辅助窗口与 guest 的样本必须被丢弃。
      ingestRendererHeapSample(MAIN_WINDOW_WC_ID, { heapUsedKb: 51_200 });
      ingestRendererHeapSample(GUEST_WC_ID, { heapUsedKb: 999_999 });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const rendererEvent = eventForRole("renderer_main");
      expect(rendererEvent?.properties).toMatchObject({
        heap_used_kb_mean: "51200",
        heap_used_kb_peak: "51200",
        rss_kb_total_mean: "200000",
        sample_count: "30",
      });
      expect(Object.keys(rendererEvent?.properties ?? {})).toHaveLength(20);

      // renderer_guest 按角色定义表不带 heap，非主窗口的样本也没有把它抬起来。
      const guestEvent = eventForRole("renderer_guest");
      expect(guestEvent?.properties).not.toHaveProperty("heap_used_kb_mean");
      expect(guestEvent?.properties).not.toHaveProperty("heap_used_kb_peak");
      expect(Object.keys(guestEvent?.properties ?? {})).toHaveLength(18);
    } finally {
      stopDesktopResourceTelemetry();
      cleanupRoles();
      vi.useRealTimers();
    }
  });

  it("PRT-014 全平台 tick、flush 与退出 flush 都不启动外部进程", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.useFakeTimers();
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
      const logger = { info: vi.fn(), warn: vi.fn() };
      const {
        configureDesktopResourceTelemetry,
        registerDesktopResourceTelemetry,
        stopDesktopResourceTelemetry,
      } = await loadTelemetry();
      try {
        configureDesktopResourceTelemetry({
          deviceMid: "prt-014-device",
          platform,
          appVersion: "3.6.1-test",
          armsEnv: "test",
        });
        registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
        await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
        stopDesktopResourceTelemetry({ flushPendingWindows: true });

        // Bug 根因：main 每 10 秒起 ps 取线程数，Windows 上曾用 PowerShell 拖慢整机。
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

  it("PRT-016 带 flush 的 stop 排空残窗且之后不再采样", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 2, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      RESOURCE_SAMPLE_INTERVAL_MS,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-016-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_INTERVAL_MS * 12);
      expect(processWindowEvents()).toHaveLength(0);

      const appMetricReadsBeforeStop = getAppMetricsMock.mock.calls.length;
      stopDesktopResourceTelemetry({ flushPendingWindows: true });

      expect(eventForRole("main")?.properties.sample_count).toBe("12");
      // 退出 flush 不触发新采样。
      expect(getAppMetricsMock).toHaveBeenCalledTimes(appMetricReadsBeforeStop);

      sendCustomMock.mockReset();
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 2);
      expect(sendCustomMock).not.toHaveBeenCalled();
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("PRT-019 不再出现 perf_resource_window", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-019-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const names = sendCustomMock.mock.calls.map(([event]) => (event as { name: string }).name);
      expect(names).toContain("perf_process_window");
      expect(names).not.toContain("perf_resource_window");
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("角色事件进入共享的 E2E 捕获环，供 E2E 通道读取最终上报内容", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { enableSharedFinalArmsCustomEventE2EController } =
      await import("../src/main/desktopArmsCustomEvent.js");
    const controller = enableSharedFinalArmsCustomEventE2EController();
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "e2e-bridge-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      controller.configure({ suppressedEventNames: ["perf_process_window"] });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const captured = controller.read().map((entry) => entry.payload.name);
      expect(captured).toContain("perf_process_window");
      // 被抑制的事件仍进入捕获环，但不真正发往 ARMS。
      expect(
        sendCustomMock.mock.calls.map(([event]) => (event as { name: string }).name),
      ).not.toContain("perf_process_window");
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("事件属性不携带 pid、路径、workspace 等隐私维度", async () => {
    vi.useFakeTimers();
    const cleanupRoles = await registerAllChromiumRoles();
    getAppMetricsMock.mockReturnValue([
      metric(MAIN_PID, "Browser", 1, 1_000),
      metric(MAIN_WINDOW_PID, "Tab", 1, 1_000),
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "privacy-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const { checkProcessResourceEventProperties } = await import("@zcode/shared");
      for (const event of processWindowEvents()) {
        expect(
          checkProcessResourceEventProperties("perf_process_window", event.properties),
        ).toMatchObject({ ok: true });
      }
      // 曾用「JSON 不含 pid 子串」断言，但真实 heap 读数（如 520193）会偶然包含 "201"，
      // 造成与代码无关的抖动。pid 泄漏的形态是某个属性值就是 pid，按值精确比对即可。
      const propertyValues = processWindowEvents().flatMap((event) =>
        Object.values(event.properties),
      );
      expect(propertyValues).not.toContain(String(MAIN_WINDOW_PID));
      expect(propertyValues).not.toContain(String(MAIN_PID));
    } finally {
      stopDesktopResourceTelemetry();
      cleanupRoles();
      vi.useRealTimers();
    }
  });

  it("ARMS sendCustom 异常不会从角色 flush 链路抛出", async () => {
    vi.useFakeTimers();
    sendCustomMock.mockImplementation(() => {
      throw new Error("ARMS unavailable");
    });
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "arms-failure-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
      expect(sendCustomMock).toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });
});

describe("desktopResourceTelemetry CLI 角色与 Windows 门禁保留行为", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    logicalCpuCount = 8;
    totalMemoryBytes = 16 * 1024 ** 3;
    getAppMetricsMock.mockReset().mockReturnValue([]);
    getAllWebContentsMock.mockReset().mockReturnValue([]);
    getAllWindowsMock.mockReset().mockReturnValue([]);
    sendCustomMock.mockReset();
  });

  it("PERF-RES-01 登记 agent pid 后的周期采样只记录 skipped 审计，不启动外部进程", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ZCODE_ENV", "test");
    vi.stubEnv("ZCODE_E2E_RUNTIME_LOG_DIR", "C:\\e2e\\runtime-logs\\desktop");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { registerHostAgentProcess, unregisterHostAgentProcess } =
      await import("../src/main/resourceManagerWindow.js");
    const {
      registerDesktopResourceTelemetry,
      RESOURCE_SAMPLE_INTERVAL_MS,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();

    registerHostAgentProcess("local-1", {
      pid: 43210,
      provider: "glm",
      workspacePath: "C:\\repo\\demo",
      command: "zcode-agent.exe",
      args: ["--stdio"],
      startedAt: 100,
    });

    try {
      registerDesktopResourceTelemetry(logger);
      await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_INTERVAL_MS * 2);

      // Bug 根因：生命周期 reporter 接通后 agent pid 不再为空，旧采样会每
      // 10 秒在 Electron main process 同步启动 PowerShell，使整个 App 随其阻塞。
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "[resource] agent_metric_probe action=skipped reason=main_process_external_probe_disabled agent_count=1",
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("agent_metric_probe action=spawn"),
      );
      expect(
        logger.info.mock.calls.filter(
          ([message]) =>
            message ===
            "[resource] agent_metric_probe action=skipped reason=main_process_external_probe_disabled agent_count=1",
        ),
      ).toHaveLength(1);
    } finally {
      stopDesktopResourceTelemetry();
      unregisterHostAgentProcess("local-1", 43210);
      platformSpy.mockRestore();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("PRT-007 chat 与 plugin lane 的 CLI 样本聚合为 cli_chat 与 cli_aux 两条角色事件", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestCliResourceSample } = await import("../src/main/processResourceCliSource.js");

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-007-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      // 三个 CLI 进程各自每 60 秒自采一次：chat lane 每 workspace 一个进程，
      // plugin / mcp-status 合并为 cli_aux。
      for (let period = 0; period < REPORT_INTERVAL_MS / 60_000; period += 1) {
        ingestCliResourceSample(cliSample({ instanceToken: "chat-0001" }), "local");
        ingestCliResourceSample(
          cliSample({
            instanceToken: "chat-0002",
            cpuPercent: 7,
            rssKb: 300_000,
            heapUsedKb: 90_000,
            uptimeMinutes: 12,
          }),
          "local",
        );
        ingestCliResourceSample(
          cliSample({ lane: "plugin", instanceToken: "aux-0001", cpuPercent: 1, rssKb: 90_000 }),
          "local",
        );
        await vi.advanceTimersByTimeAsync(60_000);
      }

      const chatEvent = eventForRole("cli_chat");
      expect(chatEvent?.properties).toMatchObject({
        runtime_surface: "local",
        cpu_percent_peak: "12",
        rss_kb_total_mean: "500000",
        rss_kb_total_peak: "500000",
        rss_kb_max_process_peak: "300000",
        heap_used_kb_mean: "90000",
        heap_used_kb_peak: "90000",
        process_count_peak: "2",
        uptime_minutes: "12",
        total_memory_gb: "32",
        // CLI 是 60 秒口径：5 分钟窗口 5 个样本，而不是 main 侧角色的 30 个。
        sample_count: "5",
      });
      expect(chatEvent?.value).toBe(12);
      expect(Object.keys(chatEvent?.properties ?? {})).toHaveLength(20);

      const auxEvent = eventForRole("cli_aux");
      expect(auxEvent?.properties).toMatchObject({
        rss_kb_total_mean: "90000",
        rss_kb_max_process_peak: "90000",
        process_count_peak: "1",
        sample_count: "5",
      });
      expect(Object.keys(auxEvent?.properties ?? {})).toHaveLength(20);
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("PRT-008 远端 CLI 样本自带的运行机信息覆盖桌面机全局值", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestCliResourceSample } = await import("../src/main/processResourceCliSource.js");

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-008-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      ingestCliResourceSample(
        cliSample({
          platform: "linux",
          arch: "x64",
          logicalCpuCount: 4,
          totalMemoryGb: 8,
          instanceToken: "remote-0001",
        }),
        "remote",
      );
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      // 桌面机是 macOS / 8 核 / 16 GB；远端角色事件必须描述进程实际运行的那台机器。
      expect(eventForRole("cli_chat")?.properties).toMatchObject({
        platform: "linux",
        runtime_surface: "remote",
        arch: "x64",
        logical_cpu_count: "4",
        total_memory_gb: "8",
      });
      expect(eventForRole("main")?.properties).toMatchObject({
        platform: "macos",
        runtime_surface: "local",
        logical_cpu_count: "8",
        total_memory_gb: "16",
      });
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("旧 CLI 样本缺 total_memory_gb 时按字段回落到桌面机的值", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestCliResourceSample } = await import("../src/main/processResourceCliSource.js");

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "legacy-cli-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      ingestCliResourceSample(
        {
          platform: "darwin",
          arch: "arm64",
          logicalCpuCount: 10,
          intervalMs: 60_000,
          cpuCores: 0.5,
          cpuPercent: 5,
          rssKb: 200_000,
        },
        "local",
      );
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const chatEvent = eventForRole("cli_chat");
      expect(chatEvent?.properties).toMatchObject({
        arch: "arm64",
        logical_cpu_count: "10",
        // 样本没有自报运行机内存，取桌面机的 16 GB。
        total_memory_gb: "16",
      });
      // 旧样本没有 heap，事件按 mcp / gpu 同样的方式少两项属性。
      expect(chatEvent?.properties).not.toHaveProperty("heap_used_kb_mean");
      expect(Object.keys(chatEvent?.properties ?? {})).toHaveLength(18);
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("PRT-019 CLI 样本不再产生 perf_resource_agent", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestCliResourceSample } = await import("../src/main/processResourceCliSource.js");

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "prt-019-cli-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      ingestCliResourceSample(cliSample(), "local");
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const names = sendCustomMock.mock.calls.map(([event]) => (event as { name: string }).name);
      expect(names).toContain("perf_process_window");
      expect(names).not.toContain("perf_resource_agent");
      expect(eventForRole("cli_chat")).toBeDefined();
      expect(eventForRole("agent_node")).toBeUndefined();
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("cli 角色事件不含 instanceToken、pid、workspace 等隐私维度", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestCliResourceSample } = await import("../src/main/processResourceCliSource.js");

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "cli-privacy-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      ingestCliResourceSample(cliSample({ instanceToken: "chat-secret-token" }), "local");
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);

      const { checkProcessResourceEventProperties } = await import("@zcode/shared");
      const cliEvents = processWindowEvents().filter((event) =>
        event.properties.process_role?.startsWith("cli_"),
      );
      expect(cliEvents).toHaveLength(1);
      for (const event of cliEvents) {
        expect(
          checkProcessResourceEventProperties("perf_process_window", event.properties),
        ).toMatchObject({ ok: true });
      }
      // instanceToken 只在 main 内存里用于统计进程数，绝不能出现在上报内容里。
      expect(JSON.stringify(cliEvents)).not.toContain("chat-secret-token");
      expect(JSON.stringify(cliEvents)).not.toContain("lane");
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });

  it("正常退出时 CLI 角色的残窗随 main 一起排空", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      RESOURCE_SAMPLE_INTERVAL_MS,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestCliResourceSample } = await import("../src/main/processResourceCliSource.js");

    try {
      configureDesktopResourceTelemetry({
        deviceMid: "cli-partial-window-device",
        platform: "darwin",
        appVersion: "3.6.1-test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });
      ingestCliResourceSample(cliSample(), "local");
      await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_INTERVAL_MS);
      // 第二条读数还没赶上下一个 60 秒交付点，退出排空必须把它一起交出来，
      // 否则开发态 / E2E 的 1 分钟窗口里退出会让 cli 角色一条事件都没有。
      ingestCliResourceSample(cliSample({ rssKb: 300_000 }), "local");
      await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_INTERVAL_MS);
      expect(processWindowEvents()).toHaveLength(0);

      const appMetricReadsBeforeStop = getAppMetricsMock.mock.calls.length;
      stopDesktopResourceTelemetry({ flushPendingWindows: true });

      expect(eventForRole("cli_chat")?.properties).toMatchObject({
        sample_count: "2",
        rss_kb_total_peak: "300000",
      });
      // 退出排空只搬已有事实，不触发新采样。
      expect(getAppMetricsMock).toHaveBeenCalledTimes(appMetricReadsBeforeStop);
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });
});

describe("desktopResourceTelemetry memory diagnostics log", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    logicalCpuCount = 8;
    totalMemoryBytes = 16 * 1024 ** 3;
    getAppMetricsMock.mockReset().mockReturnValue([]);
    getAllWebContentsMock.mockReset().mockReturnValue([]);
    getAllWindowsMock.mockReset().mockReturnValue([]);
    sendCustomMock.mockReset();
  });

  it("MEM-009 每 6 个 10s tick 写一行 role=main 样本（含按新角色的 working set）", async () => {
    vi.useFakeTimers();
    const memoryUsageSpy = vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 300 * 1024 * 1024,
      heapTotal: 120 * 1024 * 1024,
      heapUsed: 90 * 1024 * 1024,
      external: 20 * 1024 * 1024,
      arrayBuffers: 2 * 1024 * 1024,
    } as NodeJS.MemoryUsage);
    getAppMetricsMock.mockReturnValue([
      metric(MAIN_PID, "Browser", 1, 4_096),
      metric(OTHER_PID, "Utility", 1, 8_192),
    ]);
    try {
      const {
        MEMORY_LOG_SAMPLE_EVERY_N_TICKS,
        RESOURCE_SAMPLE_INTERVAL_MS,
        registerDesktopResourceTelemetry,
        stopDesktopResourceTelemetry,
      } = await loadTelemetry();
      const logger = { info: vi.fn(), warn: vi.fn() };
      registerDesktopResourceTelemetry(logger, { reportIntervalMs: REPORT_INTERVAL_MS });

      await vi.advanceTimersByTimeAsync(
        RESOURCE_SAMPLE_INTERVAL_MS * (MEMORY_LOG_SAMPLE_EVERY_N_TICKS - 1),
      );
      expect(
        logger.info.mock.calls.filter((call) => String(call[0]).startsWith("[memory]")),
      ).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(RESOURCE_SAMPLE_INTERVAL_MS);
      const lines = logger.info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[memory]"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        "[memory] role=main reason=first rssKb=307200 heapUsedKb=92160 heapTotalKb=122880 externalKb=20480 arrayBuffersKb=2048 ws.chromium_other=8192 ws.main=4096",
      );
      stopDesktopResourceTelemetry();
    } finally {
      memoryUsageSpy.mockRestore();
      vi.useRealTimers();
    }
  });
  it("PRT-009: 两个 MCP ID 各发一条 19 属性事件，CPU 按运行机核数归一化", async () => {
    vi.useFakeTimers();
    getAppMetricsMock.mockReturnValue([metric(MAIN_PID, "Browser", 1, 1_000)]);
    const {
      configureDesktopResourceTelemetry,
      registerDesktopResourceTelemetry,
      stopDesktopResourceTelemetry,
    } = await loadTelemetry();
    const { ingestMcpResourceSamples } =
      await import("../src/main/processResourceMcpTelemetrySource.js");
    const sample = {
      instanceToken: "cli-instance-01",
      sampledAt: 300000,
      intervalMs: 300000,
      processCount: 2,
      rssKbTotal: 120000,
      rssKbMaxProcess: 80000,
      cpuTimeMsDelta: 180000,
      uptimeMinutes: 5,
      platform: "linux",
      arch: "x64",
      logicalCpuCount: 4,
      totalMemoryGb: 64,
    };
    try {
      configureDesktopResourceTelemetry({
        deviceMid: "mcp-device",
        platform: "darwin",
        appVersion: "test",
        armsEnv: "test",
      });
      registerDesktopResourceTelemetry(
        { info: vi.fn(), warn: vi.fn() },
        { reportIntervalMs: REPORT_INTERVAL_MS },
      );
      const samples = ["builtin:node_repl", "custom:123456789abc"].map((mcpId) => ({
        ...sample,
        mcpId,
      }));
      ingestMcpResourceSamples(samples, "remote");
      ingestMcpResourceSamples(samples, "remote");
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
      const events = sendCustomMock.mock.calls
        .map(([event]) => event)
        .filter((event) => event.properties?.process_role === "mcp");
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.properties.mcp_id)).toEqual([
        "builtin:node_repl",
        "custom:123456789abc",
      ]);
      for (const event of events) {
        expect(Object.keys(event.properties)).toHaveLength(19);
        expect(event.properties).toMatchObject({
          platform: "linux",
          arch: "x64",
          logical_cpu_count: "4",
          total_memory_gb: "64",
          runtime_surface: "remote",
          cpu_percent_peak: "15",
          sample_count: "1",
          rss_kb_total_mean: "120000",
          rss_kb_max_process_peak: "80000",
          process_count_peak: "2",
          uptime_minutes: "5",
        });
        expect(event.properties).not.toHaveProperty("heap_used_kb_mean");
        expect(event.properties).not.toHaveProperty("instanceToken");
        expect(event.value).toBe(15);
      }
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
      expect(
        sendCustomMock.mock.calls
          .map(([event]) => event)
          .filter((event) => event.properties?.process_role === "mcp"),
      ).toHaveLength(2);
    } finally {
      stopDesktopResourceTelemetry();
      vi.useRealTimers();
    }
  });
});

it.each(["linux", "win32"] as const)(
  "PRT-010: Host 完成通知立即上报 12/10 个白名单属性（%s）",
  async (platform) => {
    const { Emitter } = await import("@zcode/rpc");
    const { hostResponseMessageSchema, PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS } =
      await import("@zcode/shared");
    const { registerHostToolExecResourceTelemetry } =
      await import("../src/host/hostToolExecResourceTelemetry.js");
    const { configureDesktopResourceTelemetry, ingestToolExecResource } = await loadTelemetry();
    configureDesktopResourceTelemetry({
      deviceMid: "device",
      appVersion: "1.0",
      armsEnv: "prod",
      platform: "darwin",
    });
    sendCustomMock.mockClear();
    const emitter = new Emitter<import("@zcode/shared").ZCodeToolExecResource>();
    const registration = registerHostToolExecResourceTelemetry({
      agentService: { onDynamicToolExecResource: () => emitter.event },
      runtimeSurface: "remote",
      postMessage: (raw) => {
        const message = hostResponseMessageSchema.parse(raw);
        if (message.type === "tool-exec-resource")
          ingestToolExecResource(message.sample, message.runtimeSurface);
      },
    });
    const sample = {
      platform,
      toolName: "bash" as const,
      durationMs: 40000,
      exitKind: "completed" as const,
      sampleCount: platform === "win32" ? 0 : 2,
      cliRssKb: 1024,
      systemFreeMemoryKb: 2048,
      ...(platform === "win32" ? {} : { treeRssKbPeak: 300, treeCpuTimeMs: 6000 }),
    };
    emitter.fire(sample);
    registration.dispose();
    emitter.fire(sample);
    expect(sendCustomMock).toHaveBeenCalledExactlyOnceWith({
      name: "perf_tool_exec_resource",
      type: "custom",
      group: "resource",
      value: 40000,
      properties: {
        platform: platform === "win32" ? "windows" : "linux",
        app_version: "1.0",
        arms_env: "prod",
        device_mid: "device",
        runtime_surface: "remote",
        tool_name: "bash",
        exit_kind: "completed",
        sample_count: platform === "win32" ? "0" : "2",
        cli_rss_kb: "1024",
        system_free_memory_kb: "2048",
        ...(platform === "win32" ? {} : { tree_rss_kb_peak: "300", tree_cpu_time_ms: "6000" }),
      },
    });
    const keys = Object.keys(sendCustomMock.mock.calls[0][0].properties);
    expect(keys.sort()).toEqual(
      PERF_TOOL_EXEC_RESOURCE_PROPERTY_KEYS.filter(
        (key) => platform !== "win32" || !key.startsWith("tree_"),
      )
        .slice()
        .sort(),
    );
  },
);

it("PRT-032 多个 Host 转发同一完成事实只上报一次，同指标不同命令仍独立", async () => {
  const { Emitter } = await import("@zcode/rpc");
  const { registerHostToolExecResourceTelemetry } =
    await import("../src/host/hostToolExecResourceTelemetry.js");
  const { hostResponseMessageSchema } = await import("@zcode/shared");
  const { configureDesktopResourceTelemetry, ingestToolExecResource } = await loadTelemetry();
  configureDesktopResourceTelemetry({
    deviceMid: "test",
    appVersion: "test",
    armsEnv: "test",
    platform: "darwin",
  });
  sendCustomMock.mockClear();
  const emitter = new Emitter<import("@zcode/shared").ZCodeToolExecResource>();
  const registrations = Array.from({ length: 2 }, () =>
    registerHostToolExecResourceTelemetry({
      agentService: { onDynamicToolExecResource: () => emitter.event },
      runtimeSurface: "remote",
      postMessage(raw) {
        const message = hostResponseMessageSchema.parse(raw);
        if (message.type === "tool-exec-resource")
          ingestToolExecResource(message.sample, message.runtimeSurface);
      },
    }),
  );
  const sample = {
    platform: "linux" as const,
    toolName: "bash" as const,
    durationMs: 40_000,
    exitKind: "completed" as const,
    sampleCount: 0,
    cliRssKb: 1000,
    systemFreeMemoryKb: 2000,
    completionToken: "00000000-0000-4000-8000-000000000001",
  };
  try {
    emitter.fire(sample);
    expect(sendCustomMock).toHaveBeenCalledTimes(1);
    registrations[0].dispose();
    emitter.fire({ ...sample, completionToken: "00000000-0000-4000-8000-000000000002" });
    expect(sendCustomMock).toHaveBeenCalledTimes(2);
    expect(
      sendCustomMock.mock.calls.every(
        ([event]) =>
          !JSON.stringify(event).includes("completionToken") &&
          !JSON.stringify(event).includes(sample.completionToken),
      ),
    ).toBe(true);
    registrations[1].dispose();
    emitter.fire({ ...sample, completionToken: "00000000-0000-4000-8000-000000000003" });
    expect(sendCustomMock).toHaveBeenCalledTimes(2);
  } finally {
    registrations.forEach((registration) => registration.dispose());
    emitter.dispose();
  }
});

it("PRT-032 完成标识有界保存且重新配置清空，旧 CLI 无标识仍可上报", async () => {
  const { configureDesktopResourceTelemetry, ingestToolExecResource } = await loadTelemetry();
  const context = {
    deviceMid: "test",
    appVersion: "test",
    armsEnv: "test" as const,
    platform: "darwin" as const,
  };
  configureDesktopResourceTelemetry(context);
  sendCustomMock.mockClear();
  const sample = {
    platform: "linux",
    toolName: "bash",
    durationMs: 40_000,
    exitKind: "completed",
    sampleCount: 0,
    cliRssKb: 1000,
    systemFreeMemoryKb: 2000,
  };
  const token = (index: number) =>
    `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
  for (let index = 0; index < 1025; index++)
    ingestToolExecResource({ ...sample, completionToken: token(index) }, "remote");
  expect(sendCustomMock).toHaveBeenCalledTimes(1025);
  ingestToolExecResource({ ...sample, completionToken: token(1024) }, "remote");
  expect(sendCustomMock).toHaveBeenCalledTimes(1025);
  ingestToolExecResource({ ...sample, completionToken: token(0) }, "remote");
  expect(sendCustomMock).toHaveBeenCalledTimes(1026);
  configureDesktopResourceTelemetry(context);
  ingestToolExecResource({ ...sample, completionToken: token(0) }, "remote");
  ingestToolExecResource(sample, "remote");
  ingestToolExecResource(sample, "remote");
  expect(sendCustomMock).toHaveBeenCalledTimes(1029);
});
