import { describe, expect, it } from "vitest";
import { BOT_TASK_STREAM_BROADCAST_CHANNEL } from "@zcode/shared";
import { resolveBotTaskStreamBroadcast } from "../src/root/botsTaskStreamBroadcast.js";
import type { WindowTabState } from "../src/store/tabStore.js";

const tabs: WindowTabState[] = [
  {
    id: "tab-1",
    kind: "workspace",
    label: "repo",
    workspacePath: "/repo",
    workspaceIdentity: "ssh://host/repo",
  },
];

describe("bot task stream broadcast", () => {
  it("accepts stream events for an open workspace", () => {
    const stream = resolveBotTaskStreamBroadcast(
      {
        channel: BOT_TASK_STREAM_BROADCAST_CHANNEL,
        payload: {
          workspacePath: "/repo",
          workspaceIdentity: "ssh://host/repo",
          taskId: "task-1",
          updatedAt: 1,
          event: {
            type: "agent_message_chunk",
            taskId: "task-1",
            traceId: "trace-1",
            content: "hello",
          },
        },
      },
      tabs,
    );

    expect(stream?.event).toMatchObject({
      type: "agent_message_chunk",
      content: "hello",
    });
  });

  it("rejects stream events whose task id does not match the envelope", () => {
    const stream = resolveBotTaskStreamBroadcast(
      {
        channel: BOT_TASK_STREAM_BROADCAST_CHANNEL,
        payload: {
          workspacePath: "/repo",
          workspaceIdentity: "ssh://host/repo",
          taskId: "task-1",
          updatedAt: 1,
          event: {
            type: "agent_message_chunk",
            taskId: "other-task",
            traceId: "trace-1",
            content: "hello",
          },
        },
      },
      tabs,
    );

    expect(stream).toBeNull();
  });
});
