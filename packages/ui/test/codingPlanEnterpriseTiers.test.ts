import { describe, expect, it } from "vitest";
import { formatEnterpriseTier } from "@/settings/model-provider-section/codingPlanEnterpriseTiers.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// 原生购买面板退役后，企业档位仍用于设置页；将对应活代码的语言契约保留在此。
describe("enterprise tier labels", () => {
  it.each([
    ["LITE", "基础版"],
    ["PRO", "标准版"],
    ["MAX", "高级版"],
  ])("localizes %s using the configured messages", (tier, label) => {
    expect(
      formatEnterpriseTier(tier, {
        locale: "zh-CN",
        formatMessage: (id, fallback) => zhCN[id as keyof typeof zhCN] ?? fallback,
      }),
    ).toBe(label);
  });

  it("preserves the English and unknown-tier fallback", () => {
    expect(formatEnterpriseTier("PRO", "en-US")).toBe("Pro");
    expect(formatEnterpriseTier("MAX", "en-US")).toBe("Max");
    expect(formatEnterpriseTier("TEAM_PLUS", "zh-CN")).toBe("Team_plus");
  });
});
