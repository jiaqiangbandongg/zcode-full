import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnRenderUnits,
  resolveNextHighspeedExpiryMs,
} from "@/v4/conversationTurnRenderUnits.js";
import { resolveAssistantCopyText } from "@/v4/ConversationTurnRow.js";

function baseRow<T extends ConversationRow>(
  row: Omit<T, "createdAt" | "createdAtSeq" | "rowId" | "turnId"> & {
    rowId: number;
    turnId?: string;
  },
): T {
  return {
    createdAt: 1_700_000_000_000 + row.rowId,
    createdAtSeq: row.rowId,
    turnId: row.turnId ?? "turn-1",
    ...row,
  } as T;
}

function turnHeader(rowId: number, overrides: Partial<TurnHeaderRow> = {}): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
    activeMs: 11_000,
    ...overrides,
  });
}

function userInput(
  rowId: number,
  text: string,
  overrides: Partial<UserInputRow> = {},
): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    kind: "userInput",
    text,
    origin: "realUser",
    ...overrides,
  });
}

function reasoning(
  rowId: number,
  text = "thinking",
  overrides: Partial<ReasoningRow> = {},
): ReasoningRow {
  return baseRow<ReasoningRow>({
    rowId,
    kind: "reasoning",
    text,
    state: "complete",
    ...overrides,
  });
}

function toolCall(
  rowId: number,
  toolName = "Read",
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return baseRow<ToolCallRow>({
    rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName,
    status: "success",
    inputText: "{}",
    ...overrides,
  });
}

function subagent(rowId: number, overrides: Partial<SubagentRow> = {}): SubagentRow {
  return baseRow<SubagentRow>({
    rowId,
    kind: "subagent",
    subagentType: "general-purpose",
    status: "success",
    summaryText: "subagent work",
    ...overrides,
  });
}

function assistantText(
  rowId: number,
  text: string,
  overrides: Partial<AssistantTextRow> = {},
): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    kind: "assistantText",
    text,
    state: "complete",
    ...overrides,
  });
}

function hookInvocation(
  rowId: number,
  overrides: Partial<HookInvocationRow> = {},
): HookInvocationRow {
  return baseRow<HookInvocationRow>({
    rowId,
    kind: "hookInvocation",
    hookInvocationId: `hook-invocation-${rowId}`,
    hookEventName: "UserPromptSubmit",
    hookCount: 1,
    state: "completed",
    startedAt: 1_700_000_000_000 + rowId,
    endedAt: 1_700_000_000_010 + rowId,
    durationMs: 10,
    lane: "assistantWork",
    executions: [
      {
        hookRunId: `hook-run-${rowId}`,
        hookIndex: 0,
        didExecute: true,
        state: "completed",
        outcome: "success",
        startedAt: 1_700_000_000_000 + rowId,
        endedAt: 1_700_000_000_010 + rowId,
        durationMs: 10,
        displayName: "prepare-context",
        sourceKind: "user",
      },
    ],
    ...overrides,
  });
}

function compactMarker(
  rowId: number,
  overrides: Partial<TimelineMarkerRow> = {},
): TimelineMarkerRow {
  return baseRow<TimelineMarkerRow>({
    rowId,
    kind: "timelineMarker",
    lane: "assistantWork",
    marker: {
      type: "compact",
      origin: "manual",
      status: "success",
    },
    ...overrides,
  });
}

function forkNoticeMarker(rowId: number): TimelineMarkerRow {
  return baseRow<TimelineMarkerRow>({
    rowId,
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: "sess_parent",
      parentRowId: 1,
    },
  });
}

function modelChangeMarker(
  rowId: number,
  overrides: Partial<TimelineMarkerRow> = {},
): TimelineMarkerRow {
  return baseRow<TimelineMarkerRow>({
    rowId,
    kind: "timelineMarker",
    lane: "lightBoundary",
    marker: {
      type: "modelChange",
      fromProvider: "p1",
      fromModel: "m1",
      toProvider: "p2",
      toModel: "m2",
      toThought: "",
    },
    ...overrides,
  });
}

function goalVerifyMarker(rowId: number): TimelineMarkerRow {
  return baseRow<TimelineMarkerRow>({
    rowId,
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "goalVerify",
      iteration: 1,
      outcome: "pass",
    },
  });
}

