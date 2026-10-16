// 工具卡 → dwf run 的联接（docs/dynamic-workflow/presentation.md「Joining cards to runs」那一行）。
//
// 值从裸 runId 加宽成 `{runId, status, nodesSettled, nodesTotal}`：聊天区的紧凑卡要直接
// 渲染状态词与步数进度，所以联接一次就把摘要算完，卡片不再自己去翻投影。
//
// 计数语义写明：**动态工作流没有静态总数**，`nodesTotal` 是**已排程**（observed）节点数，
// 进度读作「已排程的里结算了几个」，绝不冒充全程百分比。
import { describe, expect, it } from "vitest";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunStepCounts } from "@zcode/shared/zcode-protocol-v4";
import {
  buildWorkflowGraphByToolCallId,
  buildWorkflowRunByRunId,
  buildWorkflowRunByToolCallId,
  buildWorkflowRunPendingQuestionsByRunId,
  resolveWorkflowRunOpenToolCallId,
} from "@/v4/workflowRunCardJoin.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function node(
  overrides: Partial<WorkflowRunNode> & Pick<WorkflowRunNode, "phase">,
): WorkflowRunNode {
  return { siteId: "ask#1", ordinal: 1, ...overrides };
}

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

describe("buildWorkflowRunByToolCallId", () => {
  it("按 toolCallId 建表，并带上卡片要渲染的 runId 与状态", () => {
    const map = buildWorkflowRunByToolCallId([run({ runId: "dwfrun-7", status: "completed" })]);

    expect(map.get("tool-wf-1")).toMatchObject({
      runId: "dwfrun-7",
      status: "completed",
      nodesSettled: 0,
      nodesTotal: 0,
    });
  });

  it("nodesSettled 只数 settled 相位，nodesTotal 数全部已排程节点", () => {
    const map = buildWorkflowRunByToolCallId([
      run({
        nodes: [
          node({ phase: "settled", outcome: "ok" }),
          node({ ordinal: 2, phase: "settled", outcome: "failed" }),
          // 取消同样是结算：终态就是终态，进度不该把它算成「还在跑」。
          node({ ordinal: 3, phase: "settled", outcome: "cancelled" }),
          node({ ordinal: 4, phase: "dispatched" }),
          node({ ordinal: 5, phase: "repairing" }),
          node({ ordinal: 6, phase: "nudged" }),
          node({ ordinal: 7, phase: "queued" }),
        ],
      }),
    ]);

    expect(map.get("tool-wf-1")).toMatchObject({ nodesSettled: 3, nodesTotal: 7 });
  });

  it("一个节点都还没排程时给 0/0 而不是缺席", () => {
    const map = buildWorkflowRunByToolCallId([run({ status: "pending" })]);
    expect(map.get("tool-wf-1")).toMatchObject({
      nodesSettled: 0,
      nodesTotal: 0,
      status: "pending",
    });
  });

  it("没有 toolCallId 的 run 不进表（它没有可点的卡片）", () => {
    const map = buildWorkflowRunByToolCallId([
      run({ runId: "dwfrun-headless", toolCallId: undefined }),
    ]);
    expect(map.size).toBe(0);
  });

  it("多条 run 各自成键", () => {
    const map = buildWorkflowRunByToolCallId([
      run({ runId: "dwfrun-1", toolCallId: "tool-a", nodes: [node({ phase: "settled" })] }),
      run({ runId: "dwfrun-2", toolCallId: "tool-b", status: "errored" }),
    ]);

    expect(map.size).toBe(2);
    expect(map.get("tool-a")).toMatchObject({ runId: "dwfrun-1", nodesSettled: 1, nodesTotal: 1 });
    expect(map.get("tool-b")).toMatchObject({ runId: "dwfrun-2", status: "errored" });
  });

  it("活投影命中时整条 run 随摘要带上：卡片内联的时间线要灯、药丸与墨迹", () => {
    // docs/dynamic-workflow/presentation.md「Joining cards to runs」：renderer 仍然不翻投影，
    // 联接一次把整条 run 交给它。
    const state = run({ actors: [{ siteId: "actor#1", ordinal: 1, status: "running" }] });
    const map = buildWorkflowRunByToolCallId([state]);
    expect(map.get("tool-wf-1")?.run).toBe(state);
  });

  it("可恢复性只读投影的 resumable 状态位，不按 status 推导", () => {
    // docs/dynamic-workflow/presentation.md：CLI 在 run-settled 载荷上按 resume 门裁定，
    // reducer 搬运；一个 stopped 但没带该位的 run（旧 CLI）不可恢复。
    expect(
      buildWorkflowRunByToolCallId([run({ status: "stopped", resumable: true })]).get("tool-wf-1")
        ?.resumable,
    ).toBe(true);
    expect(
      buildWorkflowRunByToolCallId([
        run({ status: "stopped", stopReason: "interrupted", resumable: true }),
      ]).get("tool-wf-1")?.resumable,
    ).toBe(true);
    expect(
      buildWorkflowRunByToolCallId([run({ status: "stopped" })]).get("tool-wf-1")?.resumable,
    ).toBeUndefined();
    expect(
      buildWorkflowRunByRunId([run({ status: "stopped", resumable: true })]).get("dwfrun-1")
        ?.resumable,
    ).toBe(true);
  });

  it("投影里还没有 workflowRuns 时返回空表", () => {
    expect(buildWorkflowRunByToolCallId(undefined).size).toBe(0);
    expect(buildWorkflowRunByToolCallId([]).size).toBe(0);
  });
});

