import { describe, expect, it } from "vitest";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnitTypes.js";
import {
  isSameConversationLatestTurnSummary,
  resolveConversationLatestTurnSummary,
} from "@/v4/conversationTimelineLiveTail.js";

function unit(partial: Partial<ConversationTurnRenderUnit>): ConversationTurnRenderUnit {
  return { isRunning: false, ...partial } as ConversationTurnRenderUnit;
}

function answerRow(rowId: number, text: string, state: "streaming" | "complete" | "interrupted") {
  return {
    rowId,
    kind: "assistantText",
    text,
    state,
  } as ConversationTurnRenderUnit["latestAssistantTextRow"];
}

// Side Pane 完整视图浮窗：占位时长与回答气泡共用时间线最后一个回合（docs/ui/side-pane-full-view.md）。
describe("resolveConversationLatestTurnSummary", () => {
  it("returns an idle summary for an empty timeline", () => {
    expect(resolveConversationLatestTurnSummary([])).toEqual({
      turnKey: null,
      running: false,
      workDurationMs: undefined,
      answer: null,
    });
  });

  it("uses the running segment duration shown in the stream and hides the answer", () => {
    const summary = resolveConversationLatestTurnSummary([
      unit({ key: "turn-1", latestAssistantTextRow: answerRow(1, "old", "complete") }),
      unit({
        key: "turn-2",
        isRunning: true,
        latestAssistantTextRow: answerRow(5, "partial", "streaming"),
        workSegments: [
          { workStatus: { state: "completed", durationMs: 3_000 } },
          { workStatus: { state: "running", durationMs: 12_000 } },
        ] as ConversationTurnRenderUnit["workSegments"],
      }),
    ]);
    expect(summary).toEqual({
      turnKey: "turn-2",
      running: true,
      workDurationMs: 12_000,
      answer: null,
    });
  });

  it("reports the final answer only after the last turn completes", () => {
    expect(
      resolveConversationLatestTurnSummary([
        unit({ latestAssistantTextRow: answerRow(9, "done", "complete") }),
      ]).answer,
    ).toEqual({ rowId: 9, text: "done" });
    expect(
      resolveConversationLatestTurnSummary([
        unit({ latestAssistantTextRow: answerRow(9, "cut", "interrupted") }),
      ]).answer,
    ).toBeNull();
    expect(
      resolveConversationLatestTurnSummary([
        unit({ latestAssistantTextRow: answerRow(9, "   ", "complete") }),
      ]).answer,
    ).toBeNull();
  });

  it("compares summaries by value", () => {
    const a = { turnKey: "turn-1", running: true, workDurationMs: 1_000, answer: null };
    expect(isSameConversationLatestTurnSummary(a, { ...a })).toBe(true);
    expect(isSameConversationLatestTurnSummary(a, { ...a, workDurationMs: 2_000 })).toBe(false);
    expect(isSameConversationLatestTurnSummary(a, { ...a, turnKey: "turn-2" })).toBe(false);
  });
});