describe("buildConversationTurnRenderUnits", () => {
  it("同一张 Highspeed 卡的多轮 output 只在组尾标记一次 footer，不同卡分别标记", () => {
    const card = (cardId: string) => ({
      schemaVersion: 1 as const,
      cardId,
      taskId: "session-highspeed-group",
      provider: "zai",
      model: "glm-5",
      issuedAt: 1_000,
      expiresAt: 10_000,
    });
    const rows = [
      turnHeader(1, { turnId: "turn-card-a-1" }),
      userInput(2, "A1", { turnId: "turn-card-a-1", highspeed: card("card-a") }),
      assistantText(3, "A1 output", { turnId: "turn-card-a-1" }),
      turnHeader(4, { turnId: "turn-card-a-2" }),
      userInput(5, "A2", { turnId: "turn-card-a-2", highspeed: card("card-a") }),
      assistantText(6, "A2 output", { turnId: "turn-card-a-2" }),
      turnHeader(7, { turnId: "turn-ordinary" }),
      userInput(8, "ordinary", { turnId: "turn-ordinary" }),
      assistantText(9, "ordinary output", { turnId: "turn-ordinary" }),
      turnHeader(10, { turnId: "turn-card-b-1" }),
      userInput(11, "B1", { turnId: "turn-card-b-1", highspeed: card("card-b") }),
      assistantText(12, "B1 output", { turnId: "turn-card-b-1" }),
      turnHeader(13, { turnId: "turn-card-b-2" }),
      userInput(14, "B2", { turnId: "turn-card-b-2", highspeed: card("card-b") }),
      assistantText(15, "B2 output", { turnId: "turn-card-b-2" }),
    ];
    const activeUnits = buildConversationTurnRenderUnits(rows, { nowMs: 9_999 });
    const units = buildConversationTurnRenderUnits(rows, { nowMs: 10_000 });

    expect(activeUnits.every((unit) => unit.showHighspeedOutputFooter !== true)).toBe(true);
    expect(resolveNextHighspeedExpiryMs(rows, 9_999)).toBe(10_000);
    expect(resolveNextHighspeedExpiryMs(rows, 10_000)).toBeUndefined();

    expect(
      units.map((unit) => ({
        turnId: unit.turnId,
        showHighspeedOutputFooter: unit.showHighspeedOutputFooter === true,
      })),
    ).toEqual([
      { turnId: "turn-card-a-1", showHighspeedOutputFooter: false },
      { turnId: "turn-card-a-2", showHighspeedOutputFooter: true },
      { turnId: "turn-ordinary", showHighspeedOutputFooter: false },
      { turnId: "turn-card-b-1", showHighspeedOutputFooter: false },
      { turnId: "turn-card-b-2", showHighspeedOutputFooter: true },
    ]);
  });

  it.each(["completedInterrupted", "failed"] as const)(
    "Highspeed 组尾进入 %s 后仍标记 footer",
    (state) => {
      const units = buildConversationTurnRenderUnits(
        [
          turnHeader(1, { state }),
          userInput(2, "加速输出", {
            highspeed: {
              schemaVersion: 1,
              cardId: "card-terminal",
              taskId: "session-terminal",
              provider: "zai",
              model: "glm-5",
              issuedAt: 1_000,
              expiresAt: 10_000,
              regularTps: 20,
              highspeedTps: 50,
              outputTokens: 10,
              durationMs: 200,
            },
          }),
          assistantText(3, "已有输出", { state: "interrupted" }),
        ],
        { nowMs: 10_000 },
      );

      expect(units[0]?.showHighspeedOutputFooter).toBe(true);
    },
  );

  it("最后一轮无输出但同卡前序轮有输出时，footer 留在最后一轮并聚合整卡分享指标", () => {
    const card = {
      schemaVersion: 1 as const,
      cardId: "card-partial-final",
      taskId: "session-partial-final",
      provider: "zai",
      model: "glm-5",
      issuedAt: 1_000,
      expiresAt: 10_000,
      regularTps: 20,
      highspeedTps: 50,
    };
    const units = buildConversationTurnRenderUnits(
      [
        turnHeader(1, { turnId: "turn-output" }),
        userInput(2, "先产生输出", {
          turnId: "turn-output",
          highspeed: { ...card, outputTokens: 10, durationMs: 200 },
        }),
        assistantText(3, "已有输出", { turnId: "turn-output" }),
        turnHeader(4, { turnId: "turn-stopped", state: "completedInterrupted" }),
        userInput(5, "立即暂停", {
          turnId: "turn-stopped",
          highspeed: { ...card, outputTokens: 0, durationMs: 100 },
        }),
      ],
      { nowMs: 10_000 },
    );

    expect(units[0]?.showHighspeedOutputFooter).not.toBe(true);
    expect(units[1]?.showHighspeedOutputFooter).toBe(true);
    expect(units[1]?.highspeedOutputFooterTarget).toEqual({
      cardId: "card-partial-final",
      metrics: {
        outputTokens: 10,
        durationMs: 300,
        regularTps: 20,
        highspeedTps: 50,
        savedDurationMs: 277,
      },
    });
  });

  it("整张 Highspeed 卡没有任何 output 时不标记 footer", () => {
    const units = buildConversationTurnRenderUnits(
      [
        turnHeader(1, { state: "completedInterrupted" }),
        userInput(2, "立即暂停", {
          highspeed: {
            schemaVersion: 1,
            cardId: "card-empty",
            taskId: "session-empty",
            provider: "zai",
            model: "glm-5",
            issuedAt: 1_000,
            expiresAt: 10_000,
            regularTps: 20,
            highspeedTps: 50,
            outputTokens: 0,
            durationMs: 100,
          },
        }),
      ],
      { nowMs: 10_000 },
    );

    expect(units[0]?.showHighspeedOutputFooter).not.toBe(true);
  });

  it("HK08 extracts Hook summaries from assistant work without losing turn ownership", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "运行"),
      reasoning(3),
      hookInvocation(4),
      assistantText(5, "完成"),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.hookInvocations.map((row) => row.rowId)).toEqual([4]);
    expect(units[0]?.assistantWorkRows.map((row) => row.rowId)).toEqual([3, 5]);
    expect(units[0]?.flowItems.flatMap((item) => ("rows" in item ? item.rows : []))).not.toContain(
      expect.objectContaining({ kind: "hookInvocation" }),
    );
  });

  it("HK09 keeps a turn but exposes no executable Hook when every execution was admission-blocked", () => {
    const blocked = hookInvocation(3, {
      executions: [
        {
          hookRunId: "blocked-before-start",
          hookIndex: 0,
          didExecute: false,
          state: "completed",
          outcome: "blocked",
          startedAt: 1_700_000_000_003,
          endedAt: 1_700_000_000_003,
          durationMs: 0,
          displayName: "blocked-project-hook",
          sourceKind: "project",
        },
      ],
    });
    const units = buildConversationTurnRenderUnits([turnHeader(1), userInput(2, "运行"), blocked]);

    expect(units).toHaveLength(1);
    expect(units[0]?.hookInvocations).toEqual([blocked]);
    expect(units[0]?.assistantWorkRows).toEqual([]);
  });

  it("HLP01：同一 turn 补到 header 前后保持稳定 key", () => {
    const partial = buildConversationTurnRenderUnits([
      assistantText(3, "尾窗先看到回答", { turnId: "turn-long" }),
    ]);
    const complete = buildConversationTurnRenderUnits([
      turnHeader(1, { turnId: "turn-long" }),
      userInput(2, "长问题", { turnId: "turn-long" }),
      assistantText(3, "尾窗先看到回答", { turnId: "turn-long" }),
    ]);

    expect(partial[0]?.key).toBe("turn-long");
    expect(complete[0]?.key).toBe(partial[0]?.key);
  });

  it("groups a visible user query with assistant work and hides turnHeader rows", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "研究这个项目"),
      reasoning(3),
      toolCall(4),
      assistantText(5, "这是项目说明"),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.visibleUserInputs.map((row) => row.text)).toEqual(["研究这个项目"]);
    expect(units[0]?.assistantWorkRows.map((row) => row.kind)).toEqual([
      "reasoning",
      "toolCall",
      "assistantText",
    ]);
    expect(units[0]?.renderRows.map((row) => row.kind)).not.toContain("turnHeader");
  });

  it("hides completed reasoning rows whose text is empty or whitespace-only", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "继续"),
      reasoning(3, ""),
      reasoning(4, " \n\t"),
      reasoning(5, "保留这段思考"),
    ]);

    expect(units[0]?.assistantWorkRows.map((row) => row.rowId)).toEqual([5]);
    expect(units[0]?.renderRows.map((row) => row.rowId)).toEqual([2, 5]);
  });

  it("keeps latest assistant text visible and collapses previous work for completed non-last turns", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { turnId: "turn-1", activeMs: 9_000 }),
      userInput(2, "执行下 pwd", { turnId: "turn-1" }),
      reasoning(3, "思考", { turnId: "turn-1" }),
      toolCall(4, "Bash", { turnId: "turn-1" }),
      assistantText(5, "/Users/dev", { turnId: "turn-1" }),
      turnHeader(6, { turnId: "turn-2", state: "running" }),
      userInput(7, "继续", { turnId: "turn-2" }),
    ]);

    expect(units).toHaveLength(2);
    expect(units[0]?.assistantHistoryRows.map((row) => row.kind)).toEqual([
      "reasoning",
      "toolCall",
    ]);
    expect(units[0]?.latestAssistantTextRow?.text).toBe("/Users/dev");
    expect(units[0]?.assistantHistoryDefaultOpen).toBe(false);
    expect(units[0]?.workStatus?.durationMs).toBe(9_000);
  });

  it("forces assistant history open for the last running turn", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { state: "running", activeMs: 2_000 }),
      userInput(2, "跑测试"),
      reasoning(3, "思考中"),
      toolCall(4, "Bash"),
    ]);

    expect(units[0]?.isLastTurn).toBe(true);
    expect(units[0]?.isRunning).toBe(true);
    expect(units[0]?.assistantHistoryDefaultOpen).toBe(true);
    expect(units[0]?.latestAssistantTextRow).toBeUndefined();
  });

  it.each(["completedInterrupted", "failed"] as const)(
    "forces assistant history open for an abnormal %s turn with partial assistant text",
    (state) => {
      const units = buildConversationTurnRenderUnits([
        turnHeader(1, { state }),
        userInput(2, "执行任务"),
        reasoning(3, "处理中"),
        assistantText(4, "未完成的部分结果", {
          state: state === "completedInterrupted" ? "interrupted" : "failed",
        }),
      ]);

      expect(units[0]?.latestAssistantTextRow?.rowId).toBe(4);
      expect(units[0]?.assistantHistoryDefaultOpen).toBe(true);
      expect(units[0]?.workSegments?.[0]?.assistantHistoryDefaultOpen).toBe(true);
      expect(units[0]?.workSegments?.[0]?.workStatus?.state).toBe(
        state === "completedInterrupted" ? "interrupted" : "completed",
      );
    },
  );

  it("forces assistant history open for an error session when a cold tail omits turnHeader", () => {
    const units = buildConversationTurnRenderUnits(
      [
        userInput(1, "执行任务"),
        reasoning(2, "处理中"),
        assistantText(3, "失败前的部分结果", { state: "failed" }),
      ],
      { sessionPhase: "error" },
    );

    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(3);
    expect(units[0]?.assistantHistoryDefaultOpen).toBe(true);
    expect(units[0]?.workSegments?.[0]?.assistantHistoryDefaultOpen).toBe(true);
  });

  it("keeps normally completed history collapsible when final assistant text exists", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { state: "completedSuccess" }),
      userInput(2, "执行任务"),
      reasoning(3, "处理完成"),
      assistantText(4, "最终结果"),
    ]);

    expect(units[0]?.assistantHistoryDefaultOpen).toBe(false);
    expect(units[0]?.workSegments?.[0]?.assistantHistoryDefaultOpen).toBe(false);
  });

  it("不按 raw /compact 文本隐藏 CLI 标记为 visible 的 user input", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "/compact keep recent files"),
      compactMarker(3),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.visibleUserInputs.map((row) => row.rowId)).toEqual([2]);
    expect(units[0]?.assistantWorkRows.map((row) => row.kind)).toEqual(["timelineMarker"]);
    expect(units[0]?.timelineOnly).toBe(false);
    expect(units[0]?.assistantHistoryDefaultOpen).toBe(true);
  });

  it("跨 turn compact marker 也不授权 UI 嗅探并隐藏 raw /compact user input", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { turnId: "turn-user" }),
      userInput(2, "/compact", { turnId: "turn-user" }),
      compactMarker(3, { turnId: "turn-compact" }),
    ]);

    expect(units).toHaveLength(2);
    expect(units[0]?.visibleUserInputs.map((row) => row.rowId)).toEqual([2]);
    expect(units[0]?.timelineOnly).toBe(false);
    expect(units[1]?.assistantWorkRows.map((row) => row.rowId)).toEqual([3]);
  });

  it("renders standalone compact markers as timeline-only units without work history chrome", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { turnId: "turn-1", activeMs: 9_000 }),
      userInput(2, "先介绍项目", { turnId: "turn-1" }),
      assistantText(3, "这是项目", { turnId: "turn-1" }),
      compactMarker(4, { turnId: "turn-compact" }),
    ]);

    expect(units).toHaveLength(2);
    expect(units[0]?.timelineOnly).toBe(false);
    expect(units[1]?.visibleUserInputs).toEqual([]);
    expect(units[1]?.assistantWorkRows.map((row) => row.rowId)).toEqual([4]);
    expect(units[1]?.timelineOnly).toBe(true);
    expect(units[1]?.assistantHistoryRows).toEqual([]);
    expect(units[1]?.assistantHistoryDefaultOpen).toBe(false);
  });

  // 「hidden marker 不进 rows」的守恒已下沉到投影层（S7/S9/S10 隐形行清零，
  // bootstrap 侧 golden 覆盖）：UI 不再拥有「哪些 marker 可渲染」的判断，
  // 收到的每一行都视为可渲染。此处仅验证 lane 缺省的兜底（降级进工作组，不丢行）。
  it("keeps lane-less marker rows by folding them into the work group (degrade, not drop)", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "问题"),
      compactMarker(3, { lane: undefined }),
      assistantText(4, "回答"),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3]);
    expect(units[0]?.assistantTextRows.map((row) => row.rowId)).toEqual([4]);
  });

  // S2（16-plan，2026-07-09 顺序纠偏）：已工作只折叠非最终内容；
  // 展开时早段 text 与工具/思考必须保持 row 全序，不能被分桶搬到工具之后。
  it("keeps non-terminal assistant text in folded history order before the final text (S2)", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "继续检查"),
      reasoning(3, "先确认上下文"),
      assistantText(4, "中间结论"),
      toolCall(5, "Agent"),
      assistantText(6, "最终结论"),
      forkNoticeMarker(7),
    ]);

    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(6);
    // 单个「已工作」控件折叠的是最终正文之前的全部 row，展开顺序仍是 row 全序。
    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3, 4, 5]);
    expect(units[0]?.assistantTextRows.map((row) => row.rowId)).toEqual([4, 6]);
    expect(units[0]?.assistantTailRows.map((row) => row.rowId)).toEqual([7]);
  });

  it("P06：同一 turn 的 guided user 保持 CLI 全序并开启独立视觉工作段", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, {
        workSegments: [
          {
            segmentId: "initial",
            startedAt: 1_700_000_000_001,
            endedAt: 1_700_000_000_005,
            activeMs: 4,
          },
          {
            segmentId: "guide-1",
            triggerEntityId: "guide-1",
            startedAt: 1_700_000_000_005,
            endedAt: 1_700_000_000_007,
            activeMs: 2,
          },
          {
            segmentId: "guide-2",
            triggerEntityId: "guide-2",
            startedAt: 1_700_000_000_007,
            endedAt: 1_700_000_000_008,
            activeMs: 1,
          },
        ],
      }),
      userInput(2, "这是个啥项目"),
      reasoning(3, "先检查项目"),
      toolCall(4, "Read"),
      userInput(5, "111", { guided: true, entityId: "guide-1" }),
      assistantText(6, "这是项目介绍"),
      userInput(7, "11", { guided: true, entityId: "guide-2" }),
      assistantText(8, "还需要我做什么？"),
    ]);

    expect(units[0]?.renderRows.map((row) => row.rowId)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3, 4]);
    expect(
      units[0]?.flowItems.map((item) =>
        item.kind === "userInput" || item.kind === "assistantText"
          ? `${item.kind}:${item.row.rowId}`
          : `${item.kind}:${item.rows.map((row) => row.rowId).join(",")}`,
      ),
    ).toEqual([
      "userInput:2",
      "assistantHistory:3,4",
      "userInput:5",
      "assistantText:6",
      "userInput:7",
      "assistantText:8",
    ]);
    expect(units[0]?.flowItems.at(-1)).toMatchObject({
      kind: "assistantText",
      latest: true,
    });
    expect(
      units[0]?.workSegments?.map((segment) => ({
        key: segment.key,
        durationMs: segment.workStatus?.durationMs,
        itemKinds: segment.flowItems.map((item) => item.kind),
      })),
    ).toEqual([
      {
        key: "turn-1",
        durationMs: 4,
        itemKinds: ["userInput", "assistantHistory"],
      },
      {
        key: "turn-1:guide:guide-1",
        durationMs: 2,
        itemKinds: ["userInput", "assistantText"],
      },
      {
        key: "turn-1:guide:guide-2",
        durationMs: 1,
        itemKinds: ["userInput", "assistantText"],
      },
    ]);
  });

  it("P06：运行中 accepted guide 收口旧工作段并只展开新工作段", () => {
    const units = buildConversationTurnRenderUnits(
      [
        turnHeader(1, {
          state: "running",
          startedAt: 1_700_000_000_000,
          workSegments: [
            {
              segmentId: "initial",
              startedAt: 1_700_000_000_000,
              endedAt: 1_700_000_003_000,
              activeMs: 3_000,
            },
            {
              segmentId: "guide-live",
              triggerEntityId: "guide-live",
              startedAt: 1_700_000_003_000,
            },
          ],
        }),
        userInput(2, "先检查项目"),
        reasoning(3, "旧段工作"),
        userInput(4, "再看看测试", { guided: true, entityId: "guide-live" }),
        reasoning(5, "新段工作", { state: "streaming" }),
      ],
      { nowMs: 1_700_000_005_000 },
    );

    expect(
      units[0]?.workSegments?.map((segment) => ({
        state: segment.workStatus?.state,
        durationMs: segment.workStatus?.durationMs,
        open: segment.assistantHistoryDefaultOpen,
      })),
    ).toEqual([
      { state: "completed", durationMs: 3_000, open: false },
      { state: "running", durationMs: 2_000, open: true },
    ]);
  });

  it("keeps non-suffix fork and goal verification markers in row order", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "继续检查"),
      assistantText(3, "中间结论"),
      forkNoticeMarker(4),
      goalVerifyMarker(5),
      assistantText(6, "最终结论"),
    ]);

    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(6);
    // S12：只有连续后缀 marker 属于轮尾，中间 marker 不能被跨行搬运。
    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3, 4, 5]);
    expect(units[0]?.assistantTextRows.map((row) => row.rowId)).toEqual([3, 6]);
    expect(units[0]?.assistantFollowingRows).toEqual([]);
    expect(units[0]?.assistantTailRows).toEqual([]);
  });

  it("keeps ExitPlanMode cards at their original tool row after assistant text", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { state: "completedInterrupted" }),
      userInput(2, "直接写计划"),
      reasoning(3, "整理计划"),
      assistantText(4, "好，直接写计划。", {
        actions: { canRetry: true },
      }),
      toolCall(5, "ExitPlanMode", {
        input: { plan: "# 计划\n\n第一步" },
        status: "cancelled",
      }),
    ]);

    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(4);
    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3]);
    expect(units[0]?.assistantFollowingRows.map((row) => row.rowId)).toEqual([5]);
    expect(units[0]?.assistantTailRows).toEqual([]);
  });

  it("does not render EnterPlanMode tool rows in the assistant work stream", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "先进入计划模式"),
      reasoning(3, "先梳理实现边界"),
      toolCall(4, "EnterPlanMode"),
      assistantText(5, "我会先检查现有实现。"),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.assistantWorkRows.map((row) => row.rowId)).toEqual([3, 5]);
    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3]);
    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(5);
    expect(units[0]?.renderRows.map((row) => row.rowId)).toEqual([2, 3, 5]);
  });

  it("keeps turn running state while EnterPlanMode itself stays hidden", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { state: "running", activeMs: 2_000 }),
      userInput(2, "先进入计划模式"),
      toolCall(3, "EnterPlanMode", { status: "running" }),
    ]);

    expect(units[0]?.assistantWorkRows).toEqual([]);
    expect(units[0]?.isRunning).toBe(true);
    expect(units[0]?.workStatus?.state).toBe("running");
  });

  it("keeps assistant, plan, tool, reasoning, and later assistant in strict row order", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "直接写计划"),
      assistantText(3, "我先整理计划"),
      toolCall(4, "ExitPlanMode", {
        input: { plan: "# 实施计划" },
        status: "success",
      }),
      toolCall(5, "Write"),
      reasoning(6, "检查写入结果"),
      assistantText(7, "计划已保存"),
      goalVerifyMarker(8),
    ]);

    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3, 4, 5, 6]);
    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(7);
    expect(units[0]?.assistantFollowingRows).toEqual([]);
    expect(units[0]?.assistantTailRows.map((row) => row.rowId)).toEqual([8]);
  });

  it("appends the complete ExitPlanMode markdown to the turn copy text", () => {
    const plan = "# 太阳系公转轨道动画 — 实现计划\n\n## 概述\n\n完整计划正文";
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { state: "completedInterrupted" }),
      userInput(2, "直接写计划"),
      toolCall(3, "Read", {
        inputText: JSON.stringify({ file_path: "/workspace/README.md" }),
        output: { text: "普通工具输出不能进入复制内容" },
      }),
      assistantText(4, "好的，直接写计划！", {
        actions: { canRetry: true },
      }),
      toolCall(5, "ExitPlanMode", {
        inputText: JSON.stringify({ plan }),
        status: "cancelled",
      }),
    ]);

    expect(resolveAssistantCopyText(units[0]!)).toBe(`好的，直接写计划！\n\n${plan}`);
    expect(resolveAssistantCopyText(units[0]!)).not.toContain("普通工具输出不能进入复制内容");
  });

  it("BTA01/BTA09：把 Browser 完成态截图单独放在轮尾内容分组", () => {
    const screenshot = toolCall(4, "mcp__node_repl__js", {
      input: { source: "browser_turn_end" },
      display: {
        kind: "node_repl_images",
        source: "browser_turn_end",
        images: [{ base64: "AAAA", mimeType: "image/png" }],
      },
    });
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "打开网页"),
      assistantText(3, "页面已经打开。"),
      screenshot,
    ]);

    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(3);
    expect(units[0]?.assistantHistoryRows).toEqual([]);
    expect(units[0]?.assistantTailRows).toEqual([]);
    expect(units[0]?.browserTurnEndRows.map((row) => row.rowId)).toEqual([4]);
  });

  it("keeps compact markers in the single folded work group; texts stay flat (S2/S6)", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "继续检查"),
      assistantText(3, "压缩前输出"),
      compactMarker(4),
      assistantText(5, "压缩后输出"),
    ]);

    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(5);
    // 一轮唯一「已工作」组：最终正文前的 text/compact 都进 history，展开按 row 全序。
    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3, 4]);
    expect(units[0]?.assistantTextRows.map((row) => row.rowId)).toEqual([3, 5]);
    expect(units[0]?.assistantTailRows).toEqual([]);
  });

  it("keeps streaming text before a following running tool when there is no final text yet", () => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { state: "running" }),
      userInput(2, "看看项目"),
      assistantText(3, "Let me看看这个项目里有什么。", { state: "complete" }),
      toolCall(4, "Bash", { status: "running" }),
    ]);

    expect(units[0]?.isRunning).toBe(true);
    expect(units[0]?.latestAssistantTextRow).toBeUndefined();
    expect(units[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3, 4]);
    expect(units[0]?.assistantTextRows.map((row) => row.rowId)).toEqual([3]);
  });

  it.each([
    ["tool", toolCall(3, "Agent", { status: "running", backgrounded: true })],
    ["subagent", subagent(3, { status: "running", backgrounded: true })],
  ] as const)("does not let a running background %s revive a terminal main turn", (_label, row) => {
    const units = buildConversationTurnRenderUnits([
      turnHeader(1, { state: "completedSuccess" }),
      userInput(2, "后台调研"),
      row,
      assistantText(4, "已经在后台运行。"),
    ]);

    expect(units[0]?.isRunning).toBe(false);
    expect(units[0]?.latestAssistantTextRow?.rowId).toBe(4);
  });

  it("ignores background-only rows in the headerless compatibility fallback", () => {
    const backgroundUnit = buildConversationTurnRenderUnits([
      subagent(1, { status: "running", backgrounded: true }),
    ])[0];
    const foregroundUnit = buildConversationTurnRenderUnits([
      subagent(2, { status: "running" }),
    ])[0];

    expect(backgroundUnit?.isRunning).toBe(false);
    expect(foregroundUnit?.isRunning).toBe(true);
  });

  it("lets terminal session phase dominate a headerless cold-tail tool row", () => {
    const rows = [toolCall(1, "Grep", { status: "inputStreaming" })];

    expect(buildConversationTurnRenderUnits(rows)[0]?.isRunning).toBe(true);
    expect(buildConversationTurnRenderUnits(rows, { sessionPhase: "running" })[0]?.isRunning).toBe(
      true,
    );
    expect(
      buildConversationTurnRenderUnits(rows, { sessionPhase: "completedSuccess" })[0]?.isRunning,
    ).toBe(false);
  });

  it("keeps turnHeader authoritative over stale running work rows", () => {
    const terminalUnit = buildConversationTurnRenderUnits([
      turnHeader(1, { state: "completedSuccess" }),
      toolCall(2, "Bash", { status: "running" }),
    ])[0];
    const runningUnit = buildConversationTurnRenderUnits([
      turnHeader(3, { state: "running" }),
      subagent(4, { status: "running", backgrounded: true }),
    ])[0];

    expect(terminalUnit?.isRunning).toBe(false);
    expect(runningUnit?.isRunning).toBe(true);
  });

  it("hoists modelChange markers to leading boundary rows (S13), keeps them renderable", () => {
    const units = buildConversationTurnRenderUnits([
      modelChangeMarker(1, { turnId: "turn-2" }),
      turnHeader(2, { turnId: "turn-2" }),
      userInput(3, "换模型后的问题", { turnId: "turn-2" }),
      assistantText(4, "新模型的回答", { turnId: "turn-2" }),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.leadingBoundaryRows.map((row) => row.rowId)).toEqual([1]);
    // 轻边界不进工作组/history，不再是「渲染 null 的隐形行」。
    expect(units[0]?.assistantHistoryRows).toEqual([]);
    expect(units[0]?.assistantTextRows.map((row) => row.rowId)).toEqual([4]);
  });

  it("H17：controlOnly goal query 即使带 modelChange 和 0ms 也不派生工作状态", () => {
    const units = buildConversationTurnRenderUnits([
      modelChangeMarker(1, { turnId: "turn-goal" }),
      turnHeader(2, {
        turnId: "turn-goal",
        executionKind: "controlOnly",
        activeMs: 0,
      }),
      userInput(3, "/Goal 开发招投标系统", { turnId: "turn-goal" }),
      turnHeader(4, {
        turnId: "turn-continuation",
        origin: "goalContinuation",
        executionKind: "agent",
        state: "running",
        activeMs: undefined,
      }),
    ]);

    expect(units).toHaveLength(2);
    expect(units[0]?.leadingBoundaryRows.map((row) => row.rowId)).toEqual([1]);
    expect(units[0]?.assistantWorkRows).toEqual([]);
    expect(units[0]?.isRunning).toBe(false);
    expect(units[0]?.workStatus).toBeUndefined();
    expect(units[1]?.workStatus?.state).toBe("running");

    const legacy = buildConversationTurnRenderUnits([
      modelChangeMarker(5, { turnId: "turn-legacy-goal" }),
      turnHeader(6, { turnId: "turn-legacy-goal", activeMs: 0 }),
      userInput(7, "/Goal legacy", { turnId: "turn-legacy-goal" }),
    ]);
    expect(legacy[0]?.workStatus).toBeUndefined();
  });

  it("uses the live clock only for running work duration labels", () => {
    const completedStartedAt = 1_700_000_000_000;
    const runningStartedAt = 1_700_000_010_000;
    const units = buildConversationTurnRenderUnits(
      [
        turnHeader(1, {
          turnId: "turn-complete",
          activeMs: undefined,
          endedAt: undefined,
          startedAt: completedStartedAt,
          state: "completedSuccess",
        }),
        userInput(2, "先做完", { turnId: "turn-complete" }),
        assistantText(3, "完成了", { turnId: "turn-complete" }),
        turnHeader(4, {
          turnId: "turn-running",
          activeMs: undefined,
          endedAt: undefined,
          startedAt: runningStartedAt,
          state: "running",
        }),
        userInput(5, "继续跑", { turnId: "turn-running" }),
        reasoning(6, "还在处理", {
          state: "streaming",
          turnId: "turn-running",
        }),
      ],
      { nowMs: runningStartedAt + 5_000 },
    );

    expect(units[0]?.isRunning).toBe(false);
    expect(units[0]?.workStatus?.durationMs).toBeUndefined();
    expect(units[1]?.isRunning).toBe(true);
    expect(units[1]?.workStatus?.durationMs).toBe(5_000);
  });

  it("轮尾的 artifact 行不占用折叠锚点", () => {
    // Bug 根因：artifact 行是分享投影追加到轮尾的产出物，却同属 AssistantWorkRow，
    // 会成为 flow 最后一行。公开投影禁止 actions，分享页只剩「最后一行是 assistantText」
    // 这条兜底，于是最终答复被卷进「已工作」并整轮默认展开——任何带结果物的分享都中招。
    const artifactRow = {
      rowId: 6,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 6,
      createdAtSeq: 6,
      kind: "artifact" as const,
      artifactVersionId: "artifact-1",
      logicalArtifactKey: "report",
      displayName: "report.pdf",
      artifactType: "pdf" as const,
      mimeType: "application/pdf",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      ref: "zcode-artifact://share/artifact-1",
      state: "current" as const,
    };
    const [unit] = buildConversationTurnRenderUnits([
      turnHeader(1),
      userInput(2, "问题"),
      reasoning(3),
      toolCall(4),
      assistantText(5, "最终答复"),
      artifactRow,
    ] as never);

    expect(unit?.latestAssistantTextRow?.rowId).toBe(5);
    expect(unit?.assistantTailRows.map((row) => row.rowId)).toEqual([6]);
    expect(unit?.workSegments?.[0]?.assistantHistoryRows.map((row) => row.rowId)).toEqual([3, 4]);
    expect(unit?.workSegments?.[0]?.assistantHistoryDefaultOpen).toBe(false);
  });
});
