import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createTraceId,
  createTurnId,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import {
  V4_METHODS,
  conversationTopic,
  conversationTopicFrameSchema,
  reassembleTopicWireFrames,
  routedTopicWireFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const workspace = {
  workspacePath: "/workspace/v4-auto-drain-race",
  workspaceKey: "/workspace/v4-auto-drain-race",
};

async function requestResult(
  server: ZCodeProtocolAgentServer,
  message: ZCodeProtocolMessage,
): Promise<unknown> {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

describe("v4 queue auto-drain foreground races", () => {
  it("BG43：Core-only notification 活跃时 auto-drain 不得抢占 foreground", async () => {
    let sessionEventSink: ((event: SessionEvent) => void) | undefined;
    let sequenceNumber = 0;
    let activeForegroundExecutionId: string | undefined;
    let rejectNextIdlePromotion = true;
    let emitEvent!: (type: SessionEvent["type"], payload: unknown, turnId?: string) => SessionEvent;
    const stopActiveForegroundExecution = vi.fn().mockImplementation(() => {
      const stoppedId = activeForegroundExecutionId;
      activeForegroundExecutionId = undefined;
      return stoppedId
        ? { kind: "stopped" as const, foregroundExecutionId: stoppedId }
        : { kind: "idle" as const };
    });
    const acquireForegroundPromotionLease = vi.fn().mockImplementation(({ leaseId }) => {
      if (rejectNextIdlePromotion) {
        rejectNextIdlePromotion = false;
        return { kind: "busy" as const };
      }
      return { kind: "acquired" as const, leaseId };
    });
    const reserveQueueItem = vi.fn().mockImplementation(async (_queueItemId, reservationId) => {
      emitEvent(SessionEventType.TurnSteerDispatchChanged, {
        pendingInputId: "queue-bg43",
        reservationId,
        state: "reserved",
        targetTurnId: "turn-before-bg43",
      });
      return true;
    });
    const markQueueItemPromoting = vi
      .fn()
      .mockImplementation(async (_queueItemId, reservationId) => {
        emitEvent(SessionEventType.TurnSteerDispatchChanged, {
          pendingInputId: "queue-bg43",
          reservationId,
          state: "promoting",
          targetTurnId: "turn-before-bg43",
        });
        return true;
      });
    const removeQueueItem = vi.fn().mockImplementation(async () => {
      emitEvent(SessionEventType.TurnSteerDiscarded, {
        pendingInputIds: ["queue-bg43"],
        reason: "promoted",
        targetTurnId: "turn-before-bg43",
      });
      return true;
    });
    const setQueueAutoDrain = vi.fn().mockResolvedValue(undefined);
    const sendInput = vi
      .fn()
      .mockImplementation(
        async (
          _input: unknown,
          options?: { onTurnStartedObserved?: (event: SessionEvent) => void },
        ) => {
          const turnStarted = emitEvent(
            SessionEventType.TurnStarted,
            {
              input: "BG43 queued text",
              inputId: "source-bg43",
              messageId: "message-bg43",
              turnNumber: 2,
            },
            "turn-promoted-bg43",
          );
          options?.onTurnStartedObserved?.(turnStarted);
          return {};
        },
      );

    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options: ZCodeAppOptions) => {
        const app = createFakeApp(options);
        return {
          ...app,
          markQueueItemPromoting,
          readTarget: vi.fn().mockResolvedValue(null),
          releaseQueueItemReservation: vi.fn().mockResolvedValue(true),
          removeQueueItem,
          reserveQueueItem,
          sendInput,
          setQueueAutoDrain,
          runtime: {
            ...app.runtime,
            acquireForegroundPromotionLease,
            getActiveForegroundExecutionId: () => activeForegroundExecutionId,
            stopActiveForegroundExecution,
            subscribeEvents: (sink) => {
              sessionEventSink = sink.onSessionEvent;
              return () => {};
            },
          },
        } as ZCodeApp;
      },
      cwd: workspace.workspacePath,
      version: "test-version",
    });
    const created = (await requestResult(server, {
      id: "create-bg43",
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    })) as { session: { sessionId: string } };
    const sessionId = created.session.sessionId as SessionId;
    const traceId = createTraceId("trace-bg43");
    emitEvent = (type, payload, turnId) => {
      sequenceNumber += 1;
      const event = {
        id: `event-bg43-${sequenceNumber}`,
        payload,
        sequenceNumber,
        sessionId,
        timestamp: new Date(1_700_000_000_000 + sequenceNumber),
        traceId,
        type,
        ...(turnId ? { turnId: createTurnId(turnId) } : {}),
      } as SessionEvent;
      sessionEventSink?.(event);
      return event;
    };

    emitEvent(SessionEventType.SessionCreated, {
      contextWindow: 128_000,
      mode: "build",
    });
    emitEvent(
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-bg43",
        inputId: "source-bg43",
        input: "BG43 queued text",
        inputPreview: "BG43 queued text",
        inputSize: 16,
        delivery: "queue",
        targetTurnId: "turn-before-bg43",
        queueLength: 1,
        intent: {
          sourceCommandId: "source-bg43",
          queueItemId: "queue-bg43",
          clientId: "desktop-bg43",
          kind: "sendText",
          admissionSeq: 1,
          admittedAt: 1_700_000_000_002,
          requestedDelivery: "queue",
          admittedDelivery: "queue",
        },
      },
      "turn-before-bg43",
    );
    emitEvent(SessionEventType.QueueAutoDrainChanged, { autoDrain: true });
    activeForegroundExecutionId = "notification-bg43";

    const subscriptionRequestId = "subscribe-bg43";
    await requestResult(server, {
      id: subscriptionRequestId,
      method: V4_METHODS.conversationSubscribe,
      params: {
        clientMode: "desktop-continuous",
        connectionId: "connection-bg43",
        topic: conversationTopic(sessionId),
      },
    });
    const assembled = reassembleTopicWireFrames(
      server
        .takePostResponseMessages(subscriptionRequestId)
        .map((message) => routedTopicWireFrameSchema.parse(message.params)),
      conversationTopicFrameSchema,
    );
    if (assembled.kind !== "complete" || assembled.frame.payload.kind !== "snapshot") {
      throw new Error("Expected complete BG43 conversation snapshot");
    }
    expect(assembled.frame.payload.snapshot.queue).toMatchObject({
      autoDrain: true,
      items: [
        expect.objectContaining({
          queueItemId: "queue-bg43",
          dispatch: { state: "queued" },
        }),
      ],
    });

    const autoDrainAck = await requestResult(server, {
      id: "resume-auto-drain-bg43",
      method: V4_METHODS.command,
      params: {
        baseRevision: assembled.frame.payload.snapshot.revision,
        clientId: "desktop-bg43",
        commandId: "set-auto-drain-bg43",
        issuedAt: 1_700_000_000_003,
        payload: { autoDrain: true },
        sessionId,
        type: "setAutoDrain",
      },
    });

    if ((autoDrainAck as { status?: string }).status !== "accepted") {
      throw new Error(`Unexpected BG43 command ACK: ${JSON.stringify(autoDrainAck)}`);
    }
    expect(setQueueAutoDrain).toHaveBeenCalledWith(true);
    expect(activeForegroundExecutionId).toBe("notification-bg43");
    expect(stopActiveForegroundExecution).not.toHaveBeenCalled();
    expect(reserveQueueItem).not.toHaveBeenCalled();
    expect(markQueueItemPromoting).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(removeQueueItem).not.toHaveBeenCalled();

    activeForegroundExecutionId = undefined;
    await vi.waitFor(() => {
      expect(acquireForegroundPromotionLease).toHaveBeenCalledTimes(2);
      expect(reserveQueueItem).toHaveBeenCalledOnce();
      expect(markQueueItemPromoting).toHaveBeenCalledOnce();
      expect(sendInput).toHaveBeenCalledOnce();
      expect(removeQueueItem).toHaveBeenCalledOnce();
    });
    expect(stopActiveForegroundExecution).not.toHaveBeenCalled();
  });
});
