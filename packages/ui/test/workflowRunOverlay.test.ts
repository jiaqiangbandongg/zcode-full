// dwf 实时叠加视图的纯选择器：workflowRuns 的一条 run + 静态因果图 → statuses / animatedEdges，
// 以及车道 → actor 实例的解析（phase 5 的 transcript 下钻消费它）。
// 见 docs/dynamic-workflow/presentation.md「Node status」「状态聚合」与 apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md 的
// 「Joining runtime instances」（live view v1 不展开，按 site id 关联并在实例上聚合）以及
// 「Joining runtime instances」（带 source 的拷贝再按 actor 车道收窄）。
import { describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  workflowRunActorsForLane,
  workflowRunOverlay,
} from "../src/components/workflow-graph/run-status.js";
import type { WorkflowCausalityGraphData } from "../src/components/workflow-graph/types.js";

const graph: WorkflowCausalityGraphData = {
  steps: [
    { id: "ask#1", kind: "ask", label: "plan", lane: "actor#1" },
    { id: "ask#2", kind: "ask", label: "write", lane: "actor#2" },
    { id: "world-read#1", kind: "world-read", label: "glob", lane: "workspace" },
  ],
  lanes: [{ id: "actor#1", name: "planner" }, { id: "actor#2" }, { id: "workspace" }],
  edges: [{ from: "ask#1", to: "ask#2" }],
};

function runWith(
  nodes: WorkflowRunState["nodes"],
  overrides: Partial<WorkflowRunState> = {},
): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: nodes.length },
    actors: [],
    nodes,
    lastEventSequence: nodes.length,
    ...overrides,
  };
}

describe("workflowRunOverlay 相位映射", () => {
  it("executing / repairing / nudged 全部映射成 running", () => {
    for (const phase of ["executing", "repairing", "nudged"] as const) {
      const { statuses } = workflowRunOverlay(
        runWith([{ siteId: "ask#1", ordinal: 1, phase }]),
        graph,
      );
      expect(statuses["ask#1"]).toBe("running");
    }
  });

  it("queued / dispatched / waiting 是 pending：还没有请求在 provider 那里跑", () => {
    for (const phase of ["queued", "dispatched", "waiting"] as const) {
      const { statuses } = workflowRunOverlay(
        runWith([{ siteId: "ask#1", ordinal: 1, phase }]),
        graph,
      );
      expect(statuses["ask#1"]).toBe("pending");
    }
  });

  it("settled ok 是 done，cached 命中同样是 done", () => {
    expect(
      workflowRunOverlay(
        runWith([{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" }]),
        graph,
      ).statuses["ask#1"],
    ).toBe("done");
    expect(
      workflowRunOverlay(
        runWith([{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok", cached: true }]),
        graph,
      ).statuses["ask#1"],
    ).toBe("done");
  });

  it("settled failed 与 settled cancelled 都是 failed", () => {
    for (const outcome of ["failed", "cancelled"] as const) {
      const { statuses } = workflowRunOverlay(
        runWith([{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome }]),
        graph,
      );
      expect(statuses["ask#1"]).toBe("failed");
    }
  });

  it("没有实例的 step 没有条目：缺席不是状态，不写成 pending", () => {
    const { statuses } = workflowRunOverlay(runWith([]), graph);
    expect(statuses).toEqual({});
    // 只观察到一个站点时表里只有它：控制流没走的站点不会以 pending 出现。
    expect(
      workflowRunOverlay(
        runWith([{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" }]),
        graph,
      ).statuses,
    ).toEqual({ "ask#1": "done" });
  });

  it("无 run（静态渲染）时不产出任何状态", () => {
    expect(workflowRunOverlay(undefined, graph)).toEqual({ statuses: {}, animatedEdges: false });
  });
});

describe("workflowRunOverlay 实例聚合（叠加视图必须坍缩）", () => {
  it("running 优先于 failed：读者第一个问题是「还在动吗」", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        { siteId: "ask#2", ordinal: 3, phase: "settled", outcome: "failed" },
        { siteId: "ask#2", ordinal: 4, phase: "executing" },
      ]),
      graph,
    );
    expect(statuses["ask#2"]).toBe("running");
  });

  it("无 running 时任一 failed 即 failed", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        { siteId: "ask#2", ordinal: 1, phase: "settled", outcome: "ok" },
        { siteId: "ask#2", ordinal: 2, phase: "settled", outcome: "failed" },
      ]),
      graph,
    );
    expect(statuses["ask#2"]).toBe("failed");
  });

  it("全部结算且全部 ok 才是 done", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        { siteId: "ask#2", ordinal: 1, phase: "settled", outcome: "ok" },
        { siteId: "ask#2", ordinal: 2, phase: "settled", outcome: "ok", cached: true },
      ]),
      graph,
    );
    expect(statuses["ask#2"]).toBe("done");
  });

  it("既有已结算又有排队的实例是 running：开始了、没结束，既不谎报 done 也不谎报没开始", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        { siteId: "ask#2", ordinal: 1, phase: "settled", outcome: "ok" },
        { siteId: "ask#2", ordinal: 2, phase: "queued" },
      ]),
      graph,
    );
    expect(statuses["ask#2"]).toBe("running");
    // 已失败 + 排队同样是 running（running 优先于 failed 的旧裁决）。
    expect(
      workflowRunOverlay(
        runWith([
          { siteId: "ask#2", ordinal: 1, phase: "settled", outcome: "failed" },
          { siteId: "ask#2", ordinal: 2, phase: "queued" },
        ]),
        graph,
      ).statuses["ask#2"],
    ).toBe("running");
  });

  it("全部在排队时才是 pending", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        { siteId: "ask#2", ordinal: 1, phase: "queued" },
        { siteId: "ask#2", ordinal: 2, phase: "dispatched" },
      ]),
      graph,
    );
    expect(statuses["ask#2"]).toBe("pending");
  });

  it("不认识的 site id 被忽略（运行期图的节点集合绝不变化）", () => {
    const { statuses } = workflowRunOverlay(
      runWith([{ siteId: "ask#99", ordinal: 1, phase: "executing" }]),
      graph,
    );
    expect(statuses).toEqual({});
  });
});

