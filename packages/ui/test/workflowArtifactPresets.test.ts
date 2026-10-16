import { describe, expect, it } from "vitest";
import {
  applyArtifactItems,
  formatArtifactValue,
  readArtifactField,
  type ArtifactItem,
  type ChartModel,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  artifactPresetFieldPaths,
  chartSeriesFields,
  parseArtifactPresetSpec,
  type ArtifactPresetKind,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

/**
 * 预置产物的纯折叠函数与 spec 解析（docs/dynamic-workflow/authoring.md「Declaring a dashboard」
 * 「预置纯函数 `applyArtifactItems`」一行）。
 *
 * 看板不存数据，它是 journal 上带 `artifact_id` 的 report 条目的投影，因此这些断言就是
 * 「同一批条目必须折出同一张图」这条重放健全性要求本身。
 */

function items(...raw: unknown[]): ArtifactItem[] {
  return raw.map((item, index) => ({
    sequence: index + 1,
    siteId: "report#1",
    ordinal: index + 1,
    item,
  }));
}

function parsedChart(spec: unknown): ChartSpec {
  const parsed = parseArtifactPresetSpec("chart", spec);
  expect(parsed).toBeDefined();
  return parsed as ChartSpec;
}

function seriesValues(model: ChartModel, seriesIndex: number): (number | string | null)[] {
  const key = model.series[seriesIndex]!.key;
  return model.points.map((point) => point[key] ?? null);
}

describe("readArtifactField / formatArtifactValue", () => {
  it("walks dot paths through objects and array indices", () => {
    const item = { timing: { after: 12 }, rounds: [{ ms: 3 }, { ms: 5 }] };
    expect(readArtifactField(item, "timing.after")).toBe(12);
    expect(readArtifactField(item, "rounds.1.ms")).toBe(5);
    expect(readArtifactField(item, "rounds.9.ms")).toBeUndefined();
    expect(readArtifactField(item, "timing.missing")).toBeUndefined();
    expect(readArtifactField(item, "timing.after.deeper")).toBeUndefined();
    expect(readArtifactField(null, "a.b")).toBeUndefined();
  });

  it("renders objects as compact JSON instead of [object Object]", () => {
    expect(formatArtifactValue({ a: 1 })).toBe('{"a":1}');
    expect(formatArtifactValue(undefined)).toBe("");
    expect(formatArtifactValue(null)).toBe("");
    expect(formatArtifactValue(false)).toBe("false");
    expect(formatArtifactValue("done")).toBe("done");
  });
});

describe("parseArtifactPresetSpec", () => {
  it("normalizes a single y field into an array and fills type/scale defaults", () => {
    const spec = parsedChart({ x: { field: "round" }, y: { field: "ms", unit: "ms" } });
    expect(spec.type).toBe("line");
    expect(spec.scale).toBe("linear");
    expect(chartSeriesFields(spec)).toEqual([{ field: "ms", unit: "ms" }]);
  });

  it("keeps declared chart type, scale and baseline", () => {
    const spec = parsedChart({
      type: "bar",
      scale: "log",
      x: { field: "round" },
      y: [{ field: "a" }, { field: "b", label: "B" }],
      baseline: { field: "budget", label: "预算" },
      title: "perf",
      description: "d",
    });
    expect(spec.type).toBe("bar");
    expect(spec.scale).toBe("log");
    expect(spec.baseline).toEqual({ field: "budget", label: "预算" });
    expect(spec.title).toBe("perf");
    expect(chartSeriesFields(spec)).toHaveLength(2);
  });

  it("falls back to defaults for unknown type/scale rather than refusing to render", () => {
    const spec = parsedChart({ x: { field: "r" }, y: { field: "v" }, type: "pie", scale: "sqrt" });
    expect(spec.type).toBe("line");
    expect(spec.scale).toBe("linear");
  });

  it("drops malformed optional pieces but keeps the spec renderable", () => {
    const spec = parsedChart({
      x: { field: "r" },
      y: [{ field: "a" }, { field: "" }, 7, { label: "no field" }],
      baseline: { label: "no field" },
      title: "   ",
    });
    expect(chartSeriesFields(spec)).toEqual([{ field: "a" }]);
    expect(spec.baseline).toBeUndefined();
    expect(spec.title).toBeUndefined();
  });

  it("accepts a bare string as a field shorthand", () => {
    const spec = parsedChart({ x: "round", y: "ms" });
    expect(spec.x).toEqual({ field: "round" });
    expect(chartSeriesFields(spec)).toEqual([{ field: "ms" }]);
  });

  it("rejects malformed chart specs", () => {
    expect(parseArtifactPresetSpec("chart", undefined)).toBeUndefined();
    expect(parseArtifactPresetSpec("chart", null)).toBeUndefined();
    expect(parseArtifactPresetSpec("chart", "chart")).toBeUndefined();
    expect(parseArtifactPresetSpec("chart", [])).toBeUndefined();
    expect(parseArtifactPresetSpec("chart", {})).toBeUndefined();
    expect(parseArtifactPresetSpec("chart", { x: { field: "r" } })).toBeUndefined();
    expect(parseArtifactPresetSpec("chart", { y: { field: "v" } })).toBeUndefined();
    expect(parseArtifactPresetSpec("chart", { x: { field: "" }, y: "v" })).toBeUndefined();
    expect(parseArtifactPresetSpec("chart", { x: "r", y: [] })).toBeUndefined();
  });

  it("rejects malformed table / metrics / board specs", () => {
    expect(parseArtifactPresetSpec("table", {})).toBeUndefined();
    expect(parseArtifactPresetSpec("table", { columns: [] })).toBeUndefined();
    expect(parseArtifactPresetSpec("table", { columns: {} })).toBeUndefined();
    expect(parseArtifactPresetSpec("metrics", { metrics: [{ label: "x" }] })).toBeUndefined();
    expect(parseArtifactPresetSpec("board", { status: "s", columns: ["a"] })).toBeUndefined();
    expect(parseArtifactPresetSpec("board", { key: "k", columns: ["a"] })).toBeUndefined();
    expect(parseArtifactPresetSpec("board", { key: "k", status: "s" })).toBeUndefined();
    expect(
      parseArtifactPresetSpec("board", { key: "k", status: "s", columns: [] }),
    ).toBeUndefined();
    expect(
      parseArtifactPresetSpec("board", { key: "k", status: "s", columns: [1, ""] }),
    ).toBeUndefined();
  });

  it("keeps valid table / metrics / board specs and drops blank optionals", () => {
    const table = parseArtifactPresetSpec("table", {
      columns: ["name", { field: "ms", unit: "ms" }],
      key: "  ",
    }) as TableSpec;
    expect(table.columns).toEqual([{ field: "name" }, { field: "ms", unit: "ms" }]);
    expect(table.key).toBeUndefined();

    const metrics = parseArtifactPresetSpec("metrics", {
      metrics: [{ field: "p99", label: "P99", unit: "ms" }],
    }) as MetricsSpec;
    expect(metrics.metrics).toEqual([{ field: "p99", label: "P99", unit: "ms" }]);

    const board = parseArtifactPresetSpec("board", {
      key: "id",
      status: "state",
      columns: ["todo", "done"],
      cardTitle: "title",
      detail: [{ field: "owner" }],
    }) as BoardSpec;
    expect(board.columns).toEqual(["todo", "done"]);
    expect(board.cardTitle).toBe("title");
    expect(board.detail).toEqual([{ field: "owner" }]);
  });
});

describe("applyArtifactItems — chart", () => {
  const spec = parsedChart({
    x: { field: "round", label: "轮次" },
    y: [
      { field: "queryMs", label: "查询", unit: "ms" },
      { field: "writeMs", label: "写入", unit: "ms" },
    ],
    baseline: { field: "budgetMs", label: "预算", unit: "ms" },
  });

  it("builds one series per y field and keeps the arriving sequence on every point", () => {
    const model = applyArtifactItems(
      "chart",
      spec,
      items(
        { round: 1, queryMs: 10, writeMs: 4 },
        { round: 2, queryMs: 8, writeMs: 5 },
        { round: 3, queryMs: 6 },
      ),
    );
    expect(model.series.map((series) => series.label)).toEqual(["查询", "写入"]);
    expect(model.series.map((series) => series.colorIndex)).toEqual([0, 1]);
    expect(model.points.map((point) => point.sequence)).toEqual([1, 2, 3]);
    expect(seriesValues(model, 0)).toEqual([10, 8, 6]);
    // 缺席的一维是 null（图上留缺口），不是 0——0 会凭空画出一次「性能归零」。
    expect(seriesValues(model, 1)).toEqual([4, 5, null]);
    expect(model.domain).toEqual({ xMin: 1, xMax: 3, yMin: 4, yMax: 10 });
  });

  it("sorts numeric x ascending regardless of arrival order", () => {
    const model = applyArtifactItems(
      "chart",
      spec,
      items({ round: 3, queryMs: 6 }, { round: 1, queryMs: 10 }, { round: 2, queryMs: 8 }),
    );
    expect(model.points.map((point) => point.x)).toEqual([1, 2, 3]);
    expect(model.points.map((point) => point.sequence)).toEqual([2, 3, 1]);
    expect(model.x.numeric).toBe(true);
  });

  it("keeps non-numeric x in arrival order and indexes it", () => {
    const model = applyArtifactItems(
      "chart",
      parsedChart({ x: "stage", y: "ms" }),
      items({ stage: "build", ms: 3 }, { stage: "test", ms: 9 }, { stage: "ship", ms: 1 }),
    );
    expect(model.x.numeric).toBe(false);
    expect(model.points.map((point) => point.x)).toEqual([0, 1, 2]);
    expect(model.points.map((point) => point.xLabel)).toEqual(["build", "test", "ship"]);
  });

  it("takes the baseline from the first item that has the field", () => {
    const model = applyArtifactItems(
      "chart",
      spec,
      items(
        { round: 1, queryMs: 10 },
        { round: 2, queryMs: 8, budgetMs: 7 },
        { round: 3, queryMs: 6, budgetMs: 99 },
      ),
    );
    expect(model.baseline).toEqual({ value: 7, label: "预算", unit: "ms" });
  });

  it("drops non-positive y values under a log scale", () => {
    const logSpec = parsedChart({ scale: "log", x: "round", y: "ms", baseline: "floor" });
    const model = applyArtifactItems(
      "chart",
      logSpec,
      items(
        { round: 1, ms: 10, floor: 0 },
        { round: 2, ms: 0 },
        { round: 3, ms: -4 },
        { round: 4, ms: 2, floor: 1 },
      ),
    );
    expect(seriesValues(model, 0)).toEqual([10, null, null, 2]);
    // 参考线同理：log 轴上 0 没有位置，于是跳到下一条带该字段的条目。
    expect(model.baseline).toEqual({ value: 1, label: "floor" });
    expect(model.domain).toEqual({ xMin: 1, xMax: 4, yMin: 2, yMax: 10 });
  });

  it("keeps non-positive y values under a linear scale", () => {
    const model = applyArtifactItems(
      "chart",
      parsedChart({ x: "round", y: "delta" }),
      items({ round: 1, delta: -3 }, { round: 2, delta: 0 }),
    );
    expect(seriesValues(model, 0)).toEqual([-3, 0]);
  });

  it("skips items without an x value and survives an empty stream", () => {
    const model = applyArtifactItems(
      "chart",
      spec,
      items({ queryMs: 10 }, { round: 2, queryMs: 8 }),
    );
    expect(model.points).toHaveLength(1);
    const empty = applyArtifactItems("chart", spec, []);
    expect(empty.points).toEqual([]);
    expect(empty.domain).toBeUndefined();
  });

  it("parses numeric strings so shell-scraped values still plot", () => {
    const model = applyArtifactItems(
      "chart",
      parsedChart({ x: "round", y: "ms" }),
      items({ round: "2", ms: "8.5" }, { round: "1", ms: "3" }),
    );
    expect(model.x.numeric).toBe(true);
    expect(model.points.map((point) => point.x)).toEqual([1, 2]);
    expect(seriesValues(model, 0)).toEqual([3, 8.5]);
  });
});

describe("applyArtifactItems — table", () => {
  const columns = [{ field: "name" }, { field: "state" }, { field: "timing.ms", label: "耗时" }];

  it("appends one row per item when no key is declared", () => {
    const spec = parseArtifactPresetSpec("table", { columns }) as TableSpec;
    const model = applyArtifactItems(
      "table",
      spec,
      items(
        { name: "a", state: "run", timing: { ms: 1 } },
        { name: "a", state: "done", timing: { ms: 2 } },
      ),
    );
    expect(model.rows).toHaveLength(2);
    expect(model.rows.map((row) => row.cells)).toEqual([
      ["a", "run", "1"],
      ["a", "done", "2"],
    ]);
    expect(model.columns.map((column) => column.label)).toEqual(["name", "state", "耗时"]);
  });

  it("upserts by key and keeps the row at its first-seen position", () => {
    const spec = parseArtifactPresetSpec("table", { columns, key: "name" }) as TableSpec;
    const model = applyArtifactItems(
      "table",
      spec,
      items(
        { name: "a", state: "run" },
        { name: "b", state: "run" },
        { name: "a", state: "done", timing: { ms: 9 } },
      ),
    );
    expect(model.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(model.rows[0]!.cells).toEqual(["a", "done", "9"]);
    // 替换是整行替换，所以行的 sequence 跟到最后一次写入。
    expect(model.rows[0]!.sequence).toBe(3);
  });

  it("leaves a cell empty when the path does not resolve", () => {
    const spec = parseArtifactPresetSpec("table", { columns }) as TableSpec;
    const model = applyArtifactItems("table", spec, items({ name: "a" }));
    expect(model.rows[0]!.cells).toEqual(["a", "", ""]);
  });

  it("falls back to the journal identity when a keyed item carries no key", () => {
    const spec = parseArtifactPresetSpec("table", { columns, key: "name" }) as TableSpec;
    const model = applyArtifactItems("table", spec, items({ state: "run" }, { state: "done" }));
    expect(model.rows.map((row) => row.id)).toEqual(["report#1@1", "report#1@2"]);
  });
});

describe("applyArtifactItems — metrics", () => {
  const spec = parseArtifactPresetSpec("metrics", {
    metrics: [{ field: "p99", label: "P99", unit: "ms" }, { field: "errors" }, { field: "never" }],
  }) as MetricsSpec;

  it("takes each tile from the last item that has that field", () => {
    const model = applyArtifactItems(
      "metrics",
      spec,
      items({ p99: 10, errors: 2 }, { p99: 8 }, { stage: "idle" }),
    );
    expect(model.metrics[0]).toMatchObject({ label: "P99", unit: "ms", value: "8", sequence: 2 });
    // 只报 stage 的心跳条目不该把上一轮的 errors 抹掉。
    expect(model.metrics[1]).toMatchObject({ value: "2", sequence: 1 });
    expect(model.metrics[2]!.value).toBeUndefined();
    expect(model.metrics[2]!.sequence).toBeUndefined();
  });

  it("treats an explicit null as absent", () => {
    const model = applyArtifactItems("metrics", spec, items({ p99: 5 }, { p99: null }));
    expect(model.metrics[0]!.value).toBe("5");
  });

  it("keeps every tile present when the stream is empty", () => {
    const model = applyArtifactItems("metrics", spec, []);
    expect(model.metrics).toHaveLength(3);
    expect(model.metrics.every((tile) => tile.value === undefined)).toBe(true);
  });
});

describe("applyArtifactItems — board", () => {
  const spec = parseArtifactPresetSpec("board", {
    key: "id",
    status: "state",
    columns: ["todo", "doing", "done"],
    cardTitle: "title",
    detail: [{ field: "owner", label: "负责人" }],
  }) as BoardSpec;

  it("upserts cards by key and groups them into the declared column order", () => {
    const model = applyArtifactItems(
      "board",
      spec,
      items(
        { id: "1", state: "todo", title: "解析器", owner: "a" },
        { id: "2", state: "doing", title: "渲染器" },
        { id: "1", state: "done", title: "解析器", owner: "b" },
      ),
    );
    expect(model.columns.map((column) => column.id)).toEqual(["todo", "doing", "done"]);
    expect(model.columns[0]!.cards).toEqual([]);
    expect(model.columns[1]!.cards.map((card) => card.id)).toEqual(["2"]);
    expect(model.columns[2]!.cards.map((card) => card.id)).toEqual(["1"]);
    expect(model.columns[2]!.cards[0]!.details).toEqual([{ label: "负责人", value: "b" }]);
    expect(model.cardCount).toBe(2);
  });

  it("sends an unlisted status to a trailing other column", () => {
    const model = applyArtifactItems(
      "board",
      spec,
      items({ id: "1", state: "blocked" }, { id: "2", state: "todo" }),
    );
    expect(model.columns).toHaveLength(4);
    expect(model.columns.at(-1)!.other).toBe(true);
    expect(model.columns.at(-1)!.cards.map((card) => card.id)).toEqual(["1"]);
  });

  it("omits the other column when every status is listed", () => {
    const model = applyArtifactItems("board", spec, items({ id: "1", state: "todo" }));
    expect(model.columns.some((column) => column.other)).toBe(false);
  });

  it("falls back to the key for a missing card title and skips keyless items", () => {
    const model = applyArtifactItems(
      "board",
      spec,
      items({ id: "7", state: "todo" }, { state: "todo", title: "无主" }),
    );
    expect(model.cardCount).toBe(1);
    expect(model.columns[0]!.cards[0]!.title).toBe("7");
  });
});

describe("field-only entries (the CLI extracts the fields a dashboard reads)", () => {
  /**
   * CLI 只取 spec 点名的字段时，渲染器拿到的是 `fields` 表而不是整条 item。这里模拟 CLI：用同一条
   * 路径规则从整条 item 里取出 `artifactPresetFieldPaths` 列出的字段。两种条目必须折出同一张图——
   * 路径表漏一个，那一列 / 那条序列就会变空，断言就会红。
   */
  function asFieldEntries(entries: ArtifactItem[], paths: readonly string[]): ArtifactItem[] {
    return entries.map(({ item, ...rest }) => {
      const fields: Record<string, unknown> = {};
      for (const path of paths) {
        const value = readArtifactField(item, path);
        if (value !== undefined) fields[path] = value;
      }
      return { ...rest, fields };
    });
  }

  const stream = items(
    { round: 1, timing: { ms: 120, base: 100 }, name: "a", state: "todo", rows: [{ v: 3 }] },
    { round: 2, timing: { ms: 90 }, name: "b", state: "done", rows: [{ v: 4 }] },
    { round: 3, timing: { ms: 80 }, name: "a", state: "done", note: "late", rows: [] },
  );
  const specs: Array<[ArtifactPresetKind, unknown]> = [
    ["chart", { x: "round", y: ["timing.ms", "rows.0.v"], baseline: { field: "timing.base" } }],
    ["table", { key: "name", columns: [{ field: "round" }, { field: "timing.ms", unit: "ms" }] }],
    ["metrics", { metrics: [{ field: "timing.ms" }, { field: "note" }] }],
    [
      "board",
      {
        key: "name",
        status: "state",
        columns: ["todo", "done"],
        cardTitle: "note",
        detail: [{ field: "round" }],
      },
    ],
  ];

  for (const [kind, rawSpec] of specs) {
    it(`folds a ${kind} identically from whole items and from its field list`, () => {
      const paths = artifactPresetFieldPaths(kind, rawSpec);
      expect(paths).toBeDefined();
      const spec = parseArtifactPresetSpec(kind, rawSpec)!;
      expect(applyArtifactItems(kind, spec, asFieldEntries(stream, paths!))).toEqual(
        applyArtifactItems(kind, spec, stream),
      );
    });
  }

  it("lists each path once, in spec order, and nothing for a spec it cannot render", () => {
    expect(
      artifactPresetFieldPaths("chart", { x: "round", y: ["ms", "round"], baseline: "ms" }),
    ).toEqual(["round", "ms"]);
    expect(artifactPresetFieldPaths("board", { key: "id", status: "id", columns: ["a"] })).toEqual([
      "id",
    ]);
    expect(artifactPresetFieldPaths("table", { columns: [] })).toBeUndefined();
  });
});
