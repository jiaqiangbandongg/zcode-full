import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  createAssistantPreviewPptxAutoOpenGateState,
  resolveLatestCompletedAssistantPreviewTurn,
} from "@/v4/assistantPreviewPptxAutoOpen.js";

function completedRows(): ConversationRow[] {
  return [
    {
      rowId: 1,
      turnId: "turn-1",
      entityId: "header-1",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
      endedAt: 2,
    },
    {
      rowId: 2,
      turnId: "turn-1",
      entityId: "assistant-1",
      createdAt: 2,
      createdAtSeq: 2,
      kind: "assistantText",
      text: "生成 deck.pptx",
      state: "complete",
    },
  ];
}

describe("assistant PPTX auto-open gate", () => {
  it("只在观察到 running 后的 completedSuccess 触发一次", () => {
    let state = createAssistantPreviewPptxAutoOpenGateState();
    let result = advanceAssistantPreviewPptxAutoOpenGate(state, {
      enabled: true,
      scopeKey: "workspace\u0000session-a",
      logEpoch: "epoch-1",
      phase: "running",
      completedTurn: null,
    });
    state = result.state;
    expect(result.target).toBeNull();

    const completedTurn = resolveLatestCompletedAssistantPreviewTurn(completedRows());
    result = advanceAssistantPreviewPptxAutoOpenGate(state, {
      enabled: true,
      scopeKey: "workspace\u0000session-a",
      logEpoch: "epoch-1",
      phase: "completedSuccess",
      completedTurn,
    });
    state = result.state;
    expect(result.target).toEqual({
      turnId: "turn-1",
      key: '["workspace\\u0000session-a","epoch-1","turn-1",2,"assistant-1"]',
    });

    result = advanceAssistantPreviewPptxAutoOpenGate(state, {
      enabled: true,
      scopeKey: "workspace\u0000session-a",
      logEpoch: "epoch-1",
      phase: "completedSuccess",
      completedTurn,
    });
    expect(result.target).toBeUndefined();
  });

  it("phase 先完成、当前轮 assistant 行稍后到达时仍能触发", () => {
    let state = advanceAssistantPreviewPptxAutoOpenGate(
      createAssistantPreviewPptxAutoOpenGateState(),
      {
        enabled: true,
        scopeKey: "workspace\u0000session-a",
        logEpoch: "epoch-1",
        phase: "running",
        completedTurn: null,
      },
    ).state;

    const waiting = advanceAssistantPreviewPptxAutoOpenGate(state, {
      enabled: true,
      scopeKey: "workspace\u0000session-a",
      logEpoch: "epoch-1",
      phase: "completedSuccess",
      completedTurn: null,
    });
    state = waiting.state;
    expect(waiting.target).toBeUndefined();

    const ready = advanceAssistantPreviewPptxAutoOpenGate(state, {
      enabled: true,
      scopeKey: "workspace\u0000session-a",
      logEpoch: "epoch-1",
      phase: "completedSuccess",
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(completedRows()),
    });
    expect(ready.target?.turnId).toBe("turn-1");
  });

  it("cold resume、interrupted 和未启用 surface 均不触发", () => {
    const completedTurn = resolveLatestCompletedAssistantPreviewTurn(completedRows());
    const coldResume = advanceAssistantPreviewPptxAutoOpenGate(
      createAssistantPreviewPptxAutoOpenGateState(),
      {
        enabled: true,
        scopeKey: "workspace\u0000session-a",
        logEpoch: "epoch-1",
        phase: "completedSuccess",
        completedTurn,
      },
    );
    expect(coldResume.target).toBeUndefined();

    const armed = advanceAssistantPreviewPptxAutoOpenGate(
      createAssistantPreviewPptxAutoOpenGateState(),
      {
        enabled: true,
        scopeKey: "workspace\u0000session-a",
        logEpoch: "epoch-1",
        phase: "running",
        completedTurn: null,
      },
    ).state;
    expect(
      advanceAssistantPreviewPptxAutoOpenGate(armed, {
        enabled: true,
        scopeKey: "workspace\u0000session-a",
        logEpoch: "epoch-1",
        phase: "completedInterrupted",
        completedTurn,
      }).target,
    ).toBeNull();
    expect(
      advanceAssistantPreviewPptxAutoOpenGate(armed, {
        enabled: false,
        scopeKey: "workspace\u0000session-a",
        logEpoch: "epoch-1",
        phase: "completedSuccess",
        completedTurn,
      }).target,
    ).toBeNull();
  });

  it("只选取最新 completedSuccess turn 内的完整 assistant 行", () => {
    const rows = completedRows();
    rows.push(
      {
        rowId: 3,
        turnId: "turn-2",
        entityId: "header-2",
        createdAt: 3,
        createdAtSeq: 3,
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: 3,
        endedAt: 4,
      },
      {
        rowId: 4,
        turnId: "turn-2",
        entityId: "assistant-2",
        createdAt: 4,
        createdAtSeq: 4,
        kind: "assistantText",
        text: "still settling",
        state: "streaming",
      },
    );

    expect(resolveLatestCompletedAssistantPreviewTurn(rows)).toBeNull();
    const latest = rows.at(-1);
    if (latest?.kind === "assistantText") latest.state = "complete";
    expect(resolveLatestCompletedAssistantPreviewTurn(rows)).toEqual({
      turnId: "turn-2",
      rowId: 4,
      entityId: "assistant-2",
    });
  });
});
