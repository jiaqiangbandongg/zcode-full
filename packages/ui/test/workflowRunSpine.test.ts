// @vitest-environment jsdom

// 并行阶段在脊线上（docs/dynamic-workflow/presentation.md「The spine」）：卡上横着的带，在运行
// 详情页竖着读，像提交图——左边是轨道、右边是文字，两者不共用一列。分叉与汇合各占两节之间的一行
// 16px 的接头，只在前驱 / 汇合站存在时才有；没有它们时 strand 在自己的灯上起止。排布在
// `workflowRunSpine.ts` 里是纯函数，这里既钉它，也钉它真的接到了 DOM 上。
import { createElement } from "react";
import { cleanup, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { spineLayout } from "@/app-shell/workflowRunSpine.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

/** 一站一个 ask 成员的骨架图：`near[i]` 是第 i 站的 `alongside`，边按下标给。 */
function bandGraph(
  near: (number[] | undefined)[],
  edges: [number, number][],
): WorkflowCausalityGraphData {
  const steps: WorkflowCausalityGraphData["steps"] = near.map((_, i) => ({
    id: `ask#${i}`,
    kind: "ask",
    label: `step ${i}`,
    lane: `actor#${i}`,
    phase: `phase#${i}`,
  }));
  return {
    steps,
    lanes: near.map((_, i) => ({ id: `actor#${i}`, name: `agent ${i}` })),
    participants: near.map((_, i) => ({
      id: `phase#${i}:actor#${i}`,
      lane: `actor#${i}`,
      phase: `phase#${i}`,
      steps: [`ask#${i}`],
    })),
    handoffs: [],
    phases: near.map((alongside, i) => ({
      id: `phase#${i}`,
      name: `P${i}`,
      ...(alongside === undefined ? {} : { alongside: alongside.map((j) => `phase#${j}`) }),
    })),
    phaseEdges: edges.map(([from, to]) => ({ from: `phase#${from}`, to: `phase#${to}` })),
    exits: [`phase#${near.length - 1}`],
  };
}

type Node = WorkflowRunState["nodes"][number];
function run(nodes: Node[]): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-wf-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes,
    lastEventSequence: 0,
  };
}
const settled = (siteId: string): Node =>
  ({ siteId, ordinal: 1, phase: "settled", outcome: "ok" }) as Node;
const executing = (siteId: string): Node => ({ siteId, ordinal: 1, phase: "executing" }) as Node;

// A ∥ B → C：有界层报的是约简后的边 A → B、B → C。
const TESTFIELD = bandGraph(
  [undefined, [0], undefined],
  [
    [0, 1],
    [1, 2],
  ],
);
// 同一条带，前面多一站 P：P → A 让带有了前驱，B → C 让它有了汇合站。
const WITH_PRED = bandGraph(
  [undefined, undefined, [1], undefined],
  [
    [0, 1],
    [1, 2],
    [2, 3],
  ],
);

function renderSpine(graph: WorkflowCausalityGraphData, state?: WorkflowRunState) {
  const model = buildWorkflowTimeline(graph, state);
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkflowRunPhaseList, { graph, model, pendingQuestions: [], run: state }),
    ),
  );
}

// plan → {A ∥ B}，带后面没有站：有前驱、没有汇合站（LOOP_B 的形状）。
const OPEN_END = bandGraph(
  [undefined, undefined, [1]],
  [
    [0, 1],
    [0, 2],
    [2, 0],
  ],
);

/** 容器的直接子元素序列：节是 `phase:<下标>`，接头是 `fork` / `merge`。 */
const sequenceOf = (view: ReturnType<typeof render>) =>
  [...view.getByTestId("workflow-run-phases").children].map((child) =>
    child.getAttribute("data-testid") === "workflow-run-spine-joint"
      ? child.getAttribute("data-joint-kind")
      : `phase:${child.getAttribute("data-phase-id")?.replace("phase#", "")}`,
  );

const railsOf = (element: HTMLElement) =>
  within(element)
    .queryAllByTestId("workflow-run-spine-rail")
    .map((rail) => ({
      ink: rail.getAttribute("data-rail-ink"),
      position: rail.getAttribute("data-rail-position"),
      track: rail.getAttribute("data-rail-track"),
    }));

beforeEach(() => {
  cleanup();
});

