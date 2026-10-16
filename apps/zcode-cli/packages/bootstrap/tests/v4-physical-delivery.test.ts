import { describe, expect, it, vi } from "vitest";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { measureTopicNotificationEnvelopeBytes } from "@zcode/shared/zcode-protocol-v4";
import { emitReservedTopicFrame } from "../src/zcode-protocol-v4/v4-gateway.js";
import type { TopicFrameReservation } from "../src/zcode-protocol-v4/topic-frame-reservation.js";

function frame(text = ""): ConversationTopicFrame {
  return {
    topic: "conversation/session-delivery",
    subscriptionId: "sub-delivery",
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1,
    payload: {
      kind: "deltas",
      deltas: text ? [{ op: "row.delta", rowId: 1, path: "text", append: text }] : [],
    },
  };
}

describe("V4 gateway physical reservation delivery", () => {
  it("emit 中途失败不 commit；retry 使用相同 logical id/content 并在全成功后 commit", () => {
    const commit = vi.fn(() => true);
    const reservation: TopicFrameReservation<ConversationTopicFrame> = {
      logicalFrameId: "logical-stable",
      logicalFrameOrdinal: 1,
      frame: frame("中文🙂".repeat(180_000)),
      commit,
    };
    const firstAttempt: unknown[] = [];
    let firstIndex = 0;
    expect(() =>
      emitReservedTopicFrame(reservation, (wire) => {
        firstAttempt.push(wire);
        if (firstIndex++ === 1) throw new Error("emit failed");
      }),
    ).toThrow("emit failed");
    expect(commit).not.toHaveBeenCalled();

    const retry: unknown[] = [];
    expect(emitReservedTopicFrame(reservation, (wire) => retry.push(wire))).toBe(true);
    expect(firstAttempt).toHaveLength(2);
    expect(retry.length).toBeGreaterThan(2);
    expect(retry.slice(0, firstAttempt.length)).toEqual(firstAttempt);
    expect(
      retry.every(
        (wire) => (wire as { logicalFrameId: string }).logicalFrameId === "logical-stable",
      ),
    ).toBe(true);
    const checksums = retry.map(
      (wire) => (wire as { checksum?: { value: string } }).checksum?.value,
    );
    expect(new Set(checksums).size).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);
    for (const wire of retry) {
      expect(measureTopicNotificationEnvelopeBytes(wire as never).maxBytes).toBeLessThanOrEqual(
        1024 * 1024,
      );
    }
  });
});
