import { describe, expect, it } from "vitest";
import type { FeedbackTicketStatus } from "@zcode/shared";
import {
  FEEDBACK_STATUS_MESSAGE_IDS,
  STATUS_META,
} from "@/feedback/feedbackMeta.js";
import {
  formatRelativeTime,
  formatSubmittedAt,
  STATUS_USER_HINT,
} from "@/feedback/feedbackUserView.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

function mockFormatMessage(
  descriptor: { id: string },
  values?: Record<string, string>,
) {
  const messages: Record<string, string> = {
    "feedback.time.justNow": enUS["feedback.time.justNow"],
    "feedback.time.minutesAgo": enUS["feedback.time.minutesAgo"],
    "feedback.time.hoursAgo": enUS["feedback.time.hoursAgo"],
    "feedback.time.daysAgo": enUS["feedback.time.daysAgo"],
    "feedback.time.submittedAt": enUS["feedback.time.submittedAt"],
  };
  let message = messages[descriptor.id] ?? descriptor.id;
  for (const [key, value] of Object.entries(values ?? {})) {
    message = message.replaceAll(`{${key}}`, value);
  }
  return message;
}

describe("feedback status metadata", () => {
  it("covers archived status returned by the public feedback API", () => {
    const archivedStatus = "已归档" as FeedbackTicketStatus;

    expect(STATUS_META[archivedStatus]?.className).toBeTruthy();
    expect(STATUS_META[archivedStatus]?.dot).toBeTruthy();
    expect(STATUS_USER_HINT[archivedStatus]).toContain("关闭");
    expect(FEEDBACK_STATUS_MESSAGE_IDS[archivedStatus]).toBe(
      "feedback.status.completed",
    );
  });

  it("presents the archived API status as completed to users", () => {
    expect(zhCN["feedback.status.completed"]).toBe("已完成");
    expect(enUS["feedback.status.completed"]).toBe("Completed");
  });

  // 回归：formatRelativeTime/formatSubmittedAt 兜底分支曾硬编码中文
  // （"刚刚"/"X 分钟前"），调用方必须传 formatMessage，文案跟随 locale。
  it("formats relative time and submitted label through i18n only", () => {
    const now = Date.now();
    const justNow = new Date(now - 10_000).toISOString();
    const minutesAgo = new Date(now - 5 * 60_000).toISOString();
    const submittedAt = new Date(now - 2 * 3_600_000).toISOString();

    expect(formatRelativeTime(justNow, mockFormatMessage)).toBe("just now");
    expect(formatRelativeTime(minutesAgo, mockFormatMessage)).toBe("5 min ago");
    expect(formatSubmittedAt(submittedAt, mockFormatMessage)).toBe(
      "Submitted 2 hr ago",
    );
  });
});
