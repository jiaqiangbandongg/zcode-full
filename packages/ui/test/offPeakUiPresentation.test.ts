import { readFileSync } from "node:fs";
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
  formatMessage(
    { id }: { id: string },
    values?: Record<string, string | number>,
  ) {
    let message = remainingWaitMessages[id] ?? id;
    for (const [key, value] of Object.entries(values ?? {})) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
    return message;
  },
};

const offPeakTaskListSource = readFileSync(
  new URL("../src/settings/OffPeakTaskList.tsx", import.meta.url),
  "utf8",
);
const automationsSectionSource = readFileSync(
  new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
  "utf8",
);
// 页标题自 docs/dynamic-workflow/launch.md 起就是「自动化 / 工作流」切换本身，30/34 的 Figma 标题层级
// 随之搬到 AutomationsPageTitleSwitch；AutomationsSection 只保留紧凑说明段。
const automationsPageTitleSwitchSource = readFileSync(
  new URL("../src/settings/saved-workflows/AutomationsPageTitleSwitch.tsx", import.meta.url),
  "utf8",
);
const automationScheduleBadgeSource = readFileSync(
  new URL("../src/settings/AutomationScheduleBadge.tsx", import.meta.url),
  "utf8",
);
const offPeakEditViewSource = readFileSync(
  new URL("../src/settings/OffPeakEditView.tsx", import.meta.url),
  "utf8",
);
const stylesSource = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
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
  ])(
    "formats a %i ms wait with hour/minute granularity",
    (waitMs, expected) => {
      expect(
        formatOffPeakRemainingWait(now + waitMs, now, remainingWaitIntl),
      ).toBe(expected);
    },
  );

  it("rounds a positive partial minute up and avoids calendar dates", () => {
    const label = formatOffPeakRemainingWait(
      now + 60_001,
      now,
      remainingWaitIntl,
    );

    expect(label).toBe("2 分钟");
    expect(label).not.toMatch(/[年月日]/);
  });

  it("uses a sub-minute label once the recovery point is reached", () => {
    expect(formatOffPeakRemainingWait(now, now, remainingWaitIntl)).toBe(
      "不到 1 分钟",
    );
  });

});

describe("idle-time quota tooltip wiring", () => {
  it("uses the remote remaining-wait implementation and advances it by minute", () => {
    expect(automationsSectionSource).toContain(
      "time: formatOffPeakRemainingWait(",
    );
    expect(automationsSectionSource).toContain(
      "const remainderMs = remainingMs % minuteMs;",
    );
    expect(automationsSectionSource).not.toContain(
      "new Intl.DateTimeFormat(locale",
    );
  });
});

describe("resolveOffPeakStatusFooter", () => {
  it("uses pause for paused tasks even when a queue position is present", () => {
    expect(
      resolveOffPeakStatusFooter({ status: "paused", queuePosition: 1 }),
    ).toMatchObject({
      icon: "pause",
      className: "text-idle-task",
      labelId: "offPeak.badge.pausedPosition",
    });
  });

  it("keeps moon for queued tasks and warning for failures", () => {
    expect(
      resolveOffPeakStatusFooter({ status: "queued", queuePosition: 2 }).icon,
    ).toBe("moon");
    expect(resolveOffPeakStatusFooter({ status: "failed" }).icon).toBe(
      "warning",
    );
  });
});

describe("resolveFailedOffPeakQueueFooter", () => {
  it("retains a failed task's queue position as a secondary status", () => {
    expect(
      resolveFailedOffPeakQueueFooter({ status: "failed", queuePosition: 212 }),
    ).toMatchObject({
      icon: "moon",
      className: "text-idle-task",
      labelId: "offPeak.badge.queuePosition",
      labelValues: { position: "212" },
    });
  });

  it("does not add a secondary status without both failure and a queue position", () => {
    expect(resolveFailedOffPeakQueueFooter({ status: "failed" })).toBeNull();
    expect(
      resolveFailedOffPeakQueueFooter({ status: "queued", queuePosition: 212 }),
    ).toBeNull();
  });
});

describe("idle-time and scheduled tag colors", () => {
  it("uses the Figma purple semantic tokens for idle-time queue tags", () => {
    expect(offPeakTaskListSource).toContain(
      "bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task",
    );
    expect(offPeakTaskListSource).not.toContain("bg-brand/15");
    expect(stylesSource).toContain("--color-idle-task: #9e77ed;");
    expect(stylesSource).toContain("--color-idle-task-surface: #f5f3ff;");
    expect(stylesSource).toContain("--color-idle-task: #7b5ce5;");
    expect(stylesSource).toContain("--color-idle-task-surface: #160d38;");
  });

  it("keeps scheduled task tags on the green success semantics", () => {
    expect(automationScheduleBadgeSource).toContain("bg-success/10");
    expect(automationScheduleBadgeSource).toContain("text-success");
    expect(automationScheduleBadgeSource).not.toContain("text-idle-task");
  });
});

