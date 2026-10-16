import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationFindIndex,
  findConversationMatchIndexByKey,
  getConversationFindMatchKey,
  resolveConversationFindActiveMatch,
  resolveSearchResultHighlightMatch,
} from "@/v4/conversationFindIndex.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

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

function turnHeader(rowId: number, turnId = "turn-1"): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    turnId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
  });
}

function userInput(rowId: number, text: string, turnId = "turn-1"): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    text,
    origin: "realUser",
  });
}

function assistantText(rowId: number, text: string, turnId = "turn-1"): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
  });
}

function reasoning(rowId: number, text: string): ReasoningRow {
  return baseRow<ReasoningRow>({
    rowId,
    kind: "reasoning",
    text,
    state: "complete",
  });
}

function toolCall(rowId: number, inputText: string): ToolCallRow {
  return baseRow<ToolCallRow>({
    rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName: "Read",
    status: "success",
    inputText,
  });
}

function units(rows: ConversationRow[]) {
  return buildConversationTurnRenderUnits(rows, { nowMs: 1_700_000_100_000 });
}

describe("buildConversationFindIndex", () => {
  it("indexes user and assistant body text in render order", () => {
    const index = buildConversationFindIndex(
      units([
        turnHeader(1),
        userInput(2, "Find alpha"),
        reasoning(3, "alpha in reasoning is ignored"),
        toolCall(4, "alpha in tool input is ignored"),
        assistantText(5, "assistant Alpha and alpha"),
      ]),
      "alpha",
    );

    expect(index.matches.map((match) => [match.rowId, match.rowKind, match.start])).toEqual([
      [2, "userInput", 5],
      [5, "assistantText", 10],
      [5, "assistantText", 20],
    ]);
    expect(index.matchCount).toBe(3);
  });

  it("uses non-overlapping case-insensitive matches", () => {
    const index = buildConversationFindIndex(
      units([turnHeader(1), assistantText(2, "BANANA banana")]),
      "ana",
    );

    expect(index.matches.map((match) => [match.start, match.end])).toEqual([
      [1, 4],
      [8, 11],
    ]);
  });

  it("feature enabled 时不索引隐藏的 code-comment 协议原文", () => {
    const directive =
      '::code-comment{title="Hidden title" body="Hidden body" file="src/main.ts"}';
    const renderUnits = units([
      turnHeader(1),
      assistantText(2, `visible text\n${directive}`),
    ]);

    expect(buildConversationFindIndex(renderUnits, "Hidden body").matchCount).toBe(1);
    expect(
      buildConversationFindIndex(renderUnits, "Hidden body", {
        projectAssistantCodeComments: true,
      }).matchCount,
    ).toBe(0);
    expect(
      buildConversationFindIndex(renderUnits, "visible", {
        projectAssistantCodeComments: true,
      }).matchCount,
    ).toBe(1);

    const failedUnits = units([
      turnHeader(3, "turn-failed"),
      assistantText(
        4,
        '::code-comment{title="Early title" body="Early hidden body" file="src/early.ts"}',
        "turn-failed",
      ),
      {
        ...assistantText(5, directive, "turn-failed"),
        state: "failed" as const,
      },
    ]);
    expect(
      buildConversationFindIndex(failedUnits, "Hidden title", {
        projectAssistantCodeComments: true,
      }).matchCount,
    ).toBe(1);
    expect(
      buildConversationFindIndex(failedUnits, "Early hidden body", {
        projectAssistantCodeComments: true,
      }).matchCount,
    ).toBe(1);
  });

  it("rebases an active match after older rows are prepended", () => {
    const initial = buildConversationFindIndex(
      units([
        turnHeader(10, "turn-2"),
        userInput(11, "current alpha", "turn-2"),
        assistantText(12, "answer alpha", "turn-2"),
      ]),
      "alpha",
    );
    const activeKey = getConversationFindMatchKey(
      resolveConversationFindActiveMatch(initial, 1),
    );
    const prepended = buildConversationFindIndex(
      units([
        turnHeader(1, "turn-1"),
        userInput(2, "older alpha", "turn-1"),
        assistantText(3, "older answer alpha", "turn-1"),
        turnHeader(10, "turn-2"),
        userInput(11, "current alpha", "turn-2"),
        assistantText(12, "answer alpha", "turn-2"),
      ]),
      "alpha",
    );

    expect(findConversationMatchIndexByKey(prepended, activeKey)).toBe(3);
  });
});

describe("resolveSearchResultHighlightMatch", () => {
  it("prefers the match whose source text contains the command center snippet", () => {
    const index = buildConversationFindIndex(
      units([
        turnHeader(1),
        userInput(2, "alpha first"),
        assistantText(3, "target snippet with alpha inside"),
      ]),
      "alpha",
    );

    expect(
      resolveSearchResultHighlightMatch(index, {
        requestId: 1,
        taskId: "task",
        workspacePath: "/repo",
        query: "alpha",
        snippet: "...target snippet with alpha...",
      })?.rowId,
    ).toBe(3);
  });
});
