import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 读取仓库源码用于文本契约断言。
 *
 * Bugfix：本文件的断言里有跨行片段（例如 `const hasPrimaryMenuAction =\n ...`），而仓库
 * 只对 *.mjs / *.sh 声明了 `eol=lf`，其余源码在 `core.autocrlf=true` 的 Windows 检出里是
 * CRLF。直接 `toContain` 跨行片段时 `\n` 匹配不到 `\r\n`，用例在 Windows 上必然失败，
 * 而它想断言的其实是源码内容契约，与换行字节无关。统一归一成 LF 再比对。
 */
function readSource(url: URL): string {
  return readFileSync(url, "utf8").replaceAll("\r\n", "\n");
}

const automationsSectionSource = readSource(
  new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
);
const automationEditViewSource = readSource(
  new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
);
const confirmDialogSource = readSource(new URL("../src/ConfirmDialog.tsx", import.meta.url));
const automationConfirmDialogPresentationSource = readSource(
  new URL("../src/settings/automationConfirmDialogPresentation.ts", import.meta.url),
);
const buttonSource = readSource(new URL("../src/components/ui/button.tsx", import.meta.url));
const stylesSource = readSource(new URL("../src/styles.css", import.meta.url));
const automationPrimitivesSource = readSource(
  new URL("../src/settings/AutomationDesignPrimitives.tsx", import.meta.url),
);
const settingsSegmentedTabsSource = readSource(
  new URL("../src/settings/SettingsSegmentedTabs.tsx", import.meta.url),
);
const automationIconsSource = readSource(
  new URL("../src/settings/AutomationIcons.tsx", import.meta.url),
);
const instructionsComposerUrl = new URL(
  "../src/settings/AutomationInstructionsComposer.tsx",
  import.meta.url,
);
const instructionsComposerSource = existsSync(instructionsComposerUrl)
  ? readSource(instructionsComposerUrl)
  : "";
const editViewSource = readSource(new URL("../src/settings/OffPeakEditView.tsx", import.meta.url));
const automationSwitchSource = readSource(
  new URL("../src/settings/AutomationSwitchToggle.tsx", import.meta.url),
);
const historyTabSource = readSource(
  new URL("../src/settings/OffPeakHistoryTab.tsx", import.meta.url),
);
const offPeakTaskListSource = readSource(
  new URL("../src/settings/OffPeakTaskList.tsx", import.meta.url),
);
const offPeakUiPresentationSource = readSource(
  new URL("../src/settings/offPeakUiPresentation.ts", import.meta.url),
);
const offPeakNewTaskEntrySource = readSource(
  new URL("../src/v4/OffPeakNewTaskEntry.tsx", import.meta.url),
);
const chatInputDisplaySource = readSource(
  new URL("../src/chat-input-toolbar/display.tsx", import.meta.url),
);
const sessionPaneSource = readSource(new URL("../src/v4/SessionPane.tsx", import.meta.url));

