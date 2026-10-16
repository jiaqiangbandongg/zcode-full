import { app, BrowserWindow, webContents as electronWebContents } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import os from "node:os";
import { join } from "node:path";
import {
  formatZCodeAgentProcessName,
  formatZCodeGpuProcessName,
  formatZCodeHostProcessName,
  formatZCodeMainProcessName,
  formatZCodeRendererProcessName,
  formatZCodeUtilityProcessName,
  type HostResourceUsageProcess,
  type ResourceUsageProcess,
  type ResourceUsageSnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { configureNetworkCaptureHost, observeNetworkWindow } from "./resourceManagerNetwork.js";
import { normalizeElectronCpuToMachinePercent } from "./electronCpuNormalization.js";
import type { ChromiumProcessRolePids } from "./processResourceRoleClassifier.js";
import { buildAuxiliaryRendererName } from "./resourceManagerProcessNames.js";
import {
  forgetHostResourceUsage,
  requestHostResourceUsage,
} from "./resourceManagerHostSampling.js";

/**
 * 资源管理器。
 *
 * main 只做三件事：Electron 自身进程指标（app.getAppMetrics）、系统总量（os）、
 * 合并 Host 回报的外部进程行。外部进程采样一律在 Host 内完成——
 * 历史 bug：main 里同步/异步起 ps、PowerShell 都会卡住整个 App。
 */

const preloadPath = join(import.meta.dirname, "../preload/resourceManager.cjs");
const RESOURCE_MANAGER_WINDOW_TITLE = "Resource Manager";
const BROWSER_USE_PLUGIN_NAME = "browser-use";

/** 系统整机 CPU：两次 os.cpus() 之间 busy / total 的差分 */
export interface SystemCpuMeter {
  read(): number;
}

export function createSystemCpuMeter(
  readCpus: () => Array<{ times: Record<string, number> }> = () => os.cpus(),
): SystemCpuMeter {
  let previous: { busy: number; total: number } | null = null;
  return {
    read() {
      let busy = 0;
      let total = 0;
      for (const cpu of readCpus()) {
        for (const [key, value] of Object.entries(cpu.times)) {
          total += value;
          if (key !== "idle") busy += value;
        }
      }
      const current = { busy, total };
      const baseline = previous;
      previous = current;
      if (!baseline || current.total <= baseline.total) return 0;
      const percent = ((current.busy - baseline.busy) / (current.total - baseline.total)) * 100;
      return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
    },
  };
}

// 单例：同一时刻只允许一个资源管理器窗口
let instance: BrowserWindow | null = null;
let samplingController: AbortController | undefined;

function stopResourceUsageSampling(): void {
  samplingController?.abort();
  samplingController = undefined;
  for (const label of hostProcesses.keys()) forgetHostResourceUsage(label);
}

/** 只有资源管理器本身能启停观测；Main 持有唯一生命周期。 */
export function setResourceUsageSamplingActive(senderId: number, active: boolean): void {
  if (!instance || instance.isDestroyed() || instance.webContents.id !== senderId) return;
  if (active) samplingController ??= new AbortController();
  else stopResourceUsageSampling();
}

export async function getResourceUsageSnapshot(senderId: number): Promise<ResourceUsageSnapshot> {
  if (
    !instance ||
    instance.isDestroyed() ||
    instance.webContents.id !== senderId ||
    !samplingController
  ) {
    throw new Error("Resource sampling is inactive");
  }
  const signal = samplingController.signal;
  const result = await buildResourceUsageSnapshot({ signal });
  signal.throwIfAborted();
  return result;
}

export function getResourceManagerWindowId(): number | null {
  if (!instance || instance.isDestroyed()) {
    return null;
  }
  return instance.id;
}

/**
 * 记录活跃的 host process（utility process）。
 * 每个 BrowserWindow 只注册一个 window-scoped Host；远程连接不再产生独立 Host PID。
 * key = 窗口 label（如 "local-2"），value = UtilityProcess
 */
const hostProcesses = new Map<string, ElectronUtilityProcess>();

interface RegisteredAgentProcess {
  pid: number;
  provider: ZCodeProvider;
  workspacePath: string;
  command: string;
  args: string[];
  startedAt: number;
}

const hostAgentProcesses = new Map<string, Map<number, RegisteredAgentProcess>>();

export function listRegisteredHostAgentProcessIds(): number[] {
  return [...hostAgentProcesses.values()].flatMap((processes) => [...processes.keys()]);
}

/**
 * 主应用窗口（createWindow 创建的承载 workspace 的窗口）的 webContents id。
 * 唯一数据源：资源遥测据此把主窗口 renderer 归 `renderer_main`，
 * 资源管理器 / about / update-status 等辅助窗口归 `chromium_other`。
 */
const mainApplicationWindowWebContentsIds = new Set<number>();

export function registerMainApplicationWindow(webContentsId: number): void {
  if (webContentsId > 0) {
    mainApplicationWindowWebContentsIds.add(webContentsId);
  }
}

export function unregisterMainApplicationWindow(webContentsId: number): void {
  mainApplicationWindowWebContentsIds.delete(webContentsId);
}

/** renderer heap 样本按发送方 webContents 判断是否属于 `renderer_main`。 */
export function isMainApplicationWindowWebContents(webContentsId: number): boolean {
  return mainApplicationWindowWebContentsIds.has(webContentsId);
}

/** cron scheduler 的 utilityProcess，由 spawn 点登记。 */
const schedulerProcesses = new Set<ElectronUtilityProcess>();

export function registerSchedulerProcess(child: ElectronUtilityProcess): void {
  schedulerProcesses.add(child);
}

export function unregisterSchedulerProcess(child: ElectronUtilityProcess): void {
  schedulerProcesses.delete(child);
}

function collectUtilityProcessPids(children: Iterable<ElectronUtilityProcess>): Set<number> {
  const pids = new Set<number>();
  for (const child of children) {
    if (child.pid != null && child.pid > 0) {
      pids.add(child.pid);
    }
  }
  return pids;
}

/**
 * 当前各进程角色的 pid 快照，供资源遥测按 process_role 拆分使用
 *
 * getAppMetrics 不直接给 renderer / host / scheduler 的角色，需结合
 * BrowserWindow / webContents / utilityProcess 注册表才能可靠归类。
 */
export function collectChromiumProcessRolePids(): ChromiumProcessRolePids {
  const mainWindowRendererPids = new Set<number>();
  const guestRendererPids = new Set<number>();

  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) {
      continue;
    }
    const rendererPid = contents.getOSProcessId();
    if (rendererPid <= 0) {
      continue;
    }
    if (mainApplicationWindowWebContentsIds.has(contents.id)) {
      mainWindowRendererPids.add(rendererPid);
      continue;
    }
    // 内置浏览器 tab 是真实 `<webview>` guest；辅助窗口与 DevTools 落到 chromium_other。
    if (contents.getType() === "webview") {
      guestRendererPids.add(rendererPid);
    }
  }

  return {
    mainPid: process.pid,
    mainWindowRendererPids,
    guestRendererPids,
    hostPids: collectUtilityProcessPids(hostProcesses.values()),
    schedulerPids: collectUtilityProcessPids(schedulerProcesses),
  };
}

