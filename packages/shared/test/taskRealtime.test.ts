import { describe, expect, it } from "vitest";
import {
  taskOwnerCommandDeliverySchema,
  taskOwnerCommandRequestSchema,
  taskOwnerCommandResultSchema,
  taskRealtimeDeliveredEventSchema,
  taskRealtimeEventSchema,
  taskRealtimeHostDeliveryKindSchema,
  taskRunLeaseAcquireRequestSchema,
  taskRunLeaseResultSchema,
  taskStreamMirrorPublishOpSchema,
  taskStreamMirrorTargetSchema,
  HostMessageTypes,
  HostResponseTypes,
  hostIncomingMessageSchema,
  hostResponseMessageSchema,
  resolveWorkspaceKey,
} from "@zcode/shared";

function makeRealtimeEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "task_snapshot_invalidated",
    eventId: "evt-1",
    workspacePath: "/repo/demo",
    workspaceKey: "/repo/demo",
    reason: "user_message_saved",
    traceId: "trace-1",
    createdAt: 1,
    taskId: "task-1",
    ...overrides,
  };
}

function makeTaskMeta(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    traceId: "trace-1",
    title: "Task 1",
    workspacePath: "/repo/demo",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    provider: "codex",
    status: "running",
    ...overrides,
  };
}

