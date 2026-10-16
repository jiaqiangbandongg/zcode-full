// 留白在时间线模型上的派生（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：
// 留白是一站（虚线灯、两侧虚线轨道、尾巴留白的 40px 残段）；等待时是当前站；补全后体的阶段站在它的
// 位置上、头（笔 · 名）悬在它们之上；无阶段的补全不抬头，站自己带笔标。类型从不上界面。
// 卡、确认窗与侧板都从这一个模型出发，所以规则钉在这里。
//
// 夹具照分析器的真实输出写（apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md「Sites」）：
// 留白 id 是名字键 `hole#<8 位十六进制>`，不随嵌套增长；留白**自己的**阶段带 `fill: <包着它的留白>`
// （顶层没有），补全过的留白即使体以标记开头也留着自己的阶段。这里的十六进制是随手写的形状，
// 渲染器只认形状，不重算哈希。
import { describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { laneRefsById } from "@/components/workflow-graph/lane-name.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import {
  fillContains,
  holeParentsOf,
  narrowTimelineToFill,
  withoutHeadedHolePhases,
} from "@/components/workflow-timeline/timeline-holes.js";

const H1 = "hole#a0000001"; // 决定分组
const H2 = "hole#a0000002"; // 评判
const H11 = "hole#a0000011"; // 挑选（在 H1 的体里）
const H7 = "hole#a0000007"; // 不存在
const H10 = "hole#a0000010"; // 与 H1 无关的另一个留白

type Step = WorkflowCausalityGraphData["steps"][number];
function participantsOf(steps: readonly Step[]) {
  const byId = new Map<string, { id: string; phase: string; lane: string; steps: string[] }>();
  for (const step of steps) {
    // 留白自己的站点（kind hole、车道 main）不是参与者：留白的阶段没有成员。
    if (step.kind === "hole") continue;
    const phase = step.phase ?? "unphased";
    const id = `${phase}:${step.lane}`;
    const existing = byId.get(id);
    if (existing) existing.steps.push(step.id);
    else byId.set(id, { id, lane: step.lane, phase, steps: [step.id] });
  }
  return [...byId.values()];
}

/** 探索 → hole 决定分组 : Plan → 执行 → tail hole 评判 : Verdict（设计画布的 flaky-hunt）。 */
const OPEN_STEPS: Step[] = [
  { id: "ask#1", kind: "ask", label: "scout", lane: "actor#1", phase: "phase#1" },
  { id: H1, kind: "hole", label: "决定分组", lane: "main", phase: H1 },
  { id: "ask#2", kind: "ask", label: "member", lane: "actor#2", phase: "phase#2" },
  { id: H2, kind: "hole", label: "评判", lane: "main", phase: H2 },
];
const OPEN: WorkflowCausalityGraphData = {
  steps: OPEN_STEPS,
  lanes: [
    { id: "actor#1", name: "侦察员" },
    { id: "actor#2", name: "组员" },
  ],
  participants: participantsOf(OPEN_STEPS),
  handoffs: [],
  phases: [
    { id: "phase#1", name: "探索" },
    { id: H1, name: "决定分组" },
    { id: "phase#2", name: "执行" },
    { id: H2, name: "评判" },
  ],
  phaseEdges: [
    { from: "phase#1", to: H1 },
    { from: H1, to: "phase#2" },
    { from: "phase#2", to: H2 },
  ],
  holes: [
    { siteId: H1, name: "决定分组", type: "Plan" },
    { siteId: H2, name: "评判", type: "Verdict", tail: true },
  ],
};

/**
 * 第一处补全之后的有效脚本：体以标记开头、声明了两个阶段。留白自己的阶段没有成员，但分析器留着它
 * （侧栏靠它念出「决定分组」）；时间线把它交给头，不成站（withoutHeadedHolePhases）。
 */
const FILLED_STEPS: Step[] = [
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
];
const FILLED: WorkflowCausalityGraphData = {
  steps: FILLED_STEPS,
  lanes: [
    { id: "actor#1", name: "侦察员" },
    { id: `${H1}/actor#1`, name: "冒烟员" },
    { id: `${H1}/actor#2`, name: "分组员" },
    { id: "actor#2", name: "组员" },
  ],
  participants: participantsOf(FILLED_STEPS),
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
  holes: [{ siteId: H2, name: "评判", type: "Verdict", tail: true }],
};

