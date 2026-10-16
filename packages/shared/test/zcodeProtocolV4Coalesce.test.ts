import { describe, expect, it } from "vitest";
import {
  applyConversationDeltas,
  applyConversationDeltasMutable,
  assistantTextRowSchema,
  coalesceConversationDeltas,
  conflateByKey,
  conversationSnapshotSchema,
  createMutableConversationSnapshotAccumulator,
  type AssistantTextRow,
  type ConversationDelta,
  type ConversationSnapshot,
  type ToolCallRow,
  type TurnHeaderRow,
  reasoningRowSchema,
  toolCallRowSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("assistant response correlation", () => {
  it("accepts the same optional assistantResponseId on reasoning, text and tool rows", () => {
    expect(
      reasoningRowSchema.parse({
        ...makeAssistantRow(0, "先检查权限"),
        kind: "reasoning",
        assistantResponseId: "assistant-response-1",
      }).assistantResponseId,
    ).toBe("assistant-response-1");
    expect(
      assistantTextRowSchema.parse({
        ...makeAssistantRow(1, "正在检查权限"),
        assistantResponseId: "assistant-response-1",
      }).assistantResponseId,
    ).toBe("assistant-response-1");
    expect(
      toolCallRowSchema.parse({
        ...makeToolRow(2),
        assistantResponseId: "assistant-response-1",
      }).assistantResponseId,
    ).toBe("assistant-response-1");
  });

  it("keeps legacy rows without assistantResponseId valid", () => {
    expect(
      reasoningRowSchema.parse({ ...makeAssistantRow(0), kind: "reasoning" }).assistantResponseId,
    ).toBeUndefined();
    expect(assistantTextRowSchema.parse(makeAssistantRow(1)).assistantResponseId).toBeUndefined();
    expect(toolCallRowSchema.parse(makeToolRow(2)).assistantResponseId).toBeUndefined();
  });
});

function makeAssistantRow(rowId: number, text = ""): AssistantTextRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1000,
    createdAtSeq: rowId,
    kind: "assistantText",
    text,
    state: "streaming",
  };
}

