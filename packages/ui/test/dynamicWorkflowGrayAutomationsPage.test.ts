// @vitest-environment jsdom
// 动态工作流灰度关掉之后的自动化页（docs/dynamic-workflow/launch.md「Gray release」DWG-07）：
// 只剩一个平铺的「自动化」标题，没有「工作流」标签，也不挂中枢。
//
// AutomationsSection 本体在本仓从不整棵渲染（依赖面太大），沿用 automationsSectionOffPeakTelemetry
// 与 automationsPageTabs 的做法：接线用源码契约钉，标题本身真渲染。
import { createElement, useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_AUTOMATIONS_PAGE_TAB, testId } from "@zcode/shared";
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

// jsdom 环境下 `new URL(…, import.meta.url)` 不是 file: URL；vitest 从仓库根运行，按 cwd 定位源码。
const source = readFileSync(
  resolve(process.cwd(), "packages/ui/src/settings/AutomationsSection.tsx"),
  "utf8",
).replaceAll("\r\n", "\n");

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
    // 沿用 Figma 30/34 页面标题层级——切换存在与否不该改变标题本身的视觉层级。
    expect(heading.className).toContain("text-[30px]");
    expect(heading.className).toContain("leading-[34px]");
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

describe("AutomationsSection 灰度接线", () => {
  it("从 hook 读灰度，标题按灰度渲染", () => {
    expect(source).toContain("useDynamicWorkflowAvailability");
    expect(source).toContain("workflowTabEnabled={dynamicWorkflowEnabled}");
  });

  it("灰度关时忽略 sessionStorage 记住的「工作流」：pageTab 由灰度收窄后再用", () => {
    // 记忆本身不清，灰度再开时仍然生效；这里只保证读出来的值被灰度收窄。
    expect(source).toContain("readAutomationsPageTab()");
    expect(source).toMatch(
      /const pageTab: AutomationsPageTab = dynamicWorkflowEnabled \? storedPageTab : "automation";/,
    );
  });

  it('灰度关时 openAutomationTab: "workflow" 落到「自动化」并消费掉深链', () => {
    expect(source).toMatch(
      /if \(openAutomationTab === "workflow" && !dynamicWorkflowEnabled\) \{[\s\S]*?setPageTab\("automation"\);\s*onOpenAutomationConsumed\?\.\(\);\s*return;/,
    );
  });

  it('中枢只在 pageTab === "workflow" 分支里挂载，而该值被灰度收窄过', () => {
    expect(source).toMatch(/if \(pageTab === "workflow"\) \{\s*return \(\s*<SavedWorkflowsSection/);
    // 只有这一处渲染中枢：灰度收窄 pageTab 就等于 SavedWorkflowsSection 永不挂载。
    expect(source.match(/<SavedWorkflowsSection/g)).toHaveLength(1);
  });
});
