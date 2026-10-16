import {
  formatZCodeAgentProcessName,
  formatZCodeGpuProcessName,
  formatZCodeHostProcessName,
  formatZCodeRendererProcessName,
  formatZCodeUtilityProcessName,
  HostMessageTypes,
} from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAppMetrics = vi.fn();
const getAllWindows = vi.fn();
const getAllWebContents = vi.fn();
const fromWebContents = vi.fn();
const cpus = vi.fn();
const totalmem = vi.fn();
const freemem = vi.fn();

vi.mock("electron", () => ({
  app: { getAppMetrics },
  BrowserWindow: { getAllWindows, fromWebContents },
  webContents: { getAllWebContents },
}));

vi.mock("node:os", () => ({
  default: {
    cpus: () => cpus(),
    totalmem: () => totalmem(),
    freemem: () => freemem(),
  },
}));

vi.mock("../src/main/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createMetric(pid: number, type: string, cpu: number, memoryKb: number, name?: string) {
  return {
    pid,
    type,
    name,
    // fixture 的 cpu 表达整机口径；Linux Electron 原始值是单核口径，四核环境需乘四。
    cpu: { percentCPUUsage: process.platform === "linux" ? cpu * 4 : cpu },
    memory: { workingSetSize: memoryKb },
  };
}

function idleCpus(count: number, user = 100, idle = 900) {
  return Array.from({ length: count }, () => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } }));
}

async function loadModule() {
  const [window, sampling] = await Promise.all([
    import("../src/main/resourceManagerWindow.js"),
    import("../src/main/resourceManagerHostSampling.js"),
  ]);
  return { ...window, ...sampling };
}

