// @vitest-environment jsdom
// 补全的框（docs/dynamic-workflow/presentation.md「Holes on the timeline」的「Filled with phases」「The stroke」
// 「Filled without phases」「The pane」）：几何是纯函数，钉数；点亮只认头——卡上的头与笔标、侧板的标题行
// 与笔标——站与药丸不点亮任何东西；一次只亮一个；侧板不缩进。
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import {
  FRAME_OUTSET,
  fillDepthOf,
  fillMarksOf,
  framePath,
  legendGaps,
  spineFrameBox,
  timelineFrames,
} from "@/components/workflow-timeline/timeline-frames.js";
import {
  HEAD_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  timelineLayout,
} from "@/components/workflow-timeline/timeline-geometry.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 留白 id 是名字键 `hole#<8 位十六进制>`（docs/analysis.md「Sites」）；渲染器只认形状。
const H1 = "hole#a0000001"; // 决定分组（体里两个阶段）
const H2 = "hole#a0000002"; // 评判（尾巴、无阶段的补全）

type Step = WorkflowCausalityGraphData["steps"][number];
const STEPS: Step[] = [
  { id: "ask#1", kind: "ask", label: "scout", lane: "actor#1", phase: "phase#1" },
  {
    id: `${H1}/ask#1`,
    kind: "ask",
    label: "smoke",
    lane: `${H1}/actor#1`,
    phase: `${H1}/phase#1`,
    fill: H1,
  },
  {
    id: `${H1}/ask#2`,
    kind: "ask",
    label: "group",
    lane: `${H1}/actor#2`,
    phase: `${H1}/phase#2`,
    fill: H1,
  },
  { id: "ask#2", kind: "ask", label: "member", lane: "actor#2", phase: "phase#2" },
  { id: `${H2}/ask#1`, kind: "ask", label: "judge", lane: `${H2}/actor#1`, phase: H2, fill: H2 },
];
/** 探索 → [决定分组：冒烟测试 → 分组] → 执行 → 评判（无阶段补全，一个 ask）。 */
const GRAPH: WorkflowCausalityGraphData = {
  steps: STEPS,
  lanes: [
    { id: "actor#1", name: "侦察员" },
    { id: `${H1}/actor#1`, name: "冒烟员" },
    { id: `${H1}/actor#2`, name: "分组员" },
    { id: "actor#2", name: "组员" },
    { id: `${H2}/actor#1`, name: "评委" },
  ],
  participants: STEPS.map((step) => ({
    id: `${step.phase}:${step.lane}`,
    lane: step.lane,
    phase: step.phase!,
    steps: [step.id],
  })),
  handoffs: [],
  phases: [
    { id: "phase#1", name: "探索" },
    { id: H1, name: "决定分组" },
    { id: `${H1}/phase#1`, name: "冒烟测试", fill: H1 },
    { id: `${H1}/phase#2`, name: "分组", fill: H1 },
    { id: "phase#2", name: "执行" },
    { id: H2, name: "评判" },
  ],
  phaseEdges: [
    { from: "phase#1", to: H1 },
    { from: H1, to: `${H1}/phase#1` },
    { from: `${H1}/phase#1`, to: `${H1}/phase#2` },
    { from: `${H1}/phase#2`, to: "phase#2" },
    { from: "phase#2", to: H2 },
  ],
  holes: [],
};

function run(filledAt = 1): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-wf-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    holes: [
      { siteId: H1, ordinal: 1, name: "决定分组", state: "filled", filledAt },
      { siteId: H2, ordinal: 1, name: "评判", state: "filled", filledAt },
    ],
  };
}

function wrap(node: ReturnType<typeof createElement>) {
  return render(createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, node));
}

afterEach(cleanup);

