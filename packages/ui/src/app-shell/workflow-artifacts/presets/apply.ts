/**
 * `applyArtifactItems` —— 把一串 `report(item, artifactId)` 条目折成预置看板的视图模型。
 *
 * 纯函数、不含 React：看板本身**不存数据**，它的每一个点 / 行 / 卡片都是一条 journal 上
 * `kind = "report"` 且 `artifact_id` 命中的条目。同一批条目重放两次必须得到同一张图，所以这里不许有任何
 * 时间、随机或外部状态；折叠规则全部由 spec 决定。
 *
 * 条目只会**追加**（journal 只追加），所以四种折叠都可以按到达顺序单遍完成。
 */

import { readWorkflowArtifactField } from "@zcode/shared/zcode-protocol-v4";
import {
  artifactFieldLabel,
  chartSeriesFields,
  type ArtifactChartScale,
  type ArtifactChartType,
  type ArtifactField,
  type ArtifactPresetKind,
  type ArtifactPresetSpec,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

/**
 * 一条到达的条目。`sequence` 是 run 内全局递增的事件序号——它同时是 React key
 * （新点揭示动画靠它区分「这个点是新来的」）与增量取数的游标；`siteId × ordinal`
 * 是 journal 上的身份（同 Results 区的 key 习语），用于没有 spec key 时的行/卡身份。
 */
export type ArtifactItem = {
  sequence: number;
  siteId: string;
  ordinal: number;
  /** 整条 item（老 CLI、或没有点名字段的取数）。 */
  item?: unknown;
  /**
   * 只取字段时：spec 点名的路径 → 值（CLI 在 SQLite 里取好、超长的值已截短）。走不通的路径
   * 不在表里。在场时折叠只读它，不读 `item`。
   */
  fields?: Record<string, unknown>;
};

export type ChartSeriesModel = {
  /** recharts 的 dataKey；用序号而不是字段路径，点路径里的 "." 会被 recharts 当嵌套读法。 */
  key: string;
  field: string;
  label: string;
  unit?: string;
  /** 调色板槽位（see seriesColorVar）。 */
  colorIndex: number;
};

export type ChartPointModel = Record<string, number | string | null> & {
  /** 稳定 React key：只有新点播揭示动画，老点不重播。 */
  sequence: number;
  /** x 轴上的位置。非数值 x 时是到达序号。 */
  x: number;
  /** x 轴刻度上显示的文本。 */
  xLabel: string;
};

export type ChartModel = {
  kind: "chart";
  type: ArtifactChartType;
  scale: ArtifactChartScale;
  series: ChartSeriesModel[];
  points: ChartPointModel[];
  x: { label: string; unit?: string; numeric: boolean };
  /** 参考线：取自第一条带该字段的条目。log 轴下非正的参考线同样丢弃。 */
  baseline?: { value: number; label: string; unit?: string };
  /** memo 比较用的定义域；无点时缺席。 */
  domain?: { xMin: number; xMax: number; yMin: number; yMax: number };
};

type TableColumnModel = { field: string; label: string; unit?: string };
type TableRowModel = { id: string; sequence: number; cells: string[] };
type TableModel = {
  kind: "table";
  columns: TableColumnModel[];
  rows: TableRowModel[];
};

export type MetricTileModel = {
  field: string;
  label: string;
  unit?: string;
  /** 最后一条带该字段的条目里的值；从没出现过则缺席。 */
  value?: string;
  raw?: unknown;
  /** 该值来自哪一条条目——瓦片刷新时的动画 key。 */
  sequence?: number;
};
type MetricsModel = { kind: "metrics"; metrics: MetricTileModel[] };

export type BoardCardModel = {
  id: string;
  sequence: number;
  title: string;
  status: string;
  details: { label: string; value: string; unit?: string }[];
};
export type BoardColumnModel = {
  id: string;
  /** 「其他」列没有 spec 给的名字，标签由渲染器用 labels.otherColumn 补。 */
  other: boolean;
  cards: BoardCardModel[];
};
type BoardModel = {
  kind: "board";
  columns: BoardColumnModel[];
  cardCount: number;
};

type ArtifactPresetModel = ChartModel | TableModel | MetricsModel | BoardModel;

/** 落到末尾「其他」列的列 id；spec 的 columns 里若真有同名列，会与它合并——可接受。 */
const BOARD_OTHER_COLUMN_ID = "__other__";

/**
 * 点路径读取："timing.after"、"rounds.0.ms"。规则是协议上的契约
 * （`readWorkflowArtifactField`）：CLI 只取字段时在 SQLite 里按同一套规则取值，两边必须逐字相同。
 */
export function readArtifactField(item: unknown, path: string): unknown {
  return readWorkflowArtifactField(item, path);
}

/**
 * 从一条到达的条目里取字段：只取字段的条目查表（CLI 已按同一条规则取好，走不通的路径不在表里），
 * 整条 item 的条目（老 CLI）现场按路径读。四种折叠都只经这一个口子读条目。
 */
function readEntryField(entry: ArtifactItem, path: string): unknown {
  if (entry.fields !== undefined) {
    return Object.hasOwn(entry.fields, path) ? entry.fields[path] : undefined;
  }
  return readArtifactField(entry.item, path);
}

/**
 * 「这条条目带这个字段吗」。`undefined` 与 `null` 都算不带：
 * metrics 的「最后一条带该字段的条目」若把显式 null 也算进去，一次清空就会把瓦片钉死在空值上。
 */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** 数值化：真数字直接用；数字串也接（脚本从命令输出里抠出来的值常是字符串）。 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 单元格 / 卡片明细的显示文本。对象走紧凑 JSON——比 "[object Object]" 有用得多。 */
export function formatArtifactValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // 循环引用等：宁可显示一句占位，也不要让整张表抛异常。
    return String(value);
  }
}

