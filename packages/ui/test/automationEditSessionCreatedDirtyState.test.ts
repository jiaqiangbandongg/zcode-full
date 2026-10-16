// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  type ZCodeAutomation,
  type ModelSelection,
} from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stableHookValues = vi.hoisted(() => ({
  configResult: { configOptions: [] },
  projectOptions: [] as Array<{
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    remoteTarget?: { type: "ssh"; host: string };
    label: string;
    workspacePurpose?: "project" | "conversation";
  }>,
  modelSelectionView: null as typeof modelSelectionView | null,
  modelSelectionTargets: [] as Array<{
    workspacePath: string | null | undefined;
    remoteSessionId?: string | null;
    workspaceIdentity?: string | null;
    remoteTarget?: unknown;
  }>,
  selectRegistrations: 0,
  effectiveSelection: undefined as ModelSelection | null | undefined,
  selectionInputs: [] as Array<{ selection: ModelSelection | null } | undefined>,
  locale: "zh-CN" as "zh-CN" | "en-US",
  services: { zcodeAgentService: {} },
}));

vi.mock("@/components/ui/select.js", async () => {
  const { createElement: h, useEffect } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Select: ({
      children,
      onValueChange,
      value,
    }: {
      children?: ReactNode;
      onValueChange?: (value: string) => void;
      value?: string;
    }) => {
      useEffect(() => {
        const timer = window.setTimeout(() => {
          // 模拟 Radix Select 受控值与子项注册竞争、在表单初始化完成后发出的空值：
          // 这不是用户操作，消费方必须丢弃值域外的回调
          // （回归：仅打开详情返回就弹未保存提示）。
          onValueChange?.("");
          if (
            value &&
            ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"].includes(value)
          ) {
            stableHookValues.selectRegistrations += 1;
            onValueChange?.(value);
          }
        }, 0);
        return () => window.clearTimeout(timer);
      }, []);
      return h("div", null, children);
    },
    SelectContent: passthrough,
    SelectItem: passthrough,
    SelectTrigger: passthrough,
    SelectValue: passthrough,
  };
});

vi.mock("@/settings/SettingsHeaderBreadcrumb.js", async () => {
  const { createElement: h } = await import("react");
  return {
    SettingsBreadcrumbReporter: ({
      items,
      onSectionSelect,
    }: {
      items: Array<{ label: string }>;
      onSectionSelect?: () => void;
    }) =>
      h(
        "button",
        {
          "data-testid": "automation-edit-breadcrumb-section",
          onClick: onSectionSelect,
          type: "button",
        },
        items[0]?.label,
      ),
  };
});

vi.mock("@/components/ui/dialog.js", async () => {
  const { createElement: h } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? h("div", null, children) : null,
    DialogClose: passthrough,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/dropdown-menu.js", async () => {
  const { createElement: h } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuSeparator: () => h("hr"),
    DropdownMenuTrigger: passthrough,
  };
});

vi.mock("@/components/ui/popover.js", async () => {
  const { createElement: h } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Popover: passthrough,
    PopoverContent: passthrough,
    PopoverTrigger: passthrough,
  };
});

