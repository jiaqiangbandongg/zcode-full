import { describe, expect, it } from "vitest";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";

const messages: Record<string, string> = {
  "settings.memory.viewer.updated.justNow": "刚刚",
  "settings.memory.viewer.updated.minutesAgo": "{count} 分钟前",
  "settings.memory.viewer.updated.today": "今天 {time}",
  "settings.memory.viewer.updated.yesterday": "昨天 {time}",
  "settings.memory.viewer.updated.weekday": "{weekday} {time}",
  "settings.memory.viewer.updated.weekdayZh": "周{weekday}",
  "settings.memory.viewer.updated.date": "{date} {time}",
  "settings.memory.viewer.updated.dateMonthDay": "{month} 月 {day} 日",
  "settings.memory.viewer.updated.dateYearMonthDay": "{year} 年 {month} 月 {day} 日",
};

const formatMessage: IntlInstance["formatMessage"] = ({ id }, values) => {
  let message = messages[id] ?? id;
  for (const [key, value] of Object.entries(values ?? {})) {
    message = message.replaceAll(`{${key}}`, String(value));
  }
  return message;
};

const now = new Date(2026, 7, 7, 22, 32).getTime();

function format(value: Date): string {
  return formatMemoryUpdatedAt({
    formatMessage,
    locale: "zh-CN",
    now,
    updatedAt: value.getTime(),
  });
}

describe("formatMemoryUpdatedAt", () => {
  it.each([
    [new Date(2026, 7, 7, 22, 31, 31), "刚刚"],
    [new Date(2026, 7, 7, 22, 20), "12 分钟前"],
    [new Date(2026, 7, 7, 22, 2), "今天 22:02"],
    [new Date(2026, 7, 6, 22, 32), "昨天 22:32"],
    [new Date(2026, 7, 3, 9, 5), "周一 09:05"],
    [new Date(2026, 6, 20, 9, 5), "7 月 20 日 09:05"],
    [new Date(2025, 11, 18, 9, 5), "2025 年 12 月 18 日 09:05"],
  ])("按时间分段格式化 %s", (updatedAt, expected) => {
    expect(format(updatedAt)).toBe(expected);
  });

  it("未来时间按刚刚处理", () => {
    expect(format(new Date(2026, 7, 7, 22, 40))).toBe("刚刚");
  });
});
