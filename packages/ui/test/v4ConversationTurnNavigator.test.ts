import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import {
  buildConversationTurnNavigatorItems,
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  shouldHydrateConversationTurnNavigatorDirectory,
} from "@/v4/conversationTurnNavigatorHelpers.js";

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

function turnHeader(
  rowId: number,
  turnId: string,
  overrides: Partial<TurnHeaderRow> = {},
): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    turnId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
    activeMs: 1_000,
    ...overrides,
  });
}

function userInput(
  rowId: number,
  turnId: string,
  text: string,
  origin: UserInputRow["origin"] = "realUser",
  overrides: Partial<UserInputRow> = {},
): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    text,
    origin,
    ...overrides,
  });
}

function assistantText(rowId: number, turnId: string, text: string): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
  });
}

function reasoning(rowId: number, turnId: string, text: string): ReasoningRow {
  return baseRow<ReasoningRow>({
    rowId,
    turnId,
    kind: "reasoning",
    text,
    state: "complete",
  });
}

function compactMarker(rowId: number, turnId: string): TimelineMarkerRow {
  return baseRow<TimelineMarkerRow>({
    rowId,
    turnId,
    kind: "timelineMarker",
    lane: "assistantWork",
    marker: {
      type: "compact",
      origin: "manual",
      status: "success",
    },
  });
}

function units(rows: ConversationRow[]) {
  return buildConversationTurnRenderUnits(rows, { nowMs: 1_700_000_100_000 });
}

