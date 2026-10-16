/** `perf_process_window` 的属性投影（纯函数，属性 key 与白名单一一对应）。 */

import type { ArmsRumEnv } from "@zcode/shared";
import { PROCESS_RESOURCE_EVENT_NAMES } from "@zcode/shared";
import type {
  ProcessResourceHardware,
  ProcessRoleWindowReport,
} from "./processResourceWindowAggregator.js";

export const PERF_PROCESS_WINDOW_EVENT_NAME = PROCESS_RESOURCE_EVENT_NAMES.processWindow;

export interface ProcessResourceReportContext {
  deviceMid: string;
  appVersion: string;
  armsEnv: ArmsRumEnv;
  /** 桌面机硬件；样本自带 hardware 时（远端 CLI / MCP）覆盖这里的默认值。 */
  desktopHardware: ProcessResourceHardware;
}

/** ARMS 的 `platform` 维度只有这三个取值，看板按它分组。 */
export type ProcessResourceOsCategory = "macos" | "windows" | "linux";

export function normalizeOsCategory(platform: NodeJS.Platform): ProcessResourceOsCategory {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

/**
 * 属性顺序与事件契约一致；值为 undefined 的属性不会进入最终 payload，
 * 因此 gpu / renderer_guest / chromium_other 天然是 18 个属性。
 */
export function buildProcessWindowEventProperties(
  report: ProcessRoleWindowReport,
  context: ProcessResourceReportContext,
): Record<string, string | number | undefined> {
  // 逐字段覆盖：远端 CLI 只带 platform / arch / 核数时，total_memory_gb 仍取桌面机的值。
  const hardware = { ...context.desktopHardware, ...report.hardware };
  return {
    platform: normalizeOsCategory(hardware.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
    device_mid: context.deviceMid,
    process_role: report.role,
    runtime_surface: report.runtimeSurface,
    arch: hardware.arch,
    logical_cpu_count: hardware.logicalCpuCount,
    total_memory_gb: hardware.totalMemoryGb,
    mcp_id: report.mcpId,
    background_ratio: report.backgroundRatio,
    uptime_minutes: report.uptimeMinutes,
    cpu_percent_p95: report.cpuPercentP95,
    cpu_percent_peak: report.cpuPercentPeak,
    rss_kb_total_mean: report.rssKbTotalMean,
    rss_kb_total_peak: report.rssKbTotalPeak,
    rss_kb_max_process_peak: report.rssKbMaxProcessPeak,
    heap_used_kb_mean: report.heapUsedKbMean,
    heap_used_kb_peak: report.heapUsedKbPeak,
    process_count_peak: report.processCountPeak,
    sample_count: report.sampleCount,
  };
}
