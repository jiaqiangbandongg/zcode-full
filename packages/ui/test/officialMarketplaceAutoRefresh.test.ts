import { beforeEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS,
  claimMarketplaceAutoRefresh,
  resetMarketplaceAutoRefreshForTests,
  shouldAutoRefreshMarketplace,
} from "@/settings/officialMarketplaceAutoRefresh.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

describe("official marketplace auto refresh throttle", () => {
  beforeEach(() => {
    resetMarketplaceAutoRefreshForTests();
  });

  it("从未成功刷新或时间戳不可解析时立即刷新", () => {
    expect(shouldAutoRefreshMarketplace({ now: NOW })).toBe(true);
    expect(shouldAutoRefreshMarketplace({ lastUpdated: "not-a-date", now: NOW })).toBe(true);
  });

  it("距上次成功刷新不足 10 分钟跳过，到期后刷新", () => {
    expect(OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS).toBe(10 * 60_000);
    expect(shouldAutoRefreshMarketplace({ lastUpdated: minutesAgo(9), now: NOW })).toBe(false);
    expect(shouldAutoRefreshMarketplace({ lastUpdated: minutesAgo(10), now: NOW })).toBe(true);
    expect(shouldAutoRefreshMarketplace({ lastUpdated: minutesAgo(11), now: NOW })).toBe(true);
  });

  it("e2e 伪造的未来 lastUpdated 依旧跳过", () => {
    expect(
      shouldAutoRefreshMarketplace({ lastUpdated: "2099-01-01T00:00:00.000Z", now: NOW }),
    ).toBe(false);
  });

  it("最近尝试过（失败或仍在飞）时即使 lastUpdated 很旧也跳过", () => {
    expect(
      shouldAutoRefreshMarketplace({
        lastUpdated: minutesAgo(60),
        lastAttemptAt: NOW - 60_000,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("claim 通过后同一市场在窗口内不再放行，不同市场互不影响", () => {
    expect(claimMarketplaceAutoRefresh("zcode-plugins-official", undefined, NOW)).toBe(true);
    expect(claimMarketplaceAutoRefresh("zcode-plugins-official", undefined, NOW + 1_000)).toBe(
      false,
    );
    expect(claimMarketplaceAutoRefresh("other-marketplace", undefined, NOW + 1_000)).toBe(true);
    expect(
      claimMarketplaceAutoRefresh(
        "zcode-plugins-official",
        undefined,
        NOW + OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS,
      ),
    ).toBe(true);
  });

  it("手动刷新成功后 lastUpdated 变新，窗口以其为准重置", () => {
    expect(claimMarketplaceAutoRefresh("zcode-plugins-official", minutesAgo(30), NOW)).toBe(true);
    // 5 分钟后手动刷新成功，lastUpdated 更新到 NOW+5min；再过 6 分钟进入商店页：
    // 距 attempt 已 11 分钟但距 lastUpdated 仅 6 分钟，应跳过。
    const manualRefreshAt = new Date(NOW + 5 * 60_000).toISOString();
    expect(
      claimMarketplaceAutoRefresh("zcode-plugins-official", manualRefreshAt, NOW + 11 * 60_000),
    ).toBe(false);
  });
});
