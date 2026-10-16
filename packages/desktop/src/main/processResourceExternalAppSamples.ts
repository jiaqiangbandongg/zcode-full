/**
 * 设备级应用总量的外部样本入口。
 *
 * `perf_system_window` 的应用总量定义为「Chromium 体系每 10 秒的精确合计，
 * 加上最近一次已知的外部样本」。外部进程（CLI 60 秒自采、MCP 5 分钟采样）不在
 * `app.getAppMetrics()` 里，也不可能按 main 的 10 秒节拍给出读数，所以这里只保留
 * 每个来源的最近一次样本，并按该来源自己的采样周期判定过期：
 * 超过两个采样周期没有新样本，说明进程已退出或采样链路断了，宁可少算也不能拿旧值充当当前事实。
 *
 * CLI 角色与 MCP 角色在各自的摄入点调用 `recordExternalAppResourceSample`。
 * 纯内存、有界、失败即丢：不排队、不持久化、不重试。
 */

import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import {
  addAppResourceTotals,
  createEmptyAppResourceTotals,
  type AppResourceTotals,
} from "./processResourceAppTotals.js";

/** 未自报采样周期时的默认周期（CLI 自采节拍）。 */
export const EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS = 60_000;

/**
 * 来源条目上限（内存有界）。
 * CLI 改为按最多 64 个实例保存后，预算增加这 64 项，保留原有 MCP 来源空间。
 * 只提高内存上限，不新增队列或定时器；超出后新来源直接丢弃。
 */
export const PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES = 128;

export interface ExternalAppResourceSample extends AppResourceTotals {
  /**
   * 来源的稳定 key（如 CLI 实例、MCP 来源组）：只用于覆盖旧样本与判定过期，
   * 不进入任何 ARMS 属性，因此不得放 pid、路径或 workspace 标识。
   */
  sourceKey: string;
  /** 设备级总量只统计本机进程；远端 CLI / MCP 的样本在这里直接丢弃。 */
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** 该来源的采样周期；过期判据为 2 倍周期未更新。缺省按 60 秒计。 */
  intervalMs?: number;
  /** main 侧收到该样本的时刻。 */
  receivedAt: number;
}

interface StoredExternalSample extends AppResourceTotals {
  receivedAt: number;
  expiresAfterMs: number;
}

const latestSamplesBySource = new Map<string, StoredExternalSample>();

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** 记录某个外部来源的最近一次样本；非法样本直接丢弃，不影响已有合计。 */
export function recordExternalAppResourceSample(sample: ExternalAppResourceSample): void {
  if (sample.runtimeSurface !== "local" || !sample.sourceKey) {
    return;
  }
  if (
    !isNonNegativeFinite(sample.cpuPercent) ||
    !isNonNegativeFinite(sample.rssKbTotal) ||
    !isNonNegativeFinite(sample.processCount) ||
    !Number.isFinite(sample.receivedAt)
  ) {
    return;
  }
  if (
    !latestSamplesBySource.has(sample.sourceKey) &&
    latestSamplesBySource.size >= PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES
  ) {
    return;
  }

  const intervalMs =
    typeof sample.intervalMs === "number" &&
    Number.isFinite(sample.intervalMs) &&
    sample.intervalMs > 0
      ? sample.intervalMs
      : EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS;

  latestSamplesBySource.set(sample.sourceKey, {
    cpuPercent: sample.cpuPercent,
    rssKbTotal: sample.rssKbTotal,
    processCount: sample.processCount,
    receivedAt: sample.receivedAt,
    expiresAfterMs: intervalMs * 2,
  });
}

/** 汇总未过期的外部来源；顺手清掉过期条目，避免长会话里僵尸来源常驻。 */
export function collectExternalAppResourceTotals(now: number): AppResourceTotals {
  let totals = createEmptyAppResourceTotals();
  for (const [sourceKey, sample] of latestSamplesBySource) {
    if (now - sample.receivedAt > sample.expiresAfterMs) {
      latestSamplesBySource.delete(sourceKey);
      continue;
    }
    totals = addAppResourceTotals(totals, sample);
  }
  return totals;
}

/** 采样启停时清空全部来源，避免跨采样会话串数据。 */
export function resetExternalAppResourceSamples(): void {
  latestSamplesBySource.clear();
}
