// @vitest-environment jsdom
// 动态工作流灰度关掉之后的自动化页（docs/dynamic-workflow/launch.md「Gray release」DWG-07）：
// 灰度关闭时标题不提供工作流标签。
//
import { createElement, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_AUTOMATIONS_PAGE_TAB } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  AutomationsPageTitle,
  type AutomationsPageTab,
} from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";

function Title({
  workflowTabEnabled,
  locale = "zh-CN",
}: {
  workflowTabEnabled: boolean;
  locale?: "zh-CN" | "en-US";
}) {
  const [tab, setTab] = useState<AutomationsPageTab>("automation");
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(AutomationsPageTitle, {
      workflowTabEnabled,
      value: tab,
      onValueChange: setTab,
    }),
  );
}

describe("AutomationsPageTitle 灰度门", () => {
  afterEach(() => {
    cleanup();
  });

  it("灰度关 → 平铺的「自动化」标题，没有 tablist，也没有「工作流」这个词", () => {
    render(createElement(Title, { workflowTabEnabled: false }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))).toBeNull();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("自动化");
  });

  it("灰度关 + en-US → 标题走同一个 i18n key，不是硬编码中文", () => {
    render(createElement(Title, { workflowTabEnabled: false, locale: "en-US" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Automations");
  });

  it("灰度开 → 与改动前一致：两个标题词组成 tablist", () => {
    render(createElement(Title, { workflowTabEnabled: true }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["自动化", "工作流"]);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});
