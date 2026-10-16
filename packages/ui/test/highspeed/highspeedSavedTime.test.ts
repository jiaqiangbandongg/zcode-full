import { describe, expect, it, vi } from "vitest";
import {
  calculateHighspeedSavedDurationMs,
  calculateHighspeedSavedDurationFromMetrics,
  readHighspeedRegularTpsFromHealth,
} from "@/highspeed/highspeedSavedTime.js";

describe("highspeed saved time", () => {
  it("通过 Service 轻量健康方法读取普通 TPS，不在 Renderer 重复缓存", async () => {
    const getCodingPlanRegularTps = vi.fn().mockResolvedValue(73);
    const usageStatsService = { getCodingPlanRegularTps } as never;
    const accountAccess = {
      type: "zhipu-account",
      accountType: "zai",
      mode: "individual-coding-plan",
      entitled: true,
    } as const;

    await expect(
      readHighspeedRegularTpsFromHealth({
        usageStatsService,
        preferredProviderId: "zai-coding-plan",
        accountAccess,
      }),
    ).resolves.toBe(73);
    await expect(
      readHighspeedRegularTpsFromHealth({
        usageStatsService,
        preferredProviderId: "zai-coding-plan",
        accountAccess,
      }),
    ).resolves.toBe(73);
    expect(getCodingPlanRegularTps).toHaveBeenCalledTimes(2);
    // Provider 重构后请求期鉴权只能由 accountAccess 解析：漏传会让 host 找不到授权并抛错，
    // 表现为节省时间静默消失，因此这里显式钉住透传契约。
    expect(getCodingPlanRegularTps).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferredProviderId: "zai-coding-plan", accountAccess }),
    );
  });

  it("按工具 20% / 推理 80% 估算每轮节省时间并把负值收口为零", () => {
    expect(
      calculateHighspeedSavedDurationMs({
        outputTokens: 9_000,
        regularTps: 30,
        highspeedTps: 90,
        durationMs: 100_000,
      }),
    ).toBe(114_286);
    expect(
      calculateHighspeedSavedDurationMs({
        outputTokens: 100,
        regularTps: 100,
        highspeedTps: 50,
        durationMs: 2_000,
      }),
    ).toBe(0);
  });

  it("优先使用 CLI 持久化的模型/工具真实耗时", () => {
    expect(
      calculateHighspeedSavedDurationMs({
        outputTokens: 9_000,
        regularTps: 30,
        highspeedTps: 90,
        durationMs: 100_000,
        modelDurationMs: 40_000,
        toolDurationMs: 50_000,
        otherDurationMs: 10_000,
      }),
    ).toBe(80_000);
  });

  it("持久化前计算节省时间时透传真实耗时拆分", () => {
    expect(
      calculateHighspeedSavedDurationFromMetrics(
        {
          outputTokens: 9_000,
          durationMs: 100_000,
          modelDurationMs: 40_000,
          toolDurationMs: 50_000,
          otherDurationMs: 10_000,
        },
        30,
        90,
      ),
    ).toBe(80_000);
  });
});