function seriesKey(index: number): string {
  return `y${index}`;
}

function applyChart(spec: ChartSpec, items: readonly ArtifactItem[]): ChartModel {
  const fields = chartSeriesFields(spec);
  const series: ChartSeriesModel[] = fields.map((field, index) => ({
    key: seriesKey(index),
    field: field.field,
    label: artifactFieldLabel(field),
    ...(field.unit ? { unit: field.unit } : {}),
    colorIndex: index,
  }));

  type Raw = { sequence: number; x: unknown; values: (number | undefined)[] };
  const raws: Raw[] = [];
  let baseline: ChartModel["baseline"];

  for (const entry of items) {
    const rawX = readEntryField(entry, spec.x.field);
    if (!hasValue(rawX)) {
      // x 都没有的条目在图上无处安放；静默跳过（它仍在 Results 区里可见）。
      continue;
    }
    const values = fields.map((field) => {
      const value = toFiniteNumber(readEntryField(entry, field.field));
      if (value === undefined) {
        return undefined;
      }
      // log 轴上非正数没有位置——丢该点的这一维，而不是丢整条序列或整张图。
      return spec.scale === "log" && value <= 0 ? undefined : value;
    });
    raws.push({ sequence: entry.sequence, x: rawX, values });

    if (spec.baseline && !baseline) {
      const raw = readEntryField(entry, spec.baseline.field);
      const value = toFiniteNumber(raw);
      if (value !== undefined && !(spec.scale === "log" && value <= 0)) {
        baseline = {
          value,
          label: artifactFieldLabel(spec.baseline),
          ...(spec.baseline.unit ? { unit: spec.baseline.unit } : {}),
        };
      }
    }
  }

  // 数值 x 才排序。混了一个非数值就整轴退化成「到达顺序」——半排序的 x 轴比不排序更骗人。
  const numericX = raws.length > 0 && raws.every((raw) => toFiniteNumber(raw.x) !== undefined);
  const ordered = numericX
    ? [...raws].sort((left, right) => {
        const delta = toFiniteNumber(left.x)! - toFiniteNumber(right.x)!;
        // 同 x 时按到达顺序，保证同一批条目每次折叠出同一个顺序。
        return delta !== 0 ? delta : left.sequence - right.sequence;
      })
    : raws;

  const points: ChartPointModel[] = ordered.map((raw, index) => {
    const x = numericX ? toFiniteNumber(raw.x)! : index;
    const point: ChartPointModel = {
      sequence: raw.sequence,
      x,
      xLabel: formatArtifactValue(raw.x),
    };
    raw.values.forEach((value, seriesIndex) => {
      point[seriesKey(seriesIndex)] = value ?? null;
    });
    return point;
  });

  const yValues = ordered.flatMap((raw) =>
    raw.values.filter((value): value is number => value !== undefined),
  );
  const domain =
    points.length > 0 && yValues.length > 0
      ? {
          xMin: Math.min(...points.map((point) => point.x)),
          xMax: Math.max(...points.map((point) => point.x)),
          yMin: Math.min(...yValues),
          yMax: Math.max(...yValues),
        }
      : undefined;

  return {
    kind: "chart",
    type: spec.type ?? "line",
    scale: spec.scale ?? "linear",
    series,
    points,
    x: {
      label: artifactFieldLabel(spec.x),
      ...(spec.x.unit ? { unit: spec.x.unit } : {}),
      numeric: numericX,
    },
    ...(baseline ? { baseline } : {}),
    ...(domain ? { domain } : {}),
  };
}

