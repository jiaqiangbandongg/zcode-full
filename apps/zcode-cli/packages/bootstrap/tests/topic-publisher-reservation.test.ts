import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ConversationSnapshot, WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationTopicPublisher,
  SessionsIndexPublisher,
  WorkspaceConfigPublisher,
} from "../src/zcode-protocol-v4/index.js";

function event(sequenceNumber: number, type: SessionEventType, payload: unknown): SessionEvent {
  return {
    id: `event-${sequenceNumber}`,
    sessionId: "session-reservation",
    type,
    timestamp: new Date(sequenceNumber * 1_000),
    traceId: "trace-reservation",
    sequenceNumber,
    payload,
  } as SessionEvent;
}

function snapshot(sessionId: string): ConversationSnapshot {
  const publisher = new ConversationTopicPublisher(sessionId, `epoch-${sessionId}`);
  publisher.ingest({
    ...event(1, SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    }),
    sessionId,
  } as SessionEvent);
  return publisher.getSnapshot();
}

const CONFIG_A: WorkspaceConfigState = { configOptions: [], slashCommands: [] };
const CONFIG_B: WorkspaceConfigState = {
  configOptions: [{ id: "mode", name: "Mode", type: "select", currentValue: "build", options: [] }],
  slashCommands: [],
};

describe("V4 topic publisher non-destructive reservation", () => {
  it("conversation retry 保持同 logical id/content，新事件进入下一 reservation", () => {
    const publisher = new ConversationTopicPublisher("session-reservation", "epoch", {
      now: () => 1,
    });
    publisher.ingest(
      event(1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const subscribed = publisher.subscribeReserved({ connectionId: "connection" });
    const initial = subscribed.reservation!;
    publisher.ingest(
      event(2, SessionEventType.SessionTitleUpdated, {
        title: "updated",
        source: "custom",
      }),
    );

    expect(publisher.reserveFlush(subscribed.ack.subscriptionId)).toBe(initial);
    expect(publisher.reserveFlush(subscribed.ack.subscriptionId)).toMatchObject({
      logicalFrameId: initial.logicalFrameId,
      frame: initial.frame,
    });
    expect(initial.commit()).toBe(true);
    const next = publisher.reserveFlush(subscribed.ack.subscriptionId)!;
    expect(next.logicalFrameId).not.toBe(initial.logicalFrameId);
    expect(next.frame.fromSeq).toBe(initial.frame.toSeq);
    expect(next.frame.toSeq).toBe(2);
  });

  it("conversation unsubscribe/re-subscribe 后旧 reservation commit 返回 false", () => {
    const publisher = new ConversationTopicPublisher("session-reservation", "epoch");
    const first = publisher.subscribeReserved({ connectionId: "connection" });
    const stale = first.reservation!;
    const replacement = publisher.subscribeReserved({ connectionId: "connection" });
    expect(replacement.ack.subscriptionId).not.toBe(first.ack.subscriptionId);
    expect(stale.commit()).toBe(false);
    expect(publisher.reserveFlush(first.ack.subscriptionId)).toBeNull();
  });

  it("conversation replacement rollback 恢复旧 owner 与后续 flush", () => {
    const publisher = new ConversationTopicPublisher("session-reservation", "epoch");
    const first = publisher.subscribeReserved({ connectionId: "connection" });
    expect(first.reservation?.commit()).toBe(true);
    const replacement = publisher.subscribeReserved({ connectionId: "connection" });
    expect(replacement.rollback()).toBe(true);
    expect(publisher.hasSubscription(first.ack.subscriptionId, "connection")).toBe(true);
    publisher.ingest(
      event(1, SessionEventType.SessionTitleUpdated, { title: "still-live", source: "custom" }),
    );
    expect(publisher.reserveFlush(first.ack.subscriptionId)?.frame.toSeq).toBe(1);
  });

  it("sessions-index reservation retry/concurrent ingest/stale commit 全守恒", () => {
    const publisher = new SessionsIndexPublisher("workspace", "epoch", () => 1);
    publisher.ingestConversation(snapshot("session-a"), { createdAt: 1, lastActivityAt: 1 });
    const first = publisher.subscribeReserved("connection");
    const initial = first.reservation!;
    publisher.ingestConversation(snapshot("session-b"), { createdAt: 2, lastActivityAt: 2 });
    expect(publisher.reserveFlush(first.subscriptionId)).toBe(initial);
    expect(initial.commit()).toBe(true);
    const next = publisher.reserveFlush(first.subscriptionId)!;
    expect(next.frame.fromSeq).toBe(initial.frame.toSeq);
    expect(next.frame.toSeq).toBe(publisher.seq);

    const stale = next;
    publisher.subscribeReserved("connection");
    expect(stale.commit()).toBe(false);
  });

  it("sessions-index replacement rollback 恢复旧 owner", () => {
    const publisher = new SessionsIndexPublisher("workspace", "epoch", () => 1);
    const first = publisher.subscribeReserved("connection");
    expect(first.reservation?.commit()).toBe(true);
    const replacement = publisher.subscribeReserved("connection");
    expect(replacement.rollback()).toBe(true);
    expect(publisher.subscriptionIds()).toEqual([first.subscriptionId]);
    publisher.ingestConversation(snapshot("session-after-rollback"), {
      createdAt: 1,
      lastActivityAt: 1,
    });
    expect(publisher.reserveFlush(first.subscriptionId)).not.toBeNull();
  });

  it("workspace-config reservation retry/concurrent publish/stale commit 全守恒", () => {
    const publisher = new WorkspaceConfigPublisher("workspace", "epoch", () => 1);
    publisher.publish(CONFIG_A);
    const first = publisher.subscribeReserved("connection");
    const initial = first.reservation!;
    publisher.publish(CONFIG_B);
    expect(publisher.reserveFlush(first.subscriptionId)).toBe(initial);
    expect(initial.commit()).toBe(true);
    const next = publisher.reserveFlush(first.subscriptionId)!;
    expect(next.frame.payload.kind).toBe("deltas");
    expect(next.frame.fromSeq).toBe(initial.frame.toSeq);

    publisher.unsubscribe(first.subscriptionId, "connection");
    expect(next.commit()).toBe(false);
  });

  it("workspace-config replacement rollback 恢复旧 owner", () => {
    const publisher = new WorkspaceConfigPublisher("workspace", "epoch", () => 1);
    const first = publisher.subscribeReserved("connection");
    expect(first.reservation?.commit()).toBe(true);
    const replacement = publisher.subscribeReserved("connection");
    expect(replacement.rollback()).toBe(true);
    expect(publisher.subscriptionIds()).toEqual([first.subscriptionId]);
    publisher.publish(CONFIG_B);
    expect(publisher.reserveFlush(first.subscriptionId)).not.toBeNull();
  });
});
