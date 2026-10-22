import { describe, expect, it } from "vitest";
import { resolveGreetingFontSizePx } from "@/v4/ConversationDraftEmptyState.js";

describe("chat empty time greeting i18n", () => {
  it("标题只在自身文字真实受到水平挤压后按 1px 档位缩小", () => {
    expect(
      resolveGreetingFontSizePx({
        availableWidthPx: 406,
        naturalTextWidthPx: 360,
      }),
    ).toBe(30);
    expect(
      resolveGreetingFontSizePx({
        availableWidthPx: 359,
        naturalTextWidthPx: 360,
      }),
    ).toBe(29);
    expect(
      resolveGreetingFontSizePx({
        availableWidthPx: 300,
        naturalTextWidthPx: 360,
      }),
    ).toBe(25);
    expect(
      resolveGreetingFontSizePx({
        availableWidthPx: 120,
        naturalTextWidthPx: 360,
      }),
    ).toBe(20);
  });

  it("标题测量暂不可用时保留默认字号而不是随窗口缩小", () => {
    expect(
      resolveGreetingFontSizePx({
        availableWidthPx: 0,
        naturalTextWidthPx: 360,
      }),
    ).toBe(30);
    expect(
      resolveGreetingFontSizePx({
        availableWidthPx: 406,
        naturalTextWidthPx: Number.NaN,
      }),
    ).toBe(30);
  });

  it("手机远控保持原有 20px 紧凑标题，不启用桌面自适应测量", () => {
    expect(
      resolveGreetingFontSizePx({
        availableWidthPx: 406,
        naturalTextWidthPx: 360,
        compactForRemoteControl: true,
      }),
    ).toBe(20);
  });
});