/** 第二处补全没有声明阶段：一次 ask 给评委，落在留白自己的阶段里。 */
const TAIL_FILLED_STEPS: Step[] = [
  ...FILLED_STEPS,
  { id: `${H2}/ask#1`, kind: "ask", label: "judge", lane: `${H2}/actor#1`, phase: H2, fill: H2 },
];
const TAIL_FILLED: WorkflowCausalityGraphData = {
  ...FILLED,
  steps: TAIL_FILLED_STEPS,
  lanes: [...FILLED.lanes, { id: `${H2}/actor#1`, name: "评委" }],
  participants: participantsOf(TAIL_FILLED_STEPS),
  holes: [],
};

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-wf-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

describe("留白站（静态）", () => {
  it("开着的留白是一站：hole.state open、类型原文、尾巴留白带 tail；两侧轨道段是虚线", () => {
    const model = buildWorkflowTimeline(OPEN, undefined);
    expect(model.stations.map((station) => station.id)).toEqual(["phase#1", H1, "phase#2", H2]);
    expect(model.stations[1]!.hole).toEqual({ siteId: H1, state: "open" });
    expect(model.stations[3]!.hole).toEqual({ siteId: H2, state: "open", tail: true });
    expect(model.stations[0]!.hole).toBeUndefined();
    expect(model.rails.map((rail) => rail.dashed)).toEqual([true, true, true]);
    expect(model.tailStub).toBe("open");
    expect(model.fills).toEqual([]);
  });

  it("留白自己的 kind hole 站点不算 ask：留白站没有药丸、摘要不计它", () => {
    const model = buildWorkflowTimeline(OPEN, undefined);
    expect(model.stations[1]!.pills).toEqual([]);
    expect(model.stations[0]!.pills.map((pill) => pill.lane.id)).toEqual(["actor#1"]);
  });

  it("没有留白的图：tailStub 缺席、fills 为空、轨道段不带 dashed", () => {
    const model = buildWorkflowTimeline(
      { ...OPEN, phases: OPEN.phases!.slice(0, 1), phaseEdges: [], holes: [] },
      undefined,
    );
    expect(model.tailStub).toBeUndefined();
    expect(model.fills).toEqual([]);
  });
});

describe("留白站（活）", () => {
  it("run 停在留白：hole.state waiting、站算作当前站（进入它的段行进、runningIndex 落在它上）", () => {
    const model = buildWorkflowTimeline(
      OPEN,
      run({
        phases: [{ name: "探索", rounds: 1 }],
        currentPhase: "探索",
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok", phaseName: "探索" },
        ],
        holes: [
          { siteId: H1, ordinal: 1, name: "决定分组", type: "Plan", state: "waiting", since: 5 },
        ],
      }),
    );
    const hole = model.stations[1]!;
    expect(hole.hole).toEqual({ siteId: H1, state: "waiting", since: 5 });
    expect(hole.status).toBe("running");
    expect(hole.visited).toBe(true);
    expect(model.runningIndex).toBe(1);
    expect(model.rails[0]!.ink).toBe("march");
    // 还没走到的尾巴留白照旧是 open。
    expect(model.stations[3]!.hole?.state).toBe("open");
    expect(model.stations[3]!.status).toBe("pending");
  });

  it("等待中的站带上 run.holes 记的提示语（侧板的等待体画它）；补全后不带", () => {
    const waiting = buildWorkflowTimeline(
      OPEN,
      run({
        holes: [
          {
            siteId: H1,
            ordinal: 1,
            name: "决定分组",
            type: "Plan",
            prompt: "侦察结果如下，请补全。",
            state: "waiting",
          },
        ],
      }),
    );
    expect(waiting.stations[1]!.hole?.prompt).toBe("侦察结果如下，请补全。");
    const filled = buildWorkflowTimeline(
      TAIL_FILLED,
      run({
        holes: [
          { siteId: H2, ordinal: 1, name: "评判", type: "Verdict", prompt: "p", state: "filled" },
        ],
      }),
    );
    expect(filled.stations[4]!.hole?.prompt).toBeUndefined();
  });
});