function applyTable(spec: TableSpec, items: readonly ArtifactItem[]): TableModel {
  const columns: TableColumnModel[] = spec.columns.map((column) => ({
    field: column.field,
    label: artifactFieldLabel(column),
    ...(column.unit ? { unit: column.unit } : {}),
  }));

  // key 在场 = upsert：后到的条目替换整行，但**行保持首次出现的位置**——
  // 一张会跳动排序的表在运行期没法读。
  const byId = new Map<string, TableRowModel>();
  for (const entry of items) {
    const keyValue = spec.key ? readEntryField(entry, spec.key) : undefined;
    // key 缺席（或声明了 key 但这条没带）时用 journal 身份兜底：`siteId@ordinal` 逐条唯一，
    // 于是 upsert 自然退化成追加——不必为两种模式各写一条路径。
    const id = hasValue(keyValue)
      ? formatArtifactValue(keyValue)
      : `${entry.siteId}@${entry.ordinal}`;
    byId.set(id, {
      id,
      sequence: entry.sequence,
      cells: columns.map((column) => formatArtifactValue(readEntryField(entry, column.field))),
    });
  }

  return { kind: "table", columns, rows: [...byId.values()] };
}

function applyMetrics(spec: MetricsSpec, items: readonly ArtifactItem[]): MetricsModel {
  const metrics: MetricTileModel[] = spec.metrics.map((metric) => ({
    field: metric.field,
    label: artifactFieldLabel(metric),
    ...(metric.unit ? { unit: metric.unit } : {}),
  }));

  // 每块瓦片各找各的「最后一条带该字段的条目」——不是「最后一条条目」。
  // 一个只报 stage 的心跳条目不该把上一轮的 p99 抹成空。
  for (const entry of items) {
    metrics.forEach((tile, index) => {
      const raw = readEntryField(entry, tile.field);
      if (!hasValue(raw)) {
        return;
      }
      metrics[index] = {
        ...tile,
        value: formatArtifactValue(raw),
        raw,
        sequence: entry.sequence,
      };
    });
  }

  return { kind: "metrics", metrics };
}

function applyBoard(spec: BoardSpec, items: readonly ArtifactItem[]): BoardModel {
  const detail: ArtifactField[] = spec.detail ?? [];
  // Map 的插入顺序 = 卡片首次出现的顺序；改状态的卡在新列里仍按这个顺序排。
  const byId = new Map<string, BoardCardModel>();

  for (const entry of items) {
    const keyValue = readEntryField(entry, spec.key);
    if (!hasValue(keyValue)) {
      // 没有身份的条目在看板上无处安放（看板整个语义就是「按 key upsert」）。
      continue;
    }
    const id = formatArtifactValue(keyValue);
    const status = formatArtifactValue(readEntryField(entry, spec.status));
    const titleRaw = spec.cardTitle ? readEntryField(entry, spec.cardTitle) : undefined;
    byId.set(id, {
      id,
      sequence: entry.sequence,
      title: hasValue(titleRaw) ? formatArtifactValue(titleRaw) : id,
      status,
      details: detail.map((field) => ({
        label: artifactFieldLabel(field),
        value: formatArtifactValue(readEntryField(entry, field.field)),
        ...(field.unit ? { unit: field.unit } : {}),
      })),
    });
  }

  const columns: BoardColumnModel[] = spec.columns.map((column) => ({
    id: column,
    other: false,
    cards: [],
  }));
  const listed = new Map(columns.map((column) => [column.id, column]));
  const other: BoardColumnModel = { id: BOARD_OTHER_COLUMN_ID, other: true, cards: [] };

  for (const card of byId.values()) {
    (listed.get(card.status) ?? other).cards.push(card);
  }

  return {
    kind: "board",
    // 「其他」永远在末尾，且只在真有卡时出现——空列会让本来就窄的侧板更挤。
    columns: other.cards.length > 0 ? [...columns, other] : columns,
    cardCount: byId.size,
  };
}

export function applyArtifactItems(
  kind: "chart",
  spec: ChartSpec,
  items: readonly ArtifactItem[],
): ChartModel;
export function applyArtifactItems(
  kind: "table",
  spec: TableSpec,
  items: readonly ArtifactItem[],
): TableModel;
export function applyArtifactItems(
  kind: "metrics",
  spec: MetricsSpec,
  items: readonly ArtifactItem[],
): MetricsModel;
export function applyArtifactItems(
  kind: "board",
  spec: BoardSpec,
  items: readonly ArtifactItem[],
): BoardModel;
export function applyArtifactItems(
  kind: ArtifactPresetKind,
  spec: ArtifactPresetSpec,
  items: readonly ArtifactItem[],
): ArtifactPresetModel;
export function applyArtifactItems(
  kind: ArtifactPresetKind,
  spec: ArtifactPresetSpec,
  items: readonly ArtifactItem[],
): ArtifactPresetModel {
  switch (kind) {
    case "chart":
      return applyChart(spec as ChartSpec, items);
    case "table":
      return applyTable(spec as TableSpec, items);
    case "metrics":
      return applyMetrics(spec as MetricsSpec, items);
    case "board":
      return applyBoard(spec as BoardSpec, items);
  }
}