vi.mock("@/components/ui/tooltip.js", async () => {
  const { createElement: h } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Tooltip: passthrough,
    TooltipContent: passthrough,
    TooltipProvider: passthrough,
    TooltipTrigger: passthrough,
  };
});

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
// 权限选择器复用会话 composer 的 ConfigSelect：这里保留真实实现，让上方 Select mock
// 发出的注册竞争空值穿过它，守住“值域外回调不得标记未保存修改”的防护。
vi.mock("@/chat-input-toolbar/RollingToolbarLabel.js", () => ({
  RollingToolbarLabel: ({ label }: { label: string }) => label,
}));
vi.mock("@/ModelConfigSelect.js", async () => {
  const { createElement: h } = await import("react");
  return {
    ModelConfigSelect: ({ triggerLabel }: { triggerLabel?: string }) =>
      h("span", { "data-testid": "automation-model-trigger-label" }, triggerLabel),
  };
});
vi.mock("@/chat-input-toolbar/ThoughtLevelCycleControl.js", () => ({
  ThoughtLevelCycleControl: () => null,
}));
vi.mock("@/ChatEmptyState.js", () => ({
  ChatEmptyWorkspacePreviewMenu: ({
    workspaceTabs,
    onSelectWorkspace,
  }: {
    workspaceTabs: Array<{ workspacePath: string; workspaceIdentity?: string; label: string }>;
    onSelectWorkspace: (workspace: {
      workspacePath: string;
      workspaceIdentity?: string;
      label: string;
    }) => void;
  }) =>
    createElement(
      "div",
      null,
      workspaceTabs.map((workspace) =>
        createElement(
          "button",
          {
            key: workspace.workspaceIdentity ?? workspace.workspacePath,
            type: "button",
            onClick: () => onSelectWorkspace(workspace),
          },
          workspace.label,
        ),
      ),
    ),
}));
vi.mock("@/hooks/useAutomationProjectOptions.js", () => ({
  useAutomationProjectOptions: () => stableHookValues.projectOptions,
}));
vi.mock("@/hooks/useZCodeConfig.js", () => ({
  useToolbarConfigOptions: () => stableHookValues.configResult,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => stableHookValues.services,
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: (
    workspacePath: string | null | undefined,
    remoteSessionId?: string | null,
    workspaceIdentity?: string | null,
    remoteTarget?: unknown,
    input?: { selection: ModelSelection | null },
  ) => {
    stableHookValues.selectionInputs.push(input);
    stableHookValues.modelSelectionTargets.push({
      workspacePath,
      remoteSessionId,
      workspaceIdentity,
      remoteTarget,
    });
    return {
      state: stableHookValues.modelSelectionView
        ? {
            status: "ready" as const,
            view: {
              ...stableHookValues.modelSelectionView,
              ...(input
                ? {
                    effectiveSelection:
                      stableHookValues.effectiveSelection === undefined
                        ? input.selection
                        : stableHookValues.effectiveSelection,
                  }
                : {}),
            },
          }
        : { status: "loading" as const },
      reload: vi.fn(),
    };
  },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        if (id === "automations.edit.titlePlaceholder") {
          return stableHookValues.locale === "zh-CN" ? "未命名定时任务" : "Untitled Automation";
        }
        return id;
      },
    },
  }),
}));

import { AutomationEditView } from "@/settings/AutomationEditView.js";

const modelSelectionView = {
  revision: 1,
  providers: [
    {
      providerId: "provider",
      providerName: "DeepSeek Provider",
      config: {
        api: { type: "openai-chat-completions", baseUrl: "https://example.test" },
      },
      models: [
        {
          modelId: "deepseek-v4-flash",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"], map: "{}" },
              maxOutputTokens: { max: 32_000, map: "{}" },
            },
          },
        },
      ],
    },
  ],
};

const sessionCreatedAutomation: ZCodeAutomation = {
  automationId: "automation-session-created",
  title: "每 10 分钟提醒",
  cronExpr: "*/10 * * * *",
  prompt: "提醒用户休息",
  model: "provider/deepseek-v4-flash",
  modelSelection: {
    providerId: "provider",
    modelId: "deepseek-v4-flash",
    options: { reasoningLevel: "low" },
  },
  mode: "edit",
  thoughtLevel: "low",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  targetTaskId: "session-from-chat",
  locationKind: "local",
  recurring: true,
  scheduleRule: {
    unit: "minute",
    interval: 10,
    hour: 16,
    minute: 49,
    anchorAt: 1_784_887_300_020,
    weekdays: [1],
    monthDays: [1],
    monthlyMode: "date",
  },
  runCount: 0,
  enabled: true,
  lifecycleStatus: "active",
  dispatchStatus: "idle",
  dispatchAttempts: 0,
  createdAt: 1,
  updatedAt: 1,
};

const uiCreatedAutomation: ZCodeAutomation = {
  ...sessionCreatedAutomation,
  automationId: "automation-ui-created",
};
delete uiCreatedAutomation.targetTaskId;