describe("resourceManagerWindow", () => {
  beforeEach(() => {
    vi.resetModules();
    getAppMetrics.mockReset();
    getAllWindows.mockReset();
    getAllWebContents.mockReset();
    fromWebContents.mockReset();
    cpus.mockReset().mockReturnValue(idleCpus(4));
    totalmem.mockReset().mockReturnValue(16 * 1024 ** 3);
    freemem.mockReset().mockReturnValue(6 * 1024 ** 3);
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("Electron 自身进程全部归基础服务，browser-use guest renderer 归内置插件", async () => {
    const mainPid = process.pid;
    const gpuPid = mainPid + 1;
    const rendererPid = mainPid + 2;
    const hostPid = mainPid + 3;
    const utilityPid = mainPid + 4;
    const guestPid = mainPid + 5;

    getAppMetrics.mockReturnValue([
      createMetric(mainPid, "Browser", 1.2, 1024),
      createMetric(gpuPid, "GPU", 0.4, 2048),
      createMetric(rendererPid, "Tab", 18.8, 4096),
      createMetric(hostPid, "Utility", 0.2, 512, "zcode-host-local-1"),
      createMetric(utilityPid, "Utility", 0.1, 256, "network-service"),
      createMetric(guestPid, "Tab", 3, 8192),
    ]);
    getAllWindows.mockReturnValue([
      {
        id: 1,
        isDestroyed: () => false,
        getTitle: () => "ZCode",
        webContents: { getOSProcessId: () => rendererPid },
      },
    ]);
    const guestContents = {
      id: 77,
      isDestroyed: () => false,
      getOSProcessId: () => guestPid,
      getType: () => "webview",
      getTitle: () => "Example",
      getURL: () => "https://example.com/",
      hostWebContents: null,
    };
    getAllWebContents.mockReturnValue([guestContents]);
    fromWebContents.mockReturnValue(null);

    const module = await loadModule();
    module.registerHostProcess("local-1", { pid: hostPid } as never);
    module.setBrowserUseGuestWebContentsIdsProvider(() => [77]);

    try {
      const snapshot = await module.buildResourceUsageSnapshot({ includeHosts: false });
      const byPid = new Map(snapshot.processes.map((row) => [row.pid, row]));
      expect(byPid.get(mainPid)).toMatchObject({
        name: "zcode-main",
        category: "base",
        groupKey: "main",
        cpuPercent: 1.2,
        memoryBytes: 1024 * 1024,
        sampled: true,
      });
      expect(byPid.get(gpuPid)).toMatchObject({
        name: formatZCodeGpuProcessName(),
        groupKey: "gpu",
      });
      expect(byPid.get(rendererPid)).toMatchObject({
        name: formatZCodeRendererProcessName("ZCode"),
        groupKey: "renderer",
      });
      expect(byPid.get(hostPid)).toMatchObject({
        name: formatZCodeHostProcessName("local-1"),
        groupKey: "host",
      });
      expect(byPid.get(utilityPid)).toMatchObject({
        name: formatZCodeUtilityProcessName("network-service"),
        groupKey: "utility",
      });
      expect(byPid.get(guestPid)).toMatchObject({
        category: "builtin-plugin",
        groupLabel: "browser-use",
        memoryBytes: 8192 * 1024,
      });
      expect(snapshot.app.memoryBytes).toBe((1024 + 2048 + 4096 + 512 + 256 + 8192) * 1024);
      expect(snapshot.app.cpuPercent).toBeCloseTo(23.7, 5);
      expect(snapshot.logicalCpuCount).toBe(4);
      expect(snapshot.system.memoryTotalBytes).toBe(16 * 1024 ** 3);
      expect(snapshot.system.memoryUsedBytes).toBe(10 * 1024 ** 3);
    } finally {
      module.unregisterHostProcess("local-1");
      module.setBrowserUseGuestWebContentsIdsProvider(() => []);
    }
  });

  it("合并 Host 回报的外部进程；注册表里未回报的 Agent 以 sampled=false 兜底", async () => {
    const mainPid = process.pid;
    const hostPid = mainPid + 3;
    const agentPid = mainPid + 10;
    const mcpPid = mainPid + 11;
    const unsampledAgentPid = mainPid + 12;
    getAppMetrics.mockReturnValue([createMetric(mainPid, "Browser", 1, 100)]);
    getAllWindows.mockReturnValue([]);
    getAllWebContents.mockReturnValue([]);

    const module = await loadModule();
    const child = {
      pid: hostPid,
      postMessage: vi.fn((message: { type: string; requestId: string }) => {
        expect(message.type).toBe(HostMessageTypes.ResourceUsageSnapshotRequest);
        queueMicrotask(() =>
          module.resolveHostResourceUsageResult("local-1", {
            type: "resource-usage-snapshot-result",
            requestId: message.requestId,
            sampledAt: 1,
            processes: [
              {
                pid: agentPid,
                name: "zcode-agent-glm-demo",
                category: "base",
                groupKey: "cli",
                groupLabel: "cli",
                cpuPercent: 2.5,
                memoryBytes: 1000,
              },
              {
                pid: mcpPid,
                name: "plugin:acme:tools",
                category: "community-plugin",
                groupKey: "plugin:acme",
                groupLabel: "acme",
                cpuPercent: 0.5,
                memoryBytes: 200,
              },
            ],
          }),
        );
      }),
    };
    module.registerHostProcess("local-1", child as never);
    module.registerHostAgentProcess("local-1", {
      pid: agentPid,
      provider: "glm",
      workspacePath: "/w/demo",
      command: "node",
      args: [],
      startedAt: 1,
    });
    module.registerHostAgentProcess("local-1", {
      pid: unsampledAgentPid,
      provider: "glm",
      workspacePath: "/w/other",
      command: "node",
      args: [],
      startedAt: 2,
    });

    try {
      const snapshot = await module.buildResourceUsageSnapshot();
      const byPid = new Map(snapshot.processes.map((row) => [row.pid, row]));
      expect(byPid.get(agentPid)).toMatchObject({
        groupKey: "cli",
        cpuPercent: 2.5,
        memoryBytes: 1000,
        sampled: true,
      });
      expect(byPid.get(mcpPid)).toMatchObject({ category: "community-plugin", sampled: true });
      expect(byPid.get(unsampledAgentPid)).toEqual({
        pid: unsampledAgentPid,
        name: formatZCodeAgentProcessName("glm", "/w/other"),
        category: "base",
        groupKey: "cli",
        groupLabel: "cli",
        cpuPercent: 0,
        memoryBytes: 0,
        sampled: false,
      });
      expect(snapshot.app.cpuPercent).toBe(4);
    } finally {
      module.unregisterHostProcess("local-1");
    }
  });

  it("Host 超时时用它上一轮结果兜底，不让列表闪空", async () => {
    vi.useFakeTimers();
    const mainPid = process.pid;
    getAppMetrics.mockReturnValue([createMetric(mainPid, "Browser", 1, 100)]);
    getAllWindows.mockReturnValue([]);
    getAllWebContents.mockReturnValue([]);
    const module = await loadModule();
    let respond = true;
    const child = {
      pid: mainPid + 3,
      postMessage: vi.fn((message: { requestId: string }) => {
        if (!respond) return;
        module.resolveHostResourceUsageResult("local-1", {
          type: "resource-usage-snapshot-result",
          requestId: message.requestId,
          sampledAt: 1,
          processes: [
            {
              pid: 4242,
              name: "zsh",
              category: "base",
              groupKey: "host",
              groupLabel: "host",
              cpuPercent: 0,
              memoryBytes: 10,
            },
          ],
        });
      }),
    };
    module.registerHostProcess("local-1", child as never);
    try {
      const first = await module.buildResourceUsageSnapshot();
      expect(first.processes.some((row) => row.pid === 4242)).toBe(true);

      respond = false;
      const pending = module.buildResourceUsageSnapshot();
      await vi.advanceTimersByTimeAsync(1_000);
      const second = await pending;
      expect(second.processes.some((row) => row.pid === 4242)).toBe(true);
    } finally {
      module.unregisterHostProcess("local-1");
    }
  });

  it("linux 上 Electron 单核口径的 CPU 会除以逻辑核数；其它平台原样", async () => {
    // 归一化函数已提升为资源管理器 UI 与 ARMS 资源遥测共用，断言跟随实现搬到共用模块。
    const { normalizeElectronCpuToMachinePercent } = await import(
      "../src/main/electronCpuNormalization.js"
    );
    expect(
      normalizeElectronCpuToMachinePercent(40, { platform: "linux", logicalCpuCount: 8 }),
    ).toBe(5);
    expect(
      normalizeElectronCpuToMachinePercent(40, { platform: "darwin", logicalCpuCount: 8 }),
    ).toBe(40);
    expect(
      normalizeElectronCpuToMachinePercent(40, { platform: "win32", logicalCpuCount: 8 }),
    ).toBe(40);
    expect(
      normalizeElectronCpuToMachinePercent(undefined, { platform: "linux", logicalCpuCount: 8 }),
    ).toBe(0);
  });

  it("系统 CPU 按两次 os.cpus() 差分计算，首轮为 0", async () => {
    const { createSystemCpuMeter } = await loadModule();
    let tick = 0;
    const meter = createSystemCpuMeter(() =>
      tick === 0 ? idleCpus(2, 100, 900) : idleCpus(2, 400, 1200),
    );
    expect(meter.read()).toBe(0);
    tick = 1;
    // Δbusy=300×2, Δtotal=600×2 → 50%
    expect(meter.read()).toBe(50);
  });
});