describe("off-peak pause presentation", () => {
  it("shows the Pause queue hint and performs the action without confirmation", () => {
    const menuHintStart = offPeakTaskListSource.indexOf("function OffPeakMenuHint");
    const menuHintEnd = offPeakTaskListSource.indexOf(
      "const STATUS_ICON",
      menuHintStart,
    );
    const menuHintSource = offPeakTaskListSource.slice(menuHintStart, menuHintEnd);
    const pauseBlockStart = offPeakTaskListSource.indexOf("data-testid={TID_OFFPEAK_ACTION_PAUSE}");
    const pauseBlockEnd = offPeakTaskListSource.indexOf(
      'task.status === "paused"',
      pauseBlockStart,
    );
    const pauseBlock = offPeakTaskListSource.slice(
      pauseBlockStart,
      pauseBlockEnd,
    );

    expect(menuHintStart).toBeGreaterThanOrEqual(0);
    expect(menuHintEnd).toBeGreaterThan(menuHintStart);
    // 修复原因：提示定位逻辑已抽到 OffPeakMenuHint，调用点不再直接包含底层 Tooltip 名称。
    expect(menuHintSource).toContain("<ControlHintTooltip");
    expect(pauseBlockStart).toBeGreaterThanOrEqual(0);
    expect(pauseBlockEnd).toBeGreaterThan(pauseBlockStart);
    expect(pauseBlock).toContain("<OffPeakMenuHint");
    expect(pauseBlock).toContain('id: "offPeak.action.pauseHint"');
    expect(automationsSectionSource).not.toContain('id: "offPeak.pause.title"');
    expect(automationsSectionSource).not.toContain("handleOffPeakPause");
    expect(
      automationsSectionSource.match(
        /onPause=\{\(task\) =>\s*void offPeakPause\(\s*task\.offPeakTaskId,\s*offPeakTaskService,?\s*\)\s*\}/g,
      ),
    ).toHaveLength(2);
  });
});

describe("off-peak permission recommendation", () => {
  it("uses a neutral info toast instead of warning semantics", () => {
    const hintStart = offPeakEditViewSource.indexOf(
      'id: "offPeak.form.fullAccessHint"',
    );
    const hintEnd = offPeakEditViewSource.indexOf("});", hintStart);
    const hintToast = offPeakEditViewSource.slice(hintStart, hintEnd);

    expect(hintStart).toBeGreaterThanOrEqual(0);
    expect(hintEnd).toBeGreaterThan(hintStart);
    expect(hintToast).toContain('variant: "info"');
    expect(hintToast).not.toContain('variant: "warning"');
    expect(hintToast).toContain('position: "top-center"');
  });

  it("centers automation upgrade and running toasts", () => {
    const topCenterToastCount = automationsSectionSource.match(
      /position: "top-center"/g,
    )?.length;

    expect(topCenterToastCount).toBe(2);
    expect(automationsSectionSource).toContain(
      'anchorId: AUTOMATIONS_TOAST_ANCHOR_ID',
    );
  });
});

describe("off-peak terminal status presentation", () => {
  it("dims completed cards while preserving hover and more-actions feedback", () => {
    expect(resolveOffPeakStatusFooter({ status: "completed" })).toMatchObject({
      icon: "success",
      className: "text-foreground-subtle",
      labelId: "offPeak.status.completed",
    });
    expect(offPeakTaskListSource).toMatch(
      /task\.status === "completed"\s*\?\s*"opacity-60 hover:bg-hover"\s*:\s*"hover:bg-hover"/,
    );

    const menuTriggerStart = offPeakTaskListSource.indexOf(
      "data-testid={TID_OFFPEAK_CARD_MENU}",
    );
    const menuTriggerEnd = offPeakTaskListSource.indexOf(
      "</button>",
      menuTriggerStart,
    );
    const menuTriggerSource = offPeakTaskListSource.slice(
      menuTriggerStart,
      menuTriggerEnd,
    );

    expect(menuTriggerStart).toBeGreaterThanOrEqual(0);
    expect(menuTriggerSource).toContain("disabled={busy}");
    expect(menuTriggerSource).not.toContain('task.status === "completed"');
    expect(menuTriggerSource).not.toContain("pointer-events-none");
  });

  it("uses the shared Lucide completed icon", () => {
    expect(offPeakTaskListSource).toMatch(
      /import\s+\{[^}]*CircleCheck[^}]*\}\s+from\s+"lucide-react"/,
    );
    expect(offPeakTaskListSource).toContain("success: CircleCheck");
    expect(offPeakTaskListSource).not.toContain("off-peak-completed-check.svg");
    expect(offPeakTaskListSource).not.toContain("maskImage");
  });

  it("does not append the file-change count to task-card footers", () => {
    expect(offPeakTaskListSource).not.toContain("task.filesChanged");
    expect(offPeakTaskListSource).not.toContain("offPeak.filesChanged");
  });
});

describe("Automations list fidelity", () => {
  it("keeps the empty-state order while moving keep-awake before populated lists", () => {
    // D47：keep-awake 是全局开关，两个 tab 都展示——列表态在任务卡前、空态在大空卡后。
    expect(automationsSectionSource).toContain("{hasAnyTasks ? (");
    expect(automationsSectionSource).toContain("{!hasAnyTasks ? (");
  });

  it("uses the Figma page-title scale and a compact description", () => {
    expect(automationsPageTitleSwitchSource).toContain(
      "text-[30px] font-medium leading-[34px] tracking-[0.114px]",
    );
    expect(automationsSectionSource).toContain(
      '<p className="text-ui-base leading-5 text-foreground-subtlest">',
    );
  });
});