describe("conversation turn navigator helpers", () => {
  it("TN01/TN07：宽 conversation 允许探测完整目录，窄 conversation 零请求", () => {
    const base = {
      canLoadOlder: true,
      containerWidthPx: 864,
      hasLoadHandler: true,
      loadingOlder: false,
    };

    expect(
      shouldHydrateConversationTurnNavigatorDirectory({
        ...base,
        containerWidthPx: 863,
      }),
    ).toBe(false);
    expect(
      shouldHydrateConversationTurnNavigatorDirectory({
        ...base,
      }),
    ).toBe(true);
  });

  it("TN07：暂时失败只安排两次有界退避重试", () => {
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(1)).toBe(250);
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(2)).toBe(1_000);
    expect(resolveConversationTurnNavigatorHydrationRetryDelayMs(3)).toBeNull();
  });

  it("TN02/TN06：每条 realUser query 独立建项并共享所属 turn 的 assistant preview", () => {
    const items = buildConversationTurnNavigatorItems(
      units([
        turnHeader(1, "turn-1"),
        userInput(2, "turn-1", "Alpha query"),
        reasoning(3, "turn-1", "private reasoning should not leak"),
        assistantText(
          4,
          "turn-1",
          "Assistant paragraph one has the useful answer.\n\nAssistant paragraph two keeps more context.\n\nAssistant paragraph three should be trimmed.",
        ),
        userInput(5, "turn-1", "Guide query stays separate", "realUser", {
          guided: true,
        }),
        assistantText(6, "turn-1", "Guide answer must not enter preview"),
        compactMarker(7, "marker-only"),
        turnHeader(8, "turn-2", { state: "running", activeMs: undefined }),
        userInput(9, "turn-2", "Gamma running query"),
      ]),
      {
        assistantEmptyPreview: "No assistant text yet",
        assistantRunningPreview: "Assistant is still working",
        maxPreviewChars: 88,
        maxPreviewParagraphs: 2,
        userFallbackPreview: "User turn",
      },
    );

    expect(items.map((item) => item.turnId)).toEqual(["turn-1", "turn-1", "turn-2"]);
    expect(items[0]).toMatchObject({
      unitIndex: 0,
      rowId: 2,
      userPreview: "Alpha query",
      assistantPreviewKind: "text",
      isRunning: false,
    });
    expect(items[1]).toMatchObject({
      unitIndex: 0,
      rowId: 5,
      userPreview: "Guide query stays separate",
      assistantPreviewKind: "text",
      isRunning: false,
    });
    expect(items[2]).toMatchObject({
      unitIndex: 2,
      rowId: 9,
      userPreview: "Gamma running query",
      assistantPreview: "Assistant is still working",
      assistantPreviewKind: "running",
      isRunning: true,
    });
    expect(items[0]?.assistantPreview).toContain("Assistant paragraph one");
    expect(items[0]?.assistantPreview).toContain("Assistant paragraph two");
    expect(items[0]?.assistantPreview).not.toContain("private reasoning");
    expect(items[1]?.assistantPreview).toBe(items[0]?.assistantPreview);
    expect(items.map((item) => item.userPreview).join(" ")).not.toContain("Assistant paragraph");
    expect(new Set(items.map((item) => item.key)).size).toBe(3);
  });

  it("TN05：只为 realUser turn 建目录，排除 assistant-only 与系统 role=user", () => {
    const items = buildConversationTurnNavigatorItems(
      units([
        assistantText(1, "turn-restored", "Restored assistant only body"),
        turnHeader(2, "turn-background", { origin: "backgroundResult" }),
        userInput(3, "turn-background", "system background payload", "backgroundResult"),
        assistantText(4, "turn-background", "Background result"),
        turnHeader(5, "turn-goal", { origin: "goalContinuation" }),
        userInput(6, "turn-goal", "continue goal", "goalContinuation"),
        assistantText(7, "turn-goal", "Goal result"),
        turnHeader(8, "turn-mailbox"),
        userInput(9, "turn-mailbox", "mailbox payload", "mailbox"),
        assistantText(10, "turn-mailbox", "Mailbox result"),
        turnHeader(11, "turn-real"),
        userInput(12, "turn-real", "Actual user query"),
        assistantText(13, "turn-real", "Actual answer"),
      ]),
      {
        assistantEmptyPreview: "No assistant text yet",
        assistantRunningPreview: "Assistant is still working",
        userFallbackPreview: "User turn",
      },
    );

    expect(items).toEqual([
      expect.objectContaining({
        turnId: "turn-real",
        rowId: 12,
        userPreview: "Actual user query",
        assistantPreview: "Actual answer",
      }),
    ]);
  });

  it("resolves the active turn from the currently visible virtual rows", () => {
    const items = [
      { key: "turn-1", turnId: "turn-1", unitIndex: 0 },
      { key: "turn-2", turnId: "turn-2", unitIndex: 4 },
      { key: "turn-3", turnId: "turn-3", unitIndex: 7 },
    ].map((item) => ({
      ...item,
      assistantPreview: "answer",
      assistantPreviewKind: "text" as const,
      isRunning: false,
      rowId: item.unitIndex + 10,
      userPreview: item.turnId,
    }));

    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 390,
        viewportHeightPx: 360,
        virtualItems: [
          { index: 4, start: 360, size: 220 },
          { index: 7, start: 760, size: 160 },
        ],
      }),
    ).toBe(4);
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 650,
        viewportHeightPx: 280,
        virtualItems: [
          { index: 5, start: 610, size: 120 },
          { index: 6, start: 730, size: 80 },
        ],
      }),
    ).toBe(7);
    expect(
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx: 0,
        viewportHeightPx: 400,
        virtualItems: [],
      }),
    ).toBe(0);
  });

  it("TN06：同一 turn 内根据可见 row 锚点解析 active query", () => {
    expect(
      resolveConversationTurnNavigatorActiveQueryRowId({
        positions: [
          { rowId: 11, start: 80, end: 140 },
          { rowId: 12, start: 360, end: 420 },
          { rowId: 13, start: 700, end: 760 },
        ],
        scrollOffsetPx: 330,
        viewportHeightPx: 300,
      }),
    ).toBe(12);
    expect(
      resolveConversationTurnNavigatorActiveQueryRowId({
        positions: [
          { rowId: 11, start: 80, end: 140 },
          { rowId: 12, start: 360, end: 420 },
          { rowId: 13, start: 700, end: 760 },
        ],
        scrollOffsetPx: 520,
        viewportHeightPx: 120,
      }),
    ).toBe(12);
  });
});
