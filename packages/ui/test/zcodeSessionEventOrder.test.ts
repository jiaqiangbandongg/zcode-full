import { describe, expect, it } from "vitest";
import type { ZCodeSessionEvent } from "@zcode/shared";
import { createZCodeSessionEventOrderGate } from "@/lib/zcodeSessionEventOrder.js";

function event(seq: number, eventId = `evt-${seq}`): ZCodeSessionEvent {
  return {
    eventId,
    payload: {},
    seq,
    sessionId: "sess-1",
    timestamp: 1_700_000_000_000 + seq,
    traceId: "trace-1",
    type: "session.updated",
  };
}

function streamingDeltaEvent(seq: number, eventId = `evt-${seq}`): ZCodeSessionEvent {
  return {
    ...event(seq, eventId),
    payload: { kind: "text_delta" },
    type: "model.streaming",
  };
}

describe("zcode session event order gate", () => {
  it("buffers future events until the missing seq arrives", () => {
    const gate = createZCodeSessionEventOrderGate();

    expect(gate.push(event(1)).readyEvents.map((item) => item.seq)).toEqual([1]);
    const future = gate.push(event(3));
    expect(future.readyEvents).toEqual([]);
    expect(future.gap).toEqual({ expectedSeq: 2, receivedSeq: 3 });

    expect(gate.push(event(2)).readyEvents.map((item) => item.seq)).toEqual([2, 3]);
  });

  it("drops duplicate event ids", () => {
    const gate = createZCodeSessionEventOrderGate();

    expect(gate.push(event(1, "evt-same")).readyEvents).toHaveLength(1);
    expect(gate.push(event(1, "evt-same"))).toMatchObject({
      duplicate: true,
      readyEvents: [],
    });
  });

  it("uses snapshot seq as the recovery watermark", () => {
    const gate = createZCodeSessionEventOrderGate();

    expect(gate.push(event(5)).readyEvents.map((item) => item.seq)).toEqual([5]);
    expect(gate.push(event(7)).gap).toEqual({ expectedSeq: 6, receivedSeq: 7 });
    expect(gate.markSnapshotSeq(6).map((item) => item.seq)).toEqual([7]);
  });

  it("preserves pending events when running snapshot cannot cover stream deltas", () => {
    const gate = createZCodeSessionEventOrderGate();

    expect(gate.markSnapshotSeq(25)).toEqual([]);
    expect(gate.push(event(27)).gap).toEqual({ expectedSeq: 26, receivedSeq: 27 });
    expect(gate.push(event(28)).gap).toEqual({ expectedSeq: 26, receivedSeq: 27 });

    expect(
      gate
        .markSnapshotSeq(29, {
          preservePendingEvents: true,
        })
        .map((item) => item.seq),
    ).toEqual([27, 28]);
  });

  it("releases selected pending events after gap recovery", () => {
    const gate = createZCodeSessionEventOrderGate();

    expect(gate.markSnapshotSeq(8)).toEqual([]);
    expect(gate.push(event(10))).toMatchObject({
      gap: { expectedSeq: 9, receivedSeq: 10 },
      readyEvents: [],
    });
    expect(gate.push(streamingDeltaEvent(11))).toMatchObject({
      gap: { expectedSeq: 9, receivedSeq: 10 },
      readyEvents: [],
    });

    expect(
      gate
        .releasePendingAfterGap({
          preserve: (item) => item.type === "model.streaming",
        })
        .map((item) => item.seq),
    ).toEqual([11]);
    expect(gate.push(event(12)).readyEvents.map((item) => item.seq)).toEqual([12]);
  });

  it("passes through legacy seq zero events without inventing UI ordering", () => {
    const gate = createZCodeSessionEventOrderGate();

    expect(gate.push(event(0, "evt-zero")).readyEvents.map((item) => item.seq)).toEqual([0]);
  });
});
