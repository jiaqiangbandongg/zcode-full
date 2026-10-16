/**
 * 进程角色的有界聚合窗口。
 *
 * 所有来源（Chromium 体系、Node 自采、CLI、MCP）都把"某角色在某一刻的瞬时事实"喂进来，
 * flush 时每个窗口投影成一条 `perf_process_window`。纯内存、有界、无队列、无重试。
 */

import type { ProcessResourceRole, ProcessResourceRuntimeSurface } from "@zcode/shared";
import {
  appendBoundedSamples,
  computeAggregateStats,
  roundMetric,
} from "./resourceMetricsStats.js";

/** 每角色每序列的样本上限（5 分钟 @10 秒 = 30，留 2 个容忍定时器漂移）。 */
export const PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW = 32;
/**
 * 同时存在的窗口上限（内存有界）。
 * 角色、运行环境、硬件与 MCP ID 会分别开窗；多远端环境共用 64 个窗口预算，
 * 超出后新窗口直接丢弃，不排队、不持久化。
 */
const PROCESS_RESOURCE_MAX_WINDOWS = 64;

export type ProcessResourceScene = "foreground" | "background";

/** 该角色实际运行的机器；缺省时由出口补桌面机的值。 */
export interface ProcessResourceHardware {
  platform: NodeJS.Platform;
  arch: string;
  logicalCpuCount: number;
  totalMemoryGb: number;
}

/**
 * 样本自报的运行机信息，可能只有一部分字段（旧 CLI 不带 `totalMemoryGb`）。
 * 出口按字段逐项覆盖桌面机默认值，不是整体二选一。
 */
export type ProcessResourceHardwareOverride = Partial<ProcessResourceHardware>;

/** 一个角色在某一刻的瞬时事实。 */
export interface ProcessRoleSample {
  role: ProcessResourceRole;
  /** Host 注入的运行环境哈希，仅用于内存分组，不投影到事件属性。 */
  environmentKey?: string;
  /** 角色内全部进程的 CPU 之和（整机归一化百分比）。 */
  cpuPercent: number;
  rssKbTotal: number;
  rssKbMaxProcess: number;
  processCount: number;
  uptimeMinutes: number;
  /** 仅 Node 角色与 renderer_main；缺省表示该次采样没有 heap 读数。 */
  heapUsedKb?: number;
  runtimeSurface?: ProcessResourceRuntimeSurface;
  /** 仅 mcp 角色。 */
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
}

export interface ProcessRoleWindowReport {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
  backgroundRatio: number;
  uptimeMinutes: number;
  cpuPercentMean: number;
  cpuPercentP95: number;
  cpuPercentPeak: number;
  rssKbTotalMean: number;
  rssKbTotalPeak: number;
  rssKbMaxProcessPeak: number;
  heapUsedKbMean?: number;
  heapUsedKbPeak?: number;
  processCountPeak: number;
  sampleCount: number;
}

interface ProcessRoleWindow {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
  cpuPercent: number[];
  rssKbTotal: number[];
  rssKbMaxProcess: number[];
  heapUsedKb: number[];
  processCountPeak: number;
  uptimeMinutes: number;
}

/**
 * 硬件维度指纹只描述规格，不代表机器身份。环境身份由 Host 单独注入窗口 key，
 * 避免同规格远端环境的 CPU/RSS 被相加；硬件指纹仍隔离同环境内不同规格的读数。
 * 本机角色不带 hardware，指纹为空串，窗口 key 与只有角色时完全一致。
 */
export function processResourceHardwareKey(hardware?: ProcessResourceHardwareOverride): string {
  if (!hardware) {
    return "";
  }
  return [
    hardware.platform ?? "",
    hardware.arch ?? "",
    hardware.logicalCpuCount ?? "",
    hardware.totalMemoryGb ?? "",
  ].join("/");
}

function windowKey(sample: ProcessRoleSample): string {
  return [
    sample.role,
    sample.runtimeSurface ?? "local",
    sample.environmentKey ?? "",
    sample.mcpId ?? "",
    processResourceHardwareKey(sample.hardware),
  ].join(":");
}

export class ProcessResourceWindowAggregator {
  private readonly windows = new Map<string, ProcessRoleWindow>();
  private sceneTicks = 0;
  private backgroundTicks = 0;

