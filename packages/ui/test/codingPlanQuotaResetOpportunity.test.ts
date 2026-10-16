// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingPlanResetType } from "@zcode/shared";
import {
  CodingPlanQuotaResetOpportunity,
  type CodingPlanQuotaResetDialogConfig,
} from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import type { CodingPlanQuotaResetDialogResetItem } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { mergeCodingPlanQuotaResetOpportunityBadges } from "@/lib/codingPlanQuotaResetUi.js";

vi.mock("@/lib/codingPlanQuotaResetConfetti.js", () => ({
  burstCodingPlanQuotaResetConfetti: vi.fn(),
}));

function renderOpportunity(props: {
  count: number;
  dialog?: CodingPlanQuotaResetDialogConfig;
  dialogOpen?: boolean;
  expiresAt: number | null;
  onDialogOpenChange?: (open: boolean) => void;
}) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(CodingPlanQuotaResetOpportunity, {
        ...props,
        placement: "inline",
        visible: true,
      }),
    ),
  );
}

function createDialogConfig(overrides: Partial<CodingPlanQuotaResetDialogConfig> = {}) {
  return {
    usageItems: [
      {
        color: "var(--color-usage-chart-1)",
        id: "five-hour",
        label: "5 小时",
        percentage: 5,
        resetTime: "19:08",
        value: "5%",
      },
      {
        color: "var(--color-usage-chart-2)",
        id: "week",
        label: "每周",
        percentage: 99,
        resetTime: "8月12日",
        value: "99%",
      },
    ],
    resetItems: [
      {
        count: 1,
        expiresAt: Date.now() + 20 * 60_000,
        onReset: vi.fn(async () => undefined),
        resetType: "FIVE_HOUR" as const,
      },
      {
        count: 1,
        expiresAt: Date.now() + 2 * 24 * 60 * 60_000,
        onReset: vi.fn(async () => undefined),
        resetType: "WEEK" as const,
      },
    ],
    ...overrides,
  } satisfies CodingPlanQuotaResetDialogConfig;
}

// 模拟 useCodingPlanQuotaResetUi 的真实时序：onReset resolve 时 store 已写入完成态，弹框 config
// 随之携带同一 status 快照里余下的机会（张数 − 1、到期取下一张；耗尽为 0 / null，但行仍在 config 中）。
function renderStatefulOpportunity(
  initialExpiries: Partial<Record<CodingPlanResetType, number[]>>,
) {
  const onReset: Record<CodingPlanResetType, ReturnType<typeof vi.fn>> = {
    FIVE_HOUR: vi.fn(),
    WEEK: vi.fn(),
  };
  function Harness() {
    const [expiries, setExpiries] = useState(initialExpiries);
    const resetItems = (Object.keys(expiries) as CodingPlanResetType[]).map(
      (resetType): CodingPlanQuotaResetDialogResetItem => {
        const remaining = expiries[resetType] ?? [];
        return {
          count: remaining.length,
          expiresAt: remaining[0] ?? null,
          onReset: async () => {
            onReset[resetType]();
            setExpiries((current) => ({
              ...current,
              [resetType]: (current[resetType] ?? []).slice(1),
            }));
          },
          resetType,
        };
      },
    );
    // 入口徽标与真实入口一致：只合并仍有张数的类型。
    const badge = mergeCodingPlanQuotaResetOpportunityBadges(
      resetItems.map((item) => ({ ...item, visible: item.count > 0 })),
    );
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(CodingPlanQuotaResetOpportunity, {
        count: badge.count,
        dialog: createDialogConfig({ resetItems }),
        expiresAt: badge.expiresAt,
        placement: "inline",
        visible: badge.visible,
      }),
    );
  }
  render(createElement(Harness));
  return onReset;
}