describe("spineLayout", () => {
  it("没有带时与从前一样：轨距 12、没有让位、每一节只有主轨的上下两截、没有接头", () => {
    const line = bandGraph(
      [undefined, undefined, undefined],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const layout = spineLayout(buildWorkflowTimeline(line, undefined));
    expect(layout).toMatchObject({ gutter: 0, pitch: 12 });
    expect(layout.sections.map((section) => section.rails)).toEqual([
      [{ ink: "faint", position: "below", track: 0 }],
      [
        { ink: "faint", position: "above", track: 0 },
        { ink: "faint", position: "below", track: 0 },
      ],
      [{ ink: "faint", position: "above", track: 0 }],
    ]);
    expect(layout.sections.some((section) => section.fork ?? section.merge)).toBe(false);
  });

  it("带有前驱也有汇合站：分叉行在带首节之前、汇合行在带末节之后，主轨与分支各就各位", () => {
    const layout = spineLayout(buildWorkflowTimeline(WITH_PRED, undefined));
    expect(layout).toMatchObject({ gutter: 12, pitch: 12 });
    const [p, a, b, c] = layout.sections;
    expect(a!.fork).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint" });
    expect(b!.merge).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint" });
    expect([p, c].some((section) => section!.fork ?? section!.merge)).toBe(false);
    expect(p!.rails).toEqual([{ ink: "faint", position: "below", track: 0 }]);
    // A：主轨从分叉行下来到灯，再往下接汇合行；分支轨从分叉行一路穿过去找 B 的灯。
    expect(a!.rails).toEqual([
      { ink: "faint", position: "above", track: 0 },
      { ink: "faint", position: "below", track: 0 },
      { ink: "faint", position: "full", track: 1 },
    ]);
    // B：自己那条分支轨上下两截，主轨整节穿过。
    expect(b!.rails).toEqual([
      { ink: "faint", position: "full", track: 0 },
      { ink: "faint", position: "above", track: 1 },
      { ink: "faint", position: "below", track: 1 },
    ]);
    expect(c!.rails).toEqual([{ ink: "faint", position: "above", track: 0 }]);
  });

  it("带从第一站起：分叉行是开口的根，两条 strand 从它下来", () => {
    const layout = spineLayout(buildWorkflowTimeline(TESTFIELD, undefined));
    const [a, b, c] = layout.sections;
    expect(a!.fork).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint", open: true });
    expect(b!.merge).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint" });
    // A 在主线上：主轨从根下来到灯，再往下穿过 B 去接汇合行；分支轨从根一路穿过 A 去找 B。
    expect(a!.rails).toEqual([
      { ink: "faint", position: "above", track: 0 },
      { ink: "faint", position: "below", track: 0 },
      { ink: "faint", position: "full", track: 1 },
    ]);
    expect(b!.rails).toEqual([
      { ink: "faint", position: "full", track: 0 },
      { ink: "faint", position: "above", track: 1 },
      { ink: "faint", position: "below", track: 1 },
    ]);
    expect(c!.rails).toEqual([{ ink: "faint", position: "above", track: 0 }]);
  });

  it("带到最后一站：汇合行是开口的汇点，分支与主线在最后一节之下相遇", () => {
    const layout = spineLayout(buildWorkflowTimeline(OPEN_END, undefined));
    const [, a, b] = layout.sections;
    expect(a!.fork).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint" });
    expect(b!.merge).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint", open: true });
    expect(a!.rails).toEqual([
      { ink: "faint", position: "above", track: 0 },
      { ink: "faint", position: "below", track: 0 },
      { ink: "faint", position: "full", track: 1 },
    ]);
    // B：自己那条分支轨上下两截；主线在 A 之后没有成员，照样整节穿过去接汇合行。
    expect(b!.rails).toEqual([
      { ink: "faint", position: "full", track: 0 },
      { ink: "faint", position: "above", track: 1 },
      { ink: "faint", position: "below", track: 1 },
    ]);
  });

  it("整个工作流就是一条带、每条 strand 只有一站：仍然画出根、每站一条线、汇点", () => {
    // 回归（2026-09-24 实机）：四阶段两两并行、前后都没有站——此前按「在灯上起止」的规则，每条
    // strand 长度为零，脊线上只剩四枚悬空的灯。
    const whole = bandGraph(
      [undefined, [0], [0, 1], [0, 1, 2]],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
    const model = buildWorkflowTimeline(whole, undefined);
    expect(model.bands).toHaveLength(1);
    expect(model.bands[0]).toMatchObject({ from: 0, to: 3 });
    expect(model.bands[0]!.pred).toBeUndefined();
    expect(model.bands[0]!.join).toBeUndefined();
    const { sections } = spineLayout(model);
    expect(sections[0]!.fork).toMatchObject({ open: true });
    expect(sections[3]!.merge).toMatchObject({ open: true });
    expect(sections[0]!.fork!.branches.map((branch) => branch.track)).toEqual([1, 2, 3]);
    // 每一节里四条轨道都在：自己那条是上下两截，别人的整节穿过。
    for (const [i, section] of sections.entries()) {
      expect(section.rails.map((rail) => [rail.track, rail.position])).toEqual(
        [0, 1, 2, 3].flatMap((t) =>
          t === i
            ? [
                [t, "above"],
                [t, "below"],
              ]
            : [[t, "full"]],
        ),
      );
    }
  });

  it("分支轨道穿过别人的节：只在 strand 活着的那几节整节穿过", () => {
    // 带 {1,4}：轨道 0 是 1、3、4，轨道 1 只有 2；前驱 0、汇合站 5。
    const wide = bandGraph(
      [undefined, undefined, [1], undefined, [2], undefined],
      [
        [0, 1],
        [1, 2],
        [2, 5],
        [3, 4],
        [4, 5],
      ],
    );
    const model = buildWorkflowTimeline(wide, undefined);
    expect(model.bands[0]).toMatchObject({ from: 1, join: 5, pred: 0, to: 4 });
    expect(model.bands[0]!.tracks.map((track) => track.stations)).toEqual([[1, 3, 4], [2]]);
    const { sections } = spineLayout(model);
    expect(sections[1]!.fork).toBeDefined();
    expect(sections[4]!.merge).toBeDefined();
    const track1 = (i: number) => sections[i]!.rails.filter((rail) => rail.track === 1);
    // 分叉行之下、第一枚灯之前：整节穿过；过了最后一枚灯、汇合行之前：也整节穿过。
    expect(track1(1)).toEqual([{ ink: "faint", position: "full", track: 1 }]);
    expect(track1(3)).toEqual([{ ink: "faint", position: "full", track: 1 }]);
    expect(track1(4)).toEqual([{ ink: "faint", position: "full", track: 1 }]);
    // 主轨穿过分支站 2（前后都有主线成员）。
    expect(sections[2]!.rails.filter((rail) => rail.track === 0)).toEqual([
      { ink: "faint", position: "full", track: 0 },
    ]);
    // 汇合站那一节只有主轨的上半截：汇合在它上面的那一行里，不在它的节头里。
    expect(sections[5]!.rails).toEqual([{ ink: "faint", position: "above", track: 0 }]);
  });

  it("轨距：最多四条分支轨时 12，多于四条收到 8；文字列让开整个轨道区", () => {
    const fan = (branches: number) => {
      const n = branches + 1;
      const near = [
        undefined,
        ...Array.from({ length: n }, (_, k) =>
          k === 0 ? undefined : Array.from({ length: k }, (_, j) => j + 1),
        ),
        undefined,
      ];
      const edges: [number, number][] = near.slice(1).map((_, k) => [k, k + 1]);
      return spineLayout(buildWorkflowTimeline(bandGraph(near, edges), undefined));
    };
    expect(fan(4)).toMatchObject({ gutter: 48, pitch: 12 });
    expect(fan(5)).toMatchObject({ gutter: 40, pitch: 8 });
  });

  it("并排的两条带：前一条的开口汇合行紧接后一条的开口分叉行", () => {
    // P → [A, B ∥ A, C ∥ B] → [D, E ∥ D] → J
    const adjacent = bandGraph(
      [undefined, undefined, [1], [2], undefined, [4], undefined],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
        [5, 6],
      ],
    );
    const model = buildWorkflowTimeline(adjacent, undefined);
    expect(model.bands.map((band) => [band.from, band.to, band.pred, band.join])).toEqual([
      [1, 3, 0, undefined],
      [4, 5, undefined, 6],
    ]);
    const { sections } = spineLayout(model);
    expect(
      sections.flatMap((section, i) =>
        [
          section.fork ? `fork:${i}${section.fork.open ? ":open" : ""}` : [],
          section.merge ? `merge:${i}${section.merge.open ? ":open" : ""}` : [],
        ].flat(),
      ),
    ).toEqual(["fork:1", "merge:3:open", "fork:4:open", "merge:5"]);
    // C 的主轨往下接开口的汇合行，D 的主轨从开口的分叉行下来。
    expect(sections[3]!.rails.find((rail) => rail.position === "below")).toEqual({
      ink: "faint",
      position: "below",
      track: 0,
    });
    expect(sections[4]!.rails.find((rail) => rail.position === "above")).toEqual({
      ink: "faint",
      position: "above",
      track: 0,
    });
  });
});

describe("WorkflowRunPhaseList · 带", () => {
  it("文字列让开整个轨道区：每一节的节头都从同一列起，灯留在自己的轨道上", () => {
    const view = renderSpine(TESTFIELD);
    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((section) => section.getAttribute("data-phase-track"))).toEqual([
      "0",
      "1",
      "0",
    ]);
    for (const phase of phases) {
      expect(within(phase).getByTestId("workflow-run-phase-toggle").style.paddingLeft).toBe("51px");
    }
    const lamps = phases.map((phase) => within(phase).getByTestId("workflow-run-phase-lamp"));
    expect(lamps.map((lamp) => lamp.style.left)).toEqual(["", "28px", ""]);
  });

  it("接头行插在两节之间：每条带都有分叉行与汇合行，没有前驱 / 汇合站时是开口的", () => {
    expect(sequenceOf(renderSpine(WITH_PRED))).toEqual([
      "phase:0",
      "fork",
      "phase:1",
      "phase:2",
      "merge",
      "phase:3",
    ]);
    cleanup();
    expect(sequenceOf(renderSpine(TESTFIELD))).toEqual([
      "fork",
      "phase:0",
      "phase:1",
      "merge",
      "phase:2",
    ]);
    cleanup();
    expect(sequenceOf(renderSpine(OPEN_END))).toEqual([
      "phase:0",
      "fork",
      "phase:1",
      "phase:2",
      "merge",
    ]);
  });

  it("接头行：主轨直穿，每条分支一条曲线，带轨道号与墨", () => {
    const view = renderSpine(WITH_PRED);
    const fork = view
      .getAllByTestId("workflow-run-spine-joint")
      .find((joint) => joint.getAttribute("data-joint-kind") === "fork")!;
    expect(railsOf(fork)).toEqual([{ ink: "faint", position: "full", track: "0" }]);
    expect(fork.getAttribute("data-joint-open")).toBeNull();
    expect(within(fork).getByTestId("workflow-run-spine-rail").style.top).toBe("");
    const curves = within(fork).getAllByTestId("workflow-run-spine-fork");
    expect(
      curves.map((curve) => [
        curve.getAttribute("data-curve-track"),
        curve.getAttribute("data-curve-ink"),
      ]),
    ).toEqual([["1", "faint"]]);
    expect(fork.getAttribute("aria-hidden")).toBe("true");
  });

  it("开口的接头：主轨在行外 4px 起（根）/ 止（汇点），不从上一节或下一节借位", () => {
    const view = renderSpine(OPEN_END);
    const joints = view.getAllByTestId("workflow-run-spine-joint");
    const fork = joints.find((joint) => joint.getAttribute("data-joint-kind") === "fork")!;
    const merge = joints.find((joint) => joint.getAttribute("data-joint-kind") === "merge")!;
    expect(fork.getAttribute("data-joint-open")).toBeNull();
    expect(merge.getAttribute("data-joint-open")).toBe("true");
    const stub = within(merge).getByTestId("workflow-run-spine-rail");
    expect(stub.style.top).toBe("0px");
    expect(stub.style.bottom).toBe("-4px");
    cleanup();
    const root = renderSpine(TESTFIELD).getAllByTestId("workflow-run-spine-joint")[0]!;
    expect(root.getAttribute("data-joint-open")).toBe("true");
    expect(within(root).getByTestId("workflow-run-spine-rail").style.top).toBe("-4px");
  });

  it("汇合站在跑、两条轨道都到过：汇合行的主轨与分支曲线一起行进", () => {
    const view = renderSpine(
      TESTFIELD,
      run([settled("ask#0"), settled("ask#1"), executing("ask#2")]),
    );
    const [a, b, c] = view.getAllByTestId("workflow-run-phase");
    const merge = view
      .getAllByTestId("workflow-run-spine-joint")
      .find((joint) => joint.getAttribute("data-joint-kind") === "merge")!;
    expect(railsOf(merge)).toEqual([{ ink: "march", position: "full", track: "0" }]);
    const curve = within(merge).getByTestId("workflow-run-spine-merge");
    expect(curve.getAttribute("data-curve-ink")).toBe("march");
    // 合流曲线上叠的是一条亮着的光：渐变描边（`url(#…)`），渐变本身就在这张 SVG 里；光画在全部底墨
    // 之上，所以它是曲线的兄弟而不是孩子。
    expect(curve.querySelector("path.wf-lit")).toBeNull();
    const light = within(merge)
      .getByTestId("workflow-run-spine-merge-lit")
      .querySelector("path.wf-lit");
    expect(light?.getAttribute("data-testid")).toBe("workflow-march-light");
    expect(light?.getAttribute("stroke")).toMatch(/^url\(#.+\)$/);
    expect(merge.querySelector("linearGradient")).toBeTruthy();
    // 主线那一段（A 的下半截、B 里穿过的主轨、C 的上半截）行进；B 的分支轨下半截接着合流曲线。
    // 根下来的那几段是到过的站的进入墨：浓。
    expect(railsOf(a!)).toEqual([
      { ink: "strong", position: "above", track: "0" },
      { ink: "march", position: "below", track: "0" },
      { ink: "strong", position: "full", track: "1" },
    ]);
    expect(railsOf(b!)).toEqual([
      { ink: "march", position: "full", track: "0" },
      { ink: "strong", position: "above", track: "1" },
      { ink: "march", position: "below", track: "1" },
    ]);
    expect(railsOf(c!)).toEqual([{ ink: "march", position: "above", track: "0" }]);
  });

  it("带里两条轨道同时在跑：两节都自己展开，不只最右那个", () => {
    const view = renderSpine(TESTFIELD, run([executing("ask#0"), executing("ask#1")]));
    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((phase) => phase.getAttribute("data-phase-status"))).toEqual([
      "running",
      "running",
      "pending",
    ]);
    expect(phases.map((phase) => phase.getAttribute("data-phase-open"))).toEqual([
      "true",
      "true",
      "false",
    ]);
    // 展开的药丸列也在文字列上。
    for (const phase of phases.slice(0, 2)) {
      expect(within(phase).getByTestId("workflow-run-phase-body").style.paddingLeft).toBe("51px");
    }
  });

  it("没有 alongside 的图：没有接头、没有让位，DOM 与从前一样", () => {
    const line = bandGraph(
      [undefined, undefined, undefined],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const view = renderSpine(line, run([settled("ask#0"), executing("ask#1")]));
    expect(view.queryAllByTestId("workflow-run-spine-joint")).toHaveLength(0);
    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((phase) => phase.getAttribute("data-phase-track"))).toEqual(["0", "0", "0"]);
    for (const phase of phases) {
      expect(within(phase).getByTestId("workflow-run-phase-toggle").style.paddingLeft).toBe("");
      for (const rail of within(phase).queryAllByTestId("workflow-run-spine-rail")) {
        expect(rail.getAttribute("data-rail-track")).toBe("0");
        expect(rail.style.left).toBe("");
      }
    }
    // 行进段仍落在进入运行站的那一段上。
    expect(railsOf(phases[0]!)).toEqual([{ ink: "march", position: "below", track: "0" }]);
    expect(railsOf(phases[1]!)).toEqual([
      { ink: "march", position: "above", track: "0" },
      { ink: "faint", position: "below", track: "0" },
    ]);
  });
});

// 子代理自己的模型（presentation.md「The spine」）：persona 点名了模型的子代理，行尾计数后面跟模型名，
// tooltip 多一行规范串；跑在 run 模型上的子代理什么都不说。
describe("WorkflowRunPhaseList · 子代理的模型", () => {
  it("点名了模型的那一行带模型名（不带 providerId），tooltip 带规范串；其余行不带", () => {
    const state: WorkflowRunState = {
      ...run([
        { ...executing("ask#0"), actorSiteId: "actor#0", actorOrdinal: 1, kind: "ask" } as Node,
        { ...executing("ask#1"), actorSiteId: "actor#1", actorOrdinal: 1, kind: "ask" } as Node,
      ]),
      actors: [
        {
          siteId: "actor#0",
          ordinal: 1,
          name: "judge",
          status: "running",
          model: "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high",
        },
        { siteId: "actor#1", ordinal: 1, name: "writer", status: "running" },
      ],
    };
    const view = renderSpine(TESTFIELD, state);
    const models = view.getAllByTestId("workflow-run-agent-model");
    expect(models).toHaveLength(1);
    expect(models[0]?.textContent).toMatch(/GLM-5\.3-Flash$/);
    expect(models[0]?.textContent).not.toContain("4fc7f541");
    const row = models[0]!.closest<HTMLElement>('[data-testid="workflow-agent-pill"]');
    expect(row?.getAttribute("title")).toBe(
      "judge\n4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high",
    );
    const pills = view.getAllByTestId("workflow-agent-pill");
    const writer = pills.find((pill) => pill.textContent?.includes("writer"));
    expect(writer?.getAttribute("title")).toBe("writer");
  });
});