describe("task realtime contract", () => {
  function makeStreamTarget(overrides: Record<string, unknown> = {}) {
    return {
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      taskId: "task-1",
      runId: "trace-1",
      traceId: "trace-1",
      ...overrides,
    };
  }

  function makeStreamBatch(overrides: Record<string, unknown> = {}) {
    return {
      type: "task_stream_mirror_batch",
      eventId: "evt-batch-1",
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      traceId: "trace-1",
      createdAt: 1,
      taskId: "task-1",
      runId: "trace-1",
      batchSeq: 1,
      fromSeq: 1,
      toSeq: 1,
      ops: [
        {
          kind: "stream_event",
          seq: 1,
          event: {
            type: "agent_message_chunk",
            taskId: "task-1",
            traceId: "trace-1",
            content: "hello",
          },
        },
      ],
      terminal: false,
      ...overrides,
    };
  }

  it("uses workspaceIdentity before workspacePath when resolving workspaceKey", () => {
    expect(
      resolveWorkspaceKey({
        workspacePath: "/repo/demo",
        workspaceIdentity: "remote:ssh:demo:/repo/demo",
      }),
    ).toBe("remote:ssh:demo:/repo/demo");
  });

  it("falls back to workspacePath when workspaceIdentity is blank", () => {
    expect(
      resolveWorkspaceKey({
        workspacePath: "/repo/demo",
        workspaceIdentity: "   ",
      }),
    ).toBe("/repo/demo");
  });

  it("rejects events with a mismatched workspaceKey", () => {
    const parsed = taskRealtimeEventSchema.safeParse(
      makeRealtimeEvent({
        workspaceIdentity: "remote:ssh:demo:/repo/demo",
        workspaceKey: "/repo/demo",
      }),
    );

    expect(parsed.success).toBe(false);
  });

  it("rejects caller-supplied originHostId in publish envelopes", () => {
    const parsed = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.TaskRealtimePublish,
      event: makeRealtimeEvent({
        originHostId: "host-a",
      }),
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts valid publish envelopes", () => {
    const parsed = hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.TaskRealtimePublish,
      event: makeRealtimeEvent(),
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts stream watermark on snapshot invalidation events", () => {
    const parsed = taskRealtimeEventSchema.safeParse(
      makeRealtimeEvent({
        reason: "stream_mirror_gap",
        streamWatermark: { runId: "trace-1", opSeq: 42 },
      }),
    );

    expect(parsed.success).toBe(true);
  });

  it("accepts valid deliver envelopes with main-owned originHostId", () => {
    const event = {
      ...makeRealtimeEvent({
        eventId: "evt-delivered",
        type: "workspace_task_list_invalidated",
        reason: "task_meta_changed",
        taskId: undefined,
      }),
      originHostId: "host-a",
    };

    const parsedEvent = taskRealtimeDeliveredEventSchema.safeParse(event);
    expect(parsedEvent.success).toBe(true);

    const parsedEnvelope = hostIncomingMessageSchema.safeParse({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event,
    });
    expect(parsedEnvelope.success).toBe(true);
  });

  it("accepts workspace task list invalidations with task meta for incremental UI sync", () => {
    const event = makeRealtimeEvent({
      type: "workspace_task_list_invalidated",
      reason: "task_status_changed",
      taskMeta: makeTaskMeta({
        lastError: {
          code: "model_request_failed",
          message: "[1301][Sensitive content rejected]",
          attribution: {
            source: "provider",
            reason: "invalid_request",
            providerId: "account:bigmodel-individual-coding-plan",
            providerErrorCode: "1301",
          },
        },
      }),
    });

    const parsed = taskRealtimeEventSchema.parse(event);
    expect(parsed).toMatchObject({
      taskMeta: {
        lastError: {
          attribution: {
            source: "provider",
            reason: "invalid_request",
            providerId: "account:bigmodel-individual-coding-plan",
            providerErrorCode: "1301",
          },
        },
      },
    });
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.TaskRealtimePublish,
        event,
      }).success,
    ).toBe(true);
  });

  it("accepts stream mirror targets with valid workspaceKey and matching runId traceId", () => {
    const parsed = taskStreamMirrorTargetSchema.safeParse(
      makeStreamTarget({
        workspaceIdentity: "remote:ssh:demo:/repo/demo",
        workspaceKey: "remote:ssh:demo:/repo/demo",
      }),
    );

    expect(parsed.success).toBe(true);
  });

  it("rejects stream mirror targets with a mismatched workspaceKey", () => {
    const parsed = taskStreamMirrorTargetSchema.safeParse(
      makeStreamTarget({
        workspaceIdentity: "remote:ssh:demo:/repo/demo",
        workspaceKey: "/repo/demo",
      }),
    );

    expect(parsed.success).toBe(false);
  });

  it("rejects stream mirror targets when runId differs from traceId", () => {
    const parsed = taskStreamMirrorTargetSchema.safeParse(
      makeStreamTarget({
        runId: "run-2",
      }),
    );

    expect(parsed.success).toBe(false);
  });

  it("accepts publish stream ops without seq and rejects caller-supplied seq", () => {
    const parsed = taskStreamMirrorPublishOpSchema.safeParse({
      kind: "user_message",
      messageId: "msg-1",
      content: "hello",
      timestamp: 1,
    });
    const withSeq = taskStreamMirrorPublishOpSchema.safeParse({
      kind: "user_message",
      messageId: "msg-1",
      content: "hello",
      timestamp: 1,
      seq: 1,
    });

    expect(parsed.success).toBe(true);
    expect(withSeq.success).toBe(false);
  });

  it("accepts video attachments in replayable stream and queued prompt payloads", () => {
    const video = {
      kind: "video",
      filename: "demo.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
      dataBase64: "/w==",
    };

    expect(
      taskStreamMirrorPublishOpSchema.safeParse({
        kind: "user_message",
        messageId: "msg-video-1",
        content: "Summarize the video.",
        attachments: [video],
        timestamp: 1,
      }).success,
    ).toBe(true);

    expect(
      taskOwnerCommandRequestSchema.safeParse({
        commandRequestId: "cmd-video-1",
        type: "enqueue_task_command",
        workspacePath: "/repo/demo",
        workspaceKey: "/repo/demo",
        taskId: "task-1",
        runId: "trace-1",
        taskCommand: {
          type: "send_prompt",
          commandId: "queued-video-1",
          workspacePath: "/repo/demo",
          workspaceKey: "/repo/demo",
          taskId: "task-1",
          traceId: "trace-video-1",
          status: "accepted",
          createdAt: 1,
          updatedAt: 1,
          content: "Summarize the video.",
          attachments: [video],
        },
      }).success,
    ).toBe(true);
  });

  it("validates lease acquire and result schemas with leaseRequestId", () => {
    const acquire = taskRunLeaseAcquireRequestSchema.safeParse({
      leaseRequestId: "lease-1",
      ...makeStreamTarget(),
    });
    const result = taskRunLeaseResultSchema.safeParse({
      leaseRequestId: "lease-1",
      acquired: true,
      ownerHostId: "host-a",
    });
    const rejected = taskRunLeaseResultSchema.safeParse({
      leaseRequestId: "lease-2",
      acquired: false,
      ownerHostId: "host-a",
      reason: "owned_by_other_host",
    });

    expect(acquire.success).toBe(true);
    expect(result.success).toBe(true);
    expect(rejected.success).toBe(true);
  });

  it("validates host delivery kind schema", () => {
    expect(taskRealtimeHostDeliveryKindSchema.safeParse("desktop_window").success).toBe(true);
    expect(taskRealtimeHostDeliveryKindSchema.safeParse("relay_bridge").success).toBe(true);
  });

  it("validates owner command request and delivery schemas", () => {
    const command = {
      commandRequestId: "cmd-1",
      type: "respond_permission",
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      taskId: "task-1",
      runId: "trace-1",
      permissionRequestId: "perm-1",
      optionId: "allow",
      response: { decision: "allow" },
    };

    expect(taskOwnerCommandRequestSchema.safeParse(command).success).toBe(true);
    expect(
      taskOwnerCommandDeliverySchema.safeParse({
        ...command,
        requesterHostId: "host-b",
      }).success,
    ).toBe(true);

    const cancelCommand = {
      commandRequestId: "cmd-cancel-1",
      type: "cancel_task_command",
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      taskId: "task-1",
      runId: "trace-1",
      commandId: "queued-1",
      clientMode: "web-remote-replayable",
    };

    expect(taskOwnerCommandRequestSchema.safeParse(cancelCommand).success).toBe(true);
    expect(
      taskOwnerCommandDeliverySchema.safeParse({
        ...cancelCommand,
        requesterHostId: "host-b",
      }).success,
    ).toBe(true);
  });

  it("validates owner command failure code schema", () => {
    const parsed = taskOwnerCommandResultSchema.safeParse({
      commandRequestId: "cmd-1",
      success: false,
      error: "No active task owner.",
      code: "NO_ACTIVE_TASK_OWNER",
    });

    expect(parsed.success).toBe(true);
  });

  it("validates new host envelopes", () => {
    const batch = makeStreamBatch();
    const leaseResult = {
      leaseRequestId: "lease-1",
      acquired: true,
      ownerHostId: "host-a",
    };
    const command = {
      commandRequestId: "cmd-1",
      type: "stop_generation",
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      taskId: "task-1",
      runId: "trace-1",
    };
    const commandResult = {
      commandRequestId: "cmd-1",
      success: true,
    };
    const enqueueCommand = {
      commandRequestId: "cmd-enqueue-1",
      type: "enqueue_task_command",
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      taskId: "task-1",
      runId: "trace-1",
      taskCommand: {
        type: "send_prompt",
        commandId: "queued-1",
        workspacePath: "/repo/demo",
        workspaceKey: "/repo/demo",
        taskId: "task-1",
        traceId: "trace-queued",
        status: "accepted",
        createdAt: 1,
        updatedAt: 1,
        content: "continue",
      },
    };
    const enqueueCommandResult = {
      commandRequestId: "cmd-enqueue-1",
      success: true,
      taskCommand: enqueueCommand.taskCommand,
    };
    const cancelCommand = {
      commandRequestId: "cmd-cancel-1",
      type: "cancel_task_command",
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      taskId: "task-1",
      runId: "trace-1",
      commandId: "queued-1",
      clientMode: "web-remote-replayable",
    };

    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: { ...batch, originHostId: "host-a", deliveryPurpose: "observer" },
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.TaskRunLeaseResult,
        result: leaseResult,
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.TaskOwnerCommandDeliver,
        command: { ...command, requesterHostId: "host-b" },
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.TaskOwnerCommandResult,
        result: commandResult,
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.TaskStreamOpPublish,
        target: makeStreamTarget(),
        op: {
          kind: "user_message",
          messageId: "msg-1",
          content: "hello",
          timestamp: 1,
        },
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.TaskRunLeaseAcquire,
        request: {
          leaseRequestId: "lease-1",
          ...makeStreamTarget(),
        },
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.TaskRunLeaseRelease,
        target: makeStreamTarget(),
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.TaskOwnerCommandRequest,
        command: enqueueCommand,
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: HostMessageTypes.TaskOwnerCommandDeliver,
        command: { ...cancelCommand, requesterHostId: "host-b" },
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.TaskOwnerCommandRequest,
        command: cancelCommand,
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: HostResponseTypes.TaskOwnerCommandResult,
        result: enqueueCommandResult,
      }).success,
    ).toBe(true);
  });
});
