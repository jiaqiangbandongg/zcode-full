import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const automationEditViewSource = readFileSync(
  new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
  "utf8",
);

describe("AutomationEditView Custom Repeat E2E 契约", () => {
  it("提供 0–200 的可输入频率、统一步进按钮，并保留分钟和重新编辑入口", () => {
    // 回归保护：频率不能重新退回只能选择 1–31 的下拉框，分钟也不能只在组件默认值里存在而被调用方隐藏。
    expect(automationEditViewSource).toContain(
      "const CUSTOM_REPEAT_INTERVAL_INPUT_MIN = 0;",
    );
    expect(automationEditViewSource).toContain(
      "const CUSTOM_REPEAT_INTERVAL_MAX = 200;",
    );
    expect(automationEditViewSource).toMatch(
      /<Input[\s\S]*?type="number"[\s\S]*?min=\{CUSTOM_REPEAT_INTERVAL_INPUT_MIN\}[\s\S]*?max=\{CUSTOM_REPEAT_INTERVAL_MAX\}[\s\S]*?data-testid=\{TID_AUTOMATION_CUSTOM_INTERVAL_SELECT\}/,
    );
    expect(automationEditViewSource).toContain(
      "data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT}",
    );
    expect(automationEditViewSource).toContain(
      "data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT}",
    );
    expect(automationEditViewSource).toContain("[appearance:textfield]");
    expect(automationEditViewSource).toMatch(/value="minute"[\s\S]*?value="hourly"/);
    expect(automationEditViewSource).not.toContain("includeMinuteUnit={false}");
    expect(automationEditViewSource).toContain("data-testid={TID_AUTOMATION_CUSTOM_REPEAT_EDIT}");
  });
});