  /** main 每个 10 秒 tick 记录一次前后台；窗口内的比例给所有角色事件共用。 */
  recordScene(scene: ProcessResourceScene): void {
    this.sceneTicks += 1;
    if (scene === "background") {
      this.backgroundTicks += 1;
    }
  }

  add(sample: ProcessRoleSample): void {
    const key = windowKey(sample);
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= PROCESS_RESOURCE_MAX_WINDOWS) {
        return;
      }
      window = {
        role: sample.role,
        runtimeSurface: sample.runtimeSurface ?? "local",
        mcpId: sample.mcpId,
        hardware: sample.hardware,
        cpuPercent: [],
        rssKbTotal: [],
        rssKbMaxProcess: [],
        heapUsedKb: [],
        processCountPeak: 0,
        uptimeMinutes: 0,
      };
      this.windows.set(key, window);
    }

    // 运行环境和硬件维度均进入窗口 key，同一窗口无需覆盖维度。
    window.cpuPercent = appendBounded(window.cpuPercent, sample.cpuPercent);
    window.rssKbTotal = appendBounded(window.rssKbTotal, sample.rssKbTotal);
    window.rssKbMaxProcess = appendBounded(window.rssKbMaxProcess, sample.rssKbMaxProcess);
    if (typeof sample.heapUsedKb === "number" && Number.isFinite(sample.heapUsedKb)) {
      window.heapUsedKb = appendBounded(window.heapUsedKb, sample.heapUsedKb);
    }
    window.processCountPeak = Math.max(window.processCountPeak, sample.processCount);
    window.uptimeMinutes = Math.max(window.uptimeMinutes, sample.uptimeMinutes);
  }

  /**
   * 窗口内的后台 tick 占比。
   * 角色事件与设备级 `perf_system_window` 共用这一个数，因此 scene 计数只有这一份；
   * 注意 `drain()` 会清零计数，设备事件要在 drain 之前取值。
   */
  get backgroundRatio(): number {
    return this.sceneTicks > 0 ? roundMetric(this.backgroundTicks / this.sceneTicks) : 0;
  }

  /** 取出并清空全部窗口；`sample_count` 如实反映窗口内的样本数（含残窗）。 */
  drain(): ProcessRoleWindowReport[] {
    const backgroundRatio = this.backgroundRatio;
    const reports = [...this.windows.values()]
      .filter((window) => window.cpuPercent.length > 0)
      .map((window) => projectWindow(window, backgroundRatio));
    this.clear();
    return reports;
  }

  clear(): void {
    this.windows.clear();
    this.sceneTicks = 0;
    this.backgroundTicks = 0;
  }
}

/**
 * 溢出时丢最旧的样本：上限只会在定时器漂移（一个窗口挤进 30 个以上 tick）时触碰，
 * 此时窗口末尾的读数才是要上报的那段时间的事实。
 */
function appendBounded(bucket: number[], value: number): number[] {
  return appendBoundedSamples(bucket, value, PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW);
}

function projectWindow(
  window: ProcessRoleWindow,
  backgroundRatio: number,
): ProcessRoleWindowReport {
  const cpu = computeAggregateStats(window.cpuPercent);
  const rssTotal = computeAggregateStats(window.rssKbTotal);
  const rssMaxProcess = computeAggregateStats(window.rssKbMaxProcess);
  const heap = window.heapUsedKb.length > 0 ? computeAggregateStats(window.heapUsedKb) : null;

  return {
    role: window.role,
    runtimeSurface: window.runtimeSurface,
    mcpId: window.mcpId,
    hardware: window.hardware,
    backgroundRatio,
    uptimeMinutes: window.uptimeMinutes,
    cpuPercentMean: cpu.mean,
    cpuPercentP95: cpu.p95,
    cpuPercentPeak: cpu.peak,
    rssKbTotalMean: rssTotal.mean,
    rssKbTotalPeak: rssTotal.peak,
    rssKbMaxProcessPeak: rssMaxProcess.peak,
    heapUsedKbMean: heap?.mean,
    heapUsedKbPeak: heap?.peak,
    processCountPeak: window.processCountPeak,
    sampleCount: cpu.sample_count,
  };
}
