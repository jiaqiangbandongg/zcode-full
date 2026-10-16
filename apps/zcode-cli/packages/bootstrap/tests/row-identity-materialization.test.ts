import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

function event(
  sequenceNumber: number,
  type: SessionEvent["type"],
  payload: unknown,
  turnId = "runtime-turn-1",
): SessionEvent {
  return {
    id: `identity-event-${sequenceNumber}` as EventId,
    sessionId: "identity-session" as SessionId,
    turnId: turnId as TurnId,
    type,
    timestamp: new Date(1_700_000_000_000 + sequenceNumber),
    traceId: "identity-trace" as TraceId,
    sequenceNumber,
    payload,
  };
}

describe("row identity materialization", () => {
  it("row 与 command target 使用同一 canonical entity，并显式下发 productTurn/visibility", () => {
    const projection = new ProductProjection("identity-session", "identity-epoch");
    const events = [
      event(1, SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 }),
      event(2, SessionEventType.TurnStarted, {
        turnNumber: 1,
        input: "identity query",
        messageId: "user-message-1",
      }),
      event(3, SessionEventType.ModelStreaming, {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "assistant-message-1",
        partId: "assistant-part-1",
      }),
      event(4, SessionEventType.ModelStreaming, {
        kind: "text_delta",
        delta: "identity answer",
        done: false,
        partId: "assistant-part-1",
      }),
      event(5, SessionEventType.ModelStreaming, {
        kind: "text_end",
        delta: "",
        done: false,
        partId: "assistant-part-1",
      }),
      event(6, SessionEventType.TurnComplete, {
        response: "identity answer",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 1,
        resultType: "success",
      }),
    ];
    for (const item of events) projection.applyEvent(item);

    const snapshot = projection.getSnapshot();
    expect(() => conversationSnapshotSchema.parse(snapshot)).not.toThrow();
    for (const row of snapshot.rows.window) {
      expect(row).toMatchObject({
        entityId: expect.any(String),
        productTurnId: row.turnId,
        visibility: "visible",
      });
      expect(projection.getEntityIdForRow(row.rowId)).toBe(
        (row as unknown as { entityId: string }).entityId,
      );
    }
    const user = snapshot.rows.window.find((row) => row.kind === "userInput");
    const assistant = snapshot.rows.window.find((row) => row.kind === "assistantText");
    expect(user).toMatchObject({
      entityId: "user-message-1",
      productTurnId: "user-message-1",
      visibility: "visible",
    });
    expect(assistant).toMatchObject({
      entityId: "assistant-message-1",
      productTurnId: "user-message-1",
      visibility: "visible",
    });
    expect(projection.getEntityIdForRow(user!.rowId)).toBe(
      (user as unknown as { entityId: string }).entityId,
    );
    expect(projection.getMessageIdForRow(user!.rowId)).toBe(
      (user as unknown as { entityId: string }).entityId,
    );
  });
});
