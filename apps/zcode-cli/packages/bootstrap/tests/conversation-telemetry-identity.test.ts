import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { uuidv7 } from "@zcode/shared";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

function event(type: SessionEvent["type"], payload: unknown, seq: number): SessionEvent {
  return {
    id: `event-${seq}`,
    sessionId: "parent",
    turnId: "turn",
    traceId: "trace",
    sequenceNumber: seq,
    timestamp: new Date(),
    type,
    payload,
  } as SessionEvent;
}

describe("main turn telemetry identity", () => {
  it.each([undefined, "background_task"])("keeps inputId through %s turn facts", (inputSource) => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const inputId = uuidv7();
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnStarted,
          {
            turnNumber: 1,
            input: "prompt",
            inputId,
            inputSource,
            messageId: "msg_persisted",
          },
          1,
        ),
      ),
    ).toMatchObject({ sourceCommandId: inputId, kind: "turn.started" });
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnComplete,
          {
            turnNumber: 1,
            result: { type: "complete" },
            duration: 10,
          },
          2,
        ),
      ),
    ).toMatchObject({ sourceCommandId: inputId, kind: "turn.terminal" });
  });

  it("does not substitute a persisted message ID for a missing input ID", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const fact = normalizer.normalize(
      "parent",
      event(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "notice",
          inputSource: "background_task",
          messageId: "msg_persisted",
        },
        1,
      ),
    );
    expect(fact).not.toHaveProperty("sourceCommandId");
  });
});
