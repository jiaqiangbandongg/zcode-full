// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyArtifactItems,
  type ArtifactItem,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import { chartPlotPropsEqual } from "@/app-shell/workflow-artifacts/presets/ArtifactChartView.js";
import {
  ArtifactBoard,
  ArtifactChart,
  ArtifactMetrics,
  ArtifactTable,
  parseArtifactPresetSpec,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type PresetLabels,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/index.js";

/**
 * 四个预置渲染器的冒烟：compact（run 侧板卡片里的小尺寸）与全尺寸两种形态各渲染一次
 * （docs/dynamic-workflow/authoring.md「Declaring a dashboard」）。
 *
 * 这里不断样式细节，只钉住形态契约：小卡露什么、全尺寸露什么、零条目时给空态，
 * 以及图表**不是**静态 import 进来的（recharts 必须可懒加载，见 Electron Linux 启动雷）。
 */

const labels: PresetLabels = {
  otherColumn: "其他",
  empty: "暂无数据",
  itemsCount: (count) => `${count} 条`,
};

function items(...raw: unknown[]): ArtifactItem[] {
  return raw.map((item, index) => ({
    sequence: index + 1,
    siteId: "report#1",
    ordinal: index + 1,
    item,
  }));
}

let restoreRect: (() => void) | undefined;

beforeAll(() => {
  // recharts 的 ResponsiveContainer 需要 ResizeObserver，且会在 effect 里读一次
  // `getBoundingClientRect()`——jsdom 无布局，两者都得补，否则它测出 0×0 就整块不渲染
  // （initialDimension 会被这次测量覆盖掉）。
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function stubbedRect(this: Element): DOMRect {
    return {
      bottom: 200,
      height: 200,
      left: 0,
      right: 320,
      toJSON: () => ({}),
      top: 0,
      width: 320,
      x: 0,
      y: 0,
    } as DOMRect;
  };
  restoreRect = () => {
    Element.prototype.getBoundingClientRect = original;
  };
});

afterAll(() => {
  restoreRect?.();
});

afterEach(() => {
  cleanup();
});

describe("ArtifactMetrics", () => {
  const spec = parseArtifactPresetSpec("metrics", {
    title: "性能",
    metrics: [{ field: "p99", label: "P99", unit: "ms" }, { field: "errors" }],
  }) as MetricsSpec;

  it("renders a tile row in the compact form", () => {
    render(
      createElement(ArtifactMetrics, {
        compact: true,
        items: items({ p99: 12, errors: 0 }, { p99: 9 }),
        labels,
        spec,
      }),
    );
    const values = screen.getAllByTestId("artifact-metric-value").map((node) => node.textContent);
    expect(values).toEqual(["9", "0"]);
    // 小卡不重复标题——卡片本身已经有标题了。
    expect(screen.queryByText("性能")).toBeNull();
  });

  it("renders the title and tiles in the full form", () => {
    render(createElement(ArtifactMetrics, { items: items({ p99: 9 }), labels, spec }));
    expect(screen.getByText("性能")).toBeTruthy();
    expect(screen.getAllByTestId("artifact-metric-tile")).toHaveLength(2);
    // 从没出现过的字段显示破折号，而不是 0。
    expect(screen.getAllByTestId("artifact-metric-value")[1]!.textContent).toBe("—");
  });

  it("shows the empty state before any item arrives", () => {
    render(createElement(ArtifactMetrics, { items: [], labels, spec }));
    expect(screen.getByTestId("artifact-preset-empty").textContent).toBe("暂无数据");
  });
});

describe("ArtifactTable", () => {
  const spec = parseArtifactPresetSpec("table", {
    title: "回合",
    columns: [{ field: "name" }, { field: "ms", label: "耗时", unit: "ms" }],
    key: "name",
  }) as TableSpec;

  it("shows the row count and only the first three rows in the compact form", () => {
    render(
      createElement(ArtifactTable, {
        compact: true,
        items: items(
          { name: "a", ms: 1 },
          { name: "b", ms: 2 },
          { name: "c", ms: 3 },
          { name: "d", ms: 4 },
        ),
        labels,
        spec,
      }),
    );
    expect(screen.getByTestId("artifact-table-count").textContent).toBe("4 条");
    expect(screen.getAllByTestId("artifact-table-row")).toHaveLength(3);
  });

  it("renders every row with unit-bearing headers in the full form", () => {
    render(
      createElement(ArtifactTable, {
        items: items({ name: "a", ms: 1 }, { name: "b", ms: 2 }, { name: "c", ms: 3 }),
        labels,
        spec,
      }),
    );
    expect(screen.getByText("回合")).toBeTruthy();
    expect(screen.getByText("耗时 (ms)")).toBeTruthy();
    expect(screen.getAllByTestId("artifact-table-row")).toHaveLength(3);
  });

  it("shows the empty state before any item arrives", () => {
    render(createElement(ArtifactTable, { items: [], labels, spec }));
    expect(screen.getByTestId("artifact-preset-empty")).toBeTruthy();
  });
});

describe("ArtifactBoard", () => {
  const spec = parseArtifactPresetSpec("board", {
    title: "驱动",
    key: "id",
    status: "state",
    columns: ["todo", "done"],
    cardTitle: "name",
    detail: [{ field: "owner", label: "负责人" }],
  }) as BoardSpec;

  const stream = items(
    { id: "1", state: "todo", name: "uart", owner: "a" },
    { id: "2", state: "done", name: "spi" },
    { id: "3", state: "blocked", name: "i2c" },
  );

  it("renders per-column counts in the compact form", () => {
    render(createElement(ArtifactBoard, { compact: true, items: stream, labels, spec }));
    const counts = screen
      .getAllByTestId("artifact-board-column-count")
      .map((node) => node.textContent);
    expect(counts).toEqual(["todo1", "done1", "其他1"]);
    expect(screen.queryByTestId("artifact-board-card")).toBeNull();
  });

  it("renders columns and cards in the full form", () => {
    render(createElement(ArtifactBoard, { items: stream, labels, spec }));
    expect(screen.getAllByTestId("artifact-board-column")).toHaveLength(3);
    expect(screen.getAllByTestId("artifact-board-card")).toHaveLength(3);
    expect(screen.getByText("uart")).toBeTruthy();
    // 未列出的 status 落到「其他」，标题由 labels 提供（组件不查 i18n）。
    expect(screen.getByText("其他")).toBeTruthy();
    // 三张卡都带 detail 行（值可以为空，标签始终在场）。
    expect(screen.getAllByText("负责人")).toHaveLength(3);
  });

  it("shows the empty state before any item arrives", () => {
    render(createElement(ArtifactBoard, { items: [], labels, spec }));
    expect(screen.getByTestId("artifact-preset-empty")).toBeTruthy();
  });
});

describe("ArtifactChart", () => {
  const spec = parseArtifactPresetSpec("chart", {
    title: "查询耗时",
    x: { field: "round", label: "轮次" },
    y: [
      { field: "queryMs", label: "查询", unit: "ms" },
      { field: "writeMs", label: "写入", unit: "ms" },
    ],
    baseline: { field: "budgetMs", label: "预算" },
  }) as ChartSpec;

  const stream = items(
    { round: 1, queryMs: 10, writeMs: 4, budgetMs: 6 },
    { round: 2, queryMs: 8, writeMs: 5 },
    { round: 3, queryMs: 6, writeMs: 5 },
  );

  it("lazily renders a sparkline plus the latest value in the compact form", async () => {
    render(createElement(ArtifactChart, { compact: true, items: stream, labels, spec }));
    // 懒加载：第一帧是骨架，recharts 落地后才有 SVG。
    expect(screen.getByTestId("artifact-chart-skeleton")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("artifact-chart-compact")).toBeTruthy());
    expect(screen.getByTestId("artifact-chart-latest").textContent).toBe("6ms");
    expect(document.querySelector("svg.recharts-surface")).toBeTruthy();
    // 无轴 sparkline：没有刻度文本。
    expect(document.querySelector(".recharts-cartesian-axis-tick")).toBeNull();
  });

  it("renders axes, a legend and the x-axis caption in the full form", async () => {
    render(createElement(ArtifactChart, { items: stream, labels, spec }));
    await waitFor(() => expect(screen.getByTestId("artifact-chart")).toBeTruthy());
    expect(screen.getByText("查询耗时")).toBeTruthy();
    // 图例永远在场，且每条带最新值——身份不只靠颜色（见 palette.ts 的次级编码那段）。
    const legend = screen.getAllByTestId("artifact-chart-legend-item").map((n) => n.textContent);
    expect(legend).toEqual(["查询6 ms", "写入5 ms"]);
    expect(screen.getByText("轮次")).toBeTruthy();
    await waitFor(() =>
      expect(document.querySelector(".recharts-cartesian-axis-tick")).toBeTruthy(),
    );
    // 参考线取自第一条带 budgetMs 的条目。
    expect(document.querySelector(".recharts-reference-line")).toBeTruthy();
  });

  it("shows the empty state before any item arrives", async () => {
    render(createElement(ArtifactChart, { items: [], labels, spec }));
    await waitFor(() => expect(screen.getByTestId("artifact-preset-empty")).toBeTruthy());
  });

  it("keeps recharts out of the barrel's static import graph", async () => {
    // 图表必须可懒加载（Electron Linux 启动雷）：barrel 自己 import 时不得拉起 recharts。
    const { readFile } = await import("node:fs/promises");
    const [entry, view, barrel] = await Promise.all(
      [
        "packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactChart.tsx",
        "packages/ui/src/app-shell/workflow-artifacts/presets/ArtifactChartView.tsx",
        "packages/ui/src/app-shell/workflow-artifacts/presets/index.ts",
      ].map((path) => readFile(path, "utf8")),
    );
    // recharts 只出现在 View 里，且只经 lazy 的动态 import 抵达。
    expect(view).toContain('from "recharts"');
    expect(entry).not.toContain('from "recharts"');
    expect(entry).toContain("lazy(");
    expect(entry).toContain(
      'import("@/app-shell/workflow-artifacts/presets/ArtifactChartView.js")',
    );
    expect(barrel).not.toContain("ArtifactChartView");
  });
});

