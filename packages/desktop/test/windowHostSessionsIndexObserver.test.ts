import { Emitter } from "@zcode/rpc";
import type { IZCodeAgentService, ZCodeAgentRuntimeLifecycleEvent } from "@zcode/services";
import type {
  SessionsIndexTopicWireCandidate,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it, vi } from "vitest";
import { createWindowHostSessionsIndexObserver } from "../src/host/windowHostSessionsIndexObserver.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "task-1",
    workspaceId: "/work/demo",
    title: "Task",
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: 2,
    createdAt: 1,
    ...overrides,
  };
}

describe("WindowHostSessionsIndexObserver", () => {
  it("runtime available 在 subscribe ACK 前到达时不会递归创建第二条订阅", async () => {
    const frames = new Emitter<SessionsIndexTopicWireCandidate>();
    const lifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
    const subscribeSessionsIndexV4 = vi.fn(async () => {
      lifecycle.fire({
        workspaceKey: "/work/demo",
        workspacePath: "/work/demo",
        state: "available",
        runtimeIdentity: {
          workspaceKey: "/work/demo",
          generation: 1,
          identity: "runtime-1",
        },
      });
      return { ack: { subscriptionId: "sub-1", mode: "snapshot" as const, logEpoch: "e1" } };
    });
    const agentService = {
      onDynamicSessionsIndexFrame: vi.fn(() => frames.event),
      onAgentRuntimeLifecycle: lifecycle.event,
      onAgentRuntimeRestarted: vi.fn(() => ({ dispose: vi.fn() })),
      subscribeSessionsIndexV4,
      resyncSessionsIndexV4: vi.fn(),
      unsubscribeSessionsIndexV4: vi.fn(async () => undefined),
    } as unknown as IZCodeAgentService;
    const observer = createWindowHostSessionsIndexObserver({
      agentService,
      target: { workspacePath: "/work/demo" },
      onSessionsChange: vi.fn(),
    });

    await observer.start();

    expect(subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("ACK 前暂存 initial frame，并按 delta 连续更新内存 summary", async () => {
    const frames = new Emitter<SessionsIndexTopicWireCandidate>();
    const changes: SessionSummary[][] = [];
    const unsubscribeSessionsIndexV4 = vi.fn(async () => undefined);
    const agentService = {
      onDynamicSessionsIndexFrame: vi.fn(() => frames.event),
      onAgentRuntimeRestarted: vi.fn(() => ({ dispose: vi.fn() })),
      subscribeSessionsIndexV4: vi.fn(async () => {
        frames.fire({
          wireVersion: 3,
          kind: "complete",
          deliveryKind: "initial",
          logicalFrameId: "logical-initial",
          logicalFrameOrdinal: 1,
          topic: "sessions-index//work/demo",
          subscriptionId: "sub-1",
          frame: {
            topic: "sessions-index//work/demo",
            subscriptionId: "sub-1",
            fromSeq: 0,
            toSeq: 1,
            sentAt: 1,
            payload: {
              kind: "snapshot",
              snapshot: {
                protocolVersion: 1,
                workspaceId: "/work/demo",
                logEpoch: "epoch-1",
                sessions: [summary()],
              },
            },
          },
        });
        return { ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" } };
      }),
      resyncSessionsIndexV4: vi.fn(),
      unsubscribeSessionsIndexV4,
    } as unknown as IZCodeAgentService;
    const observer = createWindowHostSessionsIndexObserver({
      agentService,
      target: { workspacePath: "/work/demo" },
      onSessionsChange: (sessions) => changes.push(sessions),
    });

    await observer.start();
    expect(agentService.subscribeSessionsIndexV4).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberScope: "window-controller",
        runtimePolicy: "existing-only",
        visibility: "background",
      }),
    );
    expect(changes.at(-1)).toEqual([expect.objectContaining({ phase: "running" })]);

    frames.fire({
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: "logical-delta",
      logicalFrameOrdinal: 2,
      topic: "sessions-index//work/demo",
      subscriptionId: "sub-1",
      frame: {
        topic: "sessions-index//work/demo",
        subscriptionId: "sub-1",
        fromSeq: 1,
        toSeq: 2,
        sentAt: 2,
        payload: {
          kind: "deltas",
          deltas: [{ op: "session.upserted", session: summary({ phase: "completedSuccess" }) }],
        },
      },
    });
    expect(changes.at(-1)).toEqual([expect.objectContaining({ phase: "completedSuccess" })]);

    observer.dispose();
    expect(unsubscribeSessionsIndexV4).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub-1", runtimePolicy: "existing-only" }),
    );
  });
});