describe("补全后的时间线", () => {
  const filledRun = run({
    holes: [
      {
        siteId: H1,
        ordinal: 1,
        name: "决定分组",
        type: "Plan",
        state: "filled",
        filledAt: 99,
        filledBy: "main",
      },
    ],
    phases: [
      { name: "探索", rounds: 1 },
      { name: "冒烟测试", rounds: 1 },
    ],
    currentPhase: "冒烟测试",
  });

  it("有阶段的补全：体的两站站在留白的位置，头覆盖它们（from/to）、带名与类型；留白自己没有站", () => {
    const model = buildWorkflowTimeline(FILLED, filledRun);
    expect(model.stations.map((station) => station.id)).toEqual([
      "phase#1",
      `${H1}/phase#1`,
      `${H1}/phase#2`,
      "phase#2",
      H2,
    ]);
    expect(model.fills).toEqual([{ holeId: H1, name: "决定分组", from: 1, to: 2, filledAt: 99 }]);
    // 体里的站是普通站：没有 hole 记号，进入它们的轨道段不是虚线。
    expect(model.stations[1]!.hole).toBeUndefined();
    expect(model.stations[1]!.fill).toBe(H1);
    expect(model.rails[0]!.dashed).toBeUndefined();
    expect(model.stations[1]!.status).toBe("running");
  });

  it("没有 run（确认窗）时头的名字取自 holeLabels，缺席则退回站点 id", () => {
    const labelled = buildWorkflowTimeline(
      FILLED,
      undefined,
      new Map([[H1, { name: "决定分组" }]]),
    );
    expect(labelled.fills[0]).toMatchObject({ name: "决定分组" });
    const bare = buildWorkflowTimeline(FILLED, undefined);
    expect(bare.fills[0]).toMatchObject({ holeId: H1, name: H1 });
  });

  it("无阶段的补全：站保留留白的名与徽标（state filled），不抬头；尾巴留白补全后 tailStub 变成 filled", () => {
    const model = buildWorkflowTimeline(
      TAIL_FILLED,
      run({
        holes: [
          { siteId: H1, ordinal: 1, name: "决定分组", type: "Plan", state: "filled", filledAt: 1 },
          { siteId: H2, ordinal: 1, name: "评判", type: "Verdict", state: "filled", filledAt: 2 },
        ],
      }),
    );
    const judge = model.stations[4]!;
    expect(judge.hole).toEqual({ siteId: H2, state: "filled", tail: true, filledAt: 2 });
    expect(judge.pills.map((pill) => pill.lane.id)).toEqual([`${H2}/actor#1`]);
    expect(model.fills.map((fill) => fill.holeId)).toEqual([H1]);
    expect(model.tailStub).toBe("filled");
    // 进入它的段不再是虚线：脚本的尾巴已经写下。
    expect(model.rails[3]!.dashed).toBeUndefined();
  });
});

