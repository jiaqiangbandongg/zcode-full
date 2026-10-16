// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ContextQuotaResetOpportunityReminderContent,
  createContextQuotaResetOpportunityDismissalStore,
  resolveContextQuotaResetOpportunityReminder,
  resolveContextQuotaResetOpportunityTriggerTone,
  resolveContextTriggerTooltipKind,
  shouldDismissContextQuotaResetOpportunityReminder,
  type ContextQuotaResetOpportunityDismissal,
} from "@/chat-input-toolbar/contextQuotaResetOpportunityReminder.js";

const opportunity = {
  count: 2,
  expiresAt: 1_000_000,
  sourceKey: "provider-a",
  visible: true,
} as const;

const unread: ContextQuotaResetOpportunityDismissal = {
  initial: false,
  opportunityKey: null,
  urgent: false,
};

describe("context quota reset opportunity reminder state", () => {
  it("only dismisses the reminder when pointer down happens outside its trigger and content", () => {
    const trigger = document.createElement("span");
    const triggerChild = document.createElement("button");
    trigger.append(triggerChild);
    const reminder = document.createElement("span");
    reminder.dataset.contextResetReminder = "initial";
    const reminderChild = document.createElement("button");
    reminder.append(reminderChild);
    const outside = document.createElement("div");
    const outsideText = document.createTextNode("outside");
    outside.append(outsideText);

    expect(shouldDismissContextQuotaResetOpportunityReminder(triggerChild, trigger)).toBe(false);
    expect(shouldDismissContextQuotaResetOpportunityReminder(reminderChild, trigger)).toBe(false);
    expect(shouldDismissContextQuotaResetOpportunityReminder(outside, trigger)).toBe(true);
    expect(shouldDismissContextQuotaResetOpportunityReminder(outsideText, trigger)).toBe(true);
  });

  it("keeps a dismissed phase hidden when the conversation component remounts", () => {
    const store = createContextQuotaResetOpportunityDismissalStore();
    const reminder = resolveContextQuotaResetOpportunityReminder({
      dismissal: store.getSnapshot(),
      now: opportunity.expiresAt - 181_000,
      opportunity,
    });

    expect(reminder?.phase).toBe("initial");
    store.dismiss(reminder!);

    // 模拟切换会话后的组件重新挂载：窗口级 store 仍是同一个实例。
    expect(
      resolveContextQuotaResetOpportunityReminder({
        dismissal: store.getSnapshot(),
        now: opportunity.expiresAt - 181_000,
        opportunity,
      }),
    ).toBeNull();
    expect(
      resolveContextQuotaResetOpportunityReminder({
        dismissal: store.getSnapshot(),
        now: opportunity.expiresAt - 180_000,
        opportunity,
      })?.phase,
    ).toBe("urgent");
  });

  it("uses success before the urgent window and warning during the final three minutes", () => {
    expect(
      resolveContextQuotaResetOpportunityTriggerTone({
        now: opportunity.expiresAt - 181_000,
        opportunity,
      }),
    ).toBe("available");
    expect(
      resolveContextQuotaResetOpportunityTriggerTone({
        now: opportunity.expiresAt - 180_000,
        opportunity,
      }),
    ).toBe("urgent");
  });

  it("removes the trigger tone when the opportunity is unavailable or expired", () => {
    expect(
      resolveContextQuotaResetOpportunityTriggerTone({
        now: opportunity.expiresAt,
        opportunity,
      }),
    ).toBeNull();
    expect(
      resolveContextQuotaResetOpportunityTriggerTone({
        now: opportunity.expiresAt - 181_000,
        opportunity: { ...opportunity, visible: false },
      }),
    ).toBeNull();
  });

  it("shows a persistent initial reminder for a new opportunity", () => {
    expect(
      resolveContextQuotaResetOpportunityReminder({
        dismissal: unread,
        now: opportunity.expiresAt - 181_000,
        opportunity,
      }),
    ).toMatchObject({
      count: 2,
      phase: "initial",
      remainingSeconds: 181,
    });
  });

  it("switches to urgent exactly at three minutes even after initial dismissal", () => {
    const opportunityKey = `${opportunity.sourceKey}:${opportunity.expiresAt}`;
    expect(
      resolveContextQuotaResetOpportunityReminder({
        dismissal: { initial: true, opportunityKey, urgent: false },
        now: opportunity.expiresAt - 180_000,
        opportunity,
      }),
    ).toMatchObject({ phase: "urgent", remainingSeconds: 180 });
  });

  it("replaces an unread initial reminder with urgent content at the threshold", () => {
    expect(
      resolveContextQuotaResetOpportunityReminder({
        dismissal: unread,
        now: opportunity.expiresAt - 179_001,
        opportunity,
      })?.phase,
    ).toBe("urgent");
  });

  it("does not repeat an urgent reminder after it is dismissed", () => {
    const opportunityKey = `${opportunity.sourceKey}:${opportunity.expiresAt}`;
    expect(
      resolveContextQuotaResetOpportunityReminder({
        dismissal: { initial: true, opportunityKey, urgent: true },
        now: opportunity.expiresAt - 60_000,
        opportunity,
      }),
    ).toBeNull();
  });

  it("keeps dismissal when count changes but resets it for a new expiry", () => {
    const opportunityKey = `${opportunity.sourceKey}:${opportunity.expiresAt}`;
    const dismissal = { initial: true, opportunityKey, urgent: false } as const;
    expect(
      resolveContextQuotaResetOpportunityReminder({
        dismissal,
        now: opportunity.expiresAt - 181_000,
        opportunity: { ...opportunity, count: 3 },
      }),
    ).toBeNull();
    expect(
      resolveContextQuotaResetOpportunityReminder({
        dismissal,
        now: opportunity.expiresAt + 1_000,
        opportunity: { ...opportunity, expiresAt: opportunity.expiresAt + 300_000 },
      })?.phase,
    ).toBe("initial");
  });

  it("clears reminders for hidden, empty, or expired opportunities", () => {
    for (const candidate of [
      { ...opportunity, visible: false },
      { ...opportunity, count: 0 },
      { ...opportunity, expiresAt: 500_000 },
    ]) {
      expect(
        resolveContextQuotaResetOpportunityReminder({
          dismissal: unread,
          now: 500_000,
          opportunity: candidate,
        }),
      ).toBeNull();
    }
  });

  it("gives automatic reset status priority over opportunity phases", () => {
    expect(resolveContextTriggerTooltipKind("processing", "urgent")).toBe("reset-status");
    expect(resolveContextTriggerTooltipKind(null, "urgent")).toBe("urgent");
    expect(resolveContextTriggerTooltipKind(null, "initial")).toBe("initial");
  });
});

