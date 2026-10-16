// 轮尾 run 卡的解析（docs/dynamic-workflow/presentation.md「The run card」）：凡点名了 runId 的来源都出一张卡
// ——直接启动轮按元数据、CreateWorkflow 按 toolCallId、ResumeWorkflowRun 按 runId；图按 run 的发起
// toolCallId 到图表里取；联接不到活投影的来源出中性卡（summary 缺席）；同 run 一轮一张。
import { describe, expect, it } from "vitest";
import type { ToolCallRow, WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { resolveWorkflowTurnDigests } from "@/v4/workflowTurnDigests.js";

const GRAPH = {
  steps: [{ id: "ask#1", kind: "ask", label: "a", line: 1, column: 21, lane: "actor#1" }],
  lanes: [{ id: "actor#1", name: "a", line: 1, column: 11 }],
  participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
};

function toolCallRow(
  rowId: number,
  toolName: string,
  input: unknown,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    rowId,
    turnId: "turn",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName,
    status: "success",
    input,
    inputText: JSON.stringify(input),
    ...overrides,
  };
}

function summary(runId: string, toolCallId: string): WorkflowRunCardSummary {
  return { runId, toolCallId, status: "running", nodesSettled: 0, nodesTotal: 1 };
}

const CREATE = toolCallRow(5, "CreateWorkflow", { name: "implement-verify", script: "phase('a')" });
const GRAPHS = new Map([["tool-5", GRAPH]]);

const LAUNCH: WorkflowLaunchMeta = {
  runId: "run-l",
  toolCallId: "launch-abc",
  name: "deep-research",
  scope: "project",
  path: "/w/.zcode/workflows/deep-research.dwf.ts",
};

