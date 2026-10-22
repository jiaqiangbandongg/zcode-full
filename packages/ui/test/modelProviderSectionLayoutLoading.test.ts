import { createElement, type ReactNode } from "react";

import { describe, expect, it, vi } from "vitest";
import { shouldShowModelProviderRefreshLoading } from "@/settings/model-provider-section/SectionLayout.js";

vi.mock("@/settings/model-provider-section/Navigation.js", () => ({
  ModelProviderSectionNavigation: () => createElement("nav", null, "providers"),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

describe("model provider section refresh button loading", () => {
  it("preset 或 custom 分组加载中时，刷新按钮应显示 loading", () => {
    expect(
      shouldShowModelProviderRefreshLoading({
        presetLoading: true,
        customLoading: false,
      }),
    ).toBe(true);

    expect(
      shouldShowModelProviderRefreshLoading({
        presetLoading: false,
        customLoading: true,
      }),
    ).toBe(true);
  });

  it("全部分组都不在加载时，刷新按钮不显示 loading", () => {
    expect(
      shouldShowModelProviderRefreshLoading({
        presetLoading: false,
        customLoading: false,
      }),
    ).toBe(false);
  });
});