describe("框的几何", () => {
  it("一笔：从上缘的笔 x 出发、顺时针、回到笔 x；1px 线落在半像素上；没有笔 x 时从左上角圆角之后起", () => {
    const d = framePath({ x0: 184, y0: 12, x1: 560, y1: 100, start: 209 });
    expect(d.startsWith("M209,12.5 H551.5")).toBe(true);
    expect(d.endsWith("H209")).toBe(true);
    // 顺时针：右上角 → 右缘向下 → 底缘向左 → 左缘向上 → 左上角。
    expect(d).toContain("Q559.5,12.5 559.5,20.5");
    expect(d).toContain("V91.5");
    expect(d).toContain("H192.5");
    const corner = framePath({ x0: 0, y0: 0, x1: 100, y1: 50 });
    expect(corner.startsWith("M8.5,0.5")).toBe(true);
    expect(corner.endsWith("H8.5")).toBe(true);
  });

  it("有头的补全：首列左缘 − 8 到末列右缘 + 8，头那一行的中线到最高那一列药丸之下 8px，起笔在第一盏灯", () => {
    const model = buildWorkflowTimeline(GRAPH, run());
    expect(model.fills?.map((fill) => [fill.holeId, fill.from, fill.to])).toEqual([[H1, 1, 2]]);
    const layout = timelineLayout(model.arcs, model.bands, true);
    const frames = timelineFrames({
      columnHeight: (i) => (i === 2 ? 70 : 32),
      fills: model.fills!,
      height: 400,
      inset: 0,
      layout,
      parents: model.holeParents ?? {},
      stations: model.stations,
      width: 5 * STATION_PITCH,
    });
    const h1 = frames.find((frame) => frame.holeId === H1)!;
    expect(h1.box).toEqual({
      x0: STATION_PITCH - FRAME_OUTSET,
      x1: 2 * STATION_PITCH + STATION_WIDTH + FRAME_OUTSET,
      y0: HEAD_ROW / 2,
      y1: layout.pillsTop + 70 + 8,
      start: STATION_PITCH + 17,
    });
    // 无阶段的补全（评判）：它那一列，轨道行之上 4px 到它的药丸之下 8px，从左上角起笔。
    const h2 = frames.find((frame) => frame.holeId === H2)!;
    expect(h2.box).toEqual({
      x0: 4 * STATION_PITCH - FRAME_OUTSET,
      x1: 4 * STATION_PITCH + STATION_WIDTH + FRAME_OUTSET,
      y0: layout.rowY[0]! - 12 - 4,
      y1: layout.pillsTop + 32 + 8,
    });
  });

  it("那几列没有药丸（卡收起）时框只到轨道行之下 4px；首列与末列的框夹在画布里", () => {
    const model = buildWorkflowTimeline(GRAPH, run());
    const layout = timelineLayout(model.arcs, model.bands, true);
    const fills = [{ holeId: H1, name: "决定分组", from: 0, to: 4 }];
    const [frame] = timelineFrames({
      columnHeight: () => 0,
      fills,
      height: 90,
      inset: 0,
      layout,
      parents: {},
      stations: model.stations.map(({ track }) => ({ track })),
      width: 4 * STATION_PITCH + STATION_WIDTH,
    });
    expect(frame!.box.y1).toBe(layout.pillsTop - 4);
    expect(frame!.box.x0).toBe(0);
    expect(frame!.box.x1).toBe(4 * STATION_PITCH + STATION_WIDTH);
  });

  it("与外层同起于一列的嵌套框每层左、右、下各收 4px；起点不同的不收", () => {
    const layout = timelineLayout([], [], true);
    const fills = [
      { holeId: H1, name: "外", from: 1, to: 3 },
      { holeId: H2, name: "内", from: 1, to: 2 },
    ];
    const base = {
      columnHeight: () => 32,
      height: 400,
      inset: 0,
      layout,
      stations: [],
      width: 2000,
    };
    const [outer, inner] = timelineFrames({ ...base, fills, parents: { [H2]: H1 } });
    expect(inner!.box.x0 - outer!.box.x0).toBe(4);
    expect(inner!.box.y1).toBe(outer!.box.y1 - 4);
    expect(inner!.box.y0).toBe(outer!.box.y0);
    // 没有父表：两者无关，不收。
    const [, unrelated] = timelineFrames({ ...base, fills, parents: {} });
    expect(unrelated!.box.x0).toBe(outer!.box.x0);
  });

  it("笔标：只收已补全、又不在 fills 里的留白站；图例按头那一行两侧各让 4px 挖空，量不到宽度不挖", () => {
    const model = buildWorkflowTimeline(GRAPH, run());
    expect(fillMarksOf(model.stations, model.fills ?? [])).toEqual([
      { holeId: H2, index: 4, filledAt: 1 },
    ]);
    expect(
      legendGaps([
        { left: 203, width: 120 },
        { left: 395, width: 0 },
      ]),
    ).toEqual([{ x: 199, width: 128 }]);
    expect(fillDepthOf(H2, [{ holeId: H1 }], { [H2]: H1 })).toBe(1);
  });

  it("侧板：x 8 → 右缘 − 12，嵌套每层各收 4px；有头的从标题中线到最后一节之下 4px，起笔在轨道 x；无头的上下各收 2px", () => {
    expect(spineFrameBox({ top: 100, bottom: 300, width: 440, depth: 0, headed: true })).toEqual({
      x0: 8,
      x1: 428,
      y0: 112,
      y1: 304,
      start: 21,
    });
    expect(spineFrameBox({ top: 100, bottom: 300, width: 440, depth: 1, headed: false })).toEqual({
      x0: 12,
      x1: 424,
      y0: 102,
      y1: 298,
    });
  });
});

