// @vitest-environment jsdom
import { createElement, type ReactNode, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppUsageHeatmapCell, AppUsageHeatmapWeek } from "@zcode/shared";
import zhCN from "@/i18n/locales/zh-CN.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: string;
  }) => createElement("span", { "data-tooltip-title": title }, children),
}));

const DAY_MS = 86_400_000;

function dateKeyFromUtcDayIndex(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function buildThirtyDayWeeks(
  endTime = Date.UTC(2026, 5, 4),
): AppUsageHeatmapWeek[] {
  const endDayIndex = Math.floor(endTime / DAY_MS);
  const cells: AppUsageHeatmapCell[] = Array.from(
    { length: 30 },
    (_, index) => ({
      date: dateKeyFromUtcDayIndex(endDayIndex - 29 + index),
      level: ((index % 4) + 1) as AppUsageHeatmapCell["level"],
      totalTokens: index + 1,
      turnCount: 1,
      toolCallCount: 0,
    }),
  );

  return Array.from({ length: 5 }, (_, weekIndex) => ({
    weekIndex,
    days: Array.from({ length: 7 }, (_, dayIndex) => {
      return cells[weekIndex * 7 + dayIndex] ?? null;
    }),
  }));
}

describe("UsageHeatmap", () => {
  const intl = {
    formatMessage(
      descriptor: { id: string },
      values?: Record<string, string | number>,
    ) {
      if (descriptor.id === "settings.usage.heatmapCell") {
        return `${values?.date}\n${values?.tokens} tokens · ${values?.turns} messages`;
      }
      if (descriptor.id === "settings.usage.heatmapWeeklyCell") {
        return `${values?.date} week\n${values?.tokens} tokens · ${values?.turns} messages`;
      }
      if (descriptor.id === "settings.usage.heatmapCumulativeCell") {
        return `Through ${values?.date}\n${values?.tokens} tokens · ${values?.turns} messages`;
      }
      if (descriptor.id === "settings.usage.heatmapToolCell") {
        return `${values?.date}\n${values?.tokens} tokens · ${values?.tools} tools`;
      }
      if (descriptor.id === "settings.usage.heatmapWeeklyToolCell") {
        return `${values?.date} week\n${values?.tokens} tokens · ${values?.tools} tools`;
      }
      if (descriptor.id === "settings.usage.heatmapCumulativeToolCell") {
        return `Through ${values?.date}\n${values?.tokens} tokens · ${values?.tools} tools`;
      }
      const messages: Record<string, string> = {
        "settings.usage.heatmapTitle": "Token Activity",
        "settings.usage.heatmap.less": "Less",
        "settings.usage.heatmap.more": "More",
        "settings.usage.heatmap.range.daily": "Daily",
        "settings.usage.heatmap.range.weekly": "Weekly",
        "settings.usage.heatmap.range.cumulative": "Cumulative",
      };
      return messages[descriptor.id] ?? descriptor.id;
    },
  } as ComponentProps<typeof UsageHeatmap>["intl"];

  it("uses Token activity as the Chinese heatmap title", () => {
    expect(zhCN["settings.usage.heatmapTitle"]).toBe("Token 活动");
    expect(zhCN["settings.usage.heatmapCell"]).toBe(
      "{date}\n{tokens} tokens · {turns} 轮消息",
    );
    expect(zhCN["settings.usage.heatmapWeeklyCell"]).toBe(
      "{date} 当周\n{tokens} tokens · {turns} 轮消息",
    );
    expect(zhCN["settings.usage.heatmapCumulativeCell"]).toBe(
      "截至 {date} 当周累计\n{tokens} tokens · {turns} 轮消息",
    );
  });

  it("shows real tool calls instead of missing message turns for Coding Plan", () => {
    const html = renderToStaticMarkup(
      createElement(UsageHeatmap, {
        locale: "en-US",
        intl,
        weeks: buildThirtyDayWeeks(),
        countMetric: "tools",
      }),
    );

    expect(html).toContain("tokens");
    expect(html).not.toContain("messages");
    expect(html).toContain("0 tools");
  });

  it("renders missing days as zero-usage hoverable cells", () => {
    const html = renderToStaticMarkup(
      createElement(UsageHeatmap, {
        locale: "en-US",
        intl,
        weeks: buildThirtyDayWeeks(),
      }),
    );

    expect(html).toContain("rounded-xl");
    expect(html).toContain("data-usage-heatmap-month-label");
    expect(html).toContain("Daily");
    expect(html).toContain("Weekly");
    expect(html).toContain("Cumulative");
    expect(
      html.match(/data-tooltip-title="([^"]+)\n0 tokens · 0 messages/)?.[1],
    ).toBe("June 8, 2025");
    expect((html.match(/data-tooltip-title=/g) ?? []).length).toBe(364);
    expect((html.match(/0 tokens · 0 messages/g) ?? []).length).toBe(334);
    expect(html).toContain("background-color:var(--color-usage-heatmap-0)");
    expect(html).toContain("background-color:var(--color-usage-heatmap-4)");
    expect(html).not.toContain("var(--color-brand)");
  });

  it("shows only the latest 12 month labels while preserving leading grid spans", () => {
    const { container, unmount } = render(
      createElement(UsageHeatmap, {
        locale: "en-US",
        intl,
        weeks: buildThirtyDayWeeks(Date.UTC(2026, 7, 17)),
      }),
    );
    const labels = [
      ...container.querySelectorAll("[data-usage-heatmap-month-label]"),
    ];

    expect(labels.map((label) => label.textContent)).toEqual([
      "",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
    ]);
    // 2025-09-01 是周一，所以 Sep 应锚定到包含 1 日的 2025-08-31 周列；
    // 开头仅剩 2025-08-24 一列空月份占位。
    expect(labels[0]?.getAttribute("style")).toContain("grid-column: span 1");
    unmount();
  });

  it("switches Token activity between daily, weekly, and cumulative views", () => {
    render(
      createElement(UsageHeatmap, {
        locale: "en-US",
        intl,
        weeks: buildThirtyDayWeeks(),
      }),
    );

    expect(screen.getByText("Daily")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(
      "group-hover/usage-heatmap-column:border-border-hover",
    );
    fireEvent.click(screen.getByText("Weekly"));
    expect(document.body.innerHTML).toContain("week\n");
    expect(document.body.innerHTML).toContain("tokens ·");
    expect(document.body.innerHTML).toContain(
      "group-hover/usage-heatmap-column:border-border-hover",
    );
    expect((document.body.innerHTML.match(/week\n/g) ?? []).length).toBe(52);

    fireEvent.click(screen.getByText("Cumulative"));
    expect(document.body.innerHTML).toContain("Through");
    expect(document.body.innerHTML).toContain("tokens ·");
    expect(document.body.innerHTML).toContain(
      "group-hover/usage-heatmap-column:border-border-hover",
    );
    expect((document.body.innerHTML.match(/Through/g) ?? []).length).toBe(52);
  });

  it("fits all 52 week columns in the container without horizontal scrolling", () => {
    const html = renderToStaticMarkup(
      createElement(UsageHeatmap, {
        locale: "en-US",
        intl,
        weeks: buildThirtyDayWeeks(),
      }),
    );

    expect(html).toContain("grid-template-columns:repeat(52, minmax(0, 1fr))");
    expect(html).toContain("grid w-full gap-x-0.5");
    expect(html).not.toContain("min-w-max");
    expect(html).not.toContain("overflow-x-auto");
  });

  it("matches the hook scope tabs pill styling", () => {
    const html = renderToStaticMarkup(
      createElement(UsageHeatmap, {
        locale: "en-US",
        intl,
        weeks: buildThirtyDayWeeks(),
      }),
    );

    expect(html).toContain("rounded-full bg-surface");
    expect(html).toContain("p-0.5");
    expect(html).toContain("group-data-horizontal/tabs:h-7");
    expect(html).toContain("data-active:bg-background");
    expect(html).toContain("data-active:shadow-none");
    expect(html).toContain("h-6 flex-none justify-center rounded-full");
    expect(html).toContain("px-2.5 py-0 text-ui-sm font-medium");
    expect(html).not.toContain("w-16");
    expect(html).not.toContain("h-7 flex-none rounded-full");
    expect(html).not.toContain("px-0 py-0 text-ui-sm");
    expect(html).not.toContain(
      "px-2.5 text-ui-base font-medium text-foreground-subtle",
    );
    expect(html).not.toContain("rounded-lg bg-background p-1");
  });
});
