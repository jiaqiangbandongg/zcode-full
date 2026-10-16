import { describe, expect, it, vi } from "vitest";
import {
  markWebRemoteControlBridgeTaskRead,
  markWebRemoteControlTaskRead,
} from "@web/webRemoteControlTaskRead.js";

describe("markWebRemoteControlTaskRead", () => {
  it("persists the exact mobile task target as read", async () => {
    const setTaskUnread = vi.fn(async () => ({}));

    const result = await markWebRemoteControlTaskRead({
      service: { setTaskUnread },
      target: {
        taskId: "task-1",
        workspacePath: "/workspace/remote",
        workspaceIdentity: "ssh://host/workspace/remote",
        expectedUnreadAt: 123,
      },
    });

    expect(result).toEqual({ ok: true });
    expect(setTaskUnread).toHaveBeenCalledWith({
      taskId: "task-1",
      workspacePath: "/workspace/remote",
      workspaceIdentity: "ssh://host/workspace/remote",
      unread: false,
      expectedUnreadAt: 123,
    });
  });

  it("reports a failed read mutation without rejecting task navigation", async () => {
    const failure = new Error("task index unavailable");

    await expect(
      markWebRemoteControlTaskRead({
        service: {
          setTaskUnread: vi.fn(async () => {
            throw failure;
          }),
        },
        target: {
          taskId: "task-1",
          workspacePath: "/workspace/local",
          expectedUnreadAt: 123,
        },
      }),
    ).resolves.toEqual({ ok: false, error: failure });
  });

  it("uses the newly connected remote bridge identity for cross-workspace read clearing", async () => {
    const setTaskUnread = vi.fn(async () => ({}));

    const result = await markWebRemoteControlBridgeTaskRead({
      bridge: {
        kind: "remote",
        workspacePath: "/workspace/shared-path",
        workspaceIdentity: "ssh://new-host/workspace/shared-path",
        initialTaskId: "task-cross-workspace",
      },
      service: { setTaskUnread },
      expectedUnreadAt: 456,
    });

    expect(result).toEqual({ ok: true });
    expect(setTaskUnread).toHaveBeenCalledWith({
      taskId: "task-cross-workspace",
      workspacePath: "/workspace/shared-path",
      workspaceIdentity: "ssh://new-host/workspace/shared-path",
      unread: false,
      expectedUnreadAt: 456,
    });
  });
});