describe("卡：只有头点亮框", () => {
  it("指针在站或药丸上什么都不亮；在头上只亮这一个框、头换前景色；离开时熄", () => {
    const view = wrap(
      createElement(WorkflowTimeline, { model: buildWorkflowTimeline(GRAPH, run()) }),
    );
    const frameOf = (id: string) => view.container.querySelector(`[data-fill-frame="${id}"]`)!;
    expect(
      view.container.querySelectorAll('[data-testid="workflow-timeline-fill-frame"]'),
    ).toHaveLength(2);
    const station = view.container.querySelector(
      `[data-testid="workflow-timeline-station"][data-fill="${H1}"]`,
    )!;
    fireEvent.pointerOver(station);
    expect(view.container.querySelector('[data-fill-on="true"]')).toBeNull();
    const pill = view.container.querySelector(
      `[data-testid="workflow-timeline-pills"][data-fill="${H1}"]`,
    )!;
    fireEvent.pointerOver(pill);
    expect(view.container.querySelector('[data-fill-on="true"]')).toBeNull();

    const head = view.getByTestId("workflow-timeline-fill-head");
    fireEvent.pointerOver(head.querySelector("svg")!);
    expect(frameOf(H1).getAttribute("data-fill-on")).toBe("true");
    expect(frameOf(H2).getAttribute("data-fill-on")).toBeNull();
    expect(head.getAttribute("data-fill-on")).toBe("true");
    expect(head.className).toContain("text-foreground");
    fireEvent.pointerLeave(view.getByTestId("workflow-timeline"));
    expect(view.container.querySelector('[data-fill-on="true"]')).toBeNull();
  });

  it("弧那一层 SVG 不接指针：它铺满整张时间线、画在头之后，接了就吞掉头的悬停与点击", () => {
    const graph: WorkflowCausalityGraphData = {
      ...GRAPH,
      phaseEdges: [
        ...(GRAPH.phaseEdges ?? []),
        { from: "phase#2", to: `${H1}/phase#1`, back: true },
      ],
    };
    const view = wrap(
      createElement(WorkflowTimeline, { model: buildWorkflowTimeline(graph, run()) }),
    );
    const layers = [...view.container.querySelectorAll("svg")].filter(
      (svg) => svg.querySelector("marker") !== null,
    );
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers)
      expect(layer.getAttribute("class")).toContain("pointer-events-none");
  });

  it("无阶段的补全：指针落在站头的笔标上，框住这一列", () => {
    const view = wrap(
      createElement(WorkflowTimeline, { model: buildWorkflowTimeline(GRAPH, run()) }),
    );
    const mark = view.getByTestId("workflow-hole-fill-mark");
    expect(mark.getAttribute("data-fill-head")).toBe(H2);
    // 指针真正落下的是笔图标（SVGElement）：委托必须从它往上找到笔标。
    fireEvent.pointerOver(mark.querySelector("svg")!);
    expect(
      view.container.querySelector(`[data-fill-frame="${H2}"]`)!.getAttribute("data-fill-on"),
    ).toBe("true");
    expect(
      view.container.querySelector(`[data-fill-frame="${H1}"]`)!.getAttribute("data-fill-on"),
    ).toBeNull();
  });

  it("补全刚接进 run：两个框都带新鲜态、没有指针也亮", () => {
    const view = wrap(
      createElement(WorkflowTimeline, { model: buildWorkflowTimeline(GRAPH, run(Date.now())) }),
    );
    const fresh = view.container.querySelectorAll(
      '[data-testid="workflow-timeline-fill-frame"][data-fill-fresh="true"]',
    );
    expect(fresh).toHaveLength(2);
    for (const frame of fresh) expect(frame.getAttribute("class")).toContain("wf-fill-frame-fresh");
  });
});

