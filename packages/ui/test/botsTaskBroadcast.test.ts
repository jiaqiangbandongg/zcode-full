import { describe, expect, it } from "vitest";
import { BOT_TASK_BROADCAST_CHANNEL } from "@zcode/shared";
import {
  resolveBotTaskBroadcastRefresh,
  resolveBotTaskBroadcastRuntimeStatus,
} from "../src/root/botsTaskBroadcast.js";
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

describe("bot task broadcast", () => {
  it("refreshes an open workspace by workspace identity", () => {
    const refresh = resolveBotTaskBroadcastRefresh(
      {
        channel: BOT_TASK_BROADCAST_CHANNEL,
        payload: {
          workspacePath: "/repo",
          workspaceIdentity: "ssh://host/repo",
          taskId: "task-1",
          event: "created",
          updatedAt: 1,
        },
      },
      tabs,
    );

    expect(refresh).toMatchObject({
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      taskId: "task-1",
    });
  });

  it("ignores path-only broadcasts for a remote workspace with the same path", () => {
    const refresh = resolveBotTaskBroadcastRefresh(
      {
        channel: BOT_TASK_BROADCAST_CHANNEL,
        payload: {
          workspacePath: "/repo",
          taskId: "task-1",
          event: "created",
          updatedAt: 1,
        },
      },
      tabs,
    );

    expect(refresh).toBeNull();
  });

  it("maps task events to sidebar runtime status", () => {
    expect(resolveBotTaskBroadcastRuntimeStatus("created")).toBe("creating");
    expect(resolveBotTaskBroadcastRuntimeStatus("prompt_sent")).toBe("streaming");
    expect(resolveBotTaskBroadcastRuntimeStatus("resumed")).toBe("streaming");
    expect(resolveBotTaskBroadcastRuntimeStatus("streaming")).toBe("streaming");
    expect(resolveBotTaskBroadcastRuntimeStatus("permission_request")).toBe("streaming");
    expect(resolveBotTaskBroadcastRuntimeStatus("permission_resolved")).toBe("streaming");
    expect(resolveBotTaskBroadcastRuntimeStatus("elicitation_request")).toBe("streaming");
    expect(resolveBotTaskBroadcastRuntimeStatus("elicitation_resolved")).toBe("streaming");
    expect(resolveBotTaskBroadcastRuntimeStatus("updated")).toBe("ready");
    expect(resolveBotTaskBroadcastRuntimeStatus("completed")).toBe("completed");
    expect(resolveBotTaskBroadcastRuntimeStatus("error")).toBe("failed");
  });

  it("accepts prompt metadata for optimistic user message sync", () => {
    const refresh = resolveBotTaskBroadcastRefresh(
      {
        channel: BOT_TASK_BROADCAST_CHANNEL,
        payload: {
          workspacePath: "/repo",
          workspaceIdentity: "ssh://host/repo",
          taskId: "task-1",
          event: "prompt_sent",
          updatedAt: 1,
          prompt: {
            content: "请检查项目",
            messageId: "bot-trace-1",
            sentAt: 2,
          },
        },
      },
      tabs,
    );

    expect(refresh?.prompt).toMatchObject({
      content: "请检查项目",
      messageId: "bot-trace-1",
      sentAt: 2,
    });
  });

  it("accepts task metadata for incremental sidebar cache sync", () => {
    const refresh = resolveBotTaskBroadcastRefresh(
      {
        channel: BOT_TASK_BROADCAST_CHANNEL,
        payload: {
          workspacePath: "/repo",
          workspaceIdentity: "ssh://host/repo",
          taskId: "task-1",
          event: "created",
          updatedAt: 1,
          task: {
            taskId: "task-1",
            title: "Task 1",
            workspacePath: "/repo",
            workspaceIdentity: "ssh://host/repo",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
      tabs,
    );

    expect(refresh?.task).toMatchObject({
      taskId: "task-1",
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
    });
  });
});
