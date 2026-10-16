import { describe, expect, it } from "vitest";
import {
  getAvailableModesFromConfigOptions,
  getCurrentModeIdFromConfigOptions,
  getModeLabelFromConfigOptions,
  getPlanToolPayload,
  resolveProviderNativeModeIdFromSemantic,
} from "../src/lib/planModeTool.js";

describe("planModeTool", () => {
  it.each(["full-auto", "full_auto"])("keeps %s as a YOLO alias, not Guarded", (alias) => {
    const configOptions = [{
      id: "mode", name: "Mode", category: "mode", type: "select" as const,
      currentValue: "guarded",
      options: [{ value: "guarded", name: "Guarded" }, { value: "yolo", name: "YOLO" }],
    }];
    expect(resolveProviderNativeModeIdFromSemantic(configOptions, alias)).toBe("yolo");
    expect(resolveProviderNativeModeIdFromSemantic(configOptions, "guarded")).toBe("guarded");
    const legacyOptions = [{ ...configOptions[0], options: [{ value: alias, name: "YOLO" }] }];
    expect(resolveProviderNativeModeIdFromSemantic(legacyOptions, "yolo")).toBe(alias);
    expect(resolveProviderNativeModeIdFromSemantic(legacyOptions, "guarded")).toBe("guarded");
  });

  it("parses structured update_plan payloads into ordered plan steps", () => {
    const parsed = getPlanToolPayload({
      title: "update_plan",
      input: {
        explanation: "先同步计划，再开始实现。",
        plan: [
          { step: "梳理现有协议", status: "completed" },
          { step: "实现计划面板", status: "in_progress" },
          { step: "补充验证", status: "pending" },
        ],
      },
    });

    expect(parsed?.summary).toBe("先同步计划，再开始实现。");
    expect(parsed?.steps.map((step) => ({ title: step.title, status: step.status }))).toEqual([
      { title: "梳理现有协议", status: "completed" },
      { title: "实现计划面板", status: "in_progress" },
      { title: "补充验证", status: "pending" },
    ]);
  });

  it("parses markdown plans from plan mode tools", () => {
    const parsed = getPlanToolPayload({
      title: "EnterPlanMode",
      input: {
        plan: "# 计划\n\n- 对照现有工具链路\n- 渲染差异化计划面板\n- 增加交互切换",
      },
    });

    expect(parsed?.summary).toBe("计划");
    expect(parsed?.steps.map((step) => step.title)).toEqual([
      "对照现有工具链路",
      "渲染差异化计划面板",
      "增加交互切换",
    ]);
  });

  it("derives mode metadata from config options", () => {
    const configOptions = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select" as const,
        currentValue: "plan",
        options: [
          { value: "default", name: "Default" },
          { value: "plan", name: "Plan Mode" },
        ],
      },
    ];

    expect(getCurrentModeIdFromConfigOptions(configOptions)).toBe("plan");
    expect(getModeLabelFromConfigOptions(configOptions, "plan")).toBe("Plan Mode");
    expect(getAvailableModesFromConfigOptions(configOptions)).toEqual([
      { id: "default", name: "Default", description: undefined },
      { id: "plan", name: "Plan Mode", description: undefined },
    ]);
  });

  it("keeps edit as a first-class semantic mode", () => {
    const configOptions = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select" as const,
        currentValue: "edit",
        options: [
          { value: "build", name: "Ask before changes" },
          { value: "edit", name: "Edit automatically" },
        ],
      },
    ];

    expect(getCurrentModeIdFromConfigOptions(configOptions)).toBe("edit");
    expect(getModeLabelFromConfigOptions(configOptions, "edit")).toBe("Edit automatically");
    expect(resolveProviderNativeModeIdFromSemantic(configOptions, "edit", "glm")).toBe("edit");
  });

  it("does not map retired provider-native agent mode ids", () => {
    const configOptions = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select" as const,
        currentValue: "agent",
        options: [
          { value: "agent", name: "Agent" },
          { value: "agent-full-access", name: "Agent (full access)" },
        ],
      },
    ];

    expect(resolveProviderNativeModeIdFromSemantic(configOptions, "default")).toBe("default");
    expect(
      resolveProviderNativeModeIdFromSemantic(configOptions, "bypassPermissions", "gemini"),
    ).toBe("bypassPermissions");
  });
});
