import { EventEmitter } from "node:events";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { describe, expect, it, vi } from "vitest";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import { TaskRealtimeBus } from "../src/main/taskRealtimeBus.js";

class FakeHostProcess extends EventEmitter {
  readonly postedMessages: unknown[] = [];

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  emitMessage(message: unknown): void {
    this.emit("message", message);
  }

  emitExit(): void {
    this.emit("exit", 0);
  }
}

function asUtilityProcess(process: FakeHostProcess): ElectronUtilityProcess {
  return process as unknown as ElectronUtilityProcess;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makePublish(overrides: Record<string, unknown> = {}) {
  return {
    type: HostResponseTypes.TaskRealtimePublish,
    event: {
      type: "task_snapshot_invalidated",
      eventId: "evt-1",
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      reason: "user_message_saved",
      traceId: "trace-1",
      createdAt: 1,
      taskId: "task-1",
      ...overrides,
    },
  };
}

function makeSessionRouteAnnounce(overrides: Record<string, unknown> = {}) {
  return {
    type: HostResponseTypes.SessionRouteAnnounce,
    route: {
      sessionId: "session-target",
      ...overrides,
    },
  };
}

function makeSessionMessageRequest(overrides: Record<string, unknown> = {}) {
  return {
    content: "继续成语接龙：一心一意",
    createdAt: "2026-05-21T00:00:00.000Z",
    fromSessionId: "session-source",
    messageId: "msg-1",
    requestId: "req-1",
    toSessionId: "session-target",
    ...overrides,
  };
}

function makeLeaseRequest(leaseRequestId = "lease-1", overrides: Record<string, unknown> = {}) {
  return {
    type: HostResponseTypes.TaskRunLeaseAcquire,
    request: {
      leaseRequestId,
      workspacePath: "/repo/demo",
      workspaceKey: "/repo/demo",
      taskId: "task-1",
      runId: "trace-1",
      traceId: "trace-1",
      ...overrides,
    },
  };
}

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

function makeChunk(content: string) {
  return {
    type: HostResponseTypes.TaskStreamOpPublish,
    target: makeStreamTarget(),
    op: {
      kind: "stream_event",
      event: {
        type: "agent_message_chunk",
        taskId: "task-1",
        traceId: "trace-1",
        content,
      },
    },
  };
}

function makeUserMessage(content: string, timestamp = 1234) {
  return {
    type: HostResponseTypes.TaskStreamOpPublish,
    target: makeStreamTarget(),
    op: {
      kind: "user_message",
      messageId: "trace-1:user",
      content,
      timestamp,
    },
  };
}

describe("TaskRealtimeBus", () => {
  it("forwards a publish from host A to host B in the same workspace", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });

    hostA.emitMessage(makePublish());

    expect(hostB.postedMessages).toEqual([
      {
        type: "task-realtime-deliver",
        event: expect.objectContaining({
          eventId: "evt-1",
          originHostId: "host-a",
          workspaceKey: "/repo/demo",
        }),
      },
    ]);
  });

  it("delivers publishes back to the origin host for ordered self replay", () => {
    const hostA = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });

    hostA.emitMessage(makePublish());

    expect(hostA.postedMessages).toEqual([
      {
        type: "task-realtime-deliver",
        event: expect.objectContaining({
          eventId: "evt-1",
          originHostId: "host-a",
          workspaceKey: "/repo/demo",
        }),
      },
    ]);
  });

  it("does not cross-forward different workspaceIdentity scopes with the same path", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["identity-a"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["identity-b"],
    });

    hostA.emitMessage(
      makePublish({
        workspacePath: "/repo/demo",
        workspaceIdentity: "identity-a",
        workspaceKey: "identity-a",
      }),
    );

    expect(hostB.postedMessages).toEqual([]);
  });

  it("ignores duplicate eventId values", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });

    hostA.emitMessage(makePublish());
    hostA.emitMessage(makePublish());

    expect(hostB.postedMessages).toHaveLength(1);
  });

  it("does not crash on invalid payloads", () => {
    const logger = makeLogger();
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });

    hostA.emitMessage({
      type: HostResponseTypes.TaskRealtimePublish,
      event: {
        ...makePublish().event,
        workspaceKey: "wrong",
      },
    });

    expect(hostB.postedMessages).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("unregisters a host on exit", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });

    hostB.emitExit();
    hostA.emitMessage(makePublish());

    expect(hostB.postedMessages).toEqual([]);
  });

  it("acquires, rejects, releases, and reacquires task run leases", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });

    hostA.emitMessage(makeLeaseRequest("lease-a"));
    hostA.emitMessage(makeLeaseRequest("lease-a2"));
    hostB.emitMessage(makeLeaseRequest("lease-b"));
    hostA.emitMessage({
      type: HostResponseTypes.TaskRunLeaseRelease,
      target: makeStreamTarget(),
    });
    hostB.emitMessage(makeLeaseRequest("lease-b2"));

    expect(hostA.postedMessages).toEqual([
      {
        type: HostMessageTypes.TaskRunLeaseResult,
        result: { leaseRequestId: "lease-a", acquired: true, ownerHostId: "host-a" },
      },
      {
        type: HostMessageTypes.TaskRunLeaseResult,
        result: { leaseRequestId: "lease-a2", acquired: true, ownerHostId: "host-a" },
      },
    ]);
    expect(hostB.postedMessages).toEqual([
      {
        type: HostMessageTypes.TaskRunLeaseResult,
        result: {
          leaseRequestId: "lease-b",
          acquired: false,
          ownerHostId: "host-a",
          reason: "owned_by_other_host",
        },
      },
      {
        type: HostMessageTypes.TaskRunLeaseResult,
        result: { leaseRequestId: "lease-b2", acquired: true, ownerHostId: "host-b" },
      },
    ]);
  });

  it("batches stream ops, coalesces chunks, and delivers the same seq stream to owner and observer", () => {
    vi.useFakeTimers();
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });
    hostA.emitMessage(makeLeaseRequest());
    hostA.postedMessages.length = 0;

    hostA.emitMessage(makeChunk("hel"));
    hostA.emitMessage(makeChunk("lo"));
    vi.advanceTimersByTime(1000);

    expect(hostA.postedMessages).toHaveLength(1);
    expect(hostB.postedMessages).toHaveLength(1);
    expect(hostA.postedMessages[0]).toMatchObject({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        type: "task_stream_mirror_batch",
        originHostId: "host-a",
        deliveryPurpose: "relay_owner",
        fromSeq: 1,
        toSeq: 1,
        ops: [
          {
            kind: "stream_event",
            seq: 1,
            event: { type: "agent_message_chunk", content: "hello" },
          },
        ],
      },
    });
    expect(hostB.postedMessages[0]).toMatchObject({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        type: "task_stream_mirror_batch",
        originHostId: "host-a",
        deliveryPurpose: "observer",
        fromSeq: 1,
        toSeq: 1,
        ops: [
          {
            kind: "stream_event",
            seq: 1,
            event: { type: "agent_message_chunk", content: "hello" },
          },
        ],
      },
    });
    vi.useRealTimers();
  });

  it("flushes mirrored user messages before user_message_saved invalidation", () => {
    vi.useFakeTimers();
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });
    hostA.emitMessage(makeLeaseRequest());
    hostA.postedMessages.length = 0;
    hostB.postedMessages.length = 0;

    hostA.emitMessage(makeUserMessage("hello"));
    hostA.emitMessage(
      makePublish({
        eventId: "user-saved-1",
        reason: "user_message_saved",
        traceId: "trace-1",
      }),
    );

    expect(hostA.postedMessages).toHaveLength(2);
    expect(hostB.postedMessages).toHaveLength(2);
    expect(hostA.postedMessages[0]).toMatchObject({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        type: "task_stream_mirror_batch",
        deliveryPurpose: "relay_owner",
        ops: [
          {
            kind: "user_message",
            messageId: "trace-1:user",
            content: "hello",
            timestamp: 1234,
          },
        ],
      },
    });
    expect(hostA.postedMessages[1]).toMatchObject({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        type: "task_snapshot_invalidated",
        reason: "user_message_saved",
      },
    });
    expect(hostB.postedMessages[0]).toMatchObject({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        type: "task_stream_mirror_batch",
        deliveryPurpose: "observer",
        ops: [
          {
            kind: "user_message",
            messageId: "trace-1:user",
            content: "hello",
            timestamp: 1234,
          },
        ],
      },
    });
    expect(hostB.postedMessages[1]).toMatchObject({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        type: "task_snapshot_invalidated",
        reason: "user_message_saved",
      },
    });
    vi.useRealTimers();
  });

  it("falls back to snapshot invalidation when replay exceeds retention limits", () => {
    vi.useFakeTimers();
    const hostA = new FakeHostProcess();
    const hostC = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    hostA.emitMessage(makeLeaseRequest());
    hostA.postedMessages.length = 0;

    for (let index = 0; index < 65; index += 1) {
      hostA.emitMessage(makeChunk(String(index)));
      vi.advanceTimersByTime(1000);
    }

    bus.registerHost({
      hostId: "host-c",
      windowId: 3,
      child: asUtilityProcess(hostC),
      workspaceKeys: ["/repo/demo"],
    });

    expect(hostC.postedMessages).toContainEqual(
      expect.objectContaining({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: expect.objectContaining({
          type: "task_snapshot_invalidated",
          reason: "stream_mirror_gap",
          streamWatermark: { runId: "trace-1", opSeq: 65 },
        }),
      }),
    );
    vi.useRealTimers();
  });

  it("splits oversized mirror batches for owner and invalidates observers", () => {
    vi.useFakeTimers();
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });
    hostA.emitMessage(makeLeaseRequest());
    hostA.postedMessages.length = 0;
    hostB.postedMessages.length = 0;

    hostA.emitMessage(makeChunk("x".repeat(560 * 1024)));
    vi.advanceTimersByTime(1000);

    const ownerBatches = hostA.postedMessages
      .map((message) => (message as { event?: unknown }).event)
      .filter(
        (
          event,
        ): event is { type: string; deliveryPurpose?: string; ops?: Array<{ seq: number }> } =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "task_stream_mirror_batch",
      );
    expect(ownerBatches.length).toBeGreaterThan(1);
    expect(ownerBatches.every((event) => event.deliveryPurpose === "relay_owner")).toBe(true);
    expect(ownerBatches.flatMap((event) => event.ops?.map((op) => op.seq) ?? [])).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(ownerBatches.every((event) => JSON.stringify(event).length <= 512 * 1024)).toBe(true);
    expect(hostB.postedMessages).toEqual([
      expect.objectContaining({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: expect.objectContaining({
          type: "task_snapshot_invalidated",
          reason: "stream_mirror_gap",
          streamWatermark: { runId: "trace-1", opSeq: 5 },
        }),
      }),
    ]);
    vi.useRealTimers();
  });

  it("delivers relay bridge owners the same mirror batches as observers", () => {
    vi.useFakeTimers();
    const hostA = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
      deliveryKind: "relay_bridge",
    });
    expect(bus.getHostDeliveryKindForTest("host-a")).toBe("relay_bridge");
    hostA.emitMessage(makeLeaseRequest());
    hostA.postedMessages.length = 0;
    hostA.emitMessage(makeChunk("hello"));
    vi.advanceTimersByTime(1000);

    expect(hostA.postedMessages).toEqual([
      expect.objectContaining({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: expect.objectContaining({
          type: "task_stream_mirror_batch",
          deliveryPurpose: "relay_owner",
        }),
      }),
    ]);
    vi.useRealTimers();
  });

  it("routes owner commands and forwards results", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });
    hostA.emitMessage(makeLeaseRequest());
    hostA.postedMessages.length = 0;

    hostB.emitMessage({
      type: HostResponseTypes.TaskOwnerCommandRequest,
      command: {
        commandRequestId: "cmd-1",
        type: "stop_generation",
        workspacePath: "/repo/demo",
        workspaceKey: "/repo/demo",
        taskId: "task-1",
        runId: "trace-1",
      },
    });
    expect(hostA.postedMessages[0]).toMatchObject({
      type: HostMessageTypes.TaskOwnerCommandDeliver,
      command: {
        commandRequestId: "cmd-1",
        requesterHostId: "host-b",
      },
    });

    hostA.emitMessage({
      type: HostResponseTypes.TaskOwnerCommandResult,
      result: { commandRequestId: "cmd-1", success: true },
    });
    expect(hostB.postedMessages.at(-1)).toEqual({
      type: HostMessageTypes.TaskOwnerCommandResult,
      result: { commandRequestId: "cmd-1", success: true },
    });
  });

  it("routes session messages by the desktop main session registry", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });

    hostB.emitMessage(makeSessionRouteAnnounce());
    hostB.postedMessages.length = 0;

    const request = makeSessionMessageRequest();
    hostA.emitMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request,
    });

    expect(hostB.postedMessages).toEqual([
      {
        type: HostMessageTypes.SessionMessageDeliver,
        request,
      },
    ]);

    hostB.emitMessage({
      type: HostResponseTypes.SessionMessageDeliverResult,
      result: {
        messageId: "msg-1",
        requestId: "req-1",
        sessionId: "session-source",
        status: "success",
      },
    });

    expect(hostA.postedMessages.at(-1)).toEqual({
      type: HostMessageTypes.SessionMessageDeliveryResult,
      result: {
        messageId: "msg-1",
        requestId: "req-1",
        sessionId: "session-source",
        status: "success",
      },
    });
  });

  it("returns failed session message delivery when target session is unknown", () => {
    const hostA = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });

    hostA.emitMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request: makeSessionMessageRequest({ toSessionId: "missing-session" }),
    });

    expect(hostA.postedMessages).toEqual([
      {
        type: HostMessageTypes.SessionMessageDeliveryResult,
        result: {
          error: "target session not found: missing-session",
          messageId: "msg-1",
          requestId: "req-1",
          sessionId: "session-source",
          status: "failed",
        },
      },
    ]);
  });

  it("fails pending session message delivery when the target host exits", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });

    hostB.emitMessage(makeSessionRouteAnnounce());
    hostB.postedMessages.length = 0;
    hostA.emitMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request: makeSessionMessageRequest(),
    });
    hostB.emitExit();

    expect(hostA.postedMessages.at(-1)).toEqual({
      type: HostMessageTypes.SessionMessageDeliveryResult,
      result: {
        error: "Session message host exited.",
        messageId: "msg-1",
        requestId: "req-1",
        sessionId: "session-source",
        status: "failed",
      },
    });
  });
});

describe("TaskRealtimeBus.collectMemoryDiagnostics", () => {
  it("返回 streamBatches / leases / sessionRoutes 三张表的只读大小", () => {
    const bus = new TaskRealtimeBus({ logger: makeLogger() });
    expect(bus.collectMemoryDiagnostics()).toEqual({
      streamBatches: 0,
      leases: 0,
      sessionRoutes: 0,
    });
  });
});