// 计数规则本身住在 @zcode/shared（表内 + 表外，唯一实现）；这里钉的是**建表读的是它**——
// 联接表与状态胶囊、时间线摘要必须报同一个数，此前三处各数一遍，撞过界的 run 在三个地方
// 显示三个都偏小的数字。
describe("步数来源", () => {
  it("建表的两个计数就是 workflowRunStepCounts 的两个数", () => {
    const sample = run({
      nodes: [node({ phase: "settled" }), node({ ordinal: 2, phase: "nudged" })],
    });
    const fromMap = buildWorkflowRunByToolCallId([sample]).get("tool-wf-1");

    expect({ settled: fromMap?.nodesSettled, total: fromMap?.nodesTotal }).toEqual(
      workflowRunStepCounts(sample),
    );
  });

  it("撞界后没进表的实例照样算进卡片的步数", () => {
    const sample = run({
      nodes: [node({ phase: "settled" }), node({ ordinal: 2, phase: "queued" })],
      usage: { spentTokens: 0, nodesUsed: 2, nodesUnlisted: 40, nodesUnlistedSettled: 31 },
      truncated: true,
    });

    expect(buildWorkflowRunByToolCallId([sample]).get("tool-wf-1")).toMatchObject({
      nodesSettled: 32,
      nodesTotal: 42,
    });
    expect(buildWorkflowRunByRunId([sample]).get("dwfrun-1")).toMatchObject({
      nodesSettled: 32,
      nodesTotal: 42,
    });
  });
});

// byRunId 联接（docs/dynamic-workflow/presentation.md「Joining cards to runs」二轮）：
// ResumeWorkflowRun 行的 display 带 runId，投影的 toolCallId 跨 resume 沿用原始 CreateWorkflow
// 行，所以 resume 行只能按 runId 联接同一份投影。
describe("buildWorkflowRunByRunId", () => {
  it("按 runId 建表，摘要与 byToolCallId 表同构（同一份投影的两个索引）", () => {
    const map = buildWorkflowRunByRunId([
      run({
        runId: "dwfrun-resumed",
        status: "running",
        nodes: [
          node({ phase: "settled", outcome: "ok" }),
          node({ ordinal: 2, phase: "settled", outcome: "ok" }),
          node({ ordinal: 3, phase: "dispatched" }),
        ],
      }),
    ]);

    expect(map.get("dwfrun-resumed")).toMatchObject({
      runId: "dwfrun-resumed",
      status: "running",
      nodesSettled: 2,
      nodesTotal: 3,
      toolCallId: "tool-wf-1",
    });
  });

  it("没有 toolCallId 的 run 也进 byRunId 表（resume 联接不依赖 create 行的键）", () => {
    const map = buildWorkflowRunByRunId([run({ runId: "dwfrun-x", toolCallId: undefined })]);
    expect(map.get("dwfrun-x")?.runId).toBe("dwfrun-x");
  });
});
// bug 修复的钉子（spec「工具卡 display」三轮修订）：打开请求的 toolCallId 必须是**发起
// CreateWorkflow 行**的 id——WorkflowRunSidePane 拿它找 causalityGraph 与脚本；resume 行
// 自己的 id 会让详情页落「可见历史里没有这张工作流图」。
describe("byRunId 摘要的 toolCallId 传播", () => {
  it("摘要携带投影里 run 的 toolCallId（原始 create 行 id，跨 resume 不变）", () => {
    const map = buildWorkflowRunByRunId([run({ runId: "dwfrun-r", toolCallId: "tool-create-1" })]);
    expect(map.get("dwfrun-r")?.toolCallId).toBe("tool-create-1");
  });

  it("投影 run 无 toolCallId 时摘要不带该键（回落语义由 resolve helper 表达）", () => {
    const map = buildWorkflowRunByRunId([run({ runId: "dwfrun-x", toolCallId: undefined })]);
    expect(map.get("dwfrun-x")?.toolCallId).toBeUndefined();
  });
});