describe("idle-time task Figma layout contracts", () => {
  it("keeps the footer status badge unshrinkable so a long bound-session title cannot clip it", () => {
    // Bug 回归：状态徽章与「运行会话：…」同为 min-w-0 时，长会话标题会把「失败」压到只剩一个字。
    expect(offPeakTaskListSource).toContain(
      '"flex w-fit shrink-0 items-center gap-0.5 font-normal"',
    );
    expect(offPeakTaskListSource).not.toContain(
      '"flex w-fit min-w-0 items-center gap-0.5 font-normal"',
    );
    expect(offPeakTaskListSource).toContain(
      'className="ml-auto min-w-0 truncate text-foreground-subtle"',
    );
  });

  it("scrolls the idle-time task grid with the same threshold and classes as scheduled tasks", () => {
    expect(offPeakTaskListSource).toContain("export const OFFPEAK_LIST_SCROLL_THRESHOLD = 8;");
    expect(offPeakTaskListSource).toContain("sorted.length > OFFPEAK_LIST_SCROLL_THRESHOLD &&");
    expect(offPeakTaskListSource).toContain(
      '"max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]"',
    );
    expect(automationsSectionSource).toContain(
      '"max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]"',
    );
  });

  it("keeps the idle-time create and edit page title hierarchy aligned with scheduled tasks", () => {
    expect(editViewSource).toContain('data-testid="offpeak-edit-title"');
    expect(editViewSource).toContain('className="text-ui-xl font-semibold text-foreground"');
    expect(editViewSource).toContain('data-testid="offpeak-edit-subtitle"');
    expect(editViewSource).toContain('className="text-ui-base text-foreground-subtle"');
    expect(editViewSource).toContain('id: editing ? "offPeak.edit.title" : "offPeak.create.title"');
    expect(editViewSource).toContain(
      'id: editing ? "offPeak.edit.subtitle" : "offPeak.create.subtitle"',
    );
  });

  it("keeps the idle-time entry component available without mounting it on the draft homepage", () => {
    const dockStart = sessionPaneSource.indexOf(
      "const conversationBottomDockContent = readOnly ? null :",
    );
    const dockEnd = sessionPaneSource.indexOf("\n  );\n", dockStart);
    const dockSource = sessionPaneSource.slice(dockStart, dockEnd);

    expect(dockStart).toBeGreaterThanOrEqual(0);
    // 首页入口暂时下线；组件与布局契约继续保留备用。
    expect(dockSource).not.toContain("<OffPeakNewTaskEntry");
    expect(dockSource).toContain("<ConversationDraftSuggestedPromptsContainer");
    expect(sessionPaneSource).not.toContain(
      'import { OffPeakNewTaskEntry } from "@/v4/OffPeakNewTaskEntry.js"',
    );
    expect(sessionPaneSource).not.toContain("<OffPeakNewTaskEntry");
    expect(dockSource).toContain("isWebRemoteControl={compactForRemoteControl}");

    expect(offPeakNewTaskEntrySource).toContain("max-w-[780px]");
    expect(offPeakNewTaskEntrySource).toContain("pb-[38px]");
    expect(offPeakNewTaskEntrySource).toContain("sm:grid-cols-3");
    expect(offPeakNewTaskEntrySource).toContain("data-off-peak-template-grid");
    expect(offPeakNewTaskEntrySource).not.toContain("data-off-peak-carousel-dot");
    expect(offPeakNewTaskEntrySource).not.toContain("CarouselContent");
    expect(offPeakNewTaskEntrySource).not.toContain("@min-[820px]/conversation:-mx-[54px]");
  });

  it("keeps the main tabs 8px apart and trailing actions 12px apart", () => {
    const actionRowStart = automationsSectionSource.indexOf("Tab：Scheduled");
    const actionRowEnd = automationsSectionSource.indexOf("{loading &&", actionRowStart);
    const actionRowSource = automationsSectionSource.slice(actionRowStart, actionRowEnd);

    expect(actionRowStart).toBeGreaterThanOrEqual(0);
    expect(actionRowSource.match(/className="flex items-center gap-2"/g)).toHaveLength(1);
    expect(actionRowSource.match(/className="flex items-center gap-3"/g)).toHaveLength(1);
  });

  it("keeps inactive main tabs transparent until hover", () => {
    const actionRowStart = automationsSectionSource.indexOf("Tab：Scheduled");
    const actionRowEnd = automationsSectionSource.indexOf("{loading &&", actionRowStart);
    const actionRowSource = automationsSectionSource.slice(actionRowStart, actionRowEnd);

    expect(actionRowSource).toContain(
      'tab === key\n                    ? "bg-selected text-foreground"',
    );
    expect(actionRowSource).toContain(
      '"text-foreground-subtle hover:bg-hover hover:text-foreground"',
    );
    expect(actionRowSource).not.toContain('"bg-surface text-foreground-subtle');
  });

  it("keeps action-row labels at 14px and the idle create button text-only", () => {
    const actionRowStart = automationsSectionSource.indexOf("Tab：Scheduled");
    const actionRowEnd = automationsSectionSource.indexOf("{loading &&", actionRowStart);
    const actionRowSource = automationsSectionSource.slice(actionRowStart, actionRowEnd);
    const idleButtonStart = automationsSectionSource.indexOf("function OffPeakCreateButton");
    const idleButtonEnd = automationsSectionSource.indexOf(
      "/** 创建表单的预填草稿",
      idleButtonStart,
    );
    const idleButtonSource = automationsSectionSource.slice(idleButtonStart, idleButtonEnd);

    expect(actionRowSource).toContain(
      '"rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"',
    );
    expect(settingsSegmentedTabsSource).toContain("px-2.5 text-ui-base font-medium");
    expect(idleButtonSource).toContain('variant="default"');
    expect(idleButtonSource).toContain('size="default"');
    expect(actionRowSource).toContain("font-medium");
    expect(idleButtonSource).not.toContain("<Lock");
    expect(idleButtonSource).not.toContain("<AutomationIdleTimeIcon");
    expect(idleButtonSource).toMatch(
      /<Button[\s\S]*?variant="default"[\s\S]*?size="default"[\s\S]*?onClick=\{onCreate\}\s*>/,
    );
    expect(idleButtonSource).toMatch(/<Button(?:(?!className=)[\s\S])*?onClick=\{onCreate\}\s*>/);
  });

  it("uses the shared default large button for idle-time detail creation without class overrides", () => {
    const createButtonStart = editViewSource.indexOf("const createSubmitButton");
    const createButtonEnd = editViewSource.indexOf("return (", createButtonStart);
    const createButtonSource = editViewSource.slice(createButtonStart, createButtonEnd);

    expect(createButtonSource).toMatch(
      /<Button[\s\S]*?variant="default"[\s\S]*?size="lg"[\s\S]*?onClick=\{\(\) => void handleSubmit\(\)\}\s*>/,
    );
    expect(createButtonSource).not.toContain("className=");
  });

  it("uses the shared default large button for scheduled detail creation without class overrides", () => {
    const createButtonStart = automationEditViewSource.indexOf(") : showCreateSettingsAction ? (");
    const createButtonEnd = automationEditViewSource.indexOf(") : null}", createButtonStart);
    const createButtonSource = automationEditViewSource.slice(createButtonStart, createButtonEnd);

    expect(createButtonSource).toMatch(
      /<Button[\s\S]*?variant="default"[\s\S]*?size="lg"[\s\S]*?data-testid=\{TID_AUTOMATION_FORM_SUBMIT\}/,
    );
    expect(createButtonSource).not.toContain("className=");
  });

  it("wraps idle create-block reasons within a shared 220px tooltip", () => {
    expect(offPeakUiPresentationSource).toContain(
      "max-w-[220px] [&>span]:break-words [&>span]:whitespace-normal [&>span]:text-wrap-pretty",
    );
    expect(automationsSectionSource).toContain("className={OFF_PEAK_CREATE_TOOLTIP_CLASSNAME}");
    expect(editViewSource).toContain("className={OFF_PEAK_CREATE_TOOLTIP_CLASSNAME}");
  });

  it("uses the homepage card border token for automation cards and empty states", () => {
    expect(offPeakNewTaskEntrySource).toContain(
      "rounded-2xl border border-card-border bg-background",
    );
    expect(automationsSectionSource).toContain(
      "rounded-xl border border-card-border bg-background",
    );
    expect(automationsSectionSource).toContain(
      "rounded-2xl border border-card-border bg-background",
    );
    expect(offPeakTaskListSource).toContain("rounded-[10px] border border-card-border");
    expect(automationsSectionSource).not.toContain(
      "rounded-xl border border-surface bg-background",
    );
    expect(offPeakTaskListSource).not.toContain("shadow-[inset_0_0_0_1px_var(--color-surface)]");
  });

  it("uses Client Scenes Lucide names with Moon as the homepage fallback", () => {
    expect(offPeakNewTaskEntrySource).toContain(
      'import { Megaphone, Moon, X } from "lucide-react"',
    );
    expect(offPeakNewTaskEntrySource).toContain("<ClientSceneLucideIcon");
    expect(offPeakNewTaskEntrySource).toContain("name={template.iconName}");
    expect(offPeakNewTaskEntrySource).toContain('data-off-peak-homepage-template-icon="moon"');
    expect(offPeakNewTaskEntrySource).toContain("size={16}");
    expect(offPeakNewTaskEntrySource).toContain("strokeWidth={2}");
    expect(offPeakNewTaskEntrySource).not.toContain("<OffPeakTemplateIcon");
  });

  it("keeps the keep-awake notice at 10px radius with 12px content insets", () => {
    const noticeStart = automationPrimitivesSource.indexOf(
      "export function AutomationKeepAwakeNotice",
    );
    const noticeEnd = automationPrimitivesSource.indexOf(
      "export function AutomationCreateDropdown",
      noticeStart,
    );
    const noticeSource = automationPrimitivesSource.slice(noticeStart, noticeEnd);

    expect(noticeStart).toBeGreaterThanOrEqual(0);
    expect(noticeSource).toContain("rounded-[10px]");
    expect(noticeSource).toContain("px-3 py-3");
    expect(noticeSource).not.toContain("sm:py-0");
  });

  it("uses the Changes Summary Open structure for the scheduled create split action", () => {
    const createStart = automationPrimitivesSource.indexOf(
      "export function AutomationCreateDropdown",
    );
    const createSource = automationPrimitivesSource.slice(createStart);

    expect(createSource).toMatch(
      /<DropdownMenu>\s*<div[\s\S]*?<Button[\s\S]*?<DropdownMenuTrigger asChild>/,
    );
    expect(createSource).toContain('variant="default"');
    expect(createSource).toContain('className="inline-flex h-7');
    expect(createSource).toContain(
      'className="inline-flex h-7 items-center overflow-hidden rounded-lg"',
    );
    expect(createSource).not.toContain("border border-transparent bg-primary");
    expect(createSource).toContain('size="default"');
    expect(createSource).toContain('size="icon-md"');
    expect(createSource).not.toContain('className="h-4 w-px"');
    expect(createSource).not.toContain("alignOffset={-64}");
    expect(createSource).toContain('align="end"');
  });

  it("keeps the action row and keep-awake notice 20px apart", () => {
    const contentStart = automationsSectionSource.indexOf('"flex flex-col gap-8"');
    const contentEnd = automationsSectionSource.indexOf(
      '<div className="flex w-full flex-col gap-4">',
      contentStart,
    );
    const contentSource = automationsSectionSource.slice(contentStart, contentEnd);

    expect(contentStart).toBeGreaterThanOrEqual(0);
    expect(contentSource).toContain('? "mt-5"');
    expect(contentSource).not.toContain('? "mt-4"');
  });

  it("separates visible task cards and templates with the Figma divider rhythm", () => {
    const separatorStart = automationsSectionSource.indexOf("真实任务卡与模板此前只靠空白分区");
    const separatorEnd = automationsSectionSource.indexOf(
      "Idle-time task template",
      separatorStart,
    );
    const separatorSource = automationsSectionSource.slice(separatorStart, separatorEnd);

    expect(separatorStart).toBeGreaterThanOrEqual(0);
    expect(automationsSectionSource).toContain("hasVisibleTaskCards && hasVisibleTemplates");
    expect(separatorSource).toContain("{showTaskTemplateSeparator ? (");
    expect(separatorSource).toContain("data-automations-task-template-separator");
    expect(separatorSource).toContain('className="flex w-full flex-col py-2"');
    expect(separatorSource).toContain('className="h-px w-full bg-card-border"');
    expect(separatorSource).not.toContain('className="h-px w-full bg-surface"');
  });

  it("stretches idle-time template cards to the tallest card in each desktop grid row", () => {
    const templateStart = automationsSectionSource.indexOf("data-automations-idle-templates");
    const templateEnd = automationsSectionSource.indexOf("</section>", templateStart);
    const templateSource = automationsSectionSource.slice(templateStart, templateEnd);

    expect(templateStart).toBeGreaterThanOrEqual(0);
    expect(templateSource).toContain('className="flex h-full min-h-[114px] w-full flex-col');
  });

  it("keeps the detail breadcrumb and keep-awake control above the tabs", () => {
    expect(editViewSource).toContain("<SettingsBreadcrumbReporter");
    expect(editViewSource).toContain("flex min-w-0 flex-wrap items-center gap-4 sm:flex-nowrap");
    expect(editViewSource).toContain("<AutomationSwitchToggle");
    expect(editViewSource.indexOf("<SettingsBreadcrumbReporter")).toBeLessThan(
      editViewSource.indexOf("<AutomationSettingsHistoryTabs"),
    );
  });

  it("uses the shared Input border states for the idle-time title field", () => {
    expect(editViewSource).toContain(
      '"h-9 rounded-lg bg-card px-2 text-foreground hover:bg-surface-hover focus-visible:bg-card"',
    );
    expect(editViewSource).not.toContain("rounded-lg border-transparent bg-card px-2");
  });

  it("adds 4px above the idle-time unattended note", () => {
    expect(editViewSource).toContain(
      'className="mt-1 flex items-start gap-1.5 text-ui-base leading-5 text-foreground-subtle"',
    );
  });

  it("uses breadcrumb navigation and keeps the switch interactive on hover", () => {
    expect(editViewSource).toContain("<SettingsBreadcrumbReporter");
    expect(automationEditViewSource).toContain("<SettingsBreadcrumbReporter");
    expect(editViewSource).not.toContain("AUTOMATION_BACK_TRIGGER_CLASSNAME");
    expect(automationEditViewSource).not.toContain("AUTOMATION_BACK_TRIGGER_CLASSNAME");
    expect(automationSwitchSource).toContain("hover:ring-2 hover:ring-border-hover");
  });

  it("keeps localized idle template descriptions on natural phrase boundaries", () => {
    expect(stylesSource).toContain(".text-wrap-phrase");
    expect(stylesSource).toContain("line-break: strict");
    expect(stylesSource).toContain("text-wrap: pretty");
    expect(stylesSource).toContain("@supports (word-break: auto-phrase)");
    expect(stylesSource).toContain("word-break: auto-phrase");
    expect(automationsSectionSource).toContain("text-wrap-phrase line-clamp-2");
  });

  it("removes the page-local back icon and keeps the create action text only", () => {
    expect(editViewSource).not.toMatch(/import\s+\{[^}]*ArrowLeft[^}]*\}\s+from\s+"lucide-react"/s);
    expect(editViewSource).not.toContain("<ArrowLeft");
    expect(editViewSource).not.toContain("<Play");
    expect(editViewSource).not.toMatch(/import\s+\{[^}]*\bPlay\b[^}]*\}\s+from\s+"lucide-react"/s);
    expect(automationEditViewSource).not.toContain("<Play");
    expect(automationEditViewSource).not.toMatch(
      /import\s+\{[^}]*\bPlay\b[^}]*\}\s+from\s+"lucide-react"/s,
    );
    expect(editViewSource).not.toContain("<OffPeakFigmaAssetIcon");
    expect(editViewSource).not.toContain("@/assets/off-peak-");
    expect(editViewSource).not.toContain("maskImage");
  });

  it("anchors the 160px history menu from the trigger start and preserves its 89px stack", () => {
    const menuStart = historyTabSource.indexOf("旧版按触发器右缘对齐");
    const menuEnd = historyTabSource.indexOf("</DropdownMenuContent>", menuStart);
    const menuSource = historyTabSource.slice(menuStart, menuEnd);

    expect(menuStart).toBeGreaterThanOrEqual(0);
    expect(menuSource).toContain('align="start"');
    expect(menuSource).toContain("alignOffset={-10}");
    expect(menuSource).toContain("sideOffset={4}");
    expect(menuSource).toContain("collisionPadding={8}");
    expect(menuSource).toContain("w-[160px]");
    expect(menuSource).toContain("gap-0.5");
    expect(menuSource).toContain("py-1.5");
    expect(menuSource).toContain("<DropdownMenuSeparator");
    expect(menuSource.match(/min-h-9/g)).toHaveLength(2);
  });

  it("keeps the shared empty history state rounded-xl with a dashed border", () => {
    const emptyStart = historyTabSource.indexOf("if (!task?.startedAt");
    const emptyEnd = historyTabSource.indexOf(
      "const status = resolveOffPeakHistoryStatus",
      emptyStart,
    );
    const emptyStateSource = historyTabSource.slice(emptyStart, emptyEnd);

    expect(emptyStart).toBeGreaterThanOrEqual(0);
    expect(emptyStateSource).toContain("<AutomationHistoryEmptyState>");
    expect(automationEditViewSource).toContain("<AutomationHistoryEmptyState>");
    expect(automationPrimitivesSource).toContain("min-h-[226px]");
    expect(automationPrimitivesSource).toContain("border-card-border");
    expect(automationPrimitivesSource).toContain("rounded-xl");
    expect(automationPrimitivesSource).toContain("border-dashed");
    expect(automationPrimitivesSource).toContain("bg-background");
    expect(automationPrimitivesSource).toContain("text-center text-ui-base text-foreground-subtle");
    expect(automationPrimitivesSource).not.toContain(
      "min-h-[226px] items-center justify-center rounded-lg border border-card-border bg-card",
    );
    expect(automationPrimitivesSource).not.toContain(
      "min-h-[226px] items-center justify-center rounded-lg border border-card-border bg-surface",
    );
  });

  it("does not repeat the awake-only hint above scheduled history", () => {
    expect(automationEditViewSource).not.toContain('id: "automations.runs.awakeHint"');
  });

  it("omits the separator when an idle task menu only contains delete", () => {
    // 修复原因：源码契约只关心状态集合，不能让格式化产生的缩进变化误报产品回归。
    expect(offPeakTaskListSource).toMatch(
      /const hasPrimaryMenuAction =\s*task\.status === "queued" \|\|\s*task\.status === "paused" \|\|\s*task\.status === "running";/,
    );
    expect(offPeakTaskListSource).toContain(
      "{hasPrimaryMenuAction ? <DropdownMenuSeparator /> : null}",
    );
    expect(offPeakTaskListSource).not.toContain(
      "\n                  <DropdownMenuSeparator />\n                  <DropdownMenuItem",
    );
  });

  it("shares a five-to-seven-line auto-sizing Instructions composer across scheduled and idle forms", () => {
    expect(instructionsComposerSource).toContain(
      "flex min-h-39 flex-col overflow-hidden rounded-xl border-0 bg-surface",
    );
    expect(instructionsComposerSource).toContain("border border-input-border bg-input");
    expect(instructionsComposerSource).toContain("h-29 min-h-29 max-h-39");
    expect(instructionsComposerSource).toContain("AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX = 116");
    expect(instructionsComposerSource).toContain("AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX = 156");
    expect(instructionsComposerSource).toContain(
      "textarea.style.height = `${AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX}px`",
    );
    expect(instructionsComposerSource).toContain(
      'contentHeight > AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX ? "auto" : "hidden"',
    );
    expect(instructionsComposerSource).toContain("max-h-39 shrink-0 resize-none");
    expect(instructionsComposerSource).toContain("bg-input p-3 text-foreground");
    expect(instructionsComposerSource).toContain("AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME");
    expect(instructionsComposerSource).toContain(
      "flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-0 p-1.5 sm:h-10 sm:flex-nowrap",
    );
    expect(automationEditViewSource).toContain("<AutomationInstructionsComposer");
    expect(editViewSource).toContain("<AutomationInstructionsComposer");
    expect(automationEditViewSource).not.toContain("min-h-[116px] max-h-[156px]");
    expect(editViewSource).not.toContain("<textarea");
    expect(editViewSource).toContain('containerClassName="contents"');
    expect(editViewSource).not.toContain("focus-within:bg-hover");
    expect(editViewSource).toContain("<ModelConfigSelect");
    expect(editViewSource).toContain("showProviderLevel={false}");
    expect(editViewSource).toContain("<ThoughtLevelCycleControl");
    expect(editViewSource).toContain("focusSelectorOnClose={null}");
    expect(editViewSource).toContain("restoreFocusSelector={null}");
    // 权限下拉与项目/模型/推理一样以 New Task composer 为唯一实现来源。
    expect(editViewSource).toContain("<ConfigSelect");
    expect(editViewSource).not.toContain("OffPeakToolbarSelect");
    expect(editViewSource).toContain("buildAutomationModeOption(mode)");
    expect(editViewSource).toContain("provider={ZCODE_AGENT_PROVIDER}");
    expect(editViewSource).not.toContain("offPeak.mode.");
    expect(automationEditViewSource).toContain("<ConfigSelect");
    expect(editViewSource).toContain(
      "flex w-full shrink-0 flex-nowrap items-center justify-end gap-0 sm:w-auto",
    );
    expect(automationIconsSource).toContain("ChevronDown");
    expect(automationIconsSource).toContain("strokeWidth={2}");
    expect(automationIconsSource).not.toContain("@/assets/");
    expect(automationIconsSource).not.toContain("maskImage");
    expect(editViewSource).toContain("triggerIndicator={");
    expect(editViewSource).toContain("containerSize={20}");
    expect(editViewSource).toContain("<ConfigSelect");
    expect(editViewSource).toContain("option={modeOption}");
    expect(chatInputDisplaySource).toContain(
      "text-warning hover:text-warning aria-expanded:text-warning",
    );
    expect(chatInputDisplaySource).toContain("min-h-13 items-start gap-3 py-2 pl-2 pr-8");
    expect(instructionsComposerSource).toContain("hover:bg-hover hover:text-foreground");
    expect(instructionsComposerSource).toContain(
      "aria-expanded:bg-hover aria-expanded:text-foreground",
    );
  });

  it("removes the idle-time queue guidance block before the task title", () => {
    expect(editViewSource).not.toContain('id: "offPeak.form.idleTimeLabel"');
    expect(editViewSource).not.toContain('id: "offPeak.form.scheduleHint"');
    expect(editViewSource).not.toContain('id: "offPeak.form.soonestAvailable"');
  });

  it("shares the remote Automation confirmation presentation for destructive drafts", () => {
    const zaiDarkThemeStart = stylesSource.indexOf(".theme-zai-dark {");
    const zaiDarkThemeEnd = stylesSource.indexOf("\n}", zaiDarkThemeStart);
    const zaiDarkThemeSource = stylesSource.slice(zaiDarkThemeStart, zaiDarkThemeEnd);

    expect(automationEditViewSource).toContain("const confirmDialog = useConfirmDialog();");
    expect(automationEditViewSource).toContain(
      'title: intl.formatMessage({ id: "automations.unsaved.title" })',
    );
    expect(automationEditViewSource).toContain('confirmVariant: "destructive"');
    expect(automationEditViewSource).toContain("showCloseButton: true");
    expect(automationEditViewSource).toContain("showKeyboardHints: false");
    expect(automationEditViewSource).toContain('presentation: "automation-confirmation"');
    expect(editViewSource).toContain('presentation: "automation-confirmation"');
    expect(automationEditViewSource).not.toContain("<Dialog open={unsavedDialogOpen}");

    expect(confirmDialogSource).toContain(
      'displayedRequest?.presentation === "automation-confirmation"',
    );
    expect(automationConfirmDialogPresentationSource).toContain(
      "min-h-[180px] w-[min(448px,calc(100vw-2rem))]",
    );
    expect(automationConfirmDialogPresentationSource).not.toContain(
      "gap-5 rounded-2xl border-none bg-popover/98 p-5",
    );
    expect(automationConfirmDialogPresentationSource).not.toContain(
      "text-ui-lg font-semibold text-foreground",
    );
    expect(automationConfirmDialogPresentationSource).not.toContain(
      "text-ui-base leading-6 text-foreground-subtle",
    );
    expect(confirmDialogSource).toContain(
      '<DialogTitle className="text-ui-lg font-semibold text-foreground">',
    );
    expect(confirmDialogSource).toContain(
      "whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle",
    );
    expect(confirmDialogSource).toContain('isAutomationConfirmation && "mt-auto"');
    expect(confirmDialogSource).toContain('"gap-5 rounded-2xl border-none bg-popover/98 p-5');
    expect(confirmDialogSource).toContain('"h-9 gap-3 px-4"');
    expect(zaiDarkThemeStart).toBeGreaterThanOrEqual(0);
    expect(zaiDarkThemeSource).toContain("--color-destructive-foreground: #ffffff;");
    expect(buttonSource).toContain(
      "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    );
    expect(confirmDialogSource).not.toContain('"text-white hover:text-white"');
  });
});