const sessionCreatedUiResetAutomation: ZCodeAutomation = {
  ...sessionCreatedAutomation,
  automationId: "automation-session-created-ui-reset",
  cronExpr: "0 9 * * *",
  scheduleRule: undefined,
  scheduleEditedByUser: true,
};

beforeEach(() => {
  stableHookValues.selectRegistrations = 0;
  stableHookValues.locale = "zh-CN";
  stableHookValues.projectOptions.length = 0;
  stableHookValues.modelSelectionView = null;
  stableHookValues.modelSelectionTargets.length = 0;
  stableHookValues.effectiveSelection = undefined;
  stableHookValues.selectionInputs.length = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(cleanup);

describe("AutomationEditView session-created dirty state", () => {
  it("原账号选择只派生展示，主动保存才采用有效选择", async () => {
    stableHookValues.modelSelectionView = modelSelectionView;
    stableHookValues.effectiveSelection = uiCreatedAutomation.modelSelection;
    const original = {
      ...uiCreatedAutomation.modelSelection!,
      providerId: "account:bigmodel-individual-coding-plan",
    };
    const editing = { ...uiCreatedAutomation, modelSelection: original };
    const onSubmit = vi.fn(async () => true);
    render(
      createElement(AutomationEditView, {
        editing,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit,
        onBack: vi.fn(),
      }),
    );
    await waitFor(() =>
      expect(stableHookValues.selectionInputs.at(-1)).toEqual({ selection: original }),
    );
    expect(screen.getByTestId("automation-model-trigger-label").textContent).toBe(
      "DeepSeek Provider/deepseek-v4-flash",
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editing.modelSelection).toEqual(original);
    fireEvent.click(screen.getByRole("button", { name: "automations.form.save" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ modelSelection: uiCreatedAutomation.modelSelection }),
        }),
      ),
    );
    expect(editing.modelSelection).toEqual(original);
  });

  it("新建任务的自动默认标题会随语言切换更新且不覆盖用户输入", () => {
    const props = {
      editing: null,
      defaultWorkspacePath: "/workspace",
      saving: false,
      onSubmit: vi.fn(async () => true),
      onBack: vi.fn(),
    };
    const { rerender } = render(createElement(AutomationEditView, props));
    const titleInput = screen.getByLabelText<HTMLInputElement>("automations.form.title.label");

    expect(titleInput.value).toBe("未命名定时任务");

    stableHookValues.locale = "en-US";
    rerender(createElement(AutomationEditView, props));
    expect(titleInput.value).toBe("Untitled Automation");

    fireEvent.click(screen.getByTestId("automation-edit-breadcrumb-section"));
    expect(props.onBack).toHaveBeenCalledOnce();

    fireEvent.change(titleInput, { target: { value: "Keep my title" } });
    stableHookValues.locale = "zh-CN";
    rerender(createElement(AutomationEditView, props));
    expect(titleInput.value).toBe("Keep my title");
  });

  it("模板值进入表单后成为普通草稿，语言切换不覆盖用户编辑", () => {
    const props = {
      editing: null,
      initialDraft: {
        title: "远程模板标题",
        cronExpr: "0 9 * * 1-5",
        prompt: "远程模板指令",
      },
      defaultWorkspacePath: "/workspace",
      modelProviders: [],
      saving: false,
      onSubmit: vi.fn(async () => true),
      onBack: vi.fn(),
    };
    const { rerender } = render(createElement(AutomationEditView, props));
    const titleInput = screen.getByLabelText<HTMLInputElement>("automations.form.title.label");
    const promptInput = screen.getByLabelText<HTMLTextAreaElement>("automations.form.prompt.label");

    fireEvent.change(titleInput, { target: { value: "用户标题" } });
    fireEvent.change(promptInput, { target: { value: "用户编辑后的指令" } });
    stableHookValues.locale = "en-US";
    rerender(createElement(AutomationEditView, props));

    expect(titleInput.value).toBe("用户标题");
    expect(promptInput.value).toBe("用户编辑后的指令");
  });

  it("编辑任务时模型触发器与会话侧一致显示 providerName/modelName", () => {
    stableHookValues.modelSelectionView = modelSelectionView;
    render(
      createElement(AutomationEditView, {
        editing: sessionCreatedAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    expect(screen.getByTestId("automation-model-trigger-label").textContent).toBe(
      "DeepSeek Provider/deepseek-v4-flash",
    );
  });

  it("切换目标项目后从对应 Host 读取模型视图且携带远程路由", async () => {
    stableHookValues.projectOptions.push(
      { workspacePath: "/local", label: "local" },
      {
        workspacePath: "/remote/project",
        workspaceIdentity: "ssh:server:/remote/project",
        remoteSessionId: "remote-session",
        remoteTarget: { type: "ssh", host: "server" },
        label: "remote",
      },
    );

    render(
      createElement(AutomationEditView, {
        editing: null,
        defaultWorkspacePath: "/local",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "remote" }));

    await waitFor(() => {
      expect(stableHookValues.modelSelectionTargets.at(-1)).toEqual({
        workspacePath: "/remote/project",
        remoteSessionId: "remote-session",
        workspaceIdentity: "ssh:server:/remote/project",
        remoteTarget: { type: "ssh", host: "server" },
      });
    });
  });

  it("编辑无项目任务时继续展示会话侧文案与图标", () => {
    const conversationWorkspacePath = "/Users/test/.zcode/workspace/default";
    stableHookValues.projectOptions.push({
      workspacePath: conversationWorkspacePath,
      label: "default",
      workspacePurpose: "conversation",
    });
    const conversationAutomation: ZCodeAutomation = {
      ...uiCreatedAutomation,
      workspaceKey: conversationWorkspacePath,
      workspacePath: conversationWorkspacePath,
    };

    const { container } = render(
      createElement(AutomationEditView, {
        editing: conversationAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    const workspaceLabel = screen.getByText("chat.empty.workOutsideProject");
    const workspaceButton = workspaceLabel.closest("button");
    expect(workspaceButton?.querySelector(".lucide-message-circle")).not.toBeNull();
    expect(workspaceButton?.querySelector(".lucide-folder-open")).toBeNull();
    expect(container.textContent).not.toContain("default");
  });

  it("会话创建的分钟计划只显示自定义且仅打开返回不提示保存", async () => {
    const onBack = vi.fn();
    render(
      createElement(AutomationEditView, {
        editing: sessionCreatedAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack,
      }),
    );

    expect(screen.getByTestId(TID_AUTOMATION_SCHEDULE_PREVIEW).textContent).toBe(
      "automations.schedule.customMinutes",
    );
    expect(screen.queryByText("automations.customRepeat.compactFrequency")).not.toBeNull();
    expect(stableHookValues.selectRegistrations).toBe(0);

    // 等 Select 注册竞争的空值回调发出后再返回，复现“仅打开详情就被标记未保存”的回归。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    fireEvent.click(screen.getByRole("button", { name: sessionCreatedAutomation.title }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.queryByText("automations.unsaved.title")).toBeNull();
  });

  it("UI 创建的相同分钟计划仍使用可视化调度控件", async () => {
    render(
      createElement(AutomationEditView, {
        editing: uiCreatedAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("automations.customRepeat.compactFrequency")).toBeTruthy();
      expect(stableHookValues.selectRegistrations).toBeGreaterThan(0);
    });
    expect(screen.getByText("automations.customRepeat.compactFrequency")).toBeTruthy();
  });

  it("会话创建任务由用户重设调度后，重新打开仍恢复可视化调度控件", async () => {
    render(
      createElement(AutomationEditView, {
        editing: sessionCreatedUiResetAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(stableHookValues.selectRegistrations).toBeGreaterThan(0);
    });
    expect(screen.getByTestId(TID_AUTOMATION_SCHEDULE_PREVIEW).textContent).toBe(
      "automations.schedule.daily",
    );
  });

  it("删除会话来源的自定义调度后切换到 UI 调度入口", () => {
    render(
      createElement(AutomationEditView, {
        editing: sessionCreatedAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));

    expect(screen.getByTestId(TID_AUTOMATION_SCHEDULE_ADD)).toBeTruthy();
    expect(screen.queryByText("automations.customRepeat.compactFrequency")).toBeNull();
  });
});
