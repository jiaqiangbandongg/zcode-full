import { describe, expect, it } from "vitest";
import {
  formatOffPeakRemainingWait,
  resolveFailedOffPeakQueueFooter,
  resolveOffPeakCreateBlockReason,
  resolveLocalizedOffPeakCreateTitle,
  resolveOffPeakStatusFooter,
  shouldShowOffPeakModelSelectionIssue,
} from "@/settings/offPeakUiPresentation.js";

const remainingWaitMessages: Record<string, string> = {
  "offPeak.create.remaining.hoursMinutes": "{hours} 小时 {minutes} 分钟",
  "offPeak.create.remaining.hours": "{hours} 小时",
  "offPeak.create.remaining.minutes": "{minutes} 分钟",
  "offPeak.create.remaining.lessThanMinute": "不到 1 分钟",
};
const remainingWaitIntl = {
  formatMessage({ id }: { id: string }, values?: Record<string, string | number>) {
    let message = remainingWaitMessages[id] ?? id;
    for (const [key, value] of Object.entries(values ?? {})) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
    return message;
  },
};

describe("resolveLocalizedOffPeakCreateTitle", () => {
  it("updates an untouched localized default when the locale changes", () => {
    expect(
      resolveLocalizedOffPeakCreateTitle({
        currentTitle: "未命名",
        hasInitialTitle: false,
        isEditing: false,
        nextDefaultTitle: "Untitled",
        previousDefaultTitle: "未命名",
        titleTouched: false,
      }),
    ).toBe("Untitled");
  });

  it.each([
    { hasInitialTitle: false, isEditing: false, titleTouched: true },
    { hasInitialTitle: true, isEditing: false, titleTouched: false },
    { hasInitialTitle: false, isEditing: true, titleTouched: false },
  ])("preserves user, template, and persisted titles: %o", (state) => {
    expect(
      resolveLocalizedOffPeakCreateTitle({
        currentTitle: "用户标题",
        nextDefaultTitle: "Untitled",
        previousDefaultTitle: "未命名",
        ...state,
      }),
    ).toBe("用户标题");
  });
});

describe("resolveOffPeakCreateBlockReason", () => {
  it.each([
    ["idle", undefined, "unavailable"],
    ["loading", undefined, "unavailable"],
    ["error", undefined, "unavailable"],
    ["ready", false, "quota"],
    ["ready", true, null],
  ] as const)(
    "fails closed for availability status %s / %s",
    (availabilityStatus, canTakeNumber, expected) => {
      expect(
        resolveOffPeakCreateBlockReason({
          availabilityStatus,
          canTakeNumber,
          grayEnabled: true,
          noPlan: false,
        }),
      ).toBe(expected);
    },
  );

  it("prioritizes ineligibility and ignores admission when the feature is hidden", () => {
    expect(
      resolveOffPeakCreateBlockReason({
        availabilityStatus: "ready",
        canTakeNumber: true,
        grayEnabled: true,
        noPlan: true,
      }),
    ).toBe("plan");
    expect(
      resolveOffPeakCreateBlockReason({
        availabilityStatus: "error",
        canTakeNumber: undefined,
        grayEnabled: true,
        noPlan: true,
      }),
    ).toBe("unavailable");
    expect(
      resolveOffPeakCreateBlockReason({
        availabilityStatus: "error",
        canTakeNumber: undefined,
        grayEnabled: false,
        noPlan: false,
      }),
    ).toBeNull();
  });
});

describe("shouldShowOffPeakModelSelectionIssue", () => {
  it.each([
    ["queued", true],
    ["paused", true],
    ["running", true],
    ["completed", false],
    ["failed", false],
    ["cancelled", false],
  ] as const)("只对仍可能执行的 %s 任务显示修复提示", (status, expected) => {
    expect(shouldShowOffPeakModelSelectionIssue(status)).toBe(expected);
  });
});

describe("formatOffPeakRemainingWait", () => {
  const now = 1_000_000;

  it.each([
    [125 * 60_000, "2 小时 5 分钟"],
    [120 * 60_000, "2 小时"],
    [42 * 60_000, "42 分钟"],
  ])("formats a %i ms wait with hour/minute granularity", (waitMs, expected) => {
    expect(formatOffPeakRemainingWait(now + waitMs, now, remainingWaitIntl)).toBe(expected);
  });

  it("rounds a positive partial minute up", () => {
    const label = formatOffPeakRemainingWait(now + 60_001, now, remainingWaitIntl);

    expect(label).toBe("2 分钟");
  });

  it("uses a sub-minute label once the recovery point is reached", () => {
    expect(formatOffPeakRemainingWait(now, now, remainingWaitIntl)).toBe("不到 1 分钟");
  });
});

describe("resolveOffPeakStatusFooter", () => {
  it("uses pause for paused tasks even when a queue position is present", () => {
    expect(resolveOffPeakStatusFooter({ status: "paused", queuePosition: 1 })).toMatchObject({
      icon: "pause",
      className: "text-idle-task",
      labelId: "offPeak.badge.pausedPosition",
    });
  });

  it("keeps moon for queued tasks and warning for failures", () => {
    expect(resolveOffPeakStatusFooter({ status: "queued", queuePosition: 2 }).icon).toBe("moon");
    expect(resolveOffPeakStatusFooter({ status: "failed" }).icon).toBe("warning");
  });
});

describe("resolveFailedOffPeakQueueFooter", () => {
  it("retains a failed task's queue position as a secondary status", () => {
    expect(resolveFailedOffPeakQueueFooter({ status: "failed", queuePosition: 212 })).toMatchObject(
      {
        icon: "moon",
        className: "text-idle-task",
        labelId: "offPeak.badge.queuePosition",
        labelValues: { position: "212" },
      },
    );
  });

  it("does not add a secondary status without both failure and a queue position", () => {
    expect(resolveFailedOffPeakQueueFooter({ status: "failed" })).toBeNull();
    expect(resolveFailedOffPeakQueueFooter({ status: "queued", queuePosition: 212 })).toBeNull();
  });
});

describe("off-peak terminal status presentation", () => {
  it("completed tasks resolve to the terminal status footer", () => {
    expect(resolveOffPeakStatusFooter({ status: "completed" })).toMatchObject({
      icon: "success",
      className: "text-foreground-subtle",
      labelId: "offPeak.status.completed",
    });
  });
});