describe("workflowRunOverlay animatedEdges", () => {
  it("有 step 在跑时开启边动画", () => {
    expect(
      workflowRunOverlay(runWith([{ siteId: "ask#1", ordinal: 1, phase: "executing" }]), graph)
        .animatedEdges,
    ).toBe(true);
  });

  it("终态 run 关闭边动画", () => {
    expect(
      workflowRunOverlay(
        runWith([{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" }], {
          status: "completed",
        }),
        graph,
      ).animatedEdges,
    ).toBe(false);
  });
});

// may-set 车道展开后的图：一个站点两张卡片，各归其候选车道，`source` 是它们共同的站点 id。
// 见 apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md「Joining runtime instances」。
const expandedGraph: WorkflowCausalityGraphData = {
  steps: [
    {
      id: "ask#1~actor#1",
      source: "ask#1",
      kind: "ask",
      label: "ask",
      lane: "actor#1",
      lanes: ["actor#1", "actor#2"],
      repeat: "serial",
    },
    {
      id: "ask#1~actor#2",
      source: "ask#1",
      kind: "ask",
      label: "ask",
      lane: "actor#2",
      lanes: ["actor#1", "actor#2"],
      repeat: "serial",
    },
    { id: "ask#2", kind: "ask", label: "judge", lane: "actor#3" },
  ],
  lanes: [{ id: "actor#1", name: "black" }, { id: "actor#2", name: "white" }, { id: "actor#3" }],
  edges: [{ from: "ask#1~actor#1", to: "ask#1~actor#2", back: true }],
};

describe("workflowRunOverlay 展开拷贝的车道路由", () => {
  it("某一候选车道上的实例只点亮该候选的拷贝", () => {
    const { statuses } = workflowRunOverlay(
      runWith([{ siteId: "ask#1", ordinal: 1, phase: "executing", actorSiteId: "actor#1" }]),
      expandedGraph,
    );
    expect(statuses["ask#1~actor#1"]).toBe("running");
    expect(statuses["ask#1~actor#2"]).toBeUndefined();
  });

  it("同一站点的两条车道各自聚合，互不串味", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        {
          siteId: "ask#1",
          ordinal: 1,
          phase: "settled",
          outcome: "failed",
          actorSiteId: "actor#1",
        },
        { siteId: "ask#1", ordinal: 2, phase: "executing", actorSiteId: "actor#2" },
      ]),
      expandedGraph,
    );
    expect(statuses["ask#1~actor#1"]).toBe("failed");
    expect(statuses["ask#1~actor#2"]).toBe("running");
  });

  it("actorSiteId 缺席的实例聚合进该 source 的全部拷贝（退化成旧单卡的过度点亮，不是死图）", () => {
    const { statuses } = workflowRunOverlay(
      runWith([{ siteId: "ask#1", ordinal: 1, phase: "executing" }]),
      expandedGraph,
    );
    expect(statuses["ask#1~actor#1"]).toBe("running");
    expect(statuses["ask#1~actor#2"]).toBe("running");
  });

  it("落在候选之外车道的实例不点亮任何拷贝（拷贝的车道就是它的全部主张）", () => {
    const { statuses } = workflowRunOverlay(
      runWith([{ siteId: "ask#1", ordinal: 1, phase: "executing", actorSiteId: "actor#9" }]),
      expandedGraph,
    );
    expect(statuses["ask#1~actor#1"]).toBeUndefined();
    expect(statuses["ask#1~actor#2"]).toBeUndefined();
  });

  it("孤儿拷贝：运行时从未选中的候选在 run 终局后仍无条目（画面上空心，模型上是缺席）", () => {
    const { animatedEdges, statuses } = workflowRunOverlay(
      runWith(
        [{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok", actorSiteId: "actor#1" }],
        {
          status: "completed",
        },
      ),
      expandedGraph,
    );
    expect(statuses).toEqual({ "ask#1~actor#1": "done" });
    expect(animatedEdges).toBe(false);
  });

  it("拷贝 id 不是站点 id：按拷贝 id 关联的实例一个也收不到", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        { siteId: "ask#1~actor#1", ordinal: 1, phase: "executing", actorSiteId: "actor#1" },
      ]),
      expandedGraph,
    );
    expect(statuses["ask#1~actor#1"]).toBeUndefined();
  });
});

