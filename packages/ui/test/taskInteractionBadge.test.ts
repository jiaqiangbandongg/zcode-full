import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ZCodeTaskPendingInteraction } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  TaskInteractionBadge,
  getTaskInteractionBadgePresentation,
} from "../src/TaskInteractionBadge.js";

const countdown: ZCodeTaskPendingInteraction = {
  interactionId: "ask-1",
  kind: "userInput",
  toolName: "AskUserQuestion",
  autoResolution: {
    state: "visibleCountdown",
    startedAt: 0,
    visibleAt: 60_000,
    deadlineAt: 300_000,
  },
};

describe("TaskInteractionBadge", () => {
  it("keeps the first minute static, then derives absolute four-minute progress", () => {
    expect(getTaskInteractionBadgePresentation(countdown, false, 0)).toEqual({
      kind: "userInput",
      canSnooze: true,
    });
    expect(getTaskInteractionBadgePresentation(countdown, false, 59_000)).toEqual({
      kind: "userInput",
      canSnooze: true,
    });
    expect(getTaskInteractionBadgePresentation(countdown, false, 60_000)).toEqual({
      kind: "userInput",
      countdownProgress: 1,
      canSnooze: true,
    });
    expect(getTaskInteractionBadgePresentation(countdown, false, 180_000)).toEqual({
      kind: "userInput",
      countdownProgress: 0.5,
      canSnooze: true,
    });
    expect(getTaskInteractionBadgePresentation(countdown, false, 300_000)).toEqual({
      kind: "userInput",
      countdownProgress: 0,
      canSnooze: true,
    });
  });

  it("returns to a static full pill after snooze and never animates permissions", () => {
    expect(
      getTaskInteractionBadgePresentation(
        {
          interactionId: "ask-1",
          kind: "userInput",
          toolName: "AskUserQuestion",
          autoResolution: { state: "snoozed", startedAt: 0, snoozedAt: 299_000 },
        },
        false,
        300_000,
      ),
    ).toEqual({ kind: "userInput", canSnooze: false });
    expect(
      getTaskInteractionBadgePresentation(
        { interactionId: "permission-1", kind: "permission" },
        false,
        300_000,
      ),
    ).toEqual({ kind: "permission", canSnooze: false });
    expect(
      getTaskInteractionBadgePresentation(
        { interactionId: "exit-plan-1", kind: "userInput", toolName: "ExitPlanMode" },
        false,
        300_000,
      ),
    ).toEqual({ kind: "permission", canSnooze: false });
  });

  it("uses toolName for Ask identity and autoResolution as the old-summary fallback", () => {
    expect(
      getTaskInteractionBadgePresentation(
        { interactionId: "ask-new", kind: "userInput", toolName: "AskUserQuestion" },
        false,
        0,
      ),
    ).toEqual({ kind: "userInput", canSnooze: true });
    expect(
      getTaskInteractionBadgePresentation(
        {
          interactionId: "ask-old",
          kind: "userInput",
          autoResolution: {
            state: "hiddenGrace",
            startedAt: 0,
            visibleAt: 60_000,
            deadlineAt: 300_000,
          },
        },
        false,
        0,
      ),
    ).toEqual({ kind: "userInput", canSnooze: true });
  });

  it("keeps waiting/stop copy centered above a left-anchored fill in both locales", () => {
    const render = (locale: "zh-CN" | "en-US") =>
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: locale },
          createElement(TaskInteractionBadge, {
            interaction: countdown,
            now: 180_000,
            onSnoozeCountdown: () => true,
            formatMessage: (id: string) => {
              if (id === "taskList.permissionTag" || id === "taskList.userInputTag") {
                return locale === "zh-CN" ? "等待确认" : "Awaiting approval";
              }
              if (id === "taskList.stopCountdown") {
                return locale === "zh-CN" ? "停止计时" : "Stop timer";
              }
              return id;
            },
          }),
        ),
      );

    const zh = render("zh-CN");
    expect(zh).toContain("等待确认");
    expect(zh).toContain("停止计时");
    expect(zh).toContain('aria-label="停止计时"');
    expect(zh).toContain('data-countdown-snoozable="true"');
    expect(zh).toContain('data-countdown-progress="0.500"');
    expect(zh).toContain("origin-left");
    expect(zh).toContain("absolute inset-0");
    expect(zh).toContain("relative z-1 grid whitespace-nowrap");
    expect(zh).toContain("bg-interaction-confirmation-surface");
    expect(zh).toContain("text-interaction-confirmation-foreground");
    expect(zh).toContain("text-ui-sm");
    expect(zh).toContain("bg-interaction-ask-fill");
    expect(zh).toContain("hover:bg-secondary");
    expect(render("en-US")).toContain("Awaiting approval");
    expect(render("en-US")).toContain("Stop timer");
  });

  it("keeps permissions static even when a snooze callback is present", () => {
    const html = renderToStaticMarkup(
      createElement(TaskInteractionBadge, {
        interaction: { interactionId: "permission-1", kind: "permission" },
        now: 180_000,
        onSnoozeCountdown: () => true,
        formatMessage: (id: string) => (id === "taskList.permissionTag" ? "等待确认" : "停止计时"),
      }),
    );

    expect(html).toContain("等待确认");
    expect(html).not.toContain("停止计时");
    expect(html).not.toContain("data-countdown-snoozable");
    expect(html).toContain("bg-interaction-confirmation-surface");
    expect(html).toContain("text-interaction-confirmation-foreground");
  });

  it("keeps a snoozed Ask badge green and static until the interaction resolves", () => {
    const html = renderToStaticMarkup(
      createElement(TaskInteractionBadge, {
        interaction: {
          interactionId: "ask-1",
          kind: "userInput",
          toolName: "AskUserQuestion",
          autoResolution: { state: "snoozed", startedAt: 0, snoozedAt: 299_000 },
        },
        now: 300_000,
        onSnoozeCountdown: () => true,
        formatMessage: (id: string) => (id === "taskList.userInputTag" ? "等待确认" : "停止计时"),
      }),
    );

    expect(html).toContain("等待确认");
    expect(html).toContain("bg-interaction-confirmation-surface");
    expect(html).toContain("text-ui-sm");
    expect(html).not.toContain("停止计时");
    expect(html).not.toContain("data-countdown-snoozable");
  });
});
