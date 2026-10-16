import { describe, expect, it } from "vitest";
import {
  resolveChangedAutomationEditFields,
  type AutomationEditFieldSignatures,
} from "@/settings/automationEditDirtyState.js";

const initial: AutomationEditFieldSignatures = {
  title: "提醒吃饭",
  prompt: "提醒用户吃饭",
  schedule: '{"cronExpr":"0 */2 * * *"}',
  mode: "build",
  thoughtLevel: "xhigh",
  model: "provider/gpt-5.5",
};

describe("automation edit dirty state", () => {
  it("忽略用户未触碰字段的运行时归一化", () => {
    const current = {
      ...initial,
      schedule: '{"cronExpr":"0 */2 * * *","scheduleRule":null}',
      thoughtLevel: "high",
    };

    expect(
      resolveChangedAutomationEditFields({
        touchedFields: new Set(),
        current,
        baseline: initial,
      }),
    ).toEqual([]);
  });

  it("只报告用户实际修改过且值发生变化的字段", () => {
    const current = { ...initial, title: "新的提醒" };

    expect(
      resolveChangedAutomationEditFields({
        touchedFields: new Set(["title", "thoughtLevel"]),
        current,
        baseline: initial,
      }),
    ).toEqual(["title"]);
  });

  it("用户把字段改回初始值后恢复 clean", () => {
    expect(
      resolveChangedAutomationEditFields({
        touchedFields: new Set(["prompt"]),
        current: { ...initial },
        baseline: initial,
      }),
    ).toEqual([]);
  });
});
