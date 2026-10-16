// run 目录的纯模型（docs/dynamic-workflow/presentation.md「Other places a run appears」
// 与「run 目录的单一信源：journal」两行）。
//
// 这个模块存在的全部理由是**一个谓词只有一处实现**：任务岛页脚行上的计数与目录页里的行必须
// 出自同一次过滤与同一套分桶，否则「岛说 5 条、点开只有 4 行」这种不一致随时会长出来。
// 因此下面每个用例都同时断言列表与计数。
import { describe, expect, it } from "vitest";
import type {
  V4ConversationWorkflowRunSummary,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  buildWorkflowRunDirectory,
  countEndedWorkflowRuns,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";

function summary(
  overrides: Partial<V4ConversationWorkflowRunSummary> &
    Pick<V4ConversationWorkflowRunSummary, "runId">,
): V4ConversationWorkflowRunSummary {
  return {
    toolCallId: `call-${overrides.runId}`,
    status: "completed",
    resumable: false,
    ...overrides,
  };
}

describe("buildWorkflowRunDirectory", () => {
  it("按五值状态分桶：pending/running 归运行中，completed/errored/stopped 归已结束", () => {
    const directory = buildWorkflowRunDirectory([
      summary({ runId: "r-pending", status: "pending" }),
      summary({ runId: "r-running", status: "running" }),
      summary({ runId: "r-completed", status: "completed" }),
      summary({ runId: "r-failed", status: "errored" }),
      summary({ runId: "r-cancelled", status: "stopped" }),
    ]);

    expect(directory.running.map((row) => row.runId)).toEqual(["r-pending", "r-running"]);
    expect(directory.ended.map((row) => row.runId)).toEqual([
      "r-completed",
      "r-failed",
      "r-cancelled",
    ]);
  });

  it("缺 toolCallId 的老 run 从列表与计数一并剔除（过滤只有一处，不可能只剔一半）", () => {
    const summaries = [
      summary({ runId: "r-new" }),
      // `tool_call_id` 落库之前的 run：没有可开的详情页锚点。
      { runId: "r-old", status: "completed", resumable: false } as V4ConversationWorkflowRunSummary,
      {
        runId: "r-old-running",
        status: "running",
        resumable: false,
      } as V4ConversationWorkflowRunSummary,
    ];
    const directory = buildWorkflowRunDirectory(summaries);

    expect(directory.ended.map((row) => row.runId)).toEqual(["r-new"]);
    expect(directory.running).toEqual([]);
    expect(countEndedWorkflowRuns(summaries)).toBe(1);
  });

  it("计数恒等于已结束列表长度——这就是「岛上的 N 与页面上的行一致」那条不变量", () => {
    const summaries = [
      summary({ runId: "r-1", status: "errored" }),
      summary({ runId: "r-2", status: "running" }),
      { runId: "r-3", status: "stopped", resumable: true } as V4ConversationWorkflowRunSummary,
      summary({ runId: "r-4", status: "stopped" }),
      summary({ runId: "r-5", status: "pending" }),
    ];

    expect(countEndedWorkflowRuns(summaries)).toBe(
      buildWorkflowRunDirectory(summaries).ended.length,
    );
    expect(countEndedWorkflowRuns(summaries)).toBe(2);
  });

  it("不重排：顺序就是查询给的顺序（最近更新在前，排序在 CLI 存储层）", () => {
    const directory = buildWorkflowRunDirectory([
      summary({ runId: "r-newest", updatedAt: 300 }),
      summary({ runId: "r-middle", updatedAt: 200 }),
      summary({ runId: "r-oldest", updatedAt: 100 }),
    ]);

    expect(directory.ended.map((row) => row.runId)).toEqual(["r-newest", "r-middle", "r-oldest"]);
  });

  it("原样带上行要渲染的字段：label / updatedAt / stopReason / failureCode / resumable", () => {
    const directory = buildWorkflowRunDirectory([
      summary({
        runId: "r-1",
        label: "review-changes",
        status: "stopped",
        stopReason: "interrupted",
        failureCode: "Interrupted",
        failureMessage: "host restarted",
        updatedAt: 1_700_000_000_000,
        resumable: true,
      } as never),
    ]);

    expect(directory.ended[0]).toEqual({
      runId: "r-1",
      toolCallId: "call-r-1",
      label: "review-changes",
      status: "stopped",
      stopReason: "interrupted",
      failureCode: "Interrupted",
      failureMessage: "host restarted",
      updatedAt: 1_700_000_000_000,
      resumable: true,
    });
  });

  it("取满 limit 即判截断（提示要出现），差一条就不判", () => {
    const full = Array.from({ length: WORKFLOW_RUN_DIRECTORY_LIMIT }, (_unused, index) =>
      summary({ runId: `r-${index}` }),
    );

    expect(buildWorkflowRunDirectory(full).truncated).toBe(true);
    expect(buildWorkflowRunDirectory(full.slice(1)).truncated).toBe(false);
  });

  it("截断按**查询返回的**条数判，而不是过滤后的行数（否则满页老 run 会显示成「就这些」）", () => {
    const full = Array.from(
      { length: WORKFLOW_RUN_DIRECTORY_LIMIT },
      (_unused, index) =>
        ({
          runId: `r-old-${index}`,
          status: "completed",
          resumable: false,
        }) as V4ConversationWorkflowRunSummary,
    );
    const directory = buildWorkflowRunDirectory(full);

    expect(directory.ended).toEqual([]);
    expect(directory.truncated).toBe(true);
  });

  it("摘要缺席（还没查到 / 能力缺席）与空数组一样是空目录，不抛", () => {
    for (const input of [null, undefined, []] as const) {
      const directory = buildWorkflowRunDirectory(input);
      expect(directory.running).toEqual([]);
      expect(directory.ended).toEqual([]);
      expect(directory.truncated).toBe(false);
      expect(countEndedWorkflowRuns(input)).toBe(0);
    }
  });
});

// ── 新鲜度触发器（实测 bug：跑完的 run 不会自己挪到「已结束」）──
//
// 这个键的两个性质同样重要：**该动的时候动**（多一个 run / 跑完一个 run），
// **不该动的时候不动**（节点级进度）。后者不是优化，是它能不能挂在一个开着的页面上的前提：
// 用 `revision` 的话，一次分页读会变成一条随引擎事件走的流。
describe("workflowRunDirectoryRefreshKey", () => {
  function run(
    overrides: Partial<WorkflowRunState> & Pick<WorkflowRunState, "runId">,
  ): WorkflowRunState {
    return {
      toolCallId: `call-${overrides.runId}`,
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      actors: [],
      nodes: [],
      lastEventSequence: 0,
      ...overrides,
    };
  }

  it("run 跑完时变化：这就是那一行从「运行中」挪到「已结束」的时机", () => {
    const before = workflowRunDirectoryRefreshKey([run({ runId: "r-1" })]);
    const after = workflowRunDirectoryRefreshKey([run({ runId: "r-1", status: "completed" })]);

    expect(after).not.toBe(before);
  });

  it("三种终态都算跑完（errored / stopped 与 completed 同样要挪段）", () => {
    const running = workflowRunDirectoryRefreshKey([run({ runId: "r-1" })]);
    for (const status of ["completed", "errored", "stopped"] as const) {
      expect(workflowRunDirectoryRefreshKey([run({ runId: "r-1", status })])).not.toBe(running);
    }
  });

  it("新起一个 run 时变化：开着页面时它要出现在「运行中」", () => {
    const one = workflowRunDirectoryRefreshKey([run({ runId: "r-1" })]);
    const two = workflowRunDirectoryRefreshKey([run({ runId: "r-1" }), run({ runId: "r-2" })]);

    expect(two).not.toBe(one);
  });

  it("节点级进度**不**变化——否则一次分页读会变成一条随引擎事件走的流", () => {
    const idle = run({ runId: "r-1" });
    const busy = run({
      runId: "r-1",
      nodes: [
        { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" },
        { siteId: "ask#2", ordinal: 2, phase: "dispatched" },
      ],
      lastEventSequence: 42,
      usage: { spentTokens: 9_000, nodesUsed: 2 },
    });

    expect(workflowRunDirectoryRefreshKey([busy])).toBe(workflowRunDirectoryRefreshKey([idle]));
  });

  it("投影缺席（冷开首帧）有稳定的键，且与「一个 run 都没有」同值", () => {
    expect(workflowRunDirectoryRefreshKey(undefined)).toBe(workflowRunDirectoryRefreshKey([]));
  });
});