describe("chartPlotPropsEqual — 绘图体的重渲染契约", () => {
  const spec = parseArtifactPresetSpec("chart", {
    x: "round",
    y: "ms",
    baseline: "budget",
  }) as ChartSpec;

  function plot(count: number, options: { baseline?: number; offset?: number } = {}) {
    const stream = Array.from({ length: count }, (_, index) => ({
      sequence: index + 1 + (options.offset ?? 0),
      siteId: "report#1",
      ordinal: index + 1,
      item: {
        round: index + 1,
        ms: (index + 1) * 2,
        ...(options.baseline === undefined ? {} : { budget: options.baseline }),
      },
    }));
    return { compact: false, model: applyArtifactItems("chart", spec, stream) };
  }

  it("skips the re-render when a fresh model carries the same points", () => {
    // 父组件重渲染会造出一份新的 model 引用；点数、定义域、首尾 sequence 都没变 ⇒ 不重画。
    expect(chartPlotPropsEqual(plot(3), plot(3))).toBe(true);
  });

  it("re-renders when a point arrives", () => {
    expect(chartPlotPropsEqual(plot(3), plot(4))).toBe(false);
  });

  it("re-renders when the same-sized batch was actually replaced", () => {
    // 冷恢复重取：点数一样但 sequence 整体后移，靠首尾 sequence 认出来。
    expect(chartPlotPropsEqual(plot(3), plot(3, { offset: 100 }))).toBe(false);
  });

  it("re-renders when the baseline or the form changes", () => {
    expect(chartPlotPropsEqual(plot(3), plot(3, { baseline: 5 }))).toBe(false);
    expect(chartPlotPropsEqual(plot(3), { ...plot(3), compact: true })).toBe(false);
  });
});
