import { describe, expect, it } from "vitest";
import type { ZCodeConfigOption } from "@zcode/shared";
import {
  getNextThoughtLevelValue,
  getThoughtLevelLabel,
  isNoThoughtLevel,
} from "@/chat-input-toolbar/thoughtLevelOptions.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

const option: ZCodeConfigOption = {
  id: "thought_level",
  category: "thought_level",
  type: "select",
  currentValue: "",
};
const expectedLabels = [
  [["disabled", "false", "no", "none", "nothink", "no-think", "no_think", "off"], "关闭", "Off"],
  [["enable", "enabled", "on", "true"], "开启", "On"],
  [["minimal"], "极低", "Minimal"],
  [["low"], "低", "Low"],
  [["medium"], "中", "Medium"],
  [["high"], "高", "High"],
  [["xhigh", "extra-high", "extra_high"], "极高", "Extra high"],
  [["max"], "最高", "Max"],
  [["ultra"], "极致", "Ultra"],
] as const;

describe.each([
  ["zh-CN", zhCN, 1],
  ["en-US", enUS, 2],
] as const)("思考档位 %s", (_locale, messages, column) => {
  const intl = { formatMessage: ({ id }: { id: string }) => messages[id] ?? id };
  for (const row of expectedLabels) {
    it.each(row[0])("%s 使用约定文案且不改原始值", (value) => {
      const entry = Object.freeze({ value: ` ${value.toUpperCase()} `, name: "原始名称" });
      expect(getThoughtLevelLabel(intl, "glm", option, entry)).toBe(row[column]);
      expect(entry.value).toBe(` ${value.toUpperCase()} `);
    });
  }
  it.each([
    "light",
    "shallow",
    "balanced",
    "default",
    "normal",
    "standard",
    "deep",
    "maximum",
    "very-high",
    "very_high",
    "custom",
    "constructor",
    "__proto__",
  ])("%s 保留来源名称", (value) => {
    expect(getThoughtLevelLabel(intl, "glm", option, { value, name: `来源 ${value}` })).toBe(
      `来源 ${value}`,
    );
  });
});

describe("思考档位配置顺序", () => {
  // 自定义顺序刻意不符合旧名称 rank，证明循环不再暗中重排。
  const values = [
    "custom",
    "high",
    "minimal",
    "off",
    "low",
    "max",
    "ultra",
    "extra-high",
    "extra_high",
  ];
  const options = values.map((value) => ({ value, name: value }));
  it.each(values)("从 %s 按配置顺序循环", (currentValue) => {
    expect(getNextThoughtLevelValue({ ...option, currentValue, options })).toBe(
      values[(values.indexOf(currentValue) + 1) % values.length],
    );
    expect(options.map((entry) => entry.value)).toEqual(values);
  });
  it.each(["", "missing"])("%s 从配置首项开始", (currentValue) => {
    expect(getNextThoughtLevelValue({ ...option, currentValue, options })).toBe("custom");
  });
  it("零档和单档不循环", () => {
    expect(getNextThoughtLevelValue({ ...option, options: [] })).toBeNull();
    expect(getNextThoughtLevelValue({ ...option, options: options.slice(0, 1) })).toBeNull();
  });
  it("仅关闭类 value 是零强度，不从来源名称猜测", () => {
    expect(isNoThoughtLevel({ value: " NOTHINK ", name: "自定义名称" })).toBe(true);
    expect(isNoThoughtLevel({ value: "custom", name: "off" })).toBe(false);
    expect(isNoThoughtLevel({ value: "minimal", name: "none" })).toBe(false);
  });
});
