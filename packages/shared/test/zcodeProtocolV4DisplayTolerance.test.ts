// display 载荷在信封层不设门（docs/v4-refactor/10-protocol-spec.md §4.4.5、
// docs/v4-refactor/04-sync-and-recovery.md 封闭规则 11）。
//
// 回归来源（2026-09-21，sess_4142de31）：CLI 给 `list_workflow_runs` 的 run 行加了
// `resumedFrom` / `supersededBy` 两个 lineage 键（contracts 侧 display 复用了工具**输出**的行
// schema，输出长字段就等于 wire 长字段），本侧镜像没跟上。旧行为是整帧被
// `proto.frameAssemblyInvalidPayload` 拒 → 恢复阶梯在同一份内容上重试 → 会话停在
// fault.subscription.recoveryFailed，而每次快照都重放同一份存量载荷，永不自愈。
// 2026-09-17 的 `providerStop` 是同款事故的第一次。
//
// 现在的契约：**装饰载荷不决定 row / 帧 / 订阅的生死**。认不出来的 display 被丢掉（卡片退化成
// 纯文本，这正是 spec 一直承诺的行为），其余字段照常投影。本文件钉四个嵌入点 + 一条整帧路径。

import { describe, expect, it } from "vitest";
import {
  conversationTopicFrameSchema,
  permissionRequestPayloadSchema,
  reassembleTopicWireFrames,
  toolCallRowSchema,
  toolOutputSchema,
  workflowLaunchMetaSchema,
  type ConversationTopicFrame,
  type ConversationTopicWireFrame,
} from "../src/zcode-protocol-v4/index.js";

const TOPIC = "conversation/session-display-tolerance";
const SUBSCRIPTION_ID = "sub-display-tolerance";

/** 事故当天真的躺在库里的那张卡：20 行里 5 行带 lineage 键，此处取其中两行。 */
const POISONED_LIST_RUNS_DISPLAY = {
  kind: "list_workflow_runs",
  runs: [
    {
      runId: "dwfrun-a6c2c519-2758-48a1-995c-50f411bb6ce4",
      label: "pressure-test pause-resume",
      labelSource: "name",
      status: "completed",
      ownedByThisSession: true,
      createdAt: 1_758_000_000_000,
      updatedAt: 1_758_000_100_000,
      spentTokens: 12_345,
      // ↓ 本侧镜像不认识的两个键（CLI 侧输出 schema 在 980e257bff 长出来的）
      resumedFrom: "dwfrun-3eadf667-8c25-43da-83b1-0e26e7f4897c",
    },
    {
      runId: "dwfrun-2ffa52d4-decb-46eb-8dec-baac736f0187",
      label: "pressure-test pause-resume",
      labelSource: "name",
      status: "stopped",
      stopReason: "superseded",
      ownedByThisSession: true,
      createdAt: 1_758_000_000_000,
      updatedAt: 1_758_000_050_000,
      spentTokens: 6_789,
      supersededBy: "dwfrun-5b042041-d319-4c35-97a1-61d47003e530",
    },
  ],
  truncated: true,
} as const;

/** 本端认得的合法载荷，用来证明"不设门"不等于"不解析"。 */
const VALID_DISPLAY = {
  kind: "task_output",
  retrievalStatus: "success",
  taskStatus: "completed",
  output: "done",
} as const;

function toolRow(display: unknown): Record<string, unknown> {
  return {
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "toolCall",
    toolCallId: "call-1",
    toolName: "ListWorkflowRuns",
    status: "success",
    inputText: "{}",
    display,
  };
}

