import { beforeEach, describe, expect, it } from "vitest";
import {
  collectExternalAppResourceTotals,
  EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS,
  PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES,
  recordExternalAppResourceSample,
  resetExternalAppResourceSamples,
} from "../src/main/processResourceExternalAppSamples.js";

/**
 * 设备级应用总量的外部样本入口（spec：docs/monitoring/process-resource-telemetry.md）。
 * Chromium 体系每 10 秒有精确合计，CLI（60 秒）与 MCP（5 分钟）只能按"最近一次已知样本"计入，
 * 因此这里的核心行为是：最近样本覆盖、按各自采样周期过期、只算本机、条目有界。
 */

const NOW = 1_700_000_000_000;

function cliSample(overrides: { receivedAt?: number; rssKbTotal?: number } = {}) {
  return {
    sourceKey: "cli_chat",
    runtimeSurface: "local" as const,
    cpuPercent: 20,
    rssKbTotal: overrides.rssKbTotal ?? 500_000,
    processCount: 2,
    intervalMs: 60_000,
    receivedAt: overrides.receivedAt ?? NOW,
  };
}

describe("processResourceExternalAppSamples", () => {
  beforeEach(() => {
    resetExternalAppResourceSamples();
  });

  it("最近一次样本计入合计，同一来源的新样本覆盖旧值", () => {
    recordExternalAppResourceSample(cliSample());
    expect(collectExternalAppResourceTotals(NOW)).toEqual({
      cpuPercent: 20,
      rssKbTotal: 500_000,
      processCount: 2,
    });

    recordExternalAppResourceSample(cliSample({ receivedAt: NOW + 60_000, rssKbTotal: 700_000 }));
    expect(collectExternalAppResourceTotals(NOW + 60_000).rssKbTotal).toBe(700_000);
  });

  it("多个来源分别累加", () => {
    recordExternalAppResourceSample(cliSample());
    recordExternalAppResourceSample({
      sourceKey: "mcp:filesystem",
      runtimeSurface: "local",
      cpuPercent: 5,
      rssKbTotal: 100_000,
      processCount: 3,
      intervalMs: 300_000,
      receivedAt: NOW,
    });

    expect(collectExternalAppResourceTotals(NOW)).toEqual({
      cpuPercent: 25,
      rssKbTotal: 600_000,
      processCount: 5,
    });
  });

  it("超过两个采样周期未更新的样本不再计入", () => {
    recordExternalAppResourceSample(cliSample());

    // 60 秒周期的 CLI 样本：两个周期内仍代表当前事实。
    expect(collectExternalAppResourceTotals(NOW + 120_000).rssKbTotal).toBe(500_000);
    expect(collectExternalAppResourceTotals(NOW + 120_001).rssKbTotal).toBe(0);
    expect(collectExternalAppResourceTotals(NOW + 120_001).processCount).toBe(0);
  });

  it("过期判据按来源自身的采样周期计算，5 分钟一采的 MCP 不会被 CLI 的周期误判过期", () => {
    recordExternalAppResourceSample({
      sourceKey: "mcp:filesystem",
      runtimeSurface: "local",
      cpuPercent: 5,
      rssKbTotal: 100_000,
      processCount: 1,
      intervalMs: 300_000,
      receivedAt: NOW,
    });

    expect(collectExternalAppResourceTotals(NOW + 599_000).rssKbTotal).toBe(100_000);
    expect(collectExternalAppResourceTotals(NOW + 600_001).rssKbTotal).toBe(0);
  });

  it("缺少 intervalMs 时按默认 60 秒周期判定过期", () => {
    recordExternalAppResourceSample({
      sourceKey: "cli_aux",
      runtimeSurface: "local",
      cpuPercent: 1,
      rssKbTotal: 10_000,
      processCount: 1,
      receivedAt: NOW,
    });

    const ttlMs = EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS * 2;
    expect(collectExternalAppResourceTotals(NOW + ttlMs).rssKbTotal).toBe(10_000);
    expect(collectExternalAppResourceTotals(NOW + ttlMs + 1).rssKbTotal).toBe(0);
  });

  it("远端进程不计入设备级应用总量", () => {
    recordExternalAppResourceSample({ ...cliSample(), runtimeSurface: "remote" });
    expect(collectExternalAppResourceTotals(NOW)).toEqual({
      cpuPercent: 0,
      rssKbTotal: 0,
      processCount: 0,
    });
  });

  it("非法数值的样本直接丢弃，不污染合计", () => {
    recordExternalAppResourceSample({ ...cliSample(), rssKbTotal: Number.NaN });
    recordExternalAppResourceSample({ ...cliSample(), sourceKey: "cli_aux", cpuPercent: -1 });
    expect(collectExternalAppResourceTotals(NOW)).toEqual({
      cpuPercent: 0,
      rssKbTotal: 0,
      processCount: 0,
    });
  });

  it("来源条目有界：超过上限的新来源被丢弃（性能红线 5 内存有界）", () => {
    for (let index = 0; index < PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES; index += 1) {
      recordExternalAppResourceSample({ ...cliSample(), sourceKey: `mcp:${index}`, rssKbTotal: 1 });
    }
    expect(collectExternalAppResourceTotals(NOW).rssKbTotal).toBe(
      PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES,
    );

    recordExternalAppResourceSample({ ...cliSample(), sourceKey: "mcp:overflow", rssKbTotal: 1 });
    expect(collectExternalAppResourceTotals(NOW).rssKbTotal).toBe(
      PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES,
    );
  });

  it("reset 清空全部来源，避免跨采样会话串数据", () => {
    recordExternalAppResourceSample(cliSample());
    resetExternalAppResourceSamples();
    expect(collectExternalAppResourceTotals(NOW).rssKbTotal).toBe(0);
  });
});
