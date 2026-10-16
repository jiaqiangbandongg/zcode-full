import { describe, expect, it, vi } from "vitest";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { createSubagentMessageSink } from "../src/subagent/message-steering.js";
import { persistSubagentMessageCommand } from "../src/runtime/methods/subagent-messages.js";
import { persistBackgroundTaskNotificationBatch } from "../src/runtime/methods/background-notifications.js";
import { formatTaskNotification } from "../src/runtime-task/notification.js";

function runtime() {
  return {
    sessionId: "parent",
    ensureContextInitialized: vi.fn(),
    messageHistory: new MessageHistoryImpl(),
    persistSyntheticUserNoticeForSession: vi.fn(),
    sessionStore: undefined,
  };
}

describe("incoming message trusted producers", () => {
  it.each([undefined, " summary "])(
    "marks coordinator messages independently of summary=%s",
    async (summary) => {
      const steerTurn = vi.fn(async () => ({
        kind: "queued" as const,
        pendingInputId: "pending",
        queueLength: 1,
        turnId: "turn" as never,
      }));
      const sink = createSubagentMessageSink({ steerTurn }, { traceContext: {} as never });
      await sink.send({ id: "message", message: "raw body", summary } as never);
      expect(steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPresentation: "coordinator_steer",
          input: summary ? "summary\n\nraw body" : "raw body",
        }),
      );
    },
  );
  it.each([false, true])("persists peer consumption timing midTurn=%s", async (midTurn) => {
    const target = runtime();
    await persistSubagentMessageCommand.call(
      target as never,
      {
        text: "<subagent-message>raw</subagent-message>",
        traceContext: {},
        id: "command",
        agentId: "child",
      } as never,
      midTurn,
    );
    const marker = midTurn ? "subagent_reply_steer" : "subagent_reply";
    expect(target.messageHistory.toRuntimeEntries()[0]?.metadata).toEqual({
      source: "legacy_synthetic",
      inputPresentation: marker,
    });
    expect(target.persistSyntheticUserNoticeForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "<subagent-message>raw</subagent-message>",
        metadata: expect.objectContaining({ inputPresentation: marker }),
      }),
    );
  });
  it.each([false, true])(
    "keeps a background batch raw with one marker midTurn=%s",
    async (midTurn) => {
      const target = runtime();
      await persistBackgroundTaskNotificationBatch.call(
        target as never,
        [
          { id: "1", text: "one", traceContext: {} },
          { id: "2", text: "two", traceContext: {} },
        ] as never,
        midTurn,
      );
      expect(target.messageHistory.toRuntimeEntries()).toEqual([
        {
          message: { role: "user", content: "one\n\ntwo" },
          metadata: {
            source: "legacy_synthetic",
            inputPresentation: midTurn ? "task_notification_steer" : "task_notification",
          },
        },
      ]);
      expect(target.persistSyntheticUserNoticeForSession).toHaveBeenCalledOnce();
    },
  );
  it.each(["local_agent", "local_bash", "local_workflow", "monitor_mcp"] as const)(
    "stores only raw notification payload for %s",
    (taskType) => {
      const text = formatTaskNotification({
        taskId: "task",
        taskType,
        status: "completed",
        summary: "done",
      });
      expect(text).toMatch(/^<task-notification>/);
      expect(text).not.toContain("[SYSTEM NOTIFICATION");
    },
  );
});
