import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const capturedButtons: Array<Record<string, unknown>> = [];
const capturedInputs: Array<Record<string, unknown>> = [];
const capturedSwitches: Array<Record<string, unknown>> = [];
const EXPECTED_SHELL_DESCRIPTION_ZH =
  "仅新会话生效。Windows 下 Bash 工具用此 shell；自动优先 Git Bash，找不到回退 cmd.exe。";
const EXPECTED_SHELL_DESCRIPTION_EN =
  "Applies to new sessions only. On Windows, Bash uses this shell; Auto tries Git Bash, then cmd.exe.";
const EXPECTED_NATIVE_SEARCH_DESCRIPTION_ZH =
  "在新建会话或应用重启后恢复的会话中使用增强 Find 和 Grep。当前会话保持现有设置；Windows 的 Find 保持不变。";
const EXPECTED_NATIVE_SEARCH_DESCRIPTION_EN =
  "Use enhanced Find and Grep in new sessions and sessions restored after an app restart. Active sessions keep their current setting; Find remains unchanged on Windows.";
const EXPECTED_MEMORY_DESCRIPTION_ZH =
  "在工作区中保存并复用长期上下文，新会话生效。开启后可能增加模型调用和 Token 成本。";
const EXPECTED_MEMORY_DESCRIPTION_EN =
  "Save and reuse long-term context in workspaces. Applies to new sessions and may increase model requests and token costs.";
const EXPECTED_ASK_AUTO_RESOLUTION_DESCRIPTION_ZH =
  "开启后，Agent 提问 5 分钟未回答会自动继续；关闭后，当前和后续提问会一直等待你的回答。";
const EXPECTED_ASK_AUTO_RESOLUTION_DESCRIPTION_EN =
  "When enabled, Agent questions automatically continue after 5 minutes without an answer. When disabled, current and future questions wait for your response.";
const EXPECTED_MODEL_IO_FULL_RETENTION_DESCRIPTION_ZH =
  "保留完整的模型请求和响应，不自动压缩、限制大小或删除旧记录。";
const EXPECTED_MODEL_IO_FULL_RETENTION_DESCRIPTION_EN =
  "Keep complete model requests and responses without compression, size limits, or automatic deletion.";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: (initialValue: unknown) => [initialValue, vi.fn()] as const,
  };
});

vi.mock("@/components/lib/utils.js", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) => {
    capturedButtons.push({ children, ...props });
    return createElement("button", props, children);
  },
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => {
    capturedInputs.push(props);
    return createElement("input", props);
  },
}));

vi.mock("@/components/ui/switch.js", () => ({
  Switch: (props: Record<string, unknown>) => {
    capturedSwitches.push(props);
    return createElement("input", { type: "checkbox", ...props });
  },
}));

vi.mock("@/components/ui/select.js", () => ({
  Select: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectContent: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectItem: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectTrigger: ({ children }: { children: unknown }) => createElement("button", null, children),
  SelectValue: () => createElement("span"),
}));

vi.mock("@/components/ui/card.js", () => ({
  Card: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  CardContent: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
}));

