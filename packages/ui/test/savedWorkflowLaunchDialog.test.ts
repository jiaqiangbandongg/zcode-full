// @vitest-environment jsdom
// 实参窗（docs/dynamic-workflow/launch.md「The launch dialog」）：按类型出控件、默认值回填、一次收齐错误。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG,
  TID_WORKFLOW_LAUNCH_ERROR,
  TID_WORKFLOW_LAUNCH_FIELDS,
  TID_WORKFLOW_LAUNCH_SUBMIT,
  TID_WORKFLOW_LAUNCH_TARGET,
  type ZCodeSavedWorkflowArgsDeclaration,
  type ZCodeSavedWorkflowEntry,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import type { SavedWorkflowLaunchError } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

const ENTRY: ZCodeSavedWorkflowEntry = {
  name: "release-check",
  description: "发布前检查",
  scope: "project",
  path: "/repo/.zcode/workflows/release-check.dwf.ts",
  args: {
    branch: { type: "string", required: true, description: "目标分支" },
    count: { type: "number", default: 3 },
    dry: { type: "boolean", default: true },
    extra: { type: "json" },
  },
};

const GLOBAL_ENTRY: ZCodeSavedWorkflowEntry = {
  name: "deep-research",
  description: "深度调研",
  scope: "global",
  path: "/home/.zcode/workflows/deep-research.dwf.ts",
};

// 实参很多的声明（40 个）：第 13 个是无默认值的必填项，第 31 个是 json，其余都有默认值。
// 真实窗口里这份表单远高于视口；jsdom 不排版，这里只能断言结构与焦点，高度由桌面 e2e 断言。
const MANY_ARGS_REQUIRED = "arg12";
const MANY_ARGS_JSON = "arg30";
const MANY_ARGS: ZCodeSavedWorkflowArgsDeclaration = {};
for (let index = 0; index < 40; index += 1) {
  const name = `arg${String(index).padStart(2, "0")}`;
  MANY_ARGS[name] =
    name === MANY_ARGS_REQUIRED
      ? { type: "string", required: true }
      : name === MANY_ARGS_JSON
        ? { type: "json" }
        : { type: "string", default: `v${index}` };
}
const MANY_ARGS_ENTRY: ZCodeSavedWorkflowEntry = {
  name: "arg-overflow",
  description: "实参很多",
  scope: "global",
  path: "/home/.zcode/workflows/arg-overflow.dwf.ts",
  args: MANY_ARGS,
};

const ALPHA: AutomationWorkspaceOption = { workspacePath: "/repo/alpha", label: "Alpha" };
const BETA: AutomationWorkspaceOption = { workspacePath: "/repo/beta", label: "Beta" };
const TARGETS: readonly AutomationWorkspaceOption[] = [ALPHA, BETA];

// jsdom 没有实现 scrollIntoView；校验失败时实参窗会调它，这里记下是谁被滚进了视野。
const scrollIntoView = vi.fn();

// Radix Dialog 在 jsdom 下需要 ResizeObserver；这里给个空实现。
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockClear();
});

function mount(
  entry: ZCodeSavedWorkflowEntry | null,
  extra: {
    targets?: readonly AutomationWorkspaceOption[];
    defaultTargetKey?: string | null;
    scope?: "project" | "global";
    projectLabel?: string;
    pending?: boolean;
    error?: SavedWorkflowLaunchError | null;
  } = {},
  onSubmit = vi.fn(),
  onOpenChange = vi.fn(),
) {
  const { scope, projectLabel, ...rest } = extra;
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SavedWorkflowLaunchDialog, {
        entry,
        scope: scope ?? entry?.scope ?? "project",
        projectLabel: projectLabel ?? "Beta",
        onOpenChange,
        onSubmit,
        ...rest,
      }),
    ),
  );
  return { onSubmit, onOpenChange };
}