describe("侧板：同一个框竖着画，不缩进", () => {
  function pane(filledAt = 1) {
    const model = buildWorkflowTimeline(GRAPH, run(filledAt));
    return wrap(
      createElement(WorkflowRunPhaseList, {
        graph: GRAPH,
        model,
        pendingQuestions: [],
        run: run(filledAt),
      }),
    );
  }

  it("补全写下的节与别的节同一条文字列：标题行与节头都不再多缩 12px", () => {
    const view = pane();
    const sections = view.getAllByTestId("workflow-run-phase");
    const inFill = sections.filter((section) => section.getAttribute("data-phase-fill") === H1);
    expect(inFill).toHaveLength(2);
    const plain = sections.find((section) => section.getAttribute("data-phase-id") === "phase#1")!;
    const pad = (section: HTMLElement) =>
      within(section).getByTestId("workflow-run-phase-toggle").style.paddingLeft;
    for (const section of inFill) expect(pad(section)).toBe(pad(plain));
    expect(view.getByTestId("workflow-run-fill-heading").style.paddingLeft).toBe("");
  });

  it("标题行是头：指针落在它上面画出这次补全的框；落在节头上不画；笔标框住它那一节", () => {
    const view = pane();
    const frames = view.container.querySelectorAll('[data-testid="workflow-run-fill-frame"]');
    expect([...frames].map((frame) => frame.getAttribute("data-fill-frame"))).toEqual([H1, H2]);
    const frameOf = (id: string) =>
      view.container.querySelector(
        `[data-testid="workflow-run-fill-frame"][data-fill-frame="${id}"]`,
      )!;
    const toggle = within(view.getAllByTestId("workflow-run-phase")[1]!).getByTestId(
      "workflow-run-phase-toggle",
    );
    fireEvent.pointerOver(toggle);
    expect(view.container.querySelector('[data-fill-on="true"]')).toBeNull();
    const heading = view.getByTestId("workflow-run-fill-heading");
    expect(heading.getAttribute("data-fill-head")).toBe(H1);
    fireEvent.pointerOver(heading);
    expect(frameOf(H1).getAttribute("data-fill-on")).toBe("true");
    expect(heading.getAttribute("data-fill-on")).toBe("true");
    expect(frameOf(H2).getAttribute("data-fill-on")).toBeNull();
    fireEvent.pointerOver(view.getByTestId("workflow-hole-fill-mark").querySelector("svg")!);
    expect(frameOf(H2).getAttribute("data-fill-on")).toBe("true");
    expect(frameOf(H1).getAttribute("data-fill-on")).toBeNull();
    fireEvent.pointerLeave(view.getByTestId("workflow-run-phases"));
    expect(view.container.querySelector('[data-fill-on="true"]')).toBeNull();
  });

  it("新鲜的两秒：侧板的框也自己画一遍，标题染警示色", () => {
    const view = pane(Date.now());
    const frame = view.container.querySelector(
      `[data-testid="workflow-run-fill-frame"][data-fill-frame="${H1}"]`,
    )!;
    expect(frame.getAttribute("data-fill-fresh")).toBe("true");
    expect(view.getByTestId("workflow-run-fill-heading").className).toContain("text-warning");
  });
});