// ——— 追记 2026-09-10「叠加视图也按出生阶段收窄」：阶段拷贝按实例的 phaseName 收 ———
describe("workflowRunOverlay 阶段拷贝的阶段路由", () => {
  // 一个 ask 站点被 5 个阶段认领：5 份拷贝、同一个 source、同一条车道。
  const NAMES = ["调研", "起草", "校对", "复核", "收尾"];
  const phasedGraph: WorkflowCausalityGraphData = {
    steps: NAMES.map((_, i) => ({
      id: `ask#1~phase#${i + 1}`,
      kind: "ask" as const,
      label: "review",
      lane: "actor#1",
      phase: `phase#${i + 1}`,
      source: "ask#1",
    })),
    lanes: [{ id: "actor#1", name: "worker" }],
    edges: [],
    phases: NAMES.map((name, i) => ({ id: `phase#${i + 1}`, name })),
  };
  const copies = (statuses: Record<string, string | undefined>) =>
    NAMES.map((_, i) => statuses[`ask#1~phase#${i + 1}`]);

  it("带戳的实例只点亮出生阶段那份拷贝：第 1 阶段在跑、第 2 阶段已结算，其余无条目", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        {
          siteId: "ask#1",
          ordinal: 1,
          phase: "executing",
          actorSiteId: "actor#1",
          phaseName: "调研",
        },
        {
          siteId: "ask#1",
          ordinal: 2,
          phase: "executing",
          actorSiteId: "actor#1",
          phaseName: "调研",
        },
        {
          siteId: "ask#1",
          ordinal: 21,
          phase: "settled",
          outcome: "ok",
          actorSiteId: "actor#1",
          phaseName: "起草",
        },
      ]),
      phasedGraph,
    );
    expect(copies(statuses)).toEqual(["running", "done", undefined, undefined, undefined]);
  });

  it("无戳的 run 点亮全部拷贝：旧 CLI / 旧 run 的过度点亮逐字节保持", () => {
    const { statuses } = workflowRunOverlay(
      runWith([{ siteId: "ask#1", ordinal: 1, phase: "executing", actorSiteId: "actor#1" }]),
      phasedGraph,
    );
    expect(copies(statuses)).toEqual(["running", "running", "running", "running", "running"]);
  });

  it("戳匹配不到任何 display 阶段 → 全部拷贝：宁可多亮也不把一个在跑的实例藏起来", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        {
          siteId: "ask#1",
          ordinal: 1,
          phase: "executing",
          actorSiteId: "actor#1",
          phaseName: "别处",
        },
      ]),
      phasedGraph,
    );
    expect(copies(statuses)).toEqual(["running", "running", "running", "running", "running"]);
  });

  it("run 有词汇而实例无戳 → 只落无名阶段；这张图没有无名阶段，于是退回全部", () => {
    const { statuses } = workflowRunOverlay(
      runWith([
        {
          siteId: "ask#1",
          ordinal: 1,
          phase: "executing",
          actorSiteId: "actor#1",
          phaseName: "调研",
        },
        {
          siteId: "ask#1",
          ordinal: 2,
          phase: "settled",
          outcome: "failed",
          actorSiteId: "actor#1",
        },
      ]),
      phasedGraph,
    );
    // 无戳的 failed 落到全部五份；第 1 份还叠着一个 running，running 优先。
    expect(copies(statuses)).toEqual(["running", "failed", "failed", "failed", "failed"]);
  });
});