describe("CodingPlanQuotaResetOpportunity", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("可重置额度按钮复用任务列表等待请求的确认色", () => {
    renderOpportunity({
      count: 1,
      dialog: createDialogConfig(),
      expiresAt: Date.now() + 20 * 60_000,
    });

    const button = screen.getByRole("button", { name: "1 次重置额度" });
    expect(button.className).toContain("bg-interaction-confirmation-surface");
    expect(button.className).toContain("text-interaction-confirmation-foreground");
  });

  it("单个机会保持徽标文案和倒计时，点击同样打开重置弹框", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));

    renderOpportunity({
      count: 1,
      dialog: createDialogConfig(),
      expiresAt: Date.now() + 19 * 60_000 + 8_000,
    });

    expect(screen.getByText("1 次重置额度")).toBeTruthy();
    const countdown = screen.getByText("剩余 19 分 8 秒");
    expect(countdown.className).toContain("font-normal");
    expect(countdown.className).toContain("text-interaction-confirmation-foreground/80");
    // 单机会不切换为「获得 N 次」的多机会文案，仅交互升级为按钮。
    expect(screen.queryByRole("button", { name: "获得1次重置额度" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "1 次重置额度" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "可重置额度" })).toBeTruthy();
  });

  it("多个机会在入口展示机会次数、隐藏倒计时，点击后打开交付稿弹框", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));

    renderOpportunity({
      count: 2,
      dialog: createDialogConfig(),
      expiresAt: Date.now() + 19 * 60_000 + 8_000,
    });

    expect(screen.queryByText("剩余 19 分 8 秒")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "获得2次重置额度" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "可重置额度" })).toBeTruthy();
    // 标题不再展示可用次数药丸，次数改由每行机会自行标注。
    expect(screen.queryByText("2 次可用")).toBeNull();
    expect(screen.getByLabelText("剩余用量")).toBeTruthy();
    expect(screen.getByText("5 小时额度重置")).toBeTruthy();
    expect(screen.getByText("周额度重置")).toBeTruthy();
  });

  it.each([
    [1, "grid-cols-1"],
    [2, "grid-cols-2"],
    [3, "grid-cols-3"],
  ])("弹窗按 %i 个剩余额度项使用对应列数", (itemCount, expectedClass) => {
    const baseConfig = createDialogConfig();
    const usageItems = [
      ...baseConfig.usageItems,
      {
        color: "var(--color-usage-chart-3)",
        id: "monthly-tool",
        label: "MCP 额度",
        percentage: 75,
        resetTime: "9月1日",
        value: "75%",
      },
    ];
    renderOpportunity({
      count: 1,
      dialog: createDialogConfig({
        usageItems: usageItems.slice(0, itemCount),
      }),
      expiresAt: Date.now() + 20 * 60_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "1 次重置额度" }));
    const grid = screen.getByLabelText("剩余用量").firstElementChild;
    expect(grid?.className).toContain(expectedClass);
    expect(grid?.className).toContain("max-sm:grid-cols-1");
  });

  it("弹框内只调用被点击额度的 reset，成功后展示反馈并收起已消费项", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));
    const onReset = renderStatefulOpportunity({
      FIVE_HOUR: [Date.now() + 20 * 60_000],
      WEEK: [Date.now() + 2 * 24 * 60 * 60_000],
    });

    fireEvent.click(screen.getByRole("button", { name: "获得2次重置额度" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重置 5 小时额度" }));
      await Promise.resolve();
    });

    expect(onReset.FIVE_HOUR).toHaveBeenCalledTimes(1);
    expect(onReset.WEEK).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "重置成功" })).toBeTruthy();
    // 机会耗尽后到期为空：成功反馈与收起动画期间倒计时行留空，不渲染「0 分 0 秒」。
    expect(within(screen.getByRole("dialog")).queryByText(/0 分 0 秒/)).toBeNull();

    act(() => vi.advanceTimersByTime(600));
    expect(within(screen.getByRole("dialog")).queryByText(/0 分 0 秒/)).toBeNull();

    act(() => vi.advanceTimersByTime(220));
    expect(screen.queryByText("5 小时额度重置")).toBeNull();
    expect(screen.getByText("周额度重置")).toBeTruthy();
  });

  it("同类型多张机会核销一张后保留该行并展示下一张倒计时，不关闭弹框即可再次核销", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));
    const onReset = renderStatefulOpportunity({
      FIVE_HOUR: [Date.now() + 20 * 60_000, Date.now() + 3 * 60 * 60_000 + 30 * 60_000 + 30_000],
      WEEK: [Date.now() + 2 * 24 * 60 * 60_000],
    });

    fireEvent.click(screen.getByRole("button", { name: "获得3次重置额度" }));
    // 初始：五小时持有 2 张，展示「2 次」药丸与最早一张的「最快」倒计时。
    expect(screen.getByText("2 次")).toBeTruthy();
    expect(screen.getByText("最快 20 分 0 秒后过期")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重置 5 小时额度" }));
      await Promise.resolve();
    });
    expect(onReset.FIVE_HOUR).toHaveBeenCalledTimes(1);

    // Bugfix 回归：成功反馈结束时按最新投影决定去留。同类型仍有余下机会时行保留且不进入收起
    // 动画，倒计时切到下一张，而不是把完成态的空到期渲染成「0 分 0 秒」。
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByText("5 小时额度重置")).toBeTruthy();
    expect(screen.queryByText("2 次")).toBeNull();
    expect(screen.getByText("3 小时 30 分后过期")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByText(/0 分 0 秒/)).toBeNull();
    const resetAgain = screen.getByRole("button", { name: "重置 5 小时额度" }) as HTMLButtonElement;
    expect(resetAgain.disabled).toBe(false);

    act(() => vi.advanceTimersByTime(220));
    expect(screen.getByText("5 小时额度重置")).toBeTruthy();

    // 不关闭弹框再次点击：真实调用第二次 onReset；机会耗尽后该行收起，周额度行不受影响。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重置 5 小时额度" }));
      await Promise.resolve();
    });
    expect(onReset.FIVE_HOUR).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("dialog")).queryByText(/0 分 0 秒/)).toBeNull();
    act(() => vi.advanceTimersByTime(820));
    expect(screen.queryByText("5 小时额度重置")).toBeNull();
    expect(screen.getByText("周额度重置")).toBeTruthy();
    expect(onReset.WEEK).not.toHaveBeenCalled();
  });

  it("同类型持有多张机会时展示次数药丸与「最快」倒计时，单张不展示", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));

    renderOpportunity({
      count: 3,
      dialog: createDialogConfig({
        resetItems: [
          {
            count: 2,
            expiresAt: Date.now() + 4 * 60 * 60_000 + 52 * 60_000,
            onReset: vi.fn(async () => undefined),
            resetType: "FIVE_HOUR",
          },
          {
            count: 1,
            expiresAt: Date.now() + 4 * 60 * 60_000 + 58 * 60_000,
            onReset: vi.fn(async () => undefined),
            resetType: "WEEK",
          },
        ],
      }),
      expiresAt: Date.now() + 4 * 60 * 60_000 + 52 * 60_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "获得3次重置额度" }));

    // 多张：标题旁有「2 次」药丸，倒计时标注「最快」防止误读成统一期限。
    expect(screen.getByText("2 次")).toBeTruthy();
    expect(screen.getByText("最快 4 小时 52 分后过期")).toBeTruthy();
    // 单张：不出现「1 次」药丸，倒计时保持原文案。
    expect(screen.queryByText("1 次")).toBeNull();
    expect(screen.getByText("4 小时 58 分后过期")).toBeTruthy();
  });

  it("弹框打开后服务端机会数下降时仍保持挂载，直到用户主动关闭", () => {
    const dialog = createDialogConfig();
    const view = renderOpportunity({
      count: 2,
      dialog,
      expiresAt: Date.now() + 20 * 60_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "获得2次重置额度" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(CodingPlanQuotaResetOpportunity, {
          count: 1,
          dialog,
          expiresAt: Date.now() + 20 * 60_000,
          placement: "inline",
          visible: true,
        }),
      ),
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("成功动画期间关闭并重新打开时，不受上一次弹框的延时任务影响", async () => {
    vi.useFakeTimers();
    const resetFiveHour = vi.fn(async () => undefined);
    renderOpportunity({
      count: 2,
      dialog: createDialogConfig({
        resetItems: [
          {
            count: 1,
            expiresAt: Date.now() + 20 * 60_000,
            onReset: resetFiveHour,
            resetType: "FIVE_HOUR",
          },
        ],
      }),
      expiresAt: Date.now() + 20 * 60_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "获得2次重置额度" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重置 5 小时额度" }));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "获得2次重置额度" }));

    act(() => vi.advanceTimersByTime(820));
    expect(screen.getByText("5 小时额度重置")).toBeTruthy();
  });

  it("支持由 Composer 控制弹框开关，保证 HoverCard 在弹框期间不卸载", () => {
    const onDialogOpenChange = vi.fn();
    renderOpportunity({
      count: 2,
      dialog: createDialogConfig(),
      dialogOpen: false,
      expiresAt: Date.now() + 20 * 60_000,
      onDialogOpenChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "获得2次重置额度" }));
    expect(onDialogOpenChange).toHaveBeenCalledWith(true);
  });
});