export function registerHostProcess(label: string, child: ElectronUtilityProcess): void {
  hostProcesses.set(label, child);
  configureNetworkCaptureHost(child);
}

export function unregisterHostProcess(label: string): void {
  hostProcesses.delete(label);
  hostAgentProcesses.delete(label);
  forgetHostResourceUsage(label);
}

export function registerHostAgentProcess(label: string, process: RegisteredAgentProcess): void {
  let processes = hostAgentProcesses.get(label);
  if (!processes) {
    processes = new Map();
    hostAgentProcesses.set(label, processes);
  }

  processes.set(process.pid, process);
}

export function unregisterHostAgentProcess(label: string, pid: number): void {
  const processes = hostAgentProcesses.get(label);
  if (!processes) {
    return;
  }

  processes.delete(pid);
  if (processes.size === 0) {
    hostAgentProcesses.delete(label);
  }
}

/** browser-use 的浏览器 guest 是 main 里的 WebContentsView，其 renderer 归内置插件 browser-use */
let browserUseGuestWebContentsIdsProvider: () => Iterable<number> = () => [];

export function setBrowserUseGuestWebContentsIdsProvider(provider: () => Iterable<number>): void {
  browserUseGuestWebContentsIdsProvider = provider;
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/**
 * 打开资源管理器窗口（单例）。
 * 如果已有实例则聚焦，不重复创建。
 */
export function openResourceManager(): void {
  if (instance && !instance.isDestroyed()) {
    instance.focus();
    return;
  }

  instance = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    title: RESOURCE_MANAGER_WINDOW_TITLE,
    // 不继承主窗口的自定义标题栏，使用系统默认标题栏
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  observeNetworkWindow(instance, () => hostProcesses.values());
  // 与主窗口保持一致：生产包始终加载签名包内的渲染资源。
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    instance.loadURL(`${base}/resource-manager.html`);
  } else {
    instance.loadFile(join(import.meta.dirname, "../renderer/resource-manager.html"));
  }

  instance.on("closed", () => {
    stopResourceUsageSampling();
    instance = null;
  });
  instance.webContents.on("render-process-gone", stopResourceUsageSampling);
  instance.webContents.on("destroyed", stopResourceUsageSampling);

  logger.info("[resource-manager] window opened");
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

function baseProcess(
  pid: number,
  name: string,
  groupKey: string,
  cpuPercent: number,
  memoryBytes: number,
): ResourceUsageProcess {
  return {
    pid,
    name,
    category: "base",
    groupKey,
    groupLabel: groupKey,
    cpuPercent,
    memoryBytes,
    sampled: true,
  };
}

/** Electron 自身进程（main / gpu / renderer / host / utility）→ 进程行 */
function collectElectronProcesses(): ResourceUsageProcess[] {
  const metrics = app.getAppMetrics();
  const metricsByPid = new Map(metrics.map((m) => [m.pid, m]));
  const assigned = new Set<number>();
  const rows: ResourceUsageProcess[] = [];
  const logicalCpuCount = os.cpus().length;

  const metricsOf = (pid: number): { cpuPercent: number; memoryBytes: number } => {
    const metric = metricsByPid.get(pid);
    return {
      cpuPercent: normalizeElectronCpuToMachinePercent(metric?.cpu.percentCPUUsage, {
        logicalCpuCount,
      }),
      // getAppMetrics 的 workingSetSize 单位是 KB
      memoryBytes: (metric?.memory.workingSetSize ?? 0) * 1024,
    };
  };
  const push = (row: ResourceUsageProcess): void => {
    if (assigned.has(row.pid)) return;
    assigned.add(row.pid);
    rows.push(row);
  };

  const mainMetrics = metricsOf(process.pid);
  push(
    baseProcess(
      process.pid,
      formatZCodeMainProcessName(),
      "main",
      mainMetrics.cpuPercent,
      mainMetrics.memoryBytes,
    ),
  );

  for (const m of metrics) {
    if (m.type === "GPU") {
      const { cpuPercent, memoryBytes } = metricsOf(m.pid);
      push(baseProcess(m.pid, formatZCodeGpuProcessName(), "gpu", cpuPercent, memoryBytes));
    }
  }

  // 同一个 OS 进程可能承载多个 BrowserWindow，按 PID 去重。
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const rendererPid = win.webContents.getOSProcessId();
    if (rendererPid <= 0) continue;
    const { cpuPercent, memoryBytes } = metricsOf(rendererPid);
    push(
      baseProcess(
        rendererPid,
        formatZCodeRendererProcessName(win.getTitle() || `Window ${win.id}`),
        "renderer",
        cpuPercent,
        memoryBytes,
      ),
    );
  }

  // browser-use 的浏览器 guest：renderer 进程但归内置插件。
  const browserUseGuestIds = new Set(browserUseGuestWebContentsIdsProvider());
  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const rendererPid = contents.getOSProcessId();
    if (rendererPid <= 0 || assigned.has(rendererPid)) continue;
    const { cpuPercent, memoryBytes } = metricsOf(rendererPid);
    const name = buildAuxiliaryRendererName(contents);
    if (browserUseGuestIds.has(contents.id)) {
      push({
        pid: rendererPid,
        name,
        category: "builtin-plugin",
        groupKey: `builtin:${BROWSER_USE_PLUGIN_NAME}`,
        groupLabel: BROWSER_USE_PLUGIN_NAME,
        cpuPercent,
        memoryBytes,
        sampled: true,
      });
      continue;
    }
    push(baseProcess(rendererPid, name, "renderer", cpuPercent, memoryBytes));
  }

  // host 是 main 通过 utilityProcess.fork() 创建的直接子进程。
  for (const [label, child] of hostProcesses) {
    if (child.pid == null) continue;
    const { cpuPercent, memoryBytes } = metricsOf(child.pid);
    push(
      baseProcess(child.pid, formatZCodeHostProcessName(label), "host", cpuPercent, memoryBytes),
    );
  }

  for (const m of metrics) {
    if (assigned.has(m.pid)) continue;
    const { cpuPercent, memoryBytes } = metricsOf(m.pid);
    push(
      baseProcess(
        m.pid,
        m.type === "Utility"
          ? formatZCodeUtilityProcessName(m.name || String(m.pid))
          : formatZCodeUtilityProcessName(m.type, "process"),
        "utility",
        cpuPercent,
        memoryBytes,
      ),
    );
  }

  return rows;
}

