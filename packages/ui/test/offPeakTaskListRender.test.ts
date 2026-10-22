// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeOffPeakTask } from "@zcode/shared";
import { TID_OFFPEAK_CARD } from "@zcode/shared/test-ids";
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