describe("SavedWorkflowLaunchDialog", () => {
  it("entry 为 null 时不渲染", () => {
    mount(null);
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeNull();
  });

  it("按类型出控件并回填默认值；required 标注；说明可见", () => {
    mount(ENTRY);
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeTruthy();
    // 头部 = 名字（mono）+ 作用域徽标 + 说明；不再是「运行 {name}」标题。
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(screen.getByText("项目")).toBeTruthy();
    expect(screen.getByText("发布前检查")).toBeTruthy();
    const branch = screen.getByTestId(
      testId(TID_WORKFLOW_LAUNCH_ARG, "branch"),
    ) as HTMLInputElement;
    expect(branch.type).toBe("text");
    expect(branch.value).toBe("");
    expect(screen.getByText("必填")).toBeTruthy();
    expect(screen.getByText("目标分支")).toBeTruthy();
    const count = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "count")) as HTMLInputElement;
    expect(count.type).toBe("number");
    expect(count.value).toBe("3");
    const dry = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "dry"));
    expect(dry.getAttribute("role")).toBe("switch");
    expect(dry.getAttribute("aria-checked")).toBe("true");
    const extra = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "extra"));
    expect(extra.tagName).toBe("TEXTAREA");
  });

  it("提交前一次收齐 required 与 json 错误；修正后提交拿到按类型解析的实参", () => {
    const { onSubmit } = mount(ENTRY);
    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "extra")), {
      target: { value: "{oops" },
    });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).not.toHaveBeenCalled();
    // 徽标「必填」与错误「必填」同文案：错误出现后应有两处。
    expect(screen.getAllByText("必填")).toHaveLength(2);
    expect(screen.getByText("不是合法的 JSON")).toBeTruthy();

    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "branch")), {
      target: { value: "main" },
    });
    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "extra")), {
      target: { value: '{"a":1}' },
    });
    // 编辑即清掉该字段的错误提示。
    expect(screen.getAllByText("必填")).toHaveLength(1);
    expect(screen.queryByText("不是合法的 JSON")).toBeNull();
    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "count")), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // count 留空 → 不传（服务端按 default 回填）；dry 是 boolean 永远有值。
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ branch: "main", dry: true, extra: { a: 1 } });
  });

  it("取消按钮关闭窗口", () => {
    const { onOpenChange, onSubmit } = mount(ENTRY);
    fireEvent.click(screen.getByText("取消"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("不传 targets 时不渲染「运行于」选择器（项目档路径）", () => {
    mount(ENTRY);
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_TARGET)).toBeNull();
    expect(screen.queryByText("运行于")).toBeNull();
  });

  it("传 targets 时渲染选择器，默认选中 defaultTargetKey", () => {
    mount(GLOBAL_ENTRY, {
      targets: TARGETS,
      defaultTargetKey: resolveAutomationWorkspaceSelectionKey(BETA),
    });
    expect(screen.getByText("运行于")).toBeTruthy();
    const trigger = screen.getByTestId(TID_WORKFLOW_LAUNCH_TARGET);
    expect(trigger.textContent).toContain("Beta");
  });

  it("defaultTargetKey 不在候选里时回落到首个候选", () => {
    mount(GLOBAL_ENTRY, { targets: TARGETS, defaultTargetKey: "no-such-key" });
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_TARGET).textContent).toContain("Alpha");
  });

  it("候选为空时提示并禁用提交", () => {
    mount(GLOBAL_ENTRY, { targets: [] });
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_TARGET)).toBeNull();
    expect(screen.getByText("打开一个本地项目以运行")).toBeTruthy();
    expect((screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("无实参的全局工作流也弹窗，提交回带选中的项目", () => {
    const { onSubmit } = mount(GLOBAL_ENTRY, {
      targets: TARGETS,
      defaultTargetKey: resolveAutomationWorkspaceSelectionKey(ALPHA),
    });
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeTruthy();
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({});
    expect(onSubmit.mock.calls[0]?.[2]).toEqual(ALPHA);
  });

  it("全局档头部渲染「全局」徽标", () => {
    mount(GLOBAL_ENTRY, { targets: TARGETS, scope: "global" });
    expect(screen.getByText("deep-research")).toBeTruthy();
    expect(screen.getByText("全局")).toBeTruthy();
  });

  it("说明文案带项目名：项目档用所属项目名", () => {
    mount(ENTRY, { projectLabel: "Beta" });
    expect(screen.getByText("将立即在 Beta 的新会话中运行")).toBeTruthy();
  });

  it("说明文案带项目名：全局档用选中的「运行于」项目名", () => {
    mount(GLOBAL_ENTRY, {
      targets: TARGETS,
      scope: "global",
      defaultTargetKey: resolveAutomationWorkspaceSelectionKey(ALPHA),
    });
    expect(screen.getByText("将立即在 Alpha 的新会话中运行")).toBeTruthy();
  });

  it("pending 时禁用提交按钮，且点击不再发起", () => {
    const { onSubmit } = mount(GLOBAL_ENTRY, {
      targets: TARGETS,
      scope: "global",
      defaultTargetKey: resolveAutomationWorkspaceSelectionKey(ALPHA),
      pending: true,
    });
    const submit = screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("行内错误区按 reason 出标题，并把服务端 message 放进 mono 块", () => {
    const error: SavedWorkflowLaunchError = {
      reason: "compile_failed",
      code: "fault.command.savedWorkflowStartRejected.compile_failed",
      message: "line 3: boom",
    };
    mount(GLOBAL_ENTRY, { targets: TARGETS, scope: "global", error });
    const region = screen.getByTestId(TID_WORKFLOW_LAUNCH_ERROR);
    expect(region.textContent).toContain("工作流脚本编译失败");
    expect(region.textContent).toContain("line 3: boom");
  });

  it("能力缺席错误映射到 unsupported 文案；无 message 时不渲染 mono 块", () => {
    const error: SavedWorkflowLaunchError = {
      reason: "unsupported",
      code: "fault.command.capabilityUnsupported",
    };
    mount(GLOBAL_ENTRY, { targets: TARGETS, scope: "global", error });
    const region = screen.getByTestId(TID_WORKFLOW_LAUNCH_ERROR);
    expect(region.textContent).toContain("当前 agent 不支持直接启动工作流");
    expect(region.querySelector("pre")).toBeNull();
  });

  it("只有「运行于」与实参字段在滚动区内；说明、错误区、按钮钉在滚动区外", () => {
    const error: SavedWorkflowLaunchError = {
      reason: "compile_failed",
      code: "fault.command.savedWorkflowStartRejected.compile_failed",
      message: "line 3: boom",
    };
    mount(MANY_ARGS_ENTRY, { targets: TARGETS, scope: "global", projectLabel: "Alpha", error });
    const dialog = screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG);
    const fields = screen.getByTestId(TID_WORKFLOW_LAUNCH_FIELDS);
    expect(dialog.contains(fields)).toBe(true);
    // 滚动区内：「运行于」与全部 40 个实参字段。
    expect(fields.contains(screen.getByTestId(TID_WORKFLOW_LAUNCH_TARGET))).toBe(true);
    for (const name of Object.keys(MANY_ARGS)) {
      expect(fields.contains(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, name)))).toBe(true);
    }
    // 滚动区外、窗口内：名字、说明文案、错误区、取消与提交——实参再多它们也不会被顶出视口。
    const pinned = [
      screen.getByText("arg-overflow"),
      screen.getByText("将立即在 Alpha 的新会话中运行"),
      screen.getByTestId(TID_WORKFLOW_LAUNCH_ERROR),
      screen.getByText("取消"),
      screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT),
    ];
    for (const element of pinned) {
      expect(dialog.contains(element)).toBe(true);
      expect(fields.contains(element)).toBe(false);
    }
  });

  it("没有「运行于」也没有实参时不渲染滚动区", () => {
    mount({ ...GLOBAL_ENTRY, scope: "project" });
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeTruthy();
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_FIELDS)).toBeNull();
  });

  it("校验失败：第一个出错字段被滚进视野并拿到焦点", () => {
    const { onSubmit } = mount(MANY_ARGS_ENTRY, { targets: TARGETS, scope: "global" });
    const required = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, MANY_ARGS_REQUIRED));
    const json = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, MANY_ARGS_JSON));
    fireEvent.change(json, { target: { value: "{oops" } });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).not.toHaveBeenCalled();
    // 两个字段都出错：按声明顺序取第一个（必填项），而不是后面的 json。
    expect(document.activeElement).toBe(required);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const revealed = scrollIntoView.mock.contexts[0] as HTMLElement;
    // 滚进视野的是整行（标签 + 控件 + 错误文案），不只是输入框本身。
    expect(revealed.contains(required)).toBe(true);
    expect(revealed.textContent).toContain("必填");
    expect(revealed.contains(json)).toBe(false);

    // 修掉第一个后再提交：轮到下一个出错字段。
    fireEvent.change(required, { target: { value: "prod" } });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(json);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("校验通过时不滚动", () => {
    const { onSubmit } = mount(ENTRY);
    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "branch")), {
      target: { value: "main" },
    });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