describe("narrowTimelineToFill · 补全行的草稿阶段线", () => {
  it("只留补全的站与它们两侧的邻站，邻站 ghost；轨道段与头的下标随之重排", () => {
    const model = buildWorkflowTimeline(FILLED, undefined, new Map([[H1, { name: "决定分组" }]]));
    const narrowed = narrowTimelineToFill(model, H1);
    expect(narrowed).toBeDefined();
    expect(narrowed!.stations.map((station) => station.id)).toEqual([
      "phase#1",
      `${H1}/phase#1`,
      `${H1}/phase#2`,
      "phase#2",
    ]);
    expect(narrowed!.stations.map((station) => station.ghost)).toEqual([
      true,
      undefined,
      undefined,
      true,
    ]);
    expect(narrowed!.fills).toEqual([{ holeId: H1, name: "决定分组", from: 1, to: 2 }]);
    expect(narrowed!.rails.map((rail) => [rail.from, rail.to])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(narrowed!.arcs).toEqual([]);
    expect(narrowed!.tailStub).toBeUndefined();
  });

  it("无阶段的补全：窗口是留白自己的站加邻站；不认识的留白返回 undefined", () => {
    const model = buildWorkflowTimeline(TAIL_FILLED, undefined, new Map([[H2, { name: "评判" }]]));
    const narrowed = narrowTimelineToFill(model, H2);
    expect(narrowed!.stations.map((station) => station.id)).toEqual(["phase#2", H2]);
    expect(narrowed!.stations[1]!.hole?.state).toBe("filled");
    expect(narrowed!.tailStub).toBe("filled");
    expect(narrowTimelineToFill(model, H7)).toBeUndefined();
  });
});

/**
 * 嵌套（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：外层补全里再留白。id 不拼接，
 * 包含关系只在留白自己的阶段 / 站的 `fill` 上（H11 的阶段带 `fill: H1`）。
 *   1. 外层开着：H1 一站。
 *   2. 外层补全、内层开着：体是「冒烟测试 → H11（挑选）→ 分组」，内层是外层体里的留白站。
 *   3. 两层都补全：内层的阶段带 `fill: H11`，仍在外层的跨度里。
 */
const INNER_OPEN_STEPS: Step[] = [
  { id: "ask#1", kind: "ask", label: "scout", lane: "actor#1", phase: "phase#1" },
  {
    id: `${H1}/ask#1`,
    kind: "ask",
    label: "smoke",
    lane: `${H1}/actor#1`,
    phase: `${H1}/phase#1`,
    fill: H1,
  },
  { id: H11, kind: "hole", label: "挑选", lane: "main", phase: H11, fill: H1 },
  {
    id: `${H1}/ask#2`,
    kind: "ask",
    label: "group",
    lane: `${H1}/actor#2`,
    phase: `${H1}/phase#2`,
    fill: H1,
  },
  { id: "ask#2", kind: "ask", label: "member", lane: "actor#2", phase: "phase#2" },
  { id: H2, kind: "hole", label: "评判", lane: "main", phase: H2 },
];
const INNER_OPEN: WorkflowCausalityGraphData = {
  steps: INNER_OPEN_STEPS,
  lanes: FILLED.lanes,
  participants: participantsOf(INNER_OPEN_STEPS),
  handoffs: [],
  phases: [
    { id: "phase#1", name: "探索" },
    { id: H1, name: "决定分组" },
    { id: `${H1}/phase#1`, name: "冒烟测试", fill: H1 },
    { id: H11, name: "挑选", fill: H1 },
    { id: `${H1}/phase#2`, name: "分组", fill: H1 },
    { id: "phase#2", name: "执行" },
    { id: H2, name: "评判" },
  ],
  phaseEdges: [
    { from: "phase#1", to: H1 },
    { from: H1, to: `${H1}/phase#1` },
    { from: `${H1}/phase#1`, to: H11 },
    { from: H11, to: `${H1}/phase#2` },
    { from: `${H1}/phase#2`, to: "phase#2" },
    { from: "phase#2", to: H2 },
  ],
  holes: [
    { siteId: H11, name: "挑选", type: "Pick" },
    { siteId: H2, name: "评判", type: "Verdict", tail: true },
  ],
};
const BOTH_STEPS: Step[] = [
  ...INNER_OPEN_STEPS.filter((step) => step.kind !== "hole" || step.id === H2),
  {
    id: `${H11}/ask#1`,
    kind: "ask",
    label: "pick",
    lane: `${H11}/actor#1`,
    phase: `${H11}/phase#1`,
    fill: H11,
  },
];
const BOTH: WorkflowCausalityGraphData = {
  ...INNER_OPEN,
  steps: BOTH_STEPS,
  lanes: [...FILLED.lanes, { id: `${H11}/actor#1`, name: "挑选员" }],
  participants: participantsOf(BOTH_STEPS),
  phases: [
    { id: "phase#1", name: "探索" },
    { id: H1, name: "决定分组" },
    { id: `${H1}/phase#1`, name: "冒烟测试", fill: H1 },
    { id: H11, name: "挑选", fill: H1 },
    { id: `${H11}/phase#1`, name: "挑出候选", fill: H11 },
    { id: `${H1}/phase#2`, name: "分组", fill: H1 },
    { id: "phase#2", name: "执行" },
    { id: H2, name: "评判" },
  ],
  phaseEdges: [
    { from: "phase#1", to: H1 },
    { from: H1, to: `${H1}/phase#1` },
    { from: `${H1}/phase#1`, to: H11 },
    { from: H11, to: `${H11}/phase#1` },
    { from: `${H11}/phase#1`, to: `${H1}/phase#2` },
    { from: `${H1}/phase#2`, to: "phase#2" },
    { from: "phase#2", to: H2 },
  ],
  holes: [{ siteId: H2, name: "评判", type: "Verdict", tail: true }],
};
const OUTER_FILLED = {
  siteId: H1,
  ordinal: 1,
  name: "决定分组",
  type: "Plan",
  state: "filled" as const,
  filledAt: 10,
};

describe("嵌套的留白", () => {
  it("父表从留白自己的阶段与站读出；fillContains 沿父表向外走，不看 id 的形状拼接", () => {
    const parents = holeParentsOf(BOTH, BOTH.phases!);
    expect(parents).toEqual({ [H11]: H1 });
    expect(holeParentsOf(INNER_OPEN, INNER_OPEN.phases!)).toEqual({ [H11]: H1 });
    expect(fillContains(H1, H1, parents)).toBe(true);
    expect(fillContains(H1, H11, parents)).toBe(true);
    expect(fillContains(H11, H1, parents)).toBe(false);
    expect(fillContains(H1, H10, parents)).toBe(false);
    // 普通阶段 id 不是留白：不在任何补全里。
    expect(fillContains(H1, `${H1}/phase#2`, parents)).toBe(false);
    // 环（坏载荷）不会让它转圈。
    expect(fillContains(H2, H1, { [H1]: H11, [H11]: H1 })).toBe(false);
  });

  it("头已代表的留白阶段不成站，进它与出它的边接起来；开着的、有成员的、体里没有站的留白都留着", () => {
    const hidden = withoutHeadedHolePhases(BOTH);
    expect(hidden.phases!.map((phase) => phase.id)).toEqual([
      "phase#1",
      `${H1}/phase#1`,
      `${H11}/phase#1`,
      `${H1}/phase#2`,
      "phase#2",
      H2,
    ]);
    // 边的次序不是契约：按集合比。
    const edgeKeys = (edges: readonly { from: string; to: string }[] | undefined) =>
      (edges ?? []).map((edge) => `${edge.from} > ${edge.to}`).sort();
    expect(edgeKeys(hidden.phaseEdges)).toEqual(
      edgeKeys([
        { from: "phase#1", to: `${H1}/phase#1` },
        { from: `${H1}/phase#1`, to: `${H11}/phase#1` },
        { from: `${H11}/phase#1`, to: `${H1}/phase#2` },
        { from: `${H1}/phase#2`, to: "phase#2" },
        { from: "phase#2", to: H2 },
      ]),
    );
    // 开着的内层（INNER_OPEN 的 H11）留着；外层 H1 被头代表，拿掉。
    expect(withoutHeadedHolePhases(INNER_OPEN).phases!.map((phase) => phase.id)).toEqual([
      "phase#1",
      `${H1}/phase#1`,
      H11,
      `${H1}/phase#2`,
      "phase#2",
      H2,
    ]);
    // 无阶段的补全（H2 自己的阶段装着评委的 ask）留着；同一张图里被头代表的 H1 照样拿掉。
    expect(withoutHeadedHolePhases(TAIL_FILLED).phases!.map((phase) => phase.id)).toEqual([
      "phase#1",
      `${H1}/phase#1`,
      `${H1}/phase#2`,
      "phase#2",
      H2,
    ]);
    // 没有补全的图原样返回（同一个引用：调用方可以放心地每帧调用）。
    expect(withoutHeadedHolePhases(OPEN)).toBe(OPEN);
  });

  it(`状态 1 · 外层开着：只有 ${H1} 一站，没有头`, () => {
    const model = buildWorkflowTimeline(OPEN, undefined);
    expect(model.stations.map((station) => station.hole?.siteId)).toEqual([
      undefined,
      H1,
      undefined,
      H2,
    ]);
    expect(model.fills).toEqual([]);
  });

  it("状态 2 · 外层补全、内层开着：内层是外层体里的普通留白站，外层的头盖住含它的三站；run 停在内层时 waiting", () => {
    const live = run({
      holes: [
        OUTER_FILLED,
        { siteId: H11, ordinal: 1, name: "挑选", type: "Pick", state: "waiting", since: 20 },
      ],
    });
    const model = buildWorkflowTimeline(INNER_OPEN, live);
    expect(model.stations.map((station) => station.id)).toEqual([
      "phase#1",
      `${H1}/phase#1`,
      H11,
      `${H1}/phase#2`,
      "phase#2",
      H2,
    ]);
    const inner = model.stations[2]!;
    expect(inner.hole).toEqual({ siteId: H11, state: "waiting", since: 20 });
    expect(inner.fill).toBe(H1);
    expect(inner.pills).toEqual([]);
    expect(model.runningIndex).toBe(2);
    expect(model.rails.filter((rail) => rail.dashed).map((rail) => [rail.from, rail.to])).toEqual([
      [1, 2],
      [2, 3],
      [4, 5],
    ]);
    expect(model.fills).toEqual([{ holeId: H1, name: "决定分组", from: 1, to: 3, filledAt: 10 }]);
    // 没有 run 的静态图（确认窗）：内层是开着的留白、外层的头名字取自 holeLabels。
    const stat = buildWorkflowTimeline(
      INNER_OPEN,
      undefined,
      new Map([[H1, { name: "决定分组" }]]),
    );
    expect(stat.stations[2]!.hole?.state).toBe("open");
    expect(stat.fills.map((fill) => fill.holeId)).toEqual([H1]);
  });

  it("状态 3 · 两层都补全：内层的头在外层的跨度里，按 from 升序、同起点外层在前；窄化到内层只留它与两侧邻站", () => {
    const live = run({
      holes: [
        OUTER_FILLED,
        { siteId: H11, ordinal: 1, name: "挑选", type: "Pick", state: "filled", filledAt: 30 },
      ],
    });
    const model = buildWorkflowTimeline(BOTH, live);
    expect(model.stations[2]!.hole).toBeUndefined();
    expect(model.stations[2]!.fill).toBe(H11);
    expect(model.fills).toEqual([
      { holeId: H1, name: "决定分组", from: 1, to: 3, filledAt: 10 },
      { holeId: H11, name: "挑选", from: 2, to: 2, filledAt: 30 },
    ]);
    const narrowed = narrowTimelineToFill(model, H11)!;
    expect(narrowed.stations.map((station) => [station.id, station.ghost ?? false])).toEqual([
      [`${H1}/phase#1`, true],
      [`${H11}/phase#1`, false],
      [`${H1}/phase#2`, true],
    ]);
    expect(narrowed.fills).toEqual([{ holeId: H11, name: "挑选", from: 1, to: 1, filledAt: 30 }]);
    // 外层的体只有内层留白时，外层不被任何普通阶段点名，也算补全过：沿父表（H11 的阶段带
    // `fill: H1`）读出。两个留白自己的阶段都没有成员、都被头代表，不成站。
    const onlyInner: WorkflowCausalityGraphData = {
      ...BOTH,
      steps: BOTH_STEPS.filter((step) => step.fill !== H1),
      participants: participantsOf(BOTH_STEPS.filter((step) => step.fill !== H1)),
      phases: BOTH.phases!.filter((phase) => phase.fill !== H1 || phase.id === H11),
      phaseEdges: [
        { from: "phase#1", to: H1 },
        { from: H1, to: H11 },
        { from: H11, to: `${H11}/phase#1` },
        { from: `${H11}/phase#1`, to: "phase#2" },
        { from: "phase#2", to: H2 },
      ],
    };
    expect(
      buildWorkflowTimeline(onlyInner, undefined).fills.map((fill) => [
        fill.holeId,
        fill.from,
        fill.to,
      ]),
    ).toEqual([
      [H1, 1, 1],
      [H11, 1, 1],
    ]);
  });
});

// 修复原因（2026-09-29 testfield 实测）：分析器把开着的留白记成 `main` 车道上的一步，放在**含 `hole()`
// 调用的那个阶段**里，还为它发一个参与者（`phase#1:main`）。上面的夹具把留白放进它自己的阶段、又不给它
// 参与者，所以没测到：真实载荷下时间线把 `main` 当成一个没名字的子代理，那一站多出一枚「未命名子代理」。
// 夹具照荒岛奶茶店 run（dwfrun-4d94062b）CreateWorkflow 那份 display 原样裁出。
describe("the main agent's lane on the timeline", () => {
  const REAL: WorkflowCausalityGraphData = {
    steps: [
      {
        id: "ask#1",
        kind: "ask",
        label: "ask",
        labelPattern: { head: "点子大王·" },
        lane: "actor#1",
        phase: "phase#1",
        repeat: "serial",
      },
      {
        id: "hole#be89c200",
        kind: "hole",
        label: "第二步：把脑洞变成菜单",
        lane: "main",
        phase: "phase#1",
      },
    ],
    lanes: [{ id: "main" }, { id: "actor#1", namePattern: { head: "点子大王·" } }],
    participants: [
      {
        id: "phase#1:actor#1[0]",
        phase: "phase#1",
        lane: "actor#1",
        steps: ["ask#1"],
        member: { index: 0, of: 3 },
      },
      {
        id: "phase#1:actor#1[1]",
        phase: "phase#1",
        lane: "actor#1",
        steps: ["ask#1"],
        member: { index: 1, of: 3 },
      },
      {
        id: "phase#1:actor#1[2]",
        phase: "phase#1",
        lane: "actor#1",
        steps: ["ask#1"],
        member: { index: 2, of: 3 },
      },
      { id: "phase#1:main", phase: "phase#1", lane: "main", steps: ["hole#be89c200"] },
    ],
    handoffs: [
      { from: "phase#1:actor#1[0]", to: "phase#1:main", types: ["Pitch"] },
      { from: "phase#1:actor#1[1]", to: "phase#1:main", types: ["Pitch"] },
      { from: "phase#1:actor#1[2]", to: "phase#1:main", types: ["Pitch"] },
    ],
    phases: [
      { id: "phase#1", name: "第一幕：三位点子大王各抛一个奶茶店脑洞" },
      { id: "hole#be89c200", name: "第二步：把脑洞变成菜单" },
    ],
    phaseEdges: [{ from: "phase#1", to: "hole#be89c200" }],
    exits: ["hole#be89c200"],
    sink: ["hole#be89c200"],
    holes: [
      {
        siteId: "hole#be89c200",
        name: "第二步：把脑洞变成菜单",
        type: "HandbookReport",
        phase: "phase#1",
        tail: true,
      },
    ],
  };

  it("draws no pill for the lane an open hole waits on", () => {
    const model = buildWorkflowTimeline(REAL, undefined);
    const lanes = model.stations.map((station) => station.pills.map((pill) => pill.lane.id));
    expect(lanes).toEqual([["actor#1", "actor#1", "actor#1"], []]);
  });

  it("leaves the main lane out of a live run's pills too", () => {
    const run = {
      runId: "dwfrun-1",
      toolCallId: "call-1",
      status: "running",
      phases: [{ name: "第一幕：三位点子大王各抛一个奶茶店脑洞", ordinal: 1 }],
      nodes: [],
      actors: [],
    } as unknown as WorkflowRunState;
    const pills = buildWorkflowTimeline(REAL, run).stations[0]!.pills;
    expect(pills.map((pill) => pill.lane.id)).toEqual(["actor#1", "actor#1", "actor#1"]);
  });

  it("does not count the main lane when numbering anonymous subagents", () => {
    // 唯一一条真匿名车道不该因为 `main` 在场就叫「未命名子代理 1」。
    const refs = laneRefsById([{ id: "main" }, { id: "actor#1" }]);
    expect(refs.get("actor#1")?.anonymousIndex).toBeUndefined();
  });
});