function makeToolRow(rowId: number): ToolCallRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1000,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tc-${rowId}`,
    toolName: "Read",
    status: "inputStreaming",
    inputText: "",
  };
}

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "guard.manualCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "guard.sendQueuedNowStopsBeforeDrain" },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.stopPausesActiveGoalTarget" },
    },
    inputRouting: { mode: "enqueue" },
    // meta 是 freeze-m2 后 additive 新增（带 schema default）；夹具写归一化形态，
    // round-trip 断言 parse 前后 deep-equal 才成立。
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: ["medium", "high", "max"],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: { usedTokens: 100, maxTokens: 200000, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    // 软门禁 additive 字段:带 default(null),round-trip 归一化形态
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

/** 语义保持裁判：coalesce 后 apply 的终态必须与逐条 apply 逐字节一致。 */
function expectSemanticsPreserved(deltas: ConversationDelta[]) {
  const base = makeSnapshot();
  const direct = applyConversationDeltas(base, deltas);
  const coalesced = applyConversationDeltas(base, coalesceConversationDeltas(deltas));
  expect(coalesced).toEqual(direct);
  // 规则 6 允许把靠后的 op 合并到靠前的位置上，键序因此不再是"两条路径天然相同"——
  // 这条定律要的是**逐字节**一致，而不只是深相等。
  expect(JSON.stringify(coalesced.workflowRuns)).toBe(JSON.stringify(direct.workflowRuns));
}

/** run 出生增量：一条完整 header，客户端据它才建得起表。 */
function makeRunBirth(runId: string, revision: number): ConversationDelta {
  return {
    op: "workflowRun.updated",
    runId,
    revision,
    run: {
      runId,
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      lastEventSequence: 0,
    },
  };
}

/** 一条节点相位推进的增量（引擎事件在线上的常态形状）。 */
function makeNodePhase(
  runId: string,
  revision: number,
  ordinal: number,
  phase: "queued" | "dispatched" | "executing" | "settled",
): ConversationDelta {
  return {
    op: "workflowRun.updated",
    runId,
    revision,
    run: { lastEventSequence: revision },
    nodes: [{ siteId: "ask#1", ordinal, phase }],
  };
}

describe("zcode-protocol-v4 coalesce", () => {
  it("旧 snapshot 缺少 thoughtLevels 时按空能力集合兼容解析", () => {
    const legacySnapshot = structuredClone(makeSnapshot()) as unknown as {
      config: Record<string, unknown>;
    };
    delete legacySnapshot.config.thoughtLevels;

    expect(conversationSnapshotSchema.parse(legacySnapshot).config.thoughtLevels).toEqual([]);
  });

  it("accepts context window cache and breakdown metadata in snapshots", () => {
    const snapshot: ConversationSnapshot = {
      ...makeSnapshot(),
      usage: {
        contextWindow: {
          usedTokens: 120,
          maxTokens: 200000,
          autoCompactThresholdTokens: null,
          cache: {
            inputTokens: 100,
            cacheReadTokens: 80,
            cacheWriteTokens: 10,
            latestHitRate: 0.8,
            hitRate: 0.8,
            hitRateRequestCount: 1,
            totalInputTokens: 100,
            totalCacheReadTokens: 80,
            totalCacheWriteTokens: 10,
          },
          breakdown: [
            { source: "messages", chars: 900 },
            { source: "system_tool_schemas", chars: 100 },
          ],
        },
        cumulative: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
        },
      },
    };

    const contextWindow = conversationSnapshotSchema.parse(snapshot).usage.contextWindow;
    expect(contextWindow?.cache).toMatchObject({ hitRate: 0.8 });
    expect(contextWindow?.breakdown).toEqual([
      { source: "messages", chars: 900 },
      { source: "system_tool_schemas", chars: 100 },
    ]);
  });

  it("merges adjacent row.delta with same (rowId, path)", () => {
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.delta", rowId: 1, path: "text", append: "你好" },
      { op: "row.delta", rowId: 1, path: "text", append: "，世界" },
      { op: "row.delta", rowId: 1, path: "text", append: "！" },
    ];
    const result = coalesceConversationDeltas(deltas);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      op: "row.delta",
      rowId: 1,
      path: "text",
      append: "你好，世界！",
    });
    expectSemanticsPreserved(deltas);
  });

  it("does not merge row.delta across different rows or paths", () => {
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.appended", row: makeToolRow(2) },
      { op: "row.delta", rowId: 1, path: "text", append: "a" },
      { op: "row.delta", rowId: 2, path: "inputText", append: "{" },
      { op: "row.delta", rowId: 1, path: "text", append: "b" },
    ];
    const result = coalesceConversationDeltas(deltas);
    // 不相邻不合并（保序优先于压缩率）
    expect(result.filter((d) => d.op === "row.delta")).toHaveLength(3);
    expectSemanticsPreserved(deltas);
  });

  it("shallow-merges adjacent state.updated patches (later key wins)", () => {
    const deltas: ConversationDelta[] = [
      {
        op: "state.updated",
        patch: { revision: 1, inputRouting: { mode: "enqueue" } },
      },
      {
        op: "state.updated",
        patch: { revision: 2, queue: { items: [], autoDrain: false } },
      },
    ];
    const result = coalesceConversationDeltas(deltas);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      op: "state.updated",
      patch: {
        revision: 2,
        inputRouting: { mode: "enqueue" },
        queue: { items: [], autoDrain: false },
      },
    });
    expectSemanticsPreserved(deltas);
  });

  it("row.upserted swallows preceding row.delta of the same row", () => {
    const finalRow: AssistantTextRow = {
      ...makeAssistantRow(1, "完整文本"),
      state: "complete",
    };
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.delta", rowId: 1, path: "text", append: "完整" },
      { op: "row.delta", rowId: 1, path: "text", append: "文本" },
      { op: "row.upserted", row: finalRow },
    ];
    const result = coalesceConversationDeltas(deltas);
    expect(result).toEqual([
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.upserted", row: finalRow },
    ]);
    expectSemanticsPreserved(deltas);
  });

  it("row.upserted does not swallow deltas beyond the row's own appended (previous generation)", () => {
    // row 1 流了一段 → row 1 被整行替换 → 又流一段 → 再替换：
    // 第二次 upserted 只能吞第二段 delta，不能越过第一次 upserted。
    const gen1: AssistantTextRow = { ...makeAssistantRow(1, "第一代"), state: "streaming" };
    const gen2: AssistantTextRow = { ...makeAssistantRow(1, "第二代"), state: "complete" };
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.delta", rowId: 1, path: "text", append: "x" },
      { op: "row.upserted", row: gen1 },
      { op: "row.delta", rowId: 1, path: "text", append: "y" },
      { op: "row.upserted", row: gen2 },
    ];
    expectSemanticsPreserved(deltas);
  });

  it("row.removed is a barrier: no rule crosses it", () => {
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.delta", rowId: 1, path: "text", append: "旧" },
      { op: "row.removed", fromRowId: 1 },
      { op: "row.appended", row: makeAssistantRow(2) },
      { op: "row.delta", rowId: 2, path: "text", append: "新" },
      { op: "row.upserted", row: { ...makeAssistantRow(2, "新"), state: "complete" } },
    ];
    const result = coalesceConversationDeltas(deltas);
    // 屏障保留；屏障前的 delta 不被屏障后的 upserted 吞掉
    expect(result.some((d) => d.op === "row.removed")).toBe(true);
    expect(result.findIndex((d) => d.op === "row.delta" && d.rowId === 1)).toBeGreaterThanOrEqual(
      0,
    );
    expectSemanticsPreserved(deltas);
  });

  it("keeps only the last of adjacent row.upserted for the same row", () => {
    const a: AssistantTextRow = { ...makeAssistantRow(1, "a"), state: "streaming" };
    const b: AssistantTextRow = { ...makeAssistantRow(1, "ab"), state: "complete" };
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.upserted", row: a },
      { op: "row.upserted", row: b },
    ];
    const result = coalesceConversationDeltas(deltas);
    expect(result).toEqual([
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.upserted", row: b },
    ]);
    expectSemanticsPreserved(deltas);
  });

  // ── 规则 6：workflowRun.updated 向窗口内最早的同 runId 增量合并 ──────────────
  // 宽 fan-out 的 run 每条引擎事件产一条增量，窗口里它们被别的 run 与行操作隔开；只合并相邻的
  // 等于一条都合不掉，而 500 条/订阅者的帧界正是被这些增量顶满的。
  it("规则 6：同 runId 的增量合并到最早那条，op 数从 N 塌成 1", () => {
    const deltas: ConversationDelta[] = [
      makeRunBirth("dwfrun-1", 1),
      ...Array.from({ length: 30 }, (_, index) =>
        makeNodePhase("dwfrun-1", index + 2, 1, index % 2 === 0 ? "executing" : "queued"),
      ),
    ];
    const result = coalesceConversationDeltas(deltas);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ op: "workflowRun.updated", revision: 31 });
    expectSemanticsPreserved(deltas);
  });

  it("规则 6：两条 run 的增量与行操作、无关 state.updated 交错也能各自塌缩", () => {
    const deltas: ConversationDelta[] = [
      makeRunBirth("dwfrun-1", 1),
      { op: "row.appended", row: makeAssistantRow(1) },
      makeRunBirth("dwfrun-2", 2),
      makeNodePhase("dwfrun-1", 3, 1, "queued"),
      { op: "row.delta", rowId: 1, path: "text", append: "分析中" },
      makeNodePhase("dwfrun-2", 4, 1, "queued"),
      { op: "state.updated", patch: { revision: 7 } },
      makeNodePhase("dwfrun-1", 5, 2, "queued"),
      makeNodePhase("dwfrun-2", 6, 1, "dispatched"),
      makeNodePhase("dwfrun-1", 7, 1, "dispatched"),
    ];
    const result = coalesceConversationDeltas(deltas);
    const perRun = result.filter((delta) => delta.op === "workflowRun.updated");
    expect(perRun).toHaveLength(2);
    // 出生序保住了：合并落在**最早**那条上，所以 runs[] 的顺序与逐条投递一致。
    expect(perRun.map((delta) => (delta.op === "workflowRun.updated" ? delta.runId : ""))).toEqual([
      "dwfrun-1",
      "dwfrun-2",
    ]);
    expectSemanticsPreserved(deltas);
  });

  it("规则 6：header 键与 cleared 互为反面，后者一律对消前者", () => {
    const deltas: ConversationDelta[] = [
      makeRunBirth("dwfrun-1", 1),
      {
        op: "workflowRun.updated",
        runId: "dwfrun-1",
        revision: 2,
        run: { pendingQuestions: [{ qid: "q-1", question: "门坏了吗？" }], resultPreview: "草稿" },
      },
      // 后一条把 pendingQuestions 清成缺席、又给 resultPreview 一个新值。
      {
        op: "workflowRun.updated",
        runId: "dwfrun-1",
        revision: 3,
        run: { resultPreview: "定稿" },
        cleared: ["pendingQuestions"],
      },
    ];
    const result = coalesceConversationDeltas(deltas);
    expect(result).toHaveLength(1);
    const merged = result[0]!;
    if (merged.op !== "workflowRun.updated") throw new Error("应合并成一条 workflowRun.updated");
    expect(merged.run).not.toHaveProperty("pendingQuestions");
    expect(merged.run?.resultPreview).toBe("定稿");
    expect(merged.cleared).toEqual(["pendingQuestions"]);
    expectSemanticsPreserved(deltas);

    // 反向：先清后设，键回到 run 里、不再留在 cleared。
    const reversed: ConversationDelta[] = [
      makeRunBirth("dwfrun-1", 1),
      { op: "workflowRun.updated", runId: "dwfrun-1", revision: 2, cleared: ["pendingQuestions"] },
      {
        op: "workflowRun.updated",
        runId: "dwfrun-1",
        revision: 3,
        run: { pendingQuestions: [{ qid: "q-2", question: "换一版？" }] },
      },
    ];
    const mergedReversed = coalesceConversationDeltas(reversed)[0]!;
    if (mergedReversed.op !== "workflowRun.updated") throw new Error("应合并成一条增量");
    expect(mergedReversed.cleared).toBeUndefined();
    expect(mergedReversed.run?.pendingQuestions).toHaveLength(1);
    expectSemanticsPreserved(reversed);
  });

  it("规则 6 的屏障：整键重发的 state.updated 不可跨越", () => {
    const deltas: ConversationDelta[] = [
      makeRunBirth("dwfrun-1", 1),
      makeNodePhase("dwfrun-1", 2, 1, "queued"),
      // 整键重发（diff 的退路）：它之后的增量作用在一张全新的表上。
      {
        op: "state.updated",
        patch: {
          workflowRuns: {
            revision: 3,
            runs: [
              {
                runId: "dwfrun-1",
                status: "running",
                usage: { spentTokens: 0, nodesUsed: 0 },
                actors: [],
                nodes: [],
                lastEventSequence: 3,
              },
            ],
          },
        },
      },
      makeNodePhase("dwfrun-1", 4, 9, "queued"),
      makeNodePhase("dwfrun-1", 5, 9, "dispatched"),
    ];
    const result = coalesceConversationDeltas(deltas);
    // 屏障两侧各自塌缩成一条，屏障本身留在中间。
    expect(result.map((delta) => delta.op)).toEqual([
      "workflowRun.updated",
      "state.updated",
      "workflowRun.updated",
    ]);
    expectSemanticsPreserved(deltas);
  });

  it("规则 6 的屏障：workflowRun.removed 吞掉同 run 此前的增量（出生+淘汰=没见过）", () => {
    const deltas: ConversationDelta[] = [
      makeRunBirth("dwfrun-1", 1),
      makeRunBirth("dwfrun-2", 2),
      makeNodePhase("dwfrun-1", 3, 1, "queued"),
      makeNodePhase("dwfrun-2", 4, 1, "queued"),
      { op: "workflowRun.removed", runId: "dwfrun-1", revision: 5 },
      makeNodePhase("dwfrun-2", 6, 1, "dispatched"),
    ];
    const result = coalesceConversationDeltas(deltas);
    expect(result.map((delta) => delta.op)).toEqual(["workflowRun.updated", "workflowRun.removed"]);
    expect(result[0]).toMatchObject({ runId: "dwfrun-2", revision: 6 });
    expectSemanticsPreserved(deltas);

    // 淘汰后这条 run 又回来（迟到事件）：新增量不被吞、也不与屏障前的合并。
    const revived: ConversationDelta[] = [...deltas, makeRunBirth("dwfrun-1", 7)];
    expect(coalesceConversationDeltas(revived).map((delta) => delta.op)).toEqual([
      "workflowRun.updated",
      "workflowRun.removed",
      "workflowRun.updated",
    ]);
    expectSemanticsPreserved(revived);
  });

  it("规则 6：合并后的 op 坐在靠前的位置，容器 revision 仍收在最高水位", () => {
    const deltas: ConversationDelta[] = [
      makeRunBirth("dwfrun-1", 1),
      makeRunBirth("dwfrun-2", 2),
      // 最后一条属于 dwfrun-1，合并后会被搬到第一条的位置上——靠 apply 的 max 收口。
      makeNodePhase("dwfrun-1", 9, 1, "settled"),
    ];
    const coalesced = applyConversationDeltas(makeSnapshot(), coalesceConversationDeltas(deltas));
    expect(coalesced.workflowRuns?.revision).toBe(9);
    expectSemanticsPreserved(deltas);
  });

  it("preserves semantics on a mixed long sequence", () => {
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: makeAssistantRow(1) },
      { op: "row.delta", rowId: 1, path: "text", append: "分析中" },
      { op: "state.updated", patch: { revision: 1 } },
      { op: "row.appended", row: makeToolRow(2) },
      { op: "row.delta", rowId: 2, path: "inputText", append: '{"path":' },
      { op: "row.delta", rowId: 2, path: "inputText", append: '"a.ts"}' },
      {
        op: "row.upserted",
        row: {
          ...makeToolRow(2),
          status: "success",
          inputText: '{"path":"a.ts"}',
          output: { text: "ok" },
        },
      },
      { op: "state.updated", patch: { revision: 2 } },
      { op: "row.delta", rowId: 1, path: "text", append: "……完成" },
      { op: "row.upserted", row: { ...makeAssistantRow(1, "分析中……完成"), state: "complete" } },
      { op: "state.updated", patch: { revision: 3 } },
    ];
    expectSemanticsPreserved(deltas);
  });
});

describe("zcode-protocol-v4 apply", () => {
  it("隔离态 mutable accumulator 与规范不可变 apply 五种操作逐字节等价", () => {
    const base = makeSnapshot();
    const deltas: ConversationDelta[] = [
      { op: "row.appended", row: makeAssistantRow(1, "a") },
      { op: "row.appended", row: makeToolRow(2) },
      { op: "row.delta", rowId: 1, path: "text", append: "bc" },
      { op: "row.delta", rowId: 2, path: "inputText", append: '{"path":"a.ts"}' },
      {
        op: "row.upserted",
        row: { ...makeToolRow(2), status: "success", inputText: "done" },
      },
      { op: "state.updated", patch: { revision: 3, inputRouting: { mode: "startNow" } } },
      { op: "row.removed", fromRowId: 2 },
      { op: "row.appended", row: makeAssistantRow(5, "rerun") },
      // 缺失 row 与不适用 path 都必须保持 no-op。
      { op: "row.upserted", row: makeAssistantRow(99, "ghost") },
      { op: "row.delta", rowId: 5, path: "inputText", append: "ghost" },
    ];

    const expected = applyConversationDeltas(base, deltas);
    const accumulator = createMutableConversationSnapshotAccumulator(base);
    applyConversationDeltasMutable(accumulator, deltas);

    expect(accumulator.snapshot).toEqual(expected);
    expect([...accumulator.rowIndexById]).toEqual([
      [1, 0],
      [5, 1],
    ]);
    expect(base.rows.window).toEqual([]);
  });

  it("row.removed truncates from fromRowId and row.upserted on missing row is a no-op", () => {
    const base = makeSnapshot();
    const afterAppend = applyConversationDeltas(base, [
      { op: "row.appended", row: makeAssistantRow(1, "a") },
      { op: "row.appended", row: makeAssistantRow(2, "b") },
      { op: "row.appended", row: makeAssistantRow(3, "c") },
    ]);
    const truncated = applyConversationDeltas(afterAppend, [{ op: "row.removed", fromRowId: 2 }]);
    expect(truncated.rows.window.map((r) => r.rowId)).toEqual([1]);
    expect(truncated.rows.totalCount).toBe(1);
    expect(truncated.rows.firstRowId).toBe(1);

    // Bugfix 回归：从 active branch 首行裁剪后 rowId 分配仍继续递增，分页锚点必须
    // 先清空再由新分支首行建立，不能把 1..4 的空洞当成未加载历史。
    const removedFromHead = applyConversationDeltas(afterAppend, [
      { op: "row.removed", fromRowId: 1 },
    ]);
    expect(removedFromHead.rows).toEqual({ window: [], totalCount: 0, firstRowId: null });
    const rerun = applyConversationDeltas(removedFromHead, [
      { op: "row.appended", row: makeAssistantRow(5, "edited") },
    ]);
    expect(rerun.rows).toMatchObject({ totalCount: 1, firstRowId: 5 });
    expect(rerun.rows.window.map((row) => row.rowId)).toEqual([5]);

    // §4.3：patch 命中未加载 rowId = no-op
    const noop = applyConversationDeltas(truncated, [
      { op: "row.upserted", row: makeAssistantRow(99, "ghost") },
      { op: "row.delta", rowId: 42, path: "text", append: "ghost" },
    ]);
    expect(noop).toEqual(truncated);
  });

  it("state.updated replaces keys wholesale without deep merge", () => {
    const base = makeSnapshot();
    const next = applyConversationDeltas(base, [
      {
        op: "state.updated",
        patch: {
          control: {
            ...base.control,
            phase: "completedInterrupted",
            sessionEnded: true,
            canStop: false,
            stopState: "idle",
          },
        },
      },
    ]);
    expect(next.control.phase).toBe("completedInterrupted");
    // 其他 A 区键不受影响
    expect(next.config).toEqual(base.config);
  });
});

describe("zcode-protocol-v4 schema", () => {
  it("validates a full snapshot round-trip", () => {
    const snapshot = applyConversationDeltas(makeSnapshot(), [
      { op: "row.appended", row: makeAssistantRow(1, "hello") },
    ]);
    const parsed = conversationSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed).toEqual(snapshot);
  });

  it("BG27/BG28：snapshot round-trip 保留后台结果标题元数据", () => {
    const header: TurnHeaderRow = {
      rowId: 1,
      turnId: "background-turn",
      createdAt: 1000,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "backgroundResult",
      originMeta: {
        backgroundSource: "subagent",
        title: "Review background result rendering",
        workId: "agent-review",
      },
      state: "completedSuccess",
      startedAt: 1000,
      endedAt: 2000,
    };
    const snapshot = applyConversationDeltas(makeSnapshot(), [{ op: "row.appended", row: header }]);

    const parsed = conversationSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed.rows.window[0]).toEqual(header);
  });

  it("keeps structured userInput questions in snapshot round-trip", () => {
    const snapshot: ConversationSnapshot = {
      ...makeSnapshot(),
      pendingInteractions: [
        {
          interactionId: "ask-1",
          kind: "userInput",
          anchorRowId: 2,
          createdAt: 1000,
          payload: {
            kind: "userInput",
            prompt: "请选择实现形式",
            freeText: true,
            toolName: "AskUserQuestion",
            toolCallId: "tool-ask",
            traceId: "trace-ask",
            input: { questions: [] },
            schema: { toolName: "AskUserQuestion" },
            currentQuestionIndex: 1,
            answerDrafts: { answer_0: ["独立页面"] },
            questions: [
              {
                question: "你想把番茄钟做成什么形式？",
                header: "形式",
                options: [
                  {
                    value: "page",
                    label: "独立页面",
                    description: "通过导航访问",
                    preview: "新增 v4 页面入口",
                  },
                ],
              },
              {
                question: "默认时长是多少？",
                header: "时长",
                options: [{ value: "25", label: "25 分钟" }],
              },
            ],
          },
        },
      ],
    };

    const parsed = conversationSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    expect(parsed.pendingInteractions[0]).toMatchObject({
      kind: "userInput",
      payload: {
        toolName: "AskUserQuestion",
        currentQuestionIndex: 1,
        answerDrafts: { answer_0: ["独立页面"] },
      },
    });
    const payload = parsed.pendingInteractions[0]?.payload;
    expect(payload?.kind).toBe("userInput");
    if (payload?.kind === "userInput") {
      expect(payload.questions).toHaveLength(2);
      expect(payload.questions?.[0]).toMatchObject({
        question: "你想把番茄钟做成什么形式？",
        options: [
          {
            value: "page",
            label: "独立页面",
            description: "通过导航访问",
            preview: "新增 v4 页面入口",
          },
        ],
      });
    }
  });
});

describe("zcode-protocol-v4 conflation", () => {
  it("keeps only the latest item per key, ordered by last occurrence", () => {
    const items = [
      { id: "a", v: 1 },
      { id: "b", v: 1 },
      { id: "a", v: 2 },
      { id: "c", v: 1 },
      { id: "b", v: 2 },
    ];
    expect(conflateByKey(items, (i) => i.id)).toEqual([
      { id: "a", v: 2 },
      { id: "c", v: 1 },
      { id: "b", v: 2 },
    ]);
  });
});
