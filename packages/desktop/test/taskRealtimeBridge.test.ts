import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { HostMessageTypes } from "@zcode/shared";
import {
  createTaskRealtimeBridge,
  createTaskRealtimeBridgeForHostInit,
} from "../src/host/taskRealtimeBridge.js";

class FakeParentPort extends EventEmitter {
  readonly postedMessages: unknown[] = [];

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }
}

function makeEvent(overrides: Record<string, unknown> = {}) {
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
  } as const;
}

describe("taskRealtimeBridge", () => {
  it("publishes host response envelopes", () => {
    const parentPort = new FakeParentPort();
    const bridge = createTaskRealtimeBridge({
      hostId: "host-a",
      parentPort,
    });

    bridge.publish(makeEvent());

    expect(parentPort.postedMessages).toEqual([
      {
        type: "task-realtime-publish",
        event: makeEvent(),
      },
    ]);
  });

  it("does not include originHostId in publish envelopes", () => {
    const parentPort = new FakeParentPort();
    const bridge = createTaskRealtimeBridge({
      hostId: "host-a",
      parentPort,
    });

    bridge.publish(makeEvent());

    const message = parentPort.postedMessages[0] as { event: Record<string, unknown> };
    expect("originHostId" in message.event).toBe(false);
  });

  it("fires receive listeners once for duplicate delivered events", () => {
    const parentPort = new FakeParentPort();
    const bridge = createTaskRealtimeBridge({
      hostId: "host-b",
      parentPort,
    });
    const listener = vi.fn();
    bridge.onDidReceiveEvent(listener);
    const delivered = {
      ...makeEvent(),
      originHostId: "host-a",
    };

    parentPort.emitMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: delivered,
    });
    parentPort.emitMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: delivered,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(delivered);
  });

  it("evicts old delivered event ids after the bounded dedupe window", () => {
    const parentPort = new FakeParentPort();
    const bridge = createTaskRealtimeBridge({
      hostId: "host-b",
      parentPort,
      seenEventLimit: 2,
    });
    const listener = vi.fn();
    bridge.onDidReceiveEvent(listener);

    parentPort.emitMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        ...makeEvent(),
        eventId: "evt-1",
        originHostId: "host-a",
      },
    });
    parentPort.emitMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        ...makeEvent(),
        eventId: "evt-2",
        originHostId: "host-a",
      },
    });
    parentPort.emitMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        ...makeEvent(),
        eventId: "evt-3",
        originHostId: "host-a",
      },
    });
    parentPort.emitMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        ...makeEvent(),
        eventId: "evt-1",
        originHostId: "host-a",
      },
    });

    expect(listener).toHaveBeenCalledTimes(4);
  });
  it("creates exactly one realtime bridge for the window Local Host", () => {
    const parentPort = new FakeParentPort();

    expect(
      createTaskRealtimeBridgeForHostInit(
        {
          type: "legacy-remote-host",
          hostId: "host-a",
        },
        parentPort,
      ),
    ).toBeNull();
    expect(
      createTaskRealtimeBridgeForHostInit(
        {
          type: HostMessageTypes.InitLocal,
          hostId: "host-b",
          zcodeBuiltinProviderConfigFilePath: "/repo/config/provider/zcode-builtin.json",
        },
        parentPort,
      )?.hostId,
    ).toBe("host-b");
  });

  it("preserves realtime delivery kind from init-local", () => {
    const parentPort = new FakeParentPort();
    const bridge = createTaskRealtimeBridgeForHostInit(
      {
        type: HostMessageTypes.InitLocal,
        hostId: "host-relay",
        deliveryKind: "relay_bridge",
        zcodeBuiltinProviderConfigFilePath: "/repo/config/provider/zcode-builtin.json",
      },
      parentPort,
    );

    expect(bridge?.deliveryKind).toBe("relay_bridge");
  });
});
