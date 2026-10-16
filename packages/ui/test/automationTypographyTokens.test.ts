import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 读取仓库源码用于文本契约断言。
 *
 * Bugfix：本文件的断言里有跨行片段（例如 `TOKEN =\n  "..."`），而仓库只对 *.mjs / *.sh
 * 声明了 `eol=lf`，其余源码在 `core.autocrlf=true` 的 Windows 检出里是 CRLF。
 * 直接 `toContain` 跨行片段时 `\n` 匹配不到 `\r\n`，用例在 Windows 上必然失败，
 * 而它想断言的其实是源码内容契约，与换行字节无关。统一归一成 LF 再比对。
 */
async function readSource(url: URL): Promise<string> {
  return (await readFile(url, "utf8")).replaceAll("\r\n", "\n");
}

const typographySurfaceFiles = [
  "AutomationDesignPrimitives.tsx",
  "AutomationEditView.tsx",
  "AutomationInstructionsComposer.tsx",
  "AutomationScheduleBadge.tsx",
  "AutomationSwitchToggle.tsx",
  "AutomationsSection.tsx",
  "OffPeakEditActionsMenu.tsx",
  "OffPeakEditView.tsx",
  "OffPeakHistoryTab.tsx",
  "OffPeakTaskList.tsx",
] as const;

const typographySurfaceSources = await Promise.all(
  typographySurfaceFiles.map(async (fileName) => ({
    fileName,
    source: await readSource(new URL(`../src/settings/${fileName}`, import.meta.url)),
  })),
);
const sourceByFile = new Map(
  typographySurfaceSources.map(({ fileName, source }) => [fileName, source]),
);
const chatEmptyStateSource = await readSource(
  new URL("../src/ChatEmptyState.tsx", import.meta.url),
);
const cronCreateRendererSource = await readSource(
  new URL("../src/ToolCallBlocks/renderers/cron-create.tsx", import.meta.url),
);
const chatInputDisplaySource = await readSource(
  new URL("../src/chat-input-toolbar/display.tsx", import.meta.url),
);

