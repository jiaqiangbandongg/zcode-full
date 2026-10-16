// @vitest-environment jsdom

// 弧端的槽位（docs/dynamic-workflow/presentation.md「Rails and arcs」）：一站的起飞与落地各占一个槽，
// 远端在左的在左、在右的在右，每一侧车道最低的在最外面；只有一个弧端的站仍用灯心；带的分叉点与
// 汇合点不占槽。回归：一站既有进来的弧又有出去的弧时，出去的竖段穿过进来的箭头（testfield「工作流压力测试」）。
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { arcTerminalOffsets, lampX } from "@/components/workflow-timeline/timeline-geometry.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

interface GraphSpec {
  names: readonly string[];
  /** 站下标 → 与它并行的站下标。 */
  alongside?: Record<number, readonly number[]>;
  edges: readonly (readonly [number, number])[];
}

function graphOf({ alongside = {}, edges, names }: GraphSpec): WorkflowCausalityGraphData {
  return {
    steps: names.map((name, i) => ({
      id: `ask#${i + 1}`,
      kind: "ask",
      label: name,
      line: i + 1,
      column: 1,
      lane: "actor#1",
      phase: `phase#${i + 1}`,
    })),
    lanes: [{ id: "actor#1", name: "worker", line: 1, column: 1 }],
    participants: names.map((_, i) => ({
      id: `phase#${i + 1}:actor#1`,
      phase: `phase#${i + 1}`,
      lane: "actor#1",
      steps: [`ask#${i + 1}`],
    })),
    handoffs: [],
    phases: names.map((name, i) => ({
      id: `phase#${i + 1}`,
      name,
      line: i + 1,
      column: 1,
      ...(alongside[i] === undefined
        ? {}
        : { alongside: alongside[i]!.map((j) => `phase#${j + 1}`) }),
    })),
    phaseEdges: edges.map(([from, to]) => ({ from: `phase#${from + 1}`, to: `phase#${to + 1}` })),
    exits: [`phase#${names.length}`],
  } as WorkflowCausalityGraphData;
}

const modelOf = (spec: GraphSpec) => buildWorkflowTimeline(graphOf(spec));

/** 每条弧（`from>to`）的起飞与落地偏移。 */
function offsetsOf(spec: GraphSpec): Record<string, { takeoff: number; landing: number }> {
  const model = modelOf(spec);
  const { landing, takeoff } = arcTerminalOffsets(model.arcs, model.bands, model.stations);
  return Object.fromEntries(
    model.arcs.map((arc, j) => [
      `${arc.from}>${arc.to}`,
      { landing: landing[j]! + 0, takeoff: takeoff[j]! + 0 },
    ]),
  );
}

const chain = (n: number): [number, number][] =>
  Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]);

/** 两跳：plan → draft → publish，中间各隔一站。 */
const HOPS: GraphSpec = {
  edges: [...chain(5), [0, 2], [2, 4]],
  names: ["plan", "gather", "draft", "review", "publish"],
};

/** 两个互不相干的二选一，复用同一对阶段名：left ⇄ right 两个方向都有边。 */
const TWO_CHOICES: GraphSpec = {
  edges: [
    [0, 1],
    [0, 2],
    [1, 2],
    [1, 3],
    [2, 1],
    [2, 3],
  ],
  names: ["choose", "left", "right", "next"],
};

/** testfield「工作流压力测试」（dwfrun-c6d25e4f…）归约后的阶段图：十一站、十四条边、一条带。 */
const STRESS: GraphSpec = {
  alongside: { 9: [8] },
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [3, 5],
    [4, 5],
    [4, 6],
    [5, 4],
    [5, 6],
    [6, 7],
    [7, 8],
    [7, 9],
    [8, 10],
    [9, 10],
  ],
  names: [
    "串行链：两步依赖",
    "并行扇出：四方同算",
    "回环门禁：修复到达标为止",
    "条件分支：按阈值选边",
    "支路甲：高门限汇总",
    "支路乙：低门限汇总",
    "混合扇出：逐项产出即复核",
    "并发相位：双翼交叠探针",
    "并发左翼：先行占位",
    "并发右翼：后行占位",
    "汇合收尾：成文与发布",
  ],
};

