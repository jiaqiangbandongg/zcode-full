import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { resolveGreetingFontSizePx } from "@/v4/ConversationDraftEmptyState.js";

describe("chat empty time greeting i18n", () => {
  it("下午和夜深问候保持自然、克制的关怀语气", () => {
    expect(zhCN["chat.empty.greeting.afternoon"]).toBe("下午好呀，接下来交给我吧");
    expect(zhCN["chat.empty.greeting.lateNight"]).toBe("夜深啦，别忘了照顾好自己哦");
  });

  it("英文问候与中文保持相同意图并使用本地化表达", () => {
    expect(enUS["chat.empty.greeting.afternoon"]).toBe("Good afternoon! Leave the rest to me.");
    expect(enUS["chat.empty.greeting.lateNight"]).toBe(
      "It's late—remember to take care of yourself.",
    );
  });

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
