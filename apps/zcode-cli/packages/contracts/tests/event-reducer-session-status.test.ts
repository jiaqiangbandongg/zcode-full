import { describe, expect, it } from "vitest";
import { EventReducer } from "../src/events/event-reducer.js";
import { createSessionEvent, SessionEventType } from "../src/events/session.events.js";
import type { SessionId, ToolCallId, TurnId } from "../src/interfaces/shared.js";

describe("EventReducer session status", () => {
  const sessionId = "sess_status" as SessionId;
  const turnId = "turn_status" as TurnId;
  const toolCallId = "tool_status" as ToolCallId;

  it("keeps a turn running after the current tool batch completes", () => {
    const events = [
      createSessionEvent(SessionEventType.SessionCreated, sessionId, {
        mode: "build",
        contextWindow: 200000,
      }),
      createSessionEvent(
        SessionEventType.TurnStarted,
        sessionId,
        { turnNumber: 1, input: "Use a tool" },
        { turnId },
      ),
      createSessionEvent(SessionEventType.ToolCallScheduled, sessionId, {
        toolCallId,
        toolName: "Read",
        input: { filePath: "package.json" },
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      }),
      createSessionEvent(SessionEventType.ToolCallResult, sessionId, {
        toolCallId,
        result: { success: true, content: "{}" },
        duration: 12,
      }),
      createSessionEvent(SessionEventType.ToolBatchComplete, sessionId, {
        toolCallIds: [toolCallId],
        successCount: 1,
        errorCount: 0,
      }),
    ];

    const projection = new EventReducer().reduce(events);
    expect(projection.activeToolCalls).toEqual([]);
    expect(projection.status).toBe("running");

    const completedProjection = new EventReducer().reduce([
      ...events,
      createSessionEvent(
        SessionEventType.TurnComplete,
        sessionId,
        {
          response: "Done",
          tokenCount: 42,
          toolCallCount: 1,
          duration: 100,
          resultType: "success",
        },
        { turnId },
      ),
    ]);
    expect(completedProjection.status).toBe("idle");
  });
});