vi.mock("@/settings/SettingsPageParts.js", () => ({
  SettingsBadge: ({ children }: { children: unknown }) => createElement("span", null, children),
  SettingsGroupCard: ({ children }: { children: unknown }) =>
    createElement("section", { "data-settings-group": true }, children),
  SettingsRow: ({
    control,
    description,
    detail,
  }: {
    control: unknown;
    description?: unknown;
    detail?: unknown;
  }) => createElement("div", null, description, control, detail),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        const messages: Record<string, string> = {
          "settings.themeMode": "主题模式",
          "settings.themeMode.system": "跟随系统",
          "settings.themeMode.dark": "深色",
          "settings.themeMode.light": "浅色",
          "settings.themeMode.zai-dark": "深色",
          "settings.themeMode.zai-light": "浅色",
          "settings.locale": "界面语言",
          "settings.locale.system": "系统默认",
          "settings.locale.zh-CN": "简体中文",
          "settings.locale.en-US": "English",
          "settings.terminalProfile": "继承系统终端 Profile",
          "settings.terminalProfileDescription": "desc",
          "settings.terminalFontFamily": "终端字体",
          "settings.terminalFontFamilyDescription": "desc",
          "settings.terminalFontFamilyPlaceholder": "留空自动继承",
          "settings.integratedTerminalShell": "集成终端Shell",
          "settings.integratedTerminalShellDescription": EXPECTED_SHELL_DESCRIPTION_ZH,
          "settings.integratedTerminalShell.auto": "自动选择",
          "settings.nativeSearchEnhancements": "增强 Find 和 Grep",
          "settings.nativeSearchEnhancementsDescription": EXPECTED_NATIVE_SEARCH_DESCRIPTION_ZH,
          "settings.memory": "记忆",
          "settings.memory.workspaceMemory": "工作区记忆",
          "settings.memoryDescription": EXPECTED_MEMORY_DESCRIPTION_ZH,
          "settings.desktopChromiumHardwareAcceleration": "Chrome 硬件加速",
          "settings.desktopChromiumHardwareAccelerationDescription": "desc",
          "settings.notification": "任务通知",
          "settings.notificationDescription": "desc",
          "settings.notificationSound": "通知声音",
          "settings.notificationSoundDescription": "desc",
          "settings.messageStreamShowReasoning": "显示思考过程",
          "settings.messageStreamShowReasoningDescription": "desc",
          "settings.messageStreamShowTodos": "显示流式待办",
          "settings.messageStreamShowTodosDescription": "desc",
          "settings.toolGroupingExplore": "分组探索工具",
          "settings.toolGroupingExploreDescription": "desc",
          "settings.toolGroupingTerminal": "分组终端命令",
          "settings.toolGroupingTerminalDescription": "desc",
          "settings.toolGroupingChanges": "分组文件更改",
          "settings.toolGroupingChangesDescription": "desc",
          "settings.zcodeInteractionBehavior": "交互行为",
          "settings.zcodeInteractionBehaviorDescription": "desc",
          "settings.zcodeInteractionBehavior.option.queue": "队列",
          "settings.zcodeInteractionBehavior.option.guide": "引导",
          "settings.askUserQuestionAutoResolution": "提问自动继续",
          "settings.askUserQuestionAutoResolutionDescription":
            EXPECTED_ASK_AUTO_RESOLUTION_DESCRIPTION_ZH,
          "settings.modelIoFullRetention": "完整保留模型 I/O",
          "settings.modelIoFullRetentionDescription":
            EXPECTED_MODEL_IO_FULL_RETENTION_DESCRIPTION_ZH,
          "settings.performanceMode": "性能模式",
          "settings.performanceModeDescription": "desc",
          "settings.taskAutoArchive": "自动归档旧任务",
          "settings.taskAutoArchiveDescription": "desc",
          "settings.taskAutoArchiveDays": "归档保留时长",
          "settings.taskAutoArchiveDaysDescription": "desc",
          "settings.taskAutoArchiveDays.option.3": "3 天后归档",
          "settings.taskAutoArchiveDays.option.7": "7 天后归档",
          "settings.taskAutoArchiveDays.option.14": "14 天后归档",
          "settings.taskAutoArchiveDays.option.30": "30 天后归档",
          "settings.dataBaseDir": "数据存储路径",
          "settings.dataBaseDirDescription": "desc",
          "settings.dataBaseDirPlaceholder": "默认：用户主目录",
          "settings.dataBaseDirBrowse": "选择文件夹",
          "settings.dataBaseDirSave": "保存",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

function findButton(label: string) {
  return capturedButtons.find((button) => button.children === label);
}

async function renderGeneralSection(
  overrides: Partial<
    Parameters<typeof import("../src/settingsPageHelpers.js").GeneralSectionContent>[0]
  > = {},
) {
  const { GeneralSectionContent } = await import("../src/settingsPageHelpers.js");

  return renderToStaticMarkup(
    createElement(GeneralSectionContent, {
      theme: "system",
      localePreference: "system",
      notificationEnabled: true,
      notificationSoundEnabled: true,
      closeToTrayOnWindows: true,
      keepAwakeWhileRunning: false,
      isDesktop: true,
      receivePreviewUpdates: false,
      autoDownloadAndInstallUpdates: false,
      desktopChromiumHardwareAccelerationEnabled: true,
      dataBaseDir: "/Users/test",
      terminalInheritSystemProfile: true,
      terminalFontFamily: "",
      nativeSearchEnhancementsEnabled: true,
      defaultHomeDir: "/Users/test",
      setTheme: vi.fn(),
      setLocalePreference: vi.fn(),
      setNotificationEnabled: vi.fn(),
      setNotificationSoundEnabled: vi.fn(),
      taskAutoArchiveEnabled: false,
      taskAutoArchiveOlderThanDays: 7,
      messageStreamShowReasoning: true,
      messageStreamShowTodos: false,
      toolGroupingExploreEnabled: true,
      toolGroupingTerminalEnabled: true,
      toolGroupingChangesEnabled: false,
      zcodeInteractionBehavior: "queue",
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      onDataBaseDirChange: vi.fn(async () => {}),
      onSelectDataBaseDir: vi.fn(async () => "/Users/test/data"),
      onTerminalInheritSystemProfileChange: vi.fn(async () => {}),
      onTerminalFontFamilyChange: vi.fn(async () => {}),
      onNativeSearchEnhancementsEnabledChange: vi.fn(async () => {}),
      onDesktopChromiumHardwareAccelerationChange: vi.fn(async () => {}),
      onTaskAutoArchiveEnabledChange: vi.fn(async () => {}),
      onTaskAutoArchiveOlderThanDaysChange: vi.fn(async () => {}),
      onCloseToTrayOnWindowsChange: vi.fn(async () => {}),
      onKeepAwakeWhileRunningChange: vi.fn(async () => {}),
      onReceivePreviewUpdatesChange: vi.fn(async () => {}),
      onAutoDownloadAndInstallUpdatesChange: vi.fn(async () => {}),
      onMessageStreamShowReasoningChange: vi.fn(async () => {}),
      onMessageStreamShowTodosChange: vi.fn(async () => {}),
      onToolGroupingExploreEnabledChange: vi.fn(async () => {}),
      onToolGroupingTerminalEnabledChange: vi.fn(async () => {}),
      onToolGroupingChangesEnabledChange: vi.fn(async () => {}),
      onZCodeInteractionBehaviorChange: vi.fn(async () => {}),
      onAskUserQuestionAutoResolutionEnabledChange: vi.fn(async () => {}),
      onModelIoFullRetentionEnabledChange: vi.fn(async () => {}),
      onOptimizeAgentExperienceEnabledChange: vi.fn(async () => {}),
      onOpenOnboardingDialog: vi.fn(),
      ...overrides,
    }),
  );
}

describe("GeneralSectionContent data directory control", () => {
  beforeEach(() => {
    capturedButtons.length = 0;
    capturedInputs.length = 0;
    capturedSwitches.length = 0;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("数据目录改为只读展示，避免继续手输路径", async () => {
    await renderGeneralSection();

    expect(capturedInputs.some((input) => input.readOnly === true)).toBe(true);
    expect(findButton("保存")?.disabled).toBe(true);
  });

  it("ModelIO 全量保留默认关闭，并通过标准设置开关提交", async () => {
    const onModelIoFullRetentionEnabledChange = vi.fn(async () => {});

    await renderGeneralSection({ onModelIoFullRetentionEnabledChange });

    const modelIoSwitch = capturedSwitches.find(
      (entry) => entry["aria-label"] === "完整保留模型 I/O",
    );
    expect(modelIoSwitch?.checked).toBe(false);
    expect(modelIoSwitch?.onCheckedChange).toBeTypeOf("function");
    (modelIoSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);
    expect(onModelIoFullRetentionEnabledChange).toHaveBeenCalledWith(true);
    expect(zhCN["settings.modelIoFullRetentionDescription"]).toBe(
      EXPECTED_MODEL_IO_FULL_RETENTION_DESCRIPTION_ZH,
    );
    expect(enUS["settings.modelIoFullRetentionDescription"]).toBe(
      EXPECTED_MODEL_IO_FULL_RETENTION_DESCRIPTION_EN,
    );
  });

  it("点击选择文件夹会调用系统目录选择回调", async () => {
    const onSelectDataBaseDir = vi.fn(async () => "/Users/test/data");

    await renderGeneralSection({ onSelectDataBaseDir });

    await (findButton("选择文件夹")?.onClick as (() => Promise<void>) | undefined)?.();

    expect(onSelectDataBaseDir).toHaveBeenCalledTimes(1);
  });

  it("Windows host 会展示集成终端 Shell 下拉选项", async () => {
    const markup = await renderGeneralSection({
      showIntegratedTerminalShell: true,
      integratedTerminalShellOptions: [
        {
          dialect: "git-bash",
          id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
          label: "Git Bash",
          path: "C:\\Program Files\\Git\\bin\\bash.exe",
          source: "system",
        },
      ],
    });

    expect(markup).toContain("自动选择");
    expect(markup).toContain("Git Bash");
    expect(markup).toContain(EXPECTED_SHELL_DESCRIPTION_ZH);
    expect(zhCN["settings.integratedTerminalShellDescription"]).toBe(EXPECTED_SHELL_DESCRIPTION_ZH);
    expect(enUS["settings.integratedTerminalShellDescription"]).toBe(EXPECTED_SHELL_DESCRIPTION_EN);
  });

  it("增强搜索读取持久值并写回用户切换", async () => {
    const onNativeSearchEnhancementsEnabledChange = vi.fn(async () => {});

    await renderGeneralSection({
      nativeSearchEnhancementsEnabled: false,
      onNativeSearchEnhancementsEnabledChange,
    });

    const nativeSearchSwitch = capturedSwitches.find(
      (item) => item["aria-label"] === "增强 Find 和 Grep",
    );
    expect(nativeSearchSwitch?.checked).toBe(false);

    (nativeSearchSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);

    expect(onNativeSearchEnhancementsEnabledChange).toHaveBeenCalledWith(true);
  });

  it("增强 Find 和 Grep 与 Windows Shell 选择位于常规页同一设置组", async () => {
    const markup = await renderGeneralSection({
      showIntegratedTerminalShell: true,
    });
    const terminalSettingsGroup = markup
      .match(/<section data-settings-group="true">[\s\S]*?<\/section>/g)
      ?.find((group) => group.includes(EXPECTED_SHELL_DESCRIPTION_ZH));

    expect(terminalSettingsGroup).toContain(EXPECTED_NATIVE_SEARCH_DESCRIPTION_ZH);
  });

  it("增强搜索提供中英文 Session 生命周期说明", () => {
    expect(enUS["settings.nativeSearchEnhancements"]).toBe("Enhanced Find and Grep");
    expect(enUS["settings.nativeSearchEnhancementsDescription"]).toBe(
      EXPECTED_NATIVE_SEARCH_DESCRIPTION_EN,
    );
    expect(zhCN["settings.nativeSearchEnhancements"]).toBe("增强 Find 和 Grep");
    expect(zhCN["settings.nativeSearchEnhancementsDescription"]).toBe(
      EXPECTED_NATIVE_SEARCH_DESCRIPTION_ZH,
    );
  });

  it("记忆模块使用单段中英文说明表达工作区语义、生效边界和用量提示", () => {
    expect(enUS["settings.memory"]).toBe("Memory");
    expect(enUS["settings.memory.workspaceMemory"]).toBe("Workspace Memory");
    expect(enUS["settings.memoryDescription"]).toBe(EXPECTED_MEMORY_DESCRIPTION_EN);
    expect(enUS).not.toHaveProperty("settings.memoryUsageNotice");
    expect(zhCN["settings.memory"]).toBe("记忆");
    expect(zhCN["settings.memory.workspaceMemory"]).toBe("工作区记忆");
    expect(zhCN["settings.memoryDescription"]).toBe(EXPECTED_MEMORY_DESCRIPTION_ZH);
    expect(zhCN).not.toHaveProperty("settings.memoryUsageNotice");
  });

  it("桌面端展示 Chrome 硬件加速开关，并把用户选择写回设置", async () => {
    const onDesktopChromiumHardwareAccelerationChange = vi.fn(async () => {});

    await renderGeneralSection({
      onDesktopChromiumHardwareAccelerationChange,
    });

    const hardwareAccelerationSwitch = capturedSwitches.find(
      (item) => item["aria-label"] === "Chrome 硬件加速",
    );

    expect(hardwareAccelerationSwitch?.checked).toBe(true);

    (hardwareAccelerationSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(
      false,
    );

    expect(onDesktopChromiumHardwareAccelerationChange).toHaveBeenCalledWith(false);
  });

  it("reasoning 默认开启并把用户操作写回设置回调，同时保持 Todo 默认关闭", async () => {
    const onMessageStreamShowReasoningChange = vi.fn(async () => {});
    const onMessageStreamShowTodosChange = vi.fn(async () => {});

    await renderGeneralSection({
      onMessageStreamShowReasoningChange,
      onMessageStreamShowTodosChange,
    });

    const reasoningSwitch = capturedSwitches.find((item) => item["aria-label"] === "显示思考过程");
    const todosSwitch = capturedSwitches.find((item) => item["aria-label"] === "显示流式待办");
    const performanceModeSwitch = capturedSwitches.find(
      (item) => item["aria-label"] === "性能模式",
    );

    expect(reasoningSwitch?.checked).toBe(true);
    expect(todosSwitch?.checked).toBe(false);
    expect(performanceModeSwitch).toBeUndefined();

    (reasoningSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    (todosSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);

    expect(onMessageStreamShowReasoningChange).toHaveBeenCalledWith(false);
    expect(onMessageStreamShowTodosChange).toHaveBeenCalledWith(true);
  });

  it("工具分组开关使用各自默认值，并把用户操作写回设置回调", async () => {
    const onToolGroupingExploreEnabledChange = vi.fn(async () => {});
    const onToolGroupingTerminalEnabledChange = vi.fn(async () => {});
    const onToolGroupingChangesEnabledChange = vi.fn(async () => {});

    await renderGeneralSection({
      onToolGroupingExploreEnabledChange,
      onToolGroupingTerminalEnabledChange,
      onToolGroupingChangesEnabledChange,
    });

    const exploreSwitch = capturedSwitches.find((item) => item["aria-label"] === "分组探索工具");
    const terminalSwitch = capturedSwitches.find((item) => item["aria-label"] === "分组终端命令");
    const changesSwitch = capturedSwitches.find((item) => item["aria-label"] === "分组文件更改");

    expect(exploreSwitch?.checked).toBe(true);
    expect(terminalSwitch?.checked).toBe(true);
    expect(changesSwitch?.checked).toBe(false);

    (exploreSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    (terminalSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    (changesSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);

    expect(onToolGroupingExploreEnabledChange).toHaveBeenCalledWith(false);
    expect(onToolGroupingTerminalEnabledChange).toHaveBeenCalledWith(false);
    expect(onToolGroupingChangesEnabledChange).toHaveBeenCalledWith(true);
  });

  it("提问自动继续开关读取持久值、写回选择并提供中英文关闭语义", async () => {
    const onAskUserQuestionAutoResolutionEnabledChange = vi.fn(async () => {});

    const markup = await renderGeneralSection({
      askUserQuestionAutoResolutionEnabled: false,
      onAskUserQuestionAutoResolutionEnabledChange,
    });
    const autoResolutionSwitch = capturedSwitches.find(
      (item) => item["aria-label"] === "提问自动继续",
    );

    expect(autoResolutionSwitch?.checked).toBe(false);
    expect(markup).toContain(EXPECTED_ASK_AUTO_RESOLUTION_DESCRIPTION_ZH);
    expect(zhCN["settings.askUserQuestionAutoResolution"]).toBe("提问自动继续");
    expect(zhCN["settings.askUserQuestionAutoResolutionDescription"]).toBe(
      EXPECTED_ASK_AUTO_RESOLUTION_DESCRIPTION_ZH,
    );
    expect(enUS["settings.askUserQuestionAutoResolution"]).toBe("Automatically continue questions");
    expect(enUS["settings.askUserQuestionAutoResolutionDescription"]).toBe(
      EXPECTED_ASK_AUTO_RESOLUTION_DESCRIPTION_EN,
    );

    (autoResolutionSwitch?.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);
    expect(onAskUserQuestionAutoResolutionEnabledChange).toHaveBeenCalledWith(true);
  });
});
