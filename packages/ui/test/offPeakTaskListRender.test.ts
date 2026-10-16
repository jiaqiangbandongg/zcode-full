// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_OFFPEAK_CARD, TID_OFFPEAK_CARD_SESSION, type ZCodeOffPeakTask } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { OffPeakTaskList } from "@/settings/OffPeakTaskList.js";

afterEach(cleanup);

function task(overrides: Partial<ZCodeOffPeakTask> & { offPeakTaskId: string }): ZCodeOffPeakTask {
  return {
    title: overrides.offPeakTaskId,
    prompt: "prompt",
    status: "queued",
    createdAt: 1,
    ...overrides,
  } as ZCodeOffPeakTask;
}

function renderList(tasks: ZCodeOffPeakTask[]) {
  const noop = vi.fn();
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(OffPeakTaskList, {
        tasks,
        busyOperationId: null,
        onOpen: noop,
        onPause: noop,
        onContinue: noop,
        onCancel: noop,
        onDelete: noop,
        onOpenSession: noop,
      }),
    ),
  );
}

describe("OffPeakTaskList render", () => {
  it("失败卡片的状态徽章不可收缩，长会话标题只截断自己", () => {
    const view = renderList([
      task({
        offPeakTaskId: "failed-1",
        status: "failed",
        sessionTitle:
          "扫描最近的 CI 运行，列出失败和不稳定测试及其可能原因，并按影响范围给出修复建议",
      }),
    ]);
    const card = view.getByTestId(TID_OFFPEAK_CARD);
    const statusLabel = view.getByText("失败");
    const badge = statusLabel.parentElement!;
    // Bug 回归：徽章曾是 min-w-0，会被右侧会话标题压到只剩一个字。
    expect(badge.className).toContain("shrink-0");
    expect(badge.className).not.toContain("min-w-0");
    const session = view.getByTestId(TID_OFFPEAK_CARD_SESSION);
    expect(session.className).toContain("truncate");
    expect(session.className).toContain("min-w-0");
    expect(card.contains(session)).toBe(true);
  });

  it("超过 8 张卡片时 grid 自身滚动，8 张及以内不锁高度", () => {
    const eight = Array.from({ length: 8 }, (_, i) => task({ offPeakTaskId: `t-${i}` }));
    const view = renderList(eight);
    const grid = view.getAllByTestId(TID_OFFPEAK_CARD)[0]!.parentElement!;
    expect(grid.className).not.toContain("overflow-y-auto");

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(OffPeakTaskList, {
          tasks: [...eight, task({ offPeakTaskId: "t-8" })],
          busyOperationId: null,
          onOpen: vi.fn(),
          onPause: vi.fn(),
          onContinue: vi.fn(),
          onCancel: vi.fn(),
          onDelete: vi.fn(),
          onOpenSession: vi.fn(),
        }),
      ),
    );
    const scrollGrid = view.getAllByTestId(TID_OFFPEAK_CARD)[0]!.parentElement!;
    expect(scrollGrid.className).toContain("overflow-y-auto");
    expect(scrollGrid.className).toContain("lg:max-h-[606px]");
  });
});