describe("display 载荷在信封层不设门", () => {
  it("row 上带 lineage 键的 list_workflow_runs 卡被丢弃，row 其余字段照常投影", () => {
    const parsed = toolCallRowSchema.safeParse(toolRow(POISONED_LIST_RUNS_DISPLAY));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // 卡没了（渲染侧据此退化成纯文本），但 row 本身完好——这才是"装饰载荷"该有的分量。
    expect(parsed.data.display).toBeUndefined();
    expect(parsed.data.toolCallId).toBe("call-1");
    expect(parsed.data.status).toBe("success");
  });

  it("output.display 上的同一份载荷同样只丢卡，text 照常送达", () => {
    const parsed = toolOutputSchema.safeParse({
      text: "<runs>…</runs>",
      display: POISONED_LIST_RUNS_DISPLAY,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.display).toBeUndefined();
    expect(parsed.data.text).toBe("<runs>…</runs>");
  });

  it("认得的 display 仍逐字段通过（不设门不等于不解析）", () => {
    const row = toolCallRowSchema.safeParse(toolRow(VALID_DISPLAY));
    expect(row.success).toBe(true);
    if (row.success) expect(row.data.display).toEqual(VALID_DISPLAY);

    const output = toolOutputSchema.safeParse({ text: "done", display: VALID_DISPLAY });
    expect(output.success).toBe(true);
    if (output.success) expect(output.data.display).toEqual(VALID_DISPLAY);
  });

  // 新 display kind 曾是比新字段更硬的墙：discriminated union 对未知 discriminator 直接失败，
  // 于是"加一个卡种"对版本锁定的旧客户端等于一次破坏性变更（presentation.md 因此放弃过这个方案）。
  it("未来 CLI 新增的 display kind 只是这张卡没有载荷，不是解析失败", () => {
    const parsed = toolCallRowSchema.safeParse(
      toolRow({ kind: "some_future_card_kind_from_a_newer_cli", whatever: 1 }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  it.each([
    ["非对象", 42],
    ["缺 kind", { runs: [] }],
    ["kind 非字符串", { kind: 7 }],
    ["认得的 kind 但成员形状不对", { kind: "task_output", retrievalStatus: "nope" }],
  ])("畸形 display（%s）被丢弃而不是拒 row", (_label, display) => {
    const parsed = toolCallRowSchema.safeParse(toolRow(display));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  it("缺席的 display 不会被 catch 变成在场的 undefined 键", () => {
    const row = toolRow(undefined);
    delete row.display;
    const parsed = toolCallRowSchema.safeParse(row);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("display" in parsed.data).toBe(false);
  });

  it("确认预览（pendingInteraction.display）失败时退化成纯文本 ask，不拒整份 snapshot", () => {
    const parsed = permissionRequestPayloadSchema.safeParse({
      kind: "permission",
      toolCallId: "call-1",
      toolName: "ListWorkflowRuns",
      summary: "列出本项目的 workflow run",
      detail: {},
      options: [],
      display: POISONED_LIST_RUNS_DISPLAY,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  it("启动行的 workflowLaunch.display 失败时只是这一行没有图", () => {
    const parsed = workflowLaunchMetaSchema.safeParse({
      runId: "dwfrun-a6c2c519",
      toolCallId: "launch-2f0c9d18",
      display: { kind: "create_workflow", causalityGraph: { unexpected: true } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  // 这一条是事故本身：整帧走一遍真实的 physical reassembly。修复前这里会拿到
  // { kind: "rejected", reasonCode: "proto.frameAssemblyInvalidPayload" }，
  // 而 store 收到该 fault 后会在同一份内容上重试并最终 fail closed。
  it("承载被污染卡片的整帧仍然完整重组，不产生 InvalidPayload fault", () => {
    const frame: ConversationTopicFrame = {
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 10,
      toSeq: 11,
      sentAt: 1_700_000_000_000,
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.upserted", row: toolRow(POISONED_LIST_RUNS_DISPLAY) as never }],
      },
    };
    const wire: ConversationTopicWireFrame = {
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: "logical-display-tolerance",
      logicalFrameOrdinal: 1,
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      frame,
    };

    const result = reassembleTopicWireFrames([wire], conversationTopicFrameSchema);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    const delta = result.frame.payload.kind === "deltas" ? result.frame.payload.deltas[0] : null;
    expect(delta?.op).toBe("row.upserted");
    const row = delta?.op === "row.upserted" ? delta.row : null;
    expect(row?.kind).toBe("toolCall");
    // 帧活下来了，代价只是这张卡没有结构化载荷。
    expect(row?.kind === "toolCall" ? row.display : "unreachable").toBeUndefined();
  });

  it("信封本身没有被放松：必填字段缺失仍然拒整帧", () => {
    const { toolCallId: _dropped, ...rowMissingRequired } = toolRow(VALID_DISPLAY);
    const frame = {
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 10,
      toSeq: 11,
      sentAt: 1_700_000_000_000,
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.upserted", row: rowMissingRequired }],
      },
    };
    const wire = {
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: "logical-display-tolerance-2",
      logicalFrameOrdinal: 1,
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      frame,
    } as unknown as ConversationTopicWireFrame;

    expect(reassembleTopicWireFrames([wire], conversationTopicFrameSchema)).toEqual({
      kind: "rejected",
      reasonCode: "proto.frameAssemblyInvalidPayload",
    });
  });
});
