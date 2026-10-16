import { describe, expect, it } from "vitest";
import {
  formatContextCacheHitRateLabel,
  formatContextUsageSummary,
  formatContextUsageTokenCount,
} from "@/chat-input-toolbar/contextUsage.js";
import { runContextPanelActionWithClose } from "@/chat-input-toolbar/contextPanelAction.js";

describe("chat input context usage formatting", () => {
  it("uses uppercase English compact units", () => {
    expect(formatContextUsageTokenCount(1_250, "en-US")).toBe("1.3K");
    expect(formatContextUsageTokenCount(1_500_000, "en-US")).toBe("1.5M");
    expect(formatContextUsageTokenCount(2_300_000_000, "en-US")).toBe("2.3B");
  });

  it("renders the context window summary with integer compact total", () => {
    expect(
      formatContextUsageSummary({
        locale: "en-US",
        percent: 0.125,
        size: 1_000_000,
        used: 125_000,
      }),
    ).toBe("125K/1M (12.5%)");
  });

  it("uses localized compact token units for Chinese locale", () => {
    expect(
      formatContextUsageSummary({
        locale: "zh-CN",
        percent: 0.125,
        size: 1_000_000,
        used: 125_000,
      }),
    ).toBe("12.5万/100万 (12.5%)");
  });

  it("only renders cache hit rate at 78 percent or above", () => {
    expect(formatContextCacheHitRateLabel(0.779, "en-US")).toBeNull();
    expect(formatContextCacheHitRateLabel(0.78, "en-US")).toBe("78%");
    expect(formatContextCacheHitRateLabel(0.781, "en-US")).toBe("78.1%");
    expect(formatContextCacheHitRateLabel(null, "en-US")).toBeNull();
  });

  it("closes the context panel before running an inner action", () => {
    const calls: string[] = [];

    runContextPanelActionWithClose({
      action: () => calls.push("action"),
      close: () => calls.push("close"),
    });

    expect(calls).toEqual(["close", "action"]);
  });
});