describe("resolveWorkflowTurnDigests", () => {
  // 设置轮（docs/dynamic-workflow/presentation.md「The settings turn」）：与直接启动同一份元数据，多一块
  // `amend`；卡照旧是新 run 的卡，卡上方那一行的素材（改了什么、那一轮的时刻）随卡带出去。
  it("设置轮：一张新 run 的卡，带着 amend 与那一轮的时刻；普通启动轮没有这一块", () => {
    const amend = {
      predecessorRunId: "run-a",
      maxConcurrency: { from: 13, to: 4 },
      ceiling: 13,
    };
    const settingsTurn: WorkflowLaunchMeta = {
      runId: "run-b",
      toolCallId: "settings-1",
      name: "deep-research",
      amend,
    };
    const digests = resolveWorkflowTurnDigests(
      { workflowLaunch: settingsTurn, assistantWorkRows: [], startedAt: 1_700_000_000_000 },
      { byRunId: new Map([["run-b", summary("run-b", "settings-1")]]) },
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      key: "launch:settings-1",
      runId: "run-b",
      toolCallId: "settings-1",
      settings: { amend, at: 1_700_000_000_000 },
    });
    const launch = resolveWorkflowTurnDigests(
      { workflowLaunch: LAUNCH, assistantWorkRows: [], startedAt: 1 },
      {},
    );
    expect(launch[0]).not.toHaveProperty("settings");
  });

  // 就地生效的设置轮（docs/dynamic-workflow/presentation.md「The settings turn」）：`amend` 不带
  // predecessorRunId——它点名的 run 就是自己，卡已经在它启动的那一轮里了。只出行、不出卡。
  it("就地生效的设置轮：只出那一行（rowOnly），不再出第二张卡", () => {
    const amend = { maxConcurrency: { from: 13, to: 4 }, ceiling: 13 };
    const retune: WorkflowLaunchMeta = {
      runId: "run-l",
      toolCallId: "settings-2",
      name: "deep-research",
      amend,
    };
    const digests = resolveWorkflowTurnDigests(
      { workflowLaunch: retune, assistantWorkRows: [], startedAt: 1_700_000_000_000 },
      { byRunId: new Map([["run-l", summary("run-l", "launch-abc")]]) },
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      key: "launch:settings-2",
      runId: "run-l",
      rowOnly: true,
      settings: { amend, at: 1_700_000_000_000 },
    });
  });

  // 只出行的那条来源没有占掉「一轮一张卡」的名额：同一轮里真正启动了这条 run 的来源照常出卡。
  it("rowOnly 不挡同一轮里真正的发起来源出卡", () => {
    const retune: WorkflowLaunchMeta = {
      runId: "run-1",
      toolCallId: "settings-3",
      amend: { maxConcurrency: { from: 13, to: 4 } },
    };
    const digests = resolveWorkflowTurnDigests(
      { workflowLaunch: retune, assistantWorkRows: [CREATE] },
      { byToolCallId: new Map([["tool-5", summary("run-1", "tool-5")]]) },
    );
    expect(digests).toHaveLength(2);
    expect(digests[0]).toMatchObject({ rowOnly: true, runId: "run-1" });
    expect(digests[1]?.runId).toBe("run-1");
    expect(digests[1]).not.toHaveProperty("rowOnly");
  });

  // 就地生效的 AmendWorkflow 工具行（docs/dynamic-workflow/concurrency.md）：它没有铸新 run，所以
  // 按 toolCallId 什么都联接不到，轮尾也就没有卡——那条 run 的卡在它启动的那一轮里。行本身退成
  // 一条设置行（create-workflow 渲染器按 display.retune 走）。
  it("就地生效的 AmendWorkflow 行不出轮尾卡：它没有自己的 run", () => {
    const retuneRow = toolCallRow(7, "AmendWorkflow", { run_id: "run-1", max_concurrency: 4 });
    const digests = resolveWorkflowTurnDigests(
      { assistantWorkRows: [retuneRow] },
      { byRunId: new Map([["run-1", summary("run-1", "tool-5")]]) },
    );
    expect(digests).toEqual([]);
  });

  it("联接到 run 的 CreateWorkflow 行成一张卡：名字从行上读，图按发起 toolCallId 到图表取", () => {
    const byToolCallId = new Map([["tool-5", summary("run-1", "tool-5")]]);
    const digests = resolveWorkflowTurnDigests(
      { assistantWorkRows: [CREATE] },
      { byToolCallId, graphByToolCallId: GRAPHS },
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      key: "5:tool-5",
      name: "implement-verify",
      runId: "run-1",
      toolCallId: "tool-5",
      summary: { runId: "run-1" },
    });
    expect(digests[0]!.graph?.steps).toHaveLength(1);
  });

  it("没联接到 run 的 CreateWorkflow 行（被拒绝 / 编不过）没有卡：行本身不点名 runId；图表没有它的图时卡无图", () => {
    expect(resolveWorkflowTurnDigests({ assistantWorkRows: [CREATE] }, {})).toEqual([]);
    const digests = resolveWorkflowTurnDigests(
      { assistantWorkRows: [CREATE] },
      { byToolCallId: new Map([["tool-5", summary("run-2", "tool-5")]]) },
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]!.graph).toBeUndefined();
  });

  it("ResumeWorkflowRun 行按 runId 联接，图取自 run 的发起行；同一轮里已有同 run 的 Create 卡时并入、不开第二张", () => {
    const resume = toolCallRow(
      7,
      "ResumeWorkflowRun",
      { runId: "run-1" },
      { display: { kind: "resume_workflow_run", runId: "run-1" } as ToolCallRow["display"] },
    );
    const byRunId = new Map([["run-1", summary("run-1", "tool-5")]]);
    const alone = resolveWorkflowTurnDigests(
      { assistantWorkRows: [resume] },
      { byRunId, graphByToolCallId: GRAPHS },
    );
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatchObject({ name: undefined, runId: "run-1", toolCallId: "tool-7" });
    // 图是 run 的属性：resume 卡与发起行同一张图。
    expect(alone[0]!.graph?.steps).toHaveLength(1);

    const both = resolveWorkflowTurnDigests(
      { assistantWorkRows: [CREATE, resume] },
      { byToolCallId: new Map([["tool-5", summary("run-1", "tool-5")]]), byRunId },
    );
    expect(both).toHaveLength(1);
    expect(both[0]!.toolCallId).toBe("tool-5");
  });

  it("联接不到活投影的 ResumeWorkflowRun 行仍出卡（中性）：summary 缺席、发起行不可知故无图", () => {
    const resume = toolCallRow(
      7,
      "ResumeWorkflowRun",
      { runId: "run-gone" },
      { display: { kind: "resume_workflow_run", runId: "run-gone" } as ToolCallRow["display"] },
    );
    const digests = resolveWorkflowTurnDigests(
      { assistantWorkRows: [resume] },
      { graphByToolCallId: GRAPHS },
    );
    expect(digests).toEqual([
      {
        graph: undefined,
        key: "7:tool-7",
        name: undefined,
        runId: "run-gone",
        summary: undefined,
        toolCallId: "tool-7",
      },
    ]);
  });

  it("直接启动轮：元数据自带 runId / toolCallId / 名字，按 runId 联接，图按 toolCallId 取；排在工具行之前", () => {
    const byRunId = new Map([["run-l", summary("run-l", "launch-abc")]]);
    const digests = resolveWorkflowTurnDigests(
      { workflowLaunch: LAUNCH, assistantWorkRows: [] },
      { byRunId, graphByToolCallId: new Map([["launch-abc", GRAPH]]) },
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      key: "launch:launch-abc",
      name: "deep-research",
      runId: "run-l",
      toolCallId: "launch-abc",
      summary: { runId: "run-l" },
    });
    expect(digests[0]!.graph?.steps).toHaveLength(1);

    // run 不在投影里（淘汰 / 冷恢复）：仍出卡，summary 缺席。
    const cold = resolveWorkflowTurnDigests({ workflowLaunch: LAUNCH, assistantWorkRows: [] }, {});
    expect(cold).toHaveLength(1);
    expect(cold[0]).toMatchObject({ runId: "run-l", summary: undefined, graph: undefined });
  });

  it("非工具行与不相干的工具行一律略过", () => {
    const digests = resolveWorkflowTurnDigests(
      {
        assistantWorkRows: [
          toolCallRow(1, "Read", { file_path: "a" }),
          {
            rowId: 2,
            turnId: "turn",
            createdAt: 2,
            createdAtSeq: 2,
            kind: "reasoning",
            state: "complete",
            text: "…",
          },
        ],
      },
      { byToolCallId: new Map([["tool-9", summary("run-9", "tool-9")]]) },
    );
    expect(digests).toEqual([]);
  });
});