afterEach(cleanup);

describe("arcTerminalOffsets", () => {
  it("a station with one terminal keeps the lamp's centre", () => {
    expect(offsetsOf({ edges: [...chain(4), [3, 0]], names: ["a", "b", "c", "d"] })).toEqual({
      "3>0": { landing: 0, takeoff: 0 },
    });
    // 两条互不相干的弧各在一头：每站只有一个弧端。
    expect(offsetsOf({ edges: [...chain(6), [0, 2], [5, 3]], names: "abcdef".split("") })).toEqual({
      "0>2": { landing: 0, takeoff: 0 },
      "5>3": { landing: 0, takeoff: 0 },
    });
  });

  it("an arc in from the left and an arc out to the right take the left and right slots", () => {
    const model = modelOf(HOPS);
    expect(model.arcs.map((arc) => [arc.from, arc.to, arc.lane])).toEqual([
      [0, 2, 0],
      [2, 4, 1],
    ]);
    expect(offsetsOf(HOPS)).toEqual({
      "0>2": { landing: -5, takeoff: 0 },
      "2>4": { landing: 0, takeoff: 5 },
    });
  });

  it("on one side the arc in the lowest lane stands outermost, landing or takeoff alike", () => {
    const model = modelOf(TWO_CHOICES);
    expect(model.arcs.map((arc) => [arc.from, arc.to, arc.lane])).toEqual([
      [2, 1, 0],
      [0, 2, 1],
      [1, 3, 2],
    ]);
    expect(offsetsOf(TWO_CHOICES)).toEqual({
      // left：两个弧端都朝右——落地（车道 0）在最右，起飞（车道 2）在它里面。
      // right：两个弧端都朝左——起飞（车道 0）在最左，落地（车道 1）在它里面。
      "0>2": { landing: 5, takeoff: 0 },
      "1>3": { landing: 0, takeoff: -5 },
      "2>1": { landing: 5, takeoff: -5 },
    });
  });

  it("a fan-out nests: three takeoffs to the right, lane 0 outermost", () => {
    const spec: GraphSpec = {
      edges: [...chain(5), [0, 2], [0, 3], [0, 4]],
      names: ["triage", "small", "medium", "large", "close"],
    };
    expect(offsetsOf(spec)).toEqual({
      "0>2": { landing: 0, takeoff: 10 },
      "0>3": { landing: 0, takeoff: 0 },
      "0>4": { landing: 0, takeoff: -10 },
    });
  });

  it("both sides at once: leftward terminals first, then rightward ones", () => {
    // c 有四个弧端：a → c 与 c → a 朝左，d → c 与 c → e 朝右。
    const spec: GraphSpec = {
      edges: [...chain(5), [0, 2], [2, 4], [3, 2], [2, 0]],
      names: ["a", "b", "c", "d", "e"],
    };
    const lanes = Object.fromEntries(
      modelOf(spec).arcs.map((arc) => [`${arc.from}>${arc.to}`, arc.lane]),
    );
    expect(lanes).toEqual({ "0>2": 1, "2>0": 3, "2>4": 2, "3>2": 0 });
    expect(offsetsOf(spec)).toEqual({
      // a：两个弧端都朝右——回边落地（车道 3）在里面、起飞（车道 1）在外面。
      "0>2": { landing: -15, takeoff: 5 },
      "2>0": { landing: -5, takeoff: -5 },
      // c：左侧 a → c（车道 1）−15、c → a（车道 3）−5；右侧 c → e（车道 2）+5、d → c（车道 0）+15。
      "2>4": { landing: 0, takeoff: 5 },
      "3>2": { landing: 15, takeoff: 0 },
    });
  });

  it("a band's fork and merge points take no slot and do not count at the lamp", () => {
    // 带 [[B, D], [C]]，前驱 P、汇合 J。D → B 是主线上的回边，两端都是灯。S → B 与 T → C 被重挂到
    // 分叉点（下标仍是 B），D → X 被重挂到汇合点（下标仍是 D）——它们若也占 B、D 的槽，那两枚灯上的
    // 回边就会被挤出灯心。
    const spec: GraphSpec = {
      alongside: { 4: [3], 5: [4] },
      edges: [
        [0, 1],
        [1, 2],
        [2, 3],
        [2, 4],
        [3, 5],
        [4, 6],
        [5, 6],
        [6, 7],
        [5, 3],
        [0, 3],
        [1, 4],
        [5, 7],
      ],
      names: ["S", "T", "P", "B", "C", "D", "J", "X"],
    };
    const model = modelOf(spec);
    expect(
      model.bands.map((band) => [
        band.from,
        band.to,
        band.pred,
        band.join,
        band.tracks.map((track) => track.stations),
      ]),
    ).toEqual([[3, 5, 2, 6, [[3, 5], [4]]]]);
    expect(model.arcs.map((arc) => [arc.from, arc.to, arc.air])).toEqual(
      expect.arrayContaining([
        [5, 3, 0],
        [0, 3, 1],
        [1, 3, 1],
        [5, 7, 1],
      ]),
    );
    expect(offsetsOf(spec)).toEqual({
      "0>3": { landing: 0, takeoff: 0 },
      "1>3": { landing: 0, takeoff: 0 },
      "5>3": { landing: 0, takeoff: 0 },
      "5>7": { landing: 0, takeoff: 0 },
    });
  });
});

