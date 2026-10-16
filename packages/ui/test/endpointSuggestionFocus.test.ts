import { describe, expect, it, vi } from "vitest";
import {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "@/settings/ModelProviderSection.js";

describe("handleEndpointSuggestionPopoverOpenAutoFocus", () => {
  it("打开建议列表时会阻止焦点跳到下拉层，并保持输入框可继续输入", () => {
    const preventDefault = vi.fn();
    const focusInput = vi.fn();

    const handled = handleEndpointSuggestionPopoverOpenAutoFocus({
      keepInputFocus: true,
      preventDefault,
      focusInput,
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focusInput).toHaveBeenCalledTimes(1);
  });

  it("非输入框触发打开时不拦截默认焦点行为", () => {
    const preventDefault = vi.fn();
    const focusInput = vi.fn();

    const handled = handleEndpointSuggestionPopoverOpenAutoFocus({
      keepInputFocus: false,
      preventDefault,
      focusInput,
    });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focusInput).not.toHaveBeenCalled();
  });
});

describe("resolveEndpointSuggestionOpenRequest", () => {
  it("选择建议后会拦截下一次输入框触发的打开请求，避免列表关闭后立刻重开", () => {
    const result = resolveEndpointSuggestionOpenRequest({
      nowMs: 1000,
      suppressOpenUntilMs: 1100,
    });

    expect(result).toEqual({
      shouldOpen: false,
    });
  });

  it("普通输入框聚焦会允许打开建议列表", () => {
    const result = resolveEndpointSuggestionOpenRequest({
      nowMs: 1200,
      suppressOpenUntilMs: 1100,
    });

    expect(result).toEqual({
      shouldOpen: true,
    });
  });
});

describe("fuzzyMatch", () => {
  it("支持不连续字符匹配，bg 可以匹配 bigmodel", () => {
    expect(fuzzyMatch("https://open.bigmodel.cn/api/paas/v4/", "bg")).toBe(true);
  });

  it("不满足字符顺序时不匹配", () => {
    expect(fuzzyMatch("https://open.bigmodel.cn/api/paas/v4/", "gb")).toBe(false);
  });
});
