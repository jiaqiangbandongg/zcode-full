// 工作区 transcript 的协议面（docs/dynamic-workflow/transcript-and-notifications.md「Two read queries」）：
// 两条只读 query 的参数 / 结果形状与上界。
import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  WORKFLOW_WORKSPACE_LIMITS,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  workflowRunWorkspaceNodeSchema,
} from "../src/zcode-protocol-v4/index.js";

function node(overrides: Record<string, unknown> = {}) {
  return {
    siteId: "world-read#3",
    ordinal: 2,
    kind: "world-run" as const,
    op: "run",
    args: ["pnpm", ["vitest", "run"], { timeoutMs: 60_000 }],
    status: "completed" as const,
    summary: { resultBytes: 4_212, exitCode: 1, stdoutBytes: 4_100, stderrBytes: 80 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_300,
    ...overrides,
  };
}

describe("v4 conversation workflowRunWorkspace query", () => {
  it("声明两个只读、无状态、超时重发安全的 query，与产物的 ①/③ 拆法同族", () => {
    expect(V4_METHODS.conversationWorkflowRunWorkspace).toBe(
      "v4/conversation/workflowRunWorkspace",
    );
    expect(V4_METHODS.conversationWorkflowRunNodeResult).toBe(
      "v4/conversation/workflowRunNodeResult",
    );
    const params = { sessionId: "s", runId: "r" };
    expect(v4ConversationWorkflowRunWorkspaceParamsSchema.parse(params)).toEqual(params);
    // 不带 atSeq / atLogEpoch：读的是 journal，没有陈旧可防。
    expect(
      v4ConversationWorkflowRunWorkspaceParamsSchema.safeParse({ ...params, atSeq: 1 }).success,
    ).toBe(false);
  });

  it("清单行带 op / args / 状态 / 摘要 / 时刻，**不带正文**；升级前的历史行两者缺席仍合法", () => {
    const full = node();
    expect(workflowRunWorkspaceNodeSchema.parse(full)).toEqual(full);
    const legacy = node({ op: undefined, args: undefined, summary: undefined });
    expect(workflowRunWorkspaceNodeSchema.parse(legacy)).toEqual({
      siteId: "world-read#3",
      ordinal: 2,
      kind: "world-run",
      status: "completed",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_300,
    });
    // 正文永不进清单：多一个 result 键整行拒收。
    expect(workflowRunWorkspaceNodeSchema.safeParse(node({ result: "x" })).success).toBe(false);
    // `inputTruncated` 只有 true 一个值：false 就该缺席。
    expect(workflowRunWorkspaceNodeSchema.safeParse(node({ inputTruncated: false })).success).toBe(
      false,
    );
    expect(
      workflowRunWorkspaceNodeSchema.parse(node({ inputTruncated: true })).inputTruncated,
    ).toBe(true);
  });

  it("失败行带 code + message；message 有展示上界", () => {
    const failed = node({
      status: "failed",
      summary: undefined,
      error: { code: "DriverError", message: "timed out after 300000ms" },
    });
    expect(workflowRunWorkspaceNodeSchema.parse(failed)).toEqual(failed);
    expect(
      workflowRunWorkspaceNodeSchema.safeParse(
        node({
          status: "failed",
          summary: undefined,
          error: {
            code: "DriverError",
            message: "x".repeat(WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength + 1),
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("结果包裹 nodes 数组（有界）+ 可选的 truncated", () => {
    const result = { nodes: [node()], truncated: true };
    expect(v4ConversationWorkflowRunWorkspaceResultSchema.parse(result)).toEqual(result);
    expect(v4ConversationWorkflowRunWorkspaceResultSchema.parse({ nodes: [] })).toEqual({
      nodes: [],
    });
    expect(
      v4ConversationWorkflowRunWorkspaceResultSchema.safeParse({
        nodes: Array.from({ length: WORKFLOW_WORKSPACE_LIMITS.maxNodes + 1 }, () => node()),
      }).success,
    ).toBe(false);
  });
});

describe("v4 conversation workflowRunNodeResult query", () => {
  it("按 (run, 站点, 序号) 取一个节点的正文；maxBytes 可选且钳在 resultMaxBytes", () => {
    const params = { sessionId: "s", runId: "r", siteId: "world-read#3", ordinal: 2 };
    expect(v4ConversationWorkflowRunNodeResultParamsSchema.parse(params)).toEqual(params);
    expect(
      v4ConversationWorkflowRunNodeResultParamsSchema.parse({ ...params, maxBytes: 1024 }),
    ).toEqual({ ...params, maxBytes: 1024 });
    expect(
      v4ConversationWorkflowRunNodeResultParamsSchema.safeParse({
        ...params,
        maxBytes: WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes + 1,
      }).success,
    ).toBe(false);
    const { ordinal: _dropped, ...withoutOrdinal } = params;
    expect(v4ConversationWorkflowRunNodeResultParamsSchema.safeParse(withoutOrdinal).success).toBe(
      false,
    );
  });

  it("结果带状态、保形有界化后的正文、截断标记与截断前字节数；running 行没有正文", () => {
    const completed = {
      status: "completed" as const,
      result: { exitCode: 0, stdout: "ok\n", stderr: "" },
      truncated: false,
      totalBytes: 41,
    };
    expect(v4ConversationWorkflowRunNodeResultResultSchema.parse(completed)).toEqual(completed);
    const running = { status: "running" as const, truncated: false, totalBytes: 0 };
    expect(v4ConversationWorkflowRunNodeResultResultSchema.parse(running)).toEqual(running);
    const failed = {
      status: "failed" as const,
      error: { code: "WorldReadCapExceeded", message: "stdout over 256 KiB" },
      truncated: false,
      totalBytes: 0,
    };
    expect(v4ConversationWorkflowRunNodeResultResultSchema.parse(failed)).toEqual(failed);
    // truncated 必填：调用方要据此在页脚说「只显示前 …」。
    const { truncated: _t, ...withoutTruncated } = completed;
    expect(
      v4ConversationWorkflowRunNodeResultResultSchema.safeParse(withoutTruncated).success,
    ).toBe(false);
  });
});
