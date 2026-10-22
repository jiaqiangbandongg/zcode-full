// @vitest-environment jsdom
// 自动化页顶级标签「自动化 / 工作流」（docs/dynamic-workflow/launch.md「Where it lives」「标签记忆」）。
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_AUTOMATIONS_PAGE_TAB } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  AutomationsPageTitleSwitch,
  type AutomationsPageTab,
} from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";
import {
  readAutomationsPageTab,
  writeAutomationsPageTab,
} from "@/settings/saved-workflows/automationsPageTabMemory.js";

function Harness({ initial = "automation" }: { initial?: AutomationsPageTab }) {
  const [tab, setTab] = useState<AutomationsPageTab>(initial);
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(AutomationsPageTitleSwitch, { value: tab, onValueChange: setTab }),
  );
}

describe("AutomationsPageTitleSwitch", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("两个标题词是 tablist 里的 tab，选中态跟随 value", () => {
    render(createElement(Harness));
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["自动化", "工作流"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    // 只有选中项进 Tab 序；未选中项靠方向键。
    expect(tabs[0]?.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(screen.getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow")));
    expect(
      screen
        .getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("方向键在两个标签间循环切换", () => {
    render(createElement(Harness));
    const tablist = screen.getByRole("tablist");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(
      screen
        .getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(
      screen
        .getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "automation"))
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(
      screen
        .getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("automationsPageTabMemory", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("app 级单 key 记在 sessionStorage，不再按项目分桶；未知值回默认", () => {
    expect(readAutomationsPageTab()).toBe("automation");
    writeAutomationsPageTab("workflow");
    expect(readAutomationsPageTab()).toBe("workflow");
    // 只用一个 key，与活动项目无关。
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem("zcode-automations-page-tab")).toBe("workflow");
    sessionStorage.setItem("zcode-automations-page-tab", "bogus");
    expect(readAutomationsPageTab()).toBe("automation");
    writeAutomationsPageTab("automation");
    expect(readAutomationsPageTab()).toBe("automation");
    expect(sessionStorage.length).toBe(1);
  });
});
