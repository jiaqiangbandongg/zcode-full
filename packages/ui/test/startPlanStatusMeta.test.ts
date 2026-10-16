// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveStartPlanStatusMetaState,
  StartPlanStatusMeta,
} from "@/settings/model-provider-section/CodingPlanStatusMeta.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        values?.date ? `${id} ${values.date}` : id,
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StartPlanStatusMeta", () => {
  it("排期尚未到达时显示待生效和过期时间，不显示刷新按钮", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00+08:00"));

    const { container } = render(
      createElement(StartPlanStatusMeta, {
        expireTime: "2026-09-02T09:00:00+08:00",
        entitlements: [
          {
            entitlementId: "scheduled",
            effectiveTime: "2026-09-01T20:00:00+08:00",
          },
        ],
        hasQuota: false,
        onRefresh: vi.fn(),
      }),
    );

    expect(container.textContent).toContain("settings.modelProvider.startPlan.pendingUntil");
    expect(container.textContent).toContain("settings.modelProvider.startPlan.expiresAt");
    expect(
      screen.queryByRole("button", {
        name: "settings.modelProvider.startPlan.refreshEntitlement",
      }),
    ).toBeNull();
  });

  it("排期已到但尚无额度桶时显示刷新权益按钮，点击后调用刷新链路", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T20:01:00+08:00"));
    const onRefresh = vi.fn();

    const { container } = render(
      createElement(StartPlanStatusMeta, {
        expireTime: "2026-09-02T09:00:00+08:00",
        entitlements: [
          {
            entitlementId: "scheduled",
            effectiveTime: "2026-09-01T20:00:00+08:00",
          },
        ],
        hasQuota: false,
        onRefresh,
      }),
    );

    const refreshButton = screen.getByRole("button", {
      name: "settings.modelProvider.startPlan.refreshEntitlement",
    });
    expect(refreshButton.className).toContain("rounded-full");
    expect(refreshButton.dataset.variant).toBe("outline");
    expect(refreshButton.className).toContain("border-success/30");
    expect(refreshButton.className).toContain("bg-success/14");
    expect(refreshButton.className).toContain("text-success");
    expect(refreshButton.className).toContain("hover:bg-success/20");
    expect(refreshButton.querySelector(".lucide-refresh-cw")).not.toBeNull();
    fireEvent.click(refreshButton);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("settings.modelProvider.startPlan.pendingUntil");
    expect(container.textContent).toContain("settings.modelProvider.startPlan.expiresAt");
    expect(container.textContent?.indexOf("refreshEntitlement")).toBeLessThan(
      container.textContent?.indexOf("expiresAt") ?? -1,
    );
  });

  it("页面停留期间到达排期时间会自动把待生效切换为刷新按钮", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T19:59:00+08:00"));

    render(
      createElement(StartPlanStatusMeta, {
        expireTime: "2026-09-02T09:00:00+08:00",
        entitlements: [
          {
            entitlementId: "scheduled",
            effectiveTime: "2026-09-01T20:00:00+08:00",
          },
        ],
        hasQuota: false,
        onRefresh: vi.fn(),
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(60_001);
    });

    expect(
      screen.getByRole("button", {
        name: "settings.modelProvider.startPlan.refreshEntitlement",
      }),
    ).toBeTruthy();
  });

  it("刷新拿到额度桶后隐藏按钮，立即生效权益也始终不显示按钮", () => {
    const scheduledEntitlements = [
      {
        entitlementId: "scheduled",
        effectiveTime: "2026-09-01T20:00:00+08:00",
      },
    ];
    const now = new Date("2026-09-01T20:01:00+08:00").getTime();

    expect(
      resolveStartPlanStatusMetaState({
        entitlements: scheduledEntitlements,
        hasQuota: true,
        now,
      }),
    ).toBe("settled");
    expect(
      resolveStartPlanStatusMetaState({
        entitlements: [
          {
            entitlementId: "immediate",
            effectiveTime: "1970-01-01T00:00:00.000Z",
          },
        ],
        hasQuota: false,
        now,
      }),
    ).toBe("settled");
  });

  it("刷新期间禁用刷新权益按钮", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T20:01:00+08:00"));

    render(
      createElement(StartPlanStatusMeta, {
        expireTime: "2026-09-02T09:00:00+08:00",
        entitlements: [
          {
            entitlementId: "scheduled",
            effectiveTime: "2026-09-01T20:00:00+08:00",
          },
        ],
        hasQuota: false,
        refreshing: true,
        onRefresh: vi.fn(),
      }),
    );

    expect(
      screen
        .getByRole("button", {
          name: "settings.modelProvider.startPlan.refreshEntitlement",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