describe("ContextQuotaResetOpportunityReminderContent", () => {
  const intl = {
    formatMessage: ({ id }: { id: string }, values?: Record<string, unknown>) =>
      `${id}:${Object.values(values ?? {}).join(":")}`,
  } as never;

  it("renders the localized initial gift reminder", () => {
    const html = renderToStaticMarkup(
      createElement(ContextQuotaResetOpportunityReminderContent, {
        count: 2,
        intl,
        onDismiss: () => undefined,
        phase: "initial",
        remainingSeconds: 181,
      }),
    );
    expect(html).toContain("codingPlan.quotaReset.contextReminder.available:2");
    expect(html).toContain("lucide-gift");
    expect(html).toContain("text-success");
    expect(html).toContain("text-ui-sm");
    expect(html).toContain("data-context-reset-reminder-dismiss");
    expect(html).toContain('data-slot="button"');
    expect(html).toContain('data-size="icon-xs"');
    expect(html).toContain("rounded-full");
    expect(html).not.toContain("-my-1");
    expect(html).not.toContain("-mr-1");
    expect(html).toContain("lucide-x");
  });

  it("renders an animated urgent alarm with reduced-motion protection", () => {
    const html = renderToStaticMarkup(
      createElement(ContextQuotaResetOpportunityReminderContent, {
        count: 1,
        intl,
        onDismiss: () => undefined,
        phase: "urgent",
        remainingSeconds: 179,
      }),
    );
    expect(html).toContain("codingPlan.quotaReset.contextReminder.expiresIn");
    expect(html).toContain("lucide-alarm-clock");
    expect(html).toContain("animate-zcode-alarm-ring");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("text-warning");
    expect(html).toContain("bg-warning/10");
    expect(html).toContain("rounded-full");
    expect(html).toContain("text-ui-xs");
    expect(html).toContain("px-1.5");
    expect(html).toContain("h-3.5");
    expect(html).toContain("leading-none");
    expect(html).not.toContain("font-mono");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("codingPlan.quotaReset.contextReminder.dismiss");
    expect(html).toContain("data-context-reset-reminder-copy");
    expect(html).toContain("gap-0");
  });
});

describe("context quota reset opportunity reminder integration", () => {
  it("uses the shared ControlHintTooltip wrapper instead of composing tooltip primitives", () => {
    const source = readFileSync("packages/ui/src/chat-input-toolbar/contextUsage.tsx", "utf8");

    expect(source).toContain('import { ControlHintTooltip } from "@/ControlHintTooltip.js"');
    expect(source).toContain("standalone");
    expect(source).not.toContain("<TooltipProvider>");
    expect(source).not.toContain("<TooltipContent");
    expect(source).not.toContain("<TooltipTrigger");
    expect(source).not.toContain("sideOffset={6}");
    expect(source).toMatch(
      /triggerTooltipKind === "reset-status"\s*\? undefined\s*:\s*"bg-background py-0\.5 pr-0\.5"/,
    );
    expect(source).toContain('opportunityTriggerTone === "available" && "text-success"');
    expect(source).not.toContain('opportunityTriggerTone === "available" && "bg-success/10');
    expect(source).toMatch(
      /opportunityTriggerTone === "urgent"\s*&&\s*"bg-warning\/10 text-warning"/,
    );
    expect(source).toContain("useSyncExternalStore(");
    expect(source).toContain("contextQuotaResetOpportunityDismissalStore.dismiss(");
    expect(source).toContain('document.addEventListener("pointerdown"');
    expect(source).toContain("shouldDismissContextQuotaResetOpportunityReminder(");
    expect(source).toContain("triggerRef={contextUsageTriggerRef}");
    expect(source).not.toContain("useState<ContextQuotaResetOpportunityDismissal>");
  });
});
