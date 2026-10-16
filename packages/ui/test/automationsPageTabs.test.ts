// @vitest-environment jsdom
// 自动化页顶级标签「自动化 / 工作流」（docs/dynamic-workflow/launch.md「Where it lives」「标签记忆」）。
import { createElement, useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_AUTOMATIONS_PAGE_TAB, testId } from "@zcode/shared";
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

// jsdom 环境下 `new URL(…, import.meta.url)` 不是 file: URL；vitest 从仓库根运行，按 cwd 定位源码。
const automationsSectionSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/settings/AutomationsSection.tsx"),
  "utf8",
).replaceAll("\r\n", "\n");

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

  it("标题字号沿用原 h1 的 30/34 页面标题层级，未选中用次级色", () => {
    render(createElement(Harness));
    const active = screen.getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "automation"));
    const inactive = screen.getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"));
    expect(active.className).toContain("text-[30px]");
    expect(active.className).toContain("leading-[34px]");
    expect(active.className).toContain("text-foreground");
    expect(inactive.className).toContain("text-foreground-subtle");
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

describe("AutomationsSection 顶级标签接线", () => {
  it('页标题即切换，且 openAutomationTab: "workflow" 深链直接落到工作流页', () => {
    // 标题组件按灰度决定是切换还是平铺 h1（灰度断言在 dynamicWorkflowGrayAutomationsPage.test.ts）。
    expect(automationsSectionSource).toMatch(
      /<AutomationsPageTitle\s+workflowTabEnabled=\{dynamicWorkflowEnabled\}\s+value=\{pageTab\}\s+onValueChange=\{setPageTab\}\s*\/>/,
    );
    // 记忆已 app 级化：不再有 pageTabStorageKey，读写都无参 / 单参。
    expect(automationsSectionSource).not.toContain("pageTabStorageKey");
    expect(automationsSectionSource).toContain("readAutomationsPageTab()");
    expect(automationsSectionSource).toContain("writeAutomationsPageTab(next)");
    expect(automationsSectionSource).toMatch(
      /if \(openAutomationTab === "workflow"\) \{\s*setPageTab\("workflow"\);\s*onOpenAutomationConsumed\?\.\(\);\s*return;/,
    );
    // 定时任务 / 闲时任务的胶囊行留在「自动化」内部：工作流页整页交给 SavedWorkflowsSection。
    expect(automationsSectionSource).toMatch(
      /if \(pageTab === "workflow"\) \{\s*return \(\s*<SavedWorkflowsSection/,
    );
    // 深链 openWorkflow / 消费回调透传给 SavedWorkflowsSection（不变式 8 多项目视图）。
    expect(automationsSectionSource).toContain("openWorkflow={openWorkflow}");
    expect(automationsSectionSource).toContain("onOpenWorkflowConsumed={onOpenWorkflowConsumed}");
  });
});