describe("workflowRunOverlay 不带 source 的 step 关联行为不变", () => {
  it("不做车道收窄：>4 候选回退的单卡在别的车道上跑也照常点亮", () => {
    // 回退单卡（`lanes` 超过展开上限）画在 lanes[0]，实例却可能落在任一候选车道上——
    // 对不带 source 的 step 收窄车道等于把这类 step 的状态永久熄灭。
    const { statuses } = workflowRunOverlay(
      runWith([{ siteId: "ask#2", ordinal: 1, phase: "executing", actorSiteId: "actor#7" }]),
      expandedGraph,
    );
    expect(statuses["ask#2"]).toBe("running");
  });

  it("全无 source 的图上，带 actorSiteId 的实例与旧行为逐字节一致", () => {
    const nodes: WorkflowRunState["nodes"] = [
      { siteId: "ask#1", ordinal: 1, phase: "executing", actorSiteId: "actor#1" },
      { siteId: "ask#2", ordinal: 1, phase: "settled", outcome: "failed", actorSiteId: "actor#2" },
      { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok" },
    ];
    expect(workflowRunOverlay(runWith(nodes), graph)).toEqual(
      workflowRunOverlay(
        runWith(nodes.map(({ actorSiteId: _actorSiteId, ...node }) => node)),
        graph,
      ),
    );
  });
});

describe("workflowRunActorsForLane", () => {
  const actors: WorkflowRunState["actors"] = [
    { siteId: "actor#2", ordinal: 2, status: "running", sessionId: "sess-b" },
    { siteId: "actor#2", ordinal: 1, status: "waiting", sessionId: "sess-a" },
    { siteId: "actor#1", ordinal: 1, status: "running", name: "planner", sessionId: "sess-p" },
  ];
  const run = runWith([], { actors });

  it("按车道 site id 过滤并按 ordinal 升序（fan-out 车道族的选择器顺序稳定）", () => {
    expect(workflowRunActorsForLane(run, "actor#2").map((actor) => actor.ordinal)).toEqual([1, 2]);
  });

  it("单实例车道返回一个 actor，其会话 id 即 transcript 下钻的入口", () => {
    const resolved = workflowRunActorsForLane(run, "actor#1");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.sessionId).toBe("sess-p");
  });

  it("workspace / unknown 合成车道上没有会话，返回空", () => {
    expect(workflowRunActorsForLane(run, "workspace")).toEqual([]);
    expect(workflowRunActorsForLane(run, "unknown")).toEqual([]);
    expect(workflowRunActorsForLane(undefined, "actor#1")).toEqual([]);
  });
});
