import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

/**
 * 读取仓库源码用于文本契约断言。
 *
 * Bugfix：下面断言里有跨行片段（`<AutomationCreateDropdown\n ...`），而仓库只对 *.mjs / *.sh
 * 声明了 `eol=lf`，其余源码在 `core.autocrlf=true` 的 Windows 检出里是 CRLF，`toContain`
 * 的 `\n` 匹配不到 `\r\n`，用例在 Windows 上必然失败。它想断言的是源码内容契约，
 * 与换行字节无关，统一归一成 LF 再比对。
 */
const automationsSectionSource = readFileSync(
  new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

describe("Automations populated-list Figma contract", () => {
  it("removes the All tab and its unified mixed grid", () => {
    // 规范出处：docs/off-peak-task/decisions.md D47（2026-07-28）——主视图只保留
    // Scheduled / Idle 两个 tab，All 混排总览及其统一 grid 删除；任务区锚点保留供布局断言使用。
    expect(automationsSectionSource).not.toContain('"all"');
    expect(automationsSectionSource).not.toContain("showUnifiedAllTaskGrid");
    expect(automationsSectionSource).toContain("data-automations-task-grid");
    expect(automationsSectionSource).toContain(
      '"grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2"',
    );
  });

  it("keeps the populated banner ahead of tasks with the Figma spacing", () => {
    const bannerStart = automationsSectionSource.indexOf("<AutomationKeepAwakeNotice");
    const gridStart = automationsSectionSource.indexOf("data-automations-task-grid");

    expect(bannerStart).toBeGreaterThanOrEqual(0);
    expect(gridStart).toBeGreaterThan(bannerStart);
    // D47：keep-awake 是全局开关，Scheduled / Idle 两个 tab 都展示；有任务时提示条与 action row 收紧到 20px。
    expect(automationsSectionSource).toMatch(/hasAnyTasks \? "mt-5" : "mt-8"/);
  });

  it("keeps inactive tabs transparent and shows the scheduled create split action only on its tab", () => {
    expect(automationsSectionSource).toContain(
      '"text-foreground-subtle hover:bg-hover hover:text-foreground"',
    );
    expect(automationsSectionSource).not.toContain(
      '"bg-surface text-foreground-subtle hover:bg-hover hover:text-foreground"',
    );
    expect(automationsSectionSource).toContain(
      "<AutomationCreateDropdown\n                onViaChat={handleCreateViaChat}",
    );
    expect(automationsSectionSource).not.toContain("appearance={");
  });

  it("keeps manual refresh immediately before the populated create action", () => {
    const refreshAction = automationsSectionSource.indexOf(
      'aria-label={intl.formatMessage({ id: "automations.refresh" })}',
    );
    const createAction = automationsSectionSource.indexOf(
      "<AutomationCreateDropdown\n                onViaChat={handleCreateViaChat}",
    );

    expect(refreshAction).toBeGreaterThanOrEqual(0);
    expect(createAction).toBeGreaterThan(refreshAction);
    expect(automationsSectionSource).toContain("refresh(zcodeAgentService)");
    expect(automationsSectionSource).toContain("offPeakRefresh(offPeakTaskService)");
    expect(automationsSectionSource).toMatch(
      /variant="outline"\s+size="icon"\s+aria-label=\{intl\.formatMessage\(\{ id: "automations\.refresh" \}\)\}/,
    );
  });

  it("keeps scheduled-task delete confirmation buttons text-only", () => {
    expect(automationsSectionSource).toMatch(
      /presentation: "automation-confirmation",[\s\S]*?id: "automations\.delete\.title"[\s\S]*?confirmVariant: "destructive",[\s\S]*?showKeyboardHints: false,/,
    );
  });

  it("labels scheduled-task toggle actions as pause and continue", () => {
    expect(zhCN["automations.pause"]).toBe("暂停");
    expect(zhCN["automations.resume"]).toBe("继续");
    expect(enUS["automations.pause"]).toBe("Pause");
    expect(enUS["automations.resume"]).toBe("Continue");
  });

  it("uses the dedicated idle-time delete confirmation action label", () => {
    expect(automationsSectionSource).toMatch(
      /id: "offPeak\.delete\.title"[\s\S]*?id: "offPeak\.delete\.description"[\s\S]*?id: "offPeak\.delete\.confirm"/,
    );
  });

  it("dims paused schedule time and run count to 40 percent opacity", () => {
    expect(automationsSectionSource).toContain("font-normal text-success opacity-40");
    expect(automationsSectionSource).toMatch(
      /\(hasFailure \|\| status === "paused"\) &&\s+"opacity-40"/,
    );
  });

  it("shows only the cumulative run count without a max-runs denominator", () => {
    expect(automationsSectionSource).toContain('{ id: "automations.runCount" }');
    expect(automationsSectionSource).not.toContain('{ id: "automations.runCountLimited" }');
  });

  it("does not expose retry queue details on scheduled task cards", () => {
    expect(automationsSectionSource).not.toContain('id: "automations.retryQueued"');
    expect(automationsSectionSource).not.toContain("hasAutomationRetryQueueState(automation)");
  });

  it("shows a cron summary for completed scheduled tasks", () => {
    expect(automationsSectionSource).toMatch(
      /status === "paused" \|\|\s+status === "completed" \? \(/,
    );
  });

  it("keeps completed cards dimmed without card hover styling", () => {
    expect(automationsSectionSource).toMatch(
      /status === "completed"\s+\?\s+"opacity-60"\s+:\s+"hover:bg-hover"/,
    );
    expect(automationsSectionSource).not.toContain("opacity-60 hover:opacity-100");
  });

  it("appends next-run time only for active non-failing cards", () => {
    expect(automationsSectionSource).toContain("`${scheduleText} · ${intl.formatMessage(");
    // 列表 grid 已嵌入筛选空态的三目分支，缩进会随结构变化；断言只关心调用形态。
    expect(automationsSectionSource).toMatch(
      /formatAutomationCardNextRun\(\s*automation\.nextRunAt/,
    );
    // completed/paused/失败态调度不再推进；有限次任务跑完后 nextRunAt 仍可能指向
    // 未来时刻，不能再拼进卡片文案。
    expect(automationsSectionSource).toContain(
      'status === "active" && !hasFailure && formattedNextRun',
    );
  });
});