describe("automation typography tokens", () => {
  it.each(typographySurfaceSources)("$fileName 不再使用迁移范围内的旧字号", ({ source }) => {
    expect(source).not.toMatch(/text-ui-xs/);
    expect(source).not.toMatch(/text-\[(?:12|13|14|16)px\]/);
    expect(source).not.toMatch(/(?:^|\s)text-(?:base|sm|xs)(?=\s|["'`/])/m);
  });

  it("定时与闲时 Instructions 工具栏使用同一套 trigger 视觉", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const offPeakEditSource = sourceByFile.get("OffPeakEditView.tsx") ?? "";
    const automationToolbarSource = sourceByFile.get("AutomationInstructionsComposer.tsx") ?? "";

    expect(automationEditSource).toContain('containerClassName="contents"');
    expect(automationEditSource).toContain("AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME");
    expect(automationEditSource).toContain(
      '"w-fit max-w-72 min-w-0 shrink @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0"',
    );
    expect(offPeakEditSource).toContain('containerClassName="contents"');
    expect(offPeakEditSource).toContain("items-center gap-1 rounded-full px-2 text-ui-base");
    expect(automationToolbarSource).toContain(
      "h-7 rounded-full text-ui-base font-normal leading-5 text-foreground-subtle",
    );
    expect(automationToolbarSource).not.toContain(
      "leading-5 text-foreground hover:bg-surface-hover",
    );
    expect(automationToolbarSource).toContain("hover:bg-hover");
    expect(automationToolbarSource).toContain(
      "aria-expanded:bg-hover aria-expanded:text-foreground",
    );
    expect(offPeakEditSource).not.toContain("focus-within:bg-hover");
    expect(chatEmptyStateSource).toContain("containerClassName?: string");
    expect(chatEmptyStateSource).toContain("triggerClassName?: string");
  });

  it("定时任务模型与 Think 触发器复用会话 composer 的响应式构成", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const automationComposerSource = sourceByFile.get("AutomationInstructionsComposer.tsx") ?? "";

    expect(automationComposerSource).toContain("@container/composer");
    expect(automationEditSource).toContain(
      'labelVisibilityClassName="hidden @sm/composer:inline-flex"',
    );
    expect(automationEditSource).toContain('indicatorClassName="hidden @sm/composer:block"');
    expect(automationEditSource).toContain(
      'triggerIconClassName="inline-flex @sm/composer:hidden"',
    );
    expect(automationEditSource).toContain(
      'labelVisibilityClassName="hidden @xl/composer:inline-flex"',
    );
    expect(automationEditSource).toContain('indicatorClassName="hidden @xl/composer:block"');
    expect(automationEditSource).not.toContain('labelVisibilityClassName="inline-flex min-w-0"');
    expect(automationEditSource).toContain('id: "chat.toolbar.model.label"');
    expect(automationEditSource).not.toContain('contentAlign="end"');
  });

  it("首页卡片辅助文字与会话创建跳转按钮统一使用 text-ui-base", () => {
    const automationsSectionSource = sourceByFile.get("AutomationsSection.tsx") ?? "";

    expect(automationsSectionSource).toContain(
      "text-wrap-phrase line-clamp-2 flex-1 text-ui-base font-normal leading-5",
    );
    expect(cronCreateRendererSource).toContain(
      "px-3 py-1.5 text-ui-base text-foreground hover:bg-hover",
    );
    expect(cronCreateRendererSource).not.toContain("px-2.5 text-ui-xs text-foreground-subtle");
    expect(cronCreateRendererSource).not.toContain("ArrowRightIcon");
  });

  it("定时与闲时权限菜单直接复用首页 mode selector", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const offPeakEditSource = sourceByFile.get("OffPeakEditView.tsx") ?? "";

    for (const source of [automationEditSource, offPeakEditSource]) {
      expect(source).toContain("<ConfigSelect");
      expect(source).toContain("option={modeOption}");
      expect(source).toContain('triggerVariant="ghost"');
      expect(source).toContain('triggerSize="default"');
      expect(source).toContain('labelVisibilityClassName="inline-flex min-w-0 truncate text-left"');
      expect(source).toContain("provider={ZCODE_AGENT_PROVIDER}");
      expect(source).toContain("restoreFocusSelector={null}");
      expect(source).toContain("w-fit max-w-56 min-w-0 shrink justify-start gap-1 px-2");
    }
    expect(chatInputDisplaySource).toContain(
      'className: option.category === "mode" ? "w-64" : undefined',
    );
    expect(chatInputDisplaySource).toContain("min-h-13 items-start gap-3 py-2 pl-2 pr-8");
    expect(chatInputDisplaySource).toContain("truncate text-ui-base/relaxed text-foreground");
    expect(chatInputDisplaySource).toContain(
      "line-clamp-2 text-ui-sm/relaxed text-foreground-subtle whitespace-nowrap",
    );
    expect(offPeakEditSource).not.toContain("renderDescription={(value)");
    expect(automationEditSource).not.toContain("权限 trigger 曾固定 160px");
    // 闲时与定时任务共享 builder、provider 和会话权限词表，避免配置文案漂移。
    expect(offPeakEditSource).toContain("buildAutomationModeOption(mode)");
    expect(offPeakEditSource).not.toContain("offPeak.mode.");
    // 手写复刻已删除：两页都不再自行维护权限菜单结构与 warning 语义。
    expect(automationEditSource).not.toContain('mode === "yolo"');
    expect(offPeakEditSource).not.toContain('mode === "yolo"');
    expect(offPeakEditSource).not.toContain("OffPeakToolbarSelect");
  });

  it("定时与闲时详情通过面包屑返回并展示标题层级", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const offPeakEditSource = sourceByFile.get("OffPeakEditView.tsx") ?? "";
    expect(automationEditSource).toContain("<SettingsBreadcrumbReporter");
    expect(offPeakEditSource).toContain("<SettingsBreadcrumbReporter");
    expect(automationEditSource).toContain('data-testid="automation-edit-title"');
    expect(automationEditSource).toContain('data-testid="automation-edit-subtitle"');
    expect(automationEditSource).not.toContain("AUTOMATION_BACK_TRIGGER_CLASSNAME");
    expect(offPeakEditSource).not.toContain("AUTOMATION_BACK_TRIGGER_CLASSNAME");
  });

  it("定时与闲时字段标题到下方组件统一使用 6px flex 间距", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const offPeakEditSource = sourceByFile.get("OffPeakEditView.tsx") ?? "";
    const primitivesSource = sourceByFile.get("AutomationDesignPrimitives.tsx") ?? "";

    expect(primitivesSource).toContain('AUTOMATION_FORM_FIELD_CLASSNAME = "flex flex-col gap-1.5"');
    expect(
      automationEditSource.match(/className=\{AUTOMATION_FORM_FIELD_CLASSNAME\}/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(5);
    // 修复原因：45a0078032（会话内创建闲时任务）新增了条件渲染的「绑定会话」字段，
    // 表单字段从 2 个变为 3 个（绑定会话 / 任务标题 / 任务指令），旧断言未同步导致 staging 红测。
    expect(
      offPeakEditSource.match(/className=\{AUTOMATION_FORM_FIELD_CLASSNAME\}/g)?.length ?? 0,
    ).toBe(3);
  });

  it("定时与闲时设置页的输入内容统一使用 14px UI 字号", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const offPeakEditSource = sourceByFile.get("OffPeakEditView.tsx") ?? "";
    const instructionsSource = sourceByFile.get("AutomationInstructionsComposer.tsx") ?? "";

    // 只校验常量取值，不绑定换行格式；格式化工具可能把声明折到一行。
    expect(instructionsSource).toMatch(
      /AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME =\s*"text-ui-base leading-5"/,
    );
    expect(instructionsSource).toContain("AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,");
    expect(automationEditSource).toContain("AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME");
    expect(offPeakEditSource).toContain("AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME");
    expect(automationEditSource).not.toContain("gap-1 text-ui-sm text-foreground-subtle");
    expect(automationEditSource).not.toMatch(/w-(?:14|16).*text-ui-sm tabular-nums/);
  });

  it("闲时任务无人值守提示使用中性圆形图标与 14px UI 字号", () => {
    const offPeakEditSource = sourceByFile.get("OffPeakEditView.tsx") ?? "";

    expect(offPeakEditSource).toContain(
      "items-start gap-1.5 text-ui-base leading-5 text-foreground-subtle",
    );
    expect(offPeakEditSource).toContain('<AutomationInfoIcon className="size-4" />');
    expect(offPeakEditSource).not.toContain("TriangleAlert");
  });

  it("会话创建任务在编辑页展示只读调度摘要", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    expect(automationEditSource).toContain("preserveSessionCreatedSchedule");
    expect(automationEditSource).toContain(
      'intl.formatMessage({ id: "automations.frequency.custom" })',
    );
    expect(automationEditSource).toMatch(
      /preserveSessionCreatedSchedule\s*\? \{\}\s*: \{ scheduleRule: currentScheduleRule \?\? null \}/u,
    );
  });

  it("未保存返回弹窗复用 Automation confirmation presentation", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const offPeakEditSource = sourceByFile.get("OffPeakEditView.tsx") ?? "";

    expect(automationEditSource).toContain('presentation: "automation-confirmation"');
    expect(offPeakEditSource).toContain('presentation: "automation-confirmation"');
    expect(automationEditSource).not.toContain(
      'className="w-[min(352px,calc(100vw-2rem))] max-w-none gap-4"',
    );
  });

  it("完全访问模式复用会话 composer 的 warning 强调色", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const offPeakEditSource = sourceByFile.get("OffPeakEditView.tsx") ?? "";

    expect(automationEditSource).toContain("<ConfigSelect");
    expect(offPeakEditSource).toContain("<ConfigSelect");
    expect(chatInputDisplaySource).toContain("isHighPermissionModeValue(option.currentValue)");
    expect(chatInputDisplaySource).toContain(
      "text-warning hover:text-warning aria-expanded:text-warning",
    );
  });

  it("全部调度频率都通过同一非透明语义背景展示选中值", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const triggerStart = automationEditSource.indexOf(
      "data-testid={TID_AUTOMATION_FREQUENCY_SELECT}",
    );
    const triggerEnd = automationEditSource.indexOf("</SelectTrigger>", triggerStart);
    const frequencyTriggerSource = automationEditSource.slice(triggerStart, triggerEnd);

    expect(triggerStart).toBeGreaterThanOrEqual(0);
    expect(frequencyTriggerSource).toContain("bg-hover");
    expect(frequencyTriggerSource).not.toContain("bg-tag");
    expect(frequencyTriggerSource).toContain("h-auto");
    expect(frequencyTriggerSource).toContain("py-px");
    expect(frequencyTriggerSource).toContain("rounded-full");
    expect(frequencyTriggerSource).toContain("border-0");
    expect(frequencyTriggerSource).toContain("hover:bg-selected");
    expect(frequencyTriggerSource).not.toContain("bg-[#363636]");
    expect(frequencyTriggerSource).not.toContain("bg-[#404040]");
    expect(frequencyTriggerSource).not.toContain("bg-transparent");
  });

  it("状态胶囊使用 32px 高度和 20px frame 内的 6px 圆点", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const statusStart = automationEditSource.indexOf("{editStatus ? (");
    const statusEnd = automationEditSource.indexOf("{/* Task title */}", statusStart);
    const statusSource = automationEditSource.slice(statusStart, statusEnd);

    expect(statusSource).toContain("inline-flex h-8 max-w-full items-center gap-1");
    expect(statusSource).toContain("flex size-5 shrink-0 items-center justify-center");
    expect(statusSource).toContain('"size-1.5 shrink-0 rounded-full"');
    expect(statusSource).not.toContain("inline-flex h-9");
    expect(statusSource).not.toContain('"size-2 shrink-0 rounded-full"');
  });

  it("调度 tag 之间的连接词与 tag 内文字使用同一主文字样式", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const scheduleStart = automationEditSource.indexOf("调度栏原先使用 min-height");
    const scheduleEnd = automationEditSource.indexOf("<CustomRepeatDialog", scheduleStart);
    const scheduleSource = automationEditSource.slice(scheduleStart, scheduleEnd);

    expect(scheduleSource).toMatch(
      /<span className="text-foreground">\s*\{intl\.formatMessage\(\{\s*id: "automations\.form\.schedule\.at"/,
    );
    expect(scheduleSource).toContain(
      "flex items-center gap-1 text-ui-base leading-5 text-foreground",
    );
    expect(scheduleSource).not.toMatch(
      /<span className="text-foreground-subtle">\s*\{intl\.formatMessage\(\{\s*id: "automations\.form\.schedule\.at"/,
    );

    const weekdayPickerStart = automationEditSource.indexOf("function WeekdayPicker");
    const weekdayPickerEnd = automationEditSource.indexOf(
      "function toDateInputValue",
      weekdayPickerStart,
    );
    const weekdayPickerSource = automationEditSource.slice(weekdayPickerStart, weekdayPickerEnd);

    expect(weekdayPickerStart).toBeGreaterThanOrEqual(0);
    expect(weekdayPickerSource).toContain("text-ui-base leading-5 text-foreground");
    expect(weekdayPickerSource).not.toContain("text-[#F8F8F8]");

    const weekdayOptionStart = weekdayPickerSource.indexOf(
      'className="flex h-7 w-full items-center',
    );
    const weekdayOptionEnd = weekdayPickerSource.indexOf("</button>", weekdayOptionStart);
    const weekdayOptionSource = weekdayPickerSource.slice(weekdayOptionStart, weekdayOptionEnd);
    const weekdayLabelPosition = weekdayOptionSource.indexOf('className="min-w-0 flex-1 truncate"');
    const weekdayCheckPosition = weekdayOptionSource.indexOf(
      'className="flex size-4 shrink-0 items-center justify-center"',
    );

    expect(weekdayOptionStart).toBeGreaterThanOrEqual(0);
    expect(weekdayLabelPosition).toBeGreaterThanOrEqual(0);
    expect(weekdayCheckPosition).toBeGreaterThan(weekdayLabelPosition);
  });

  it("添加计划菜单在明暗主题都使用语义 hover 背景", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const addScheduleStart = automationEditSource.indexOf(
      "data-testid={TID_AUTOMATION_SCHEDULE_ADD}",
    );
    const addScheduleEnd = automationEditSource.indexOf(") : (", addScheduleStart);
    const addScheduleSource = automationEditSource.slice(addScheduleStart, addScheduleEnd);

    expect(addScheduleStart).toBeGreaterThanOrEqual(0);
    expect(addScheduleSource).toContain("data-[highlighted]:bg-menu-hover");
    expect(addScheduleSource).not.toContain("data-[highlighted]:bg-white/5");
  });

  it("自定义调度的频率、重复周期和时间 tag 共用 text/primary", () => {
    const automationEditSource = sourceByFile.get("AutomationEditView.tsx") ?? "";
    const customScheduleStart = automationEditSource.indexOf('{builder.frequency === "custom" ? (');
    const customScheduleEnd = automationEditSource.indexOf(
      '{builder.frequency !== "custom"',
      customScheduleStart,
    );
    const customScheduleSource = automationEditSource.slice(customScheduleStart, customScheduleEnd);
    const timePickerStart = automationEditSource.indexOf("function TimeOfDayPicker");
    const timePickerEnd = automationEditSource.indexOf("/** 月/日单列滚动列表", timePickerStart);
    const timePickerSource = automationEditSource.slice(timePickerStart, timePickerEnd);
    const timeUnitStart = automationEditSource.indexOf("function TimeUnitColumn");
    const timeUnitSource = automationEditSource.slice(timeUnitStart, timePickerStart);

    expect(automationEditSource).toContain(
      "rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 text-foreground",
    );
    expect(customScheduleSource).toContain("rounded-full bg-hover py-px");
    expect(customScheduleSource).toContain("text-ui-base leading-5 text-foreground");
    expect(customScheduleSource).not.toContain("rounded-[8px]");
    expect(customScheduleSource).not.toContain("text-[#F8F8F8]");
    expect(timePickerSource).toContain("rounded-full bg-hover py-px");
    expect(timePickerSource).not.toContain("bg-tag");
    expect(timePickerSource).toContain("text-ui-base leading-5 tabular-nums text-foreground");
    expect(timeUnitSource).toContain('? "bg-menu-hover text-foreground"');
    expect(timeUnitSource).toContain(
      '"text-foreground-subtle hover:bg-menu-hover hover:text-foreground"',
    );
    expect(timeUnitSource).not.toContain('? "bg-primary text-primary-foreground"');
    expect(automationEditSource).not.toContain("bg-[#363636]");
    expect(automationEditSource).not.toContain("bg-[#404040]");
    expect(automationEditSource).not.toContain("text-[#F8F8F8]");
    expect(timePickerSource).not.toContain("rounded-md");
  });
});