describe("resolveWorkflowRunOpenToolCallId", () => {
  it("resume 行点开：摘要带投影 id 时恒用投影值（点中行的 id 不是发起行）", () => {
    expect(
      resolveWorkflowRunOpenToolCallId("tool-resume-1", {
        runId: "dwfrun-r",
        status: "running",
        nodesSettled: 0,
        nodesTotal: 0,
        toolCallId: "tool-create-1",
      }),
    ).toBe("tool-create-1");
  });

  it("create 行点开：摘要 id 与点中行 id 本就相等，结果不变", () => {
    expect(
      resolveWorkflowRunOpenToolCallId("tool-create-1", {
        runId: "dwfrun-r",
        status: "running",
        nodesSettled: 0,
        nodesTotal: 0,
        toolCallId: "tool-create-1",
      }),
    ).toBe("tool-create-1");
  });

  it("摘要缺席回落点中行的 id（既有行为）", () => {
    expect(
      resolveWorkflowRunOpenToolCallId("tool-create-1", {
        runId: "dwfrun-r",
        status: "running",
        nodesSettled: 0,
        nodesTotal: 0,
      }),
    ).toBe("tool-create-1");
    expect(resolveWorkflowRunOpenToolCallId("tool-create-1", undefined)).toBe("tool-create-1");
  });
});

describe("buildWorkflowRunPendingQuestionsByRunId", () => {
  it("键在场 ⟺ run 在投影里，值是停驻 qid 集合（含/空两态）", () => {
    const map = buildWorkflowRunPendingQuestionsByRunId([
      run({
        runId: "dwfrun-waiting",
        pendingQuestions: [
          { qid: "q_a", question: "问题 A" },
          { qid: "q_b", question: "问题 B" },
        ],
      }),
      // pendingQuestions 零条时整个键缺席（schema 惯例）→ 坍缩成空 Set = Answered。
      run({ runId: "dwfrun-answered" }),
    ]);

    expect(map.get("dwfrun-waiting")?.has("q_a")).toBe(true);
    expect(map.get("dwfrun-waiting")?.has("q_b")).toBe(true);
    expect(map.has("dwfrun-answered")).toBe(true);
    expect(map.get("dwfrun-answered")?.size).toBe(0);
    // run 不在场 → 键缺席（中性 Question，绝不谎报 Answered）。
    expect(map.has("dwfrun-absent")).toBe(false);
  });

  it("投影缺席 → 空表", () => {
    expect(buildWorkflowRunPendingQuestionsByRunId(undefined).size).toBe(0);
  });
});

// 发起 toolCallId → 图（docs/dynamic-workflow/presentation.md「The run card」）：图是 run 的属性，按发起行找，
// 不问它挂在 CreateWorkflow 工具行上还是直接启动轮的元数据上；空图按无图。
describe("buildWorkflowGraphByToolCallId", () => {
  const GRAPH = {
    steps: [{ id: "ask#1", kind: "ask", label: "a", line: 1, column: 21, lane: "actor#1" }],
    lanes: [{ id: "actor#1", name: "a", line: 1, column: 11 }],
    participants: [
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ],
    handoffs: [],
  };
  const display = { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] } as const;
  const base = { turnId: "turn", createdAt: 1, createdAtSeq: 1 };

  it("CreateWorkflow 工具行按自己的 toolCallId 入表；空图与非工作流 display 不入", () => {
    const rows = [
      {
        ...base,
        rowId: 1,
        kind: "toolCall",
        toolCallId: "tool-1",
        toolName: "CreateWorkflow",
        status: "success",
        inputText: "",
        display: { ...display, causalityGraph: GRAPH },
      },
      {
        ...base,
        rowId: 2,
        kind: "toolCall",
        toolCallId: "tool-2",
        toolName: "CreateWorkflow",
        status: "success",
        inputText: "",
        display: { ...display, causalityGraph: { ...GRAPH, steps: [] } },
      },
      {
        ...base,
        rowId: 3,
        kind: "toolCall",
        toolCallId: "tool-3",
        toolName: "ResumeWorkflowRun",
        status: "success",
        inputText: "",
        display: { kind: "resume_workflow_run", runId: "run-1" },
      },
    ] as unknown as ConversationRow[];
    const table = buildWorkflowGraphByToolCallId(rows);
    expect([...table.keys()]).toEqual(["tool-1"]);
    expect(table.get("tool-1")?.steps).toHaveLength(1);
  });

  it("直接启动轮：turnHeader 与 userInput 各带同一份元数据，按元数据的 toolCallId 入表一次", () => {
    const workflowLaunch = {
      runId: "run-l",
      toolCallId: "launch-abc",
      name: "deep-research",
      scope: "project",
      path: "/w/.zcode/workflows/deep-research.dwf.ts",
      display: { ...display, causalityGraph: GRAPH },
    };
    const rows = [
      {
        ...base,
        rowId: 1,
        kind: "turnHeader",
        origin: "workflowLaunch",
        executionKind: "controlOnly",
        state: "completedSuccess",
        startedAt: 1,
        workflowLaunch,
      },
      { ...base, rowId: 2, kind: "userInput", text: "…", origin: "workflowLaunch", workflowLaunch },
      { ...base, rowId: 3, kind: "userInput", text: "hi", origin: "realUser" },
    ] as unknown as ConversationRow[];
    const table = buildWorkflowGraphByToolCallId(rows);
    expect([...table.keys()]).toEqual(["launch-abc"]);
    expect(buildWorkflowGraphByToolCallId(undefined).size).toBe(0);
  });
});
