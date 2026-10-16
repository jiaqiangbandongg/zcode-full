// sessions-index 的工作流运行摘要（sessions-index-workflow-activity.ts）：
// 从 workflowRuns + backgroundWorks 派生侧栏运行行要画的有界数据（docs/dynamic-workflow/presentation.md
// 「The sidebar run line」）。纯函数、无时钟。
import { describe, expect, it } from "vitest";
import {
  SESSION_WORKFLOW_ACTIVITY_MAX_RUNS,
  deriveSessionWorkflowActivity,
  sessionWorkflowActivitySchema,
  type BackgroundWorkSummary,
  type WorkflowRunNode,
  type WorkflowRunState,
} from "../src/zcode-protocol-v4/index.js";

function run(overrides: Partial<WorkflowRunState> & { runId: string }): WorkflowRunState {
  return {
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

function work(
  overrides: Partial<BackgroundWorkSummary> & { workId: string },
): BackgroundWorkSummary {
  return {
    kind: "workflow",
    title: "Deep research",
    status: "running",
    startedAt: 1_000,
    anchorRowId: null,
    ...overrides,
  };
}

describe("deriveSessionWorkflowActivity", () => {
  it("没有 run 时缺席（旧 CLI / 普通会话什么都不变）", () => {
    expect(deriveSessionWorkflowActivity({ workflowRuns: undefined, backgroundWorks: [] })).toBe(
      undefined,
    );
    expect(
      deriveSessionWorkflowActivity({
        workflowRuns: { revision: 1, runs: [] },
        backgroundWorks: [work({ workId: "r-orphan" })],
      }),
    ).toBeUndefined();
  });

  it("在跑的 run：声明阶段表按序成站点，当前 running、已进入 done、其余 pending；名字与开始时刻来自后台工作", () => {
    const activity = deriveSessionWorkflowActivity({
      workflowRuns: {
        revision: 3,
        runs: [
          run({
            runId: "r1",
            toolCallId: "tc-1",
            phaseNames: ["Research", "Draft", "Review"],
            phases: [
              { name: "Research", rounds: 1 },
              { name: "Draft", rounds: 1 },
            ],
            currentPhase: "Draft",
            actors: [
              { siteId: "a", ordinal: 1, status: "running" },
              { siteId: "b", ordinal: 1, status: "running" },
              { siteId: "c", ordinal: 1, status: "completed" },
            ],
          }),
        ],
      },
      backgroundWorks: [work({ workId: "r1", title: "Deep research", startedAt: 42 })],
    });
    expect(activity).toEqual({
      runs: [
        {
          runId: "r1",
          toolCallId: "tc-1",
          name: "Deep research",
          status: "running",
          startedAt: 42,
          phases: [
            { name: "Research", status: "done" },
            { name: "Draft", status: "running" },
            { name: "Review", status: "pending" },
          ],
          currentPhase: "Draft",
          agentsWorking: 2,
        },
      ],
    });
    expect(sessionWorkflowActivitySchema.safeParse(activity).success).toBe(true);
  });

  it("没有声明表时退化为已进入的 phase（进入序）；两者都没有时 phases 为空", () => {
    const activity = deriveSessionWorkflowActivity({
      workflowRuns: {
        revision: 1,
        runs: [
          run({
            runId: "r1",
            phases: [{ name: "plan", rounds: 1 }],
            currentPhase: "verify",
          }),
          run({ runId: "r2" }),
        ],
      },
      backgroundWorks: [],
    });
    expect(activity?.runs.map((entry) => entry.phases)).toEqual([
      [
        { name: "plan", status: "done" },
        { name: "verify", status: "running" },
      ],
      [],
    ]);
    expect(activity?.runs[0]?.name).toBeUndefined();
    expect(activity?.runs[0]?.startedAt).toBeUndefined();
  });

  it("并行站点：声明表这条路带上 alongside，裁表后指向被裁站点的引用丢掉", () => {
    const activity = deriveSessionWorkflowActivity({
      workflowRuns: {
        revision: 1,
        runs: [
          run({
            runId: "r1",
            phaseNames: ["A", "B", "C"],
            phaseAlongside: [[], [0], []],
            phases: [{ name: "A", rounds: 1 }],
            currentPhase: "B",
          }),
        ],
      },
      backgroundWorks: [],
    });
    expect(activity?.runs[0]?.phases).toEqual([
      { name: "A", status: "done" },
      { name: "B", status: "running", alongside: [0] },
      { name: "C", status: "pending" },
    ]);
    expect(sessionWorkflowActivitySchema.safeParse(activity).success).toBe(true);
  });

  it("退化路（没有声明表）没有 alongside：已进入的 phase 是另一个下标空间", () => {
    const activity = deriveSessionWorkflowActivity({
      workflowRuns: {
        revision: 1,
        runs: [
          run({
            runId: "r1",
            // 声明表缺席（旧 CLI / 无标记脚本）时下标无处可指，整个键不带。
            phaseAlongside: [[1], [0]],
            phases: [{ name: "plan", rounds: 1 }],
            currentPhase: "verify",
          }),
        ],
      },
      backgroundWorks: [],
    });
    expect(activity?.runs[0]?.phases).toEqual([
      { name: "plan", status: "done" },
      { name: "verify", status: "running" },
    ]);
  });

  // 并行阶段的灯（设计稿 Surfaces.png：A 与 B 同时在烧）：控制流只记得最后一个标记，
  // 而 A 的子代理在 B 的标记之后仍在干活——成员节点比控制流更早说话，与卡片的规则 1 同构。
  function node(overrides: Partial<WorkflowRunNode> & { siteId: string }): WorkflowRunNode {
    return { ordinal: 1, phase: "executing", ...overrides };
  }

  it("并行的两站同时点亮：出生在已进入站的节点还在跑就把它括回 running", () => {
    const phases = (nodes: WorkflowRunNode[]) =>
      deriveSessionWorkflowActivity({
        workflowRuns: {
          revision: 1,
          runs: [
            run({
              runId: "r1",
              phaseNames: ["A", "B", "C"],
              phaseAlongside: [[], [0], []],
              phases: [
                { name: "A", rounds: 1 },
                { name: "B", rounds: 1 },
              ],
              currentPhase: "B",
              nodes,
            }),
          ],
        },
        backgroundWorks: [],
      })?.runs[0]?.phases.map((phase) => phase.status);

    // A 已进入、B 是当前站，A 里有一个节点还在 executing → 两站都烧。
    expect(phases([node({ siteId: "ask#1", phaseName: "A" })])).toEqual([
      "running",
      "running",
      "pending",
    ]);
    // repairing / nudged 同算在跑；dispatched / waiting 不算（模型请求还没发出去）。
    expect(phases([node({ siteId: "ask#1", phaseName: "A", phase: "repairing" })])?.[0]).toBe(
      "running",
    );
    expect(phases([node({ siteId: "ask#1", phaseName: "A", phase: "nudged" })])?.[0]).toBe(
      "running",
    );
    expect(phases([node({ siteId: "ask#1", phaseName: "A", phase: "dispatched" })])?.[0]).toBe(
      "done",
    );
    // A 的节点全结算了 → A 回到 done（节点只会说「还在跑」，不改写其他三态）。
    expect(
      phases([node({ siteId: "ask#1", phaseName: "A", phase: "settled", outcome: "ok" })]),
    ).toEqual(["done", "running", "pending"]);
    // 失败的节点同样不改灯：侧栏的失败词留给控制流。
    expect(
      phases([node({ siteId: "ask#1", phaseName: "A", phase: "settled", outcome: "failed" })]),
    ).toEqual(["done", "running", "pending"]);
    // 没有出生戳的节点（旧 run / 首个标记之前出生）什么都点不亮。
    expect(phases([node({ siteId: "ask#1" })])).toEqual(["done", "running", "pending"]);
    // 指向未列出站的戳也点不亮。
    expect(phases([node({ siteId: "ask#1", phaseName: "Z" })])).toEqual([
      "done",
      "running",
      "pending",
    ]);
  });

  it("run 不在跑时节点一盏灯都点不亮（终态压过一切）", () => {
    const activity = deriveSessionWorkflowActivity({
      workflowRuns: {
        revision: 1,
        runs: [
          run({
            runId: "r1",
            status: "stopped",
            stopReason: "user",
            phaseNames: ["A", "B"],
            phases: [{ name: "A", rounds: 1 }],
            currentPhase: "B",
            // settled 事件没来得及落下：停下的 run 里没有人还在干活。
            nodes: [{ siteId: "ask#1", ordinal: 1, phase: "executing", phaseName: "A" }],
          }),
        ],
      },
      backgroundWorks: [],
    });
    expect(activity?.runs[0]?.phases.map((phase) => phase.status)).toEqual(["done", "pending"]);
  });

  it("终态灯：completed 已进入 done；errored 当前 failed；stopped 当前 pending 并搬 stopReason", () => {
    const phaseNames = ["a", "b", "c"];
    const entered = [
      { name: "a", rounds: 1 },
      { name: "b", rounds: 1 },
    ];
    const activity = deriveSessionWorkflowActivity({
      workflowRuns: {
        revision: 1,
        runs: [
          run({
            runId: "done",
            status: "completed",
            phaseNames,
            phases: entered,
            currentPhase: "b",
          }),
          run({ runId: "err", status: "errored", phaseNames, phases: entered, currentPhase: "b" }),
          run({
            runId: "stop",
            status: "stopped",
            stopReason: "user",
            phaseNames,
            phases: entered,
            currentPhase: "b",
          }),
        ],
      },
      backgroundWorks: [],
    });
    const byId = new Map(activity!.runs.map((entry) => [entry.runId, entry]));
    expect(byId.get("done")?.phases.map((p) => p.status)).toEqual(["done", "done", "pending"]);
    expect(byId.get("err")?.phases.map((p) => p.status)).toEqual(["done", "failed", "pending"]);
    expect(byId.get("stop")?.phases.map((p) => p.status)).toEqual(["done", "pending", "pending"]);
    expect(byId.get("stop")?.stopReason).toBe("user");
    expect(byId.get("done")?.stopReason).toBeUndefined();
  });

  it("排序与上限：在跑的按启动序在前，已结束的按 endedAt 倒序，总数裁到 4", () => {
    const activity = deriveSessionWorkflowActivity({
      workflowRuns: {
        revision: 1,
        runs: [
          run({ runId: "old-done", status: "completed" }),
          run({ runId: "live-1", status: "pending" }),
          run({ runId: "new-done", status: "errored" }),
          run({ runId: "live-2" }),
          run({ runId: "no-work-done", status: "stopped" }),
          run({ runId: "live-3" }),
        ],
      },
      backgroundWorks: [
        work({ workId: "old-done", status: "resultPending", endedAt: 10 }),
        work({ workId: "new-done", status: "failed", endedAt: 20 }),
      ],
    });
    expect(activity?.runs).toHaveLength(SESSION_WORKFLOW_ACTIVITY_MAX_RUNS);
    expect(activity?.runs.map((entry) => entry.runId)).toEqual([
      "live-1",
      "live-2",
      "live-3",
      "new-done",
    ]);
  });
});