describe("WorkflowTimeline arc terminals", () => {
  function terminalsOf(spec: GraphSpec) {
    const model = modelOf(spec);
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowTimeline, { model }),
      ),
    );
    const byStation = new Map<number, number[]>();
    const add = (station: number, x: number) =>
      byStation.set(
        station,
        [...(byStation.get(station) ?? []), x].sort((l, r) => l - r),
      );
    for (const arc of view.getAllByTestId("workflow-timeline-arc")) {
      const d = arc.querySelector("path")!.getAttribute("d")!;
      // M xa,ya V … Q xa,ly … H … Q xb,ly xb,ly+8 V yb
      const xa = Number(/^M(-?[\d.]+),/u.exec(d)![1]);
      const xb = Number([...d.matchAll(/Q(-?[\d.]+),/gu)].at(-1)![1]);
      add(Number(arc.getAttribute("data-arc-from")), xa);
      add(Number(arc.getAttribute("data-arc-to")), xb);
    }
    return { byStation, model };
  }

  it("工作流压力测试: 支路甲 and 支路乙 each get two slots, no shared vertical", () => {
    const { byStation, model } = terminalsOf(STRESS);
    expect(model.arcs.map((arc) => [arc.from, arc.to, arc.lane])).toEqual([
      [5, 4, 0],
      [3, 5, 1],
      [4, 6, 2],
    ]);
    const lamp = (i: number) => lampX(i, 0);
    expect(Object.fromEntries(byStation)).toEqual({
      3: [lamp(3)],
      // 支路甲：起飞到混合扇出（车道 2）在 −5，支路乙的回边（车道 0）落在 +5。
      4: [lamp(4) - 5, lamp(4) + 5],
      // 支路乙：回边起飞（车道 0）在 −5，条件分支的弧（车道 1）落在 +5。
      5: [lamp(5) - 5, lamp(5) + 5],
      6: [lamp(6)],
    });
  });

  it("the two choices reusing phase names draw four distinct verticals", () => {
    const { byStation } = terminalsOf(TWO_CHOICES);
    for (const xs of byStation.values()) expect(new Set(xs).size).toBe(xs.length);
    expect(byStation.get(1)).toEqual([lampX(1) - 5, lampX(1) + 5]);
    expect(byStation.get(2)).toEqual([lampX(2) - 5, lampX(2) + 5]);
  });
});
