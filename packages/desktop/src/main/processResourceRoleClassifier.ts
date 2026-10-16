/**
 * Chromium 体系（main 侧 getAppMetrics）的进程角色归类与按角色聚合。
 * 纯函数、零 Electron 运行时依赖，便于单测；pid 集合由 resourceManagerWindow 的注册表提供。
 */

import type { ProcessResourceRole } from "@zcode/shared";
import {
  addAppResourceTotals,
  createEmptyAppResourceTotals,
  type AppResourceTotals,
} from "./processResourceAppTotals.js";
import { roundMetric } from "./resourceMetricsStats.js";

/** getAppMetrics 能覆盖的七个角色；cli_* 与 mcp 由 CLI 样本贡献，不在这里出现。 */
export const CHROMIUM_PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
] as const satisfies readonly ProcessResourceRole[];

export type ChromiumProcessResourceRole = (typeof CHROMIUM_PROCESS_RESOURCE_ROLES)[number];

/** 规整后的单进程采样：CPU 已归一化到整机口径，内存单位 KB。 */
export interface ChromiumProcessMetricSample {
  pid: number;
  type: string;
  cpuPercent: number;
  rssKb: number;
  /** 进程创建时间（epoch ms）；缺省表示未知，运行时长按 0 计。 */
  creationTime?: number;
}

/**
 * 角色归属的 pid 快照。renderer 必须区分主窗口与 `<webview>` guest，
 * host 与 scheduler 的 utilityProcess pid 由各自 spawn 点登记。
 */
export interface ChromiumProcessRolePids {
  mainPid: number;
  mainWindowRendererPids: ReadonlySet<number>;
  guestRendererPids: ReadonlySet<number>;
  hostPids: ReadonlySet<number>;
  schedulerPids: ReadonlySet<number>;
}

export interface ChromiumRoleAggregate {
  role: ChromiumProcessResourceRole;
  /** 角色内全部进程的 CPU 之和（整机归一化百分比）。 */
  cpuPercent: number;
  rssKbTotal: number;
  rssKbMaxProcess: number;
  processCount: number;
  /** 角色内最老进程的运行分钟数。 */
  uptimeMinutes: number;
}

/**
 * 汇总一个 tick 的全部 Chromium 角色，得到 main 能精确枚举到的应用进程合计。
 * 设备级应用总量只从这里取 Chromium 部分：CLI 与 MCP 走外部样本入口，两边不会重复计数。
 */
export function sumChromiumRoleAggregates(
  aggregates: readonly ChromiumRoleAggregate[],
): AppResourceTotals {
  let totals = createEmptyAppResourceTotals();
  for (const aggregate of aggregates) {
    totals = addAppResourceTotals(totals, {
      cpuPercent: aggregate.cpuPercent,
      rssKbTotal: aggregate.rssKbTotal,
      processCount: aggregate.processCount,
    });
  }
  return totals;
}

export function classifyChromiumProcessRole(
  sample: Pick<ChromiumProcessMetricSample, "pid" | "type">,
  pids: ChromiumProcessRolePids,
): ChromiumProcessResourceRole {
  if (sample.pid === pids.mainPid) {
    return "main";
  }
  if (sample.type === "GPU") {
    return "gpu";
  }
  if (pids.mainWindowRendererPids.has(sample.pid)) {
    return "renderer_main";
  }
  if (pids.guestRendererPids.has(sample.pid)) {
    return "renderer_guest";
  }
  if (pids.hostPids.has(sample.pid)) {
    return "host";
  }
  if (pids.schedulerPids.has(sample.pid)) {
    return "scheduler";
  }
  return "chromium_other";
}

function uptimeMinutesOf(sample: ChromiumProcessMetricSample, now: number): number {
  const creationTime = sample.creationTime;
  if (typeof creationTime !== "number" || !Number.isFinite(creationTime) || creationTime <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((now - creationTime) / 60_000));
}

/** 按角色聚合一个 tick 的全部 Chromium 进程；只返回本 tick 有存活进程的角色。 */
export function aggregateChromiumProcessRoles(input: {
  processes: readonly ChromiumProcessMetricSample[];
  pids: ChromiumProcessRolePids;
  now: number;
}): ChromiumRoleAggregate[] {
  const byRole = new Map<ChromiumProcessResourceRole, ChromiumRoleAggregate>();

  for (const sample of input.processes) {
    const role = classifyChromiumProcessRole(sample, input.pids);
    const existing = byRole.get(role);
    const uptimeMinutes = uptimeMinutesOf(sample, input.now);
    if (!existing) {
      byRole.set(role, {
        role,
        cpuPercent: sample.cpuPercent,
        rssKbTotal: sample.rssKb,
        rssKbMaxProcess: sample.rssKb,
        processCount: 1,
        uptimeMinutes,
      });
      continue;
    }
    // 只在累加结束后取整：逐次 round 会让误差随进程数累积。
    existing.cpuPercent += sample.cpuPercent;
    existing.rssKbTotal += sample.rssKb;
    existing.rssKbMaxProcess = Math.max(existing.rssKbMaxProcess, sample.rssKb);
    existing.processCount += 1;
    existing.uptimeMinutes = Math.max(existing.uptimeMinutes, uptimeMinutes);
  }

  // 输出顺序按角色枚举固定，事件顺序在单测与看板里都可预期。
  return CHROMIUM_PROCESS_RESOURCE_ROLES.map((role) => byRole.get(role))
    .filter((aggregate): aggregate is ChromiumRoleAggregate => aggregate !== undefined)
    .map((aggregate) => ({ ...aggregate, cpuPercent: roundMetric(aggregate.cpuPercent) }));
}