async function collectHostProcesses(signal?: AbortSignal): Promise<HostResourceUsageProcess[]> {
  const results = await Promise.all(
    [...hostProcesses].map(([label, child]) =>
      child.pid != null ? requestHostResourceUsage(label, child, undefined, signal) : [],
    ),
  );
  return results.flat();
}

/** Agent 注册表兜底：Host 还没回报的 Agent 也要出现在列表里（指标未采到） */
function collectUnsampledAgentProcesses(sampledPids: Set<number>): ResourceUsageProcess[] {
  const rows: ResourceUsageProcess[] = [];
  for (const processes of hostAgentProcesses.values()) {
    for (const agent of [...processes.values()].sort(
      (left, right) => left.startedAt - right.startedAt,
    )) {
      if (sampledPids.has(agent.pid)) continue;
      rows.push({
        pid: agent.pid,
        name: formatZCodeAgentProcessName(agent.provider, agent.workspacePath),
        category: "base",
        groupKey: "cli",
        groupLabel: "cli",
        cpuPercent: 0,
        memoryBytes: 0,
        sampled: false,
      });
    }
  }
  return rows;
}

const systemCpuMeter = createSystemCpuMeter();

/** 一次完整快照：Electron 进程 + Host 采样的外部进程 + 系统总量 */
export async function buildResourceUsageSnapshot(
  options: { includeHosts?: boolean; signal?: AbortSignal } = {},
): Promise<ResourceUsageSnapshot> {
  const electronProcesses = collectElectronProcesses();
  const hostRows = options.includeHosts === false ? [] : await collectHostProcesses(options.signal);

  const electronPids = new Set(electronProcesses.map((row) => row.pid));
  const processes: ResourceUsageProcess[] = [...electronProcesses];
  for (const row of hostRows) {
    // Host 子树里会再次看到 Host 自身之外的 Electron 进程吗？不会（它们都是 main 的子进程），
    // 但 pid 复用等极端情况下仍按 Electron 指标优先。
    if (electronPids.has(row.pid)) continue;
    processes.push({ ...row, sampled: true });
  }
  processes.push(...collectUnsampledAgentProcesses(new Set(processes.map((row) => row.pid))));

  const appTotals = processes.reduce(
    (total, row) => ({
      cpuPercent: total.cpuPercent + row.cpuPercent,
      memoryBytes: total.memoryBytes + row.memoryBytes,
    }),
    { cpuPercent: 0, memoryBytes: 0 },
  );
  const memoryTotalBytes = os.totalmem();

  return {
    sampledAt: Date.now(),
    logicalCpuCount: os.cpus().length,
    system: {
      cpuPercent: systemCpuMeter.read(),
      memoryTotalBytes,
      memoryUsedBytes: Math.max(0, memoryTotalBytes - os.freemem()),
    },
    app: {
      cpuPercent: Math.round(appTotals.cpuPercent * 10) / 10,
      memoryBytes: appTotals.memoryBytes,
    },
    processes,
  };
}
