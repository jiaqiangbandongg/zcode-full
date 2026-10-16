import { BufferWriter, ProtocolMessage, ProtocolMessageType, serialize } from "@zcode/rpc";
import {
  PROTOCOL_V4_LIMITS,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  type ConversationTopicFrame,
  type ConversationTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";

const MAX_EVENT_ID = Number.MAX_SAFE_INTEGER;

function logicalFrame(append: string): ConversationTopicFrame {
  return {
    topic: "conversation/session-1",
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1,
    payload: {
      kind: "deltas",
      deltas: [{ op: "row.delta", rowId: 1, path: "text", append }],
    },
  };
}

function completeWire(frame: ConversationTopicFrame, logicalFrameId: string) {
  return {
    wireVersion: 3 as const,
    kind: "complete" as const,
    logicalFrameId,
    logicalFrameOrdinal: 1,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

function actualEnvelopeBytes(wire: ConversationTopicWireFrame) {
  const writer = new BufferWriter();
  serialize(writer, [204, MAX_EVENT_ID]);
  serialize(writer, wire);
  const channel = writer.buffer.buffer;
  const channelSocket = new ProtocolMessage(ProtocolMessageType.Regular, 0, 0, writer.buffer);
  const transportId = "x".repeat(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars);
  const relay = new TextEncoder().encode(
    JSON.stringify({
      type: "data",
      payload: {
        zcode_type: "rpc-frame",
        bridgeSessionId: transportId,
        bridgeGeneration: Number.MAX_SAFE_INTEGER,
        recoveryId: transportId,
        seq: Number.MAX_SAFE_INTEGER,
        dataBase64: Buffer.from(channel).toString("base64"),
      },
      client_ts: Number.MAX_SAFE_INTEGER,
      server_ts: Number.MAX_SAFE_INTEGER,
    }),
  ).byteLength;
  const cli =
    new TextEncoder().encode(JSON.stringify({ method: "v4/conversation/frame", params: wire }))
      .byteLength + 1;
  return { cli, channelSocket: channelSocket.byteLength, relay };
}

describe("V4 topic physical production envelopes", () => {
  it("meter matches CLI NDJSON, Channel serialization, and worst mobile relay bytes", () => {
    const logical = logicalFrame("中文🙂".repeat(120_000));
    const wires = encodeTopicWireFrames(logical, {
      topic: logical.topic,
      subscriptionId: logical.subscriptionId,
      logicalFrameId: "logical-envelope-boundary",
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    }) as ConversationTopicWireFrame[];
    expect(wires.length).toBeGreaterThan(1);

    for (const wire of wires) {
      const measured = measureTopicNotificationEnvelopeBytes(wire);
      const actual = actualEnvelopeBytes(wire);
      expect(actual.cli).toBe(measured.cliNdjsonBytes);
      expect(actual.channelSocket).toBe(measured.channelSocketBytes);
      expect(actual.relay).toBe(measured.mobileRelayBytes);
      expect(Math.max(actual.cli, actual.channelSocket, actual.relay)).toBeLessThanOrEqual(
        PROTOCOL_V4_LIMITS.maxFrameBytes,
      );
    }
  });

  it("actual serializers enforce max-1/max/max+1 thresholds and a maximal production chunk", () => {
    const hardMax = PROTOCOL_V4_LIMITS.maxFrameBytes;
    const actualMax = (wire: ConversationTopicWireFrame) => {
      const actual = actualEnvelopeBytes(wire);
      return Math.max(actual.cli, actual.channelSocket, actual.relay);
    };
    const firstAppendLengthOver = (limit: number, logicalFrameId: string) => {
      let low = 0;
      let high = hardMax * 2;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const measured = actualMax(
          completeWire(logicalFrame("x".repeat(middle)), logicalFrameId),
        );
        if (measured > limit) high = middle;
        else low = middle + 1;
      }
      return low;
    };

    for (const requestedLimit of [hardMax - 1, hardMax, hardMax + 1]) {
      const effectiveLimit = Math.min(requestedLimit, hardMax);
      const logicalFrameId = `actual-boundary-${requestedLimit}`;
      const firstOver = firstAppendLengthOver(effectiveLimit, logicalFrameId);
      const atBoundary = logicalFrame("x".repeat(firstOver - 1));
      const overBoundary = logicalFrame("x".repeat(firstOver));
      expect(actualMax(completeWire(atBoundary, logicalFrameId))).toBeLessThanOrEqual(
        effectiveLimit,
      );
      expect(actualMax(completeWire(overBoundary, logicalFrameId))).toBeGreaterThan(effectiveLimit);

      expect(
        encodeTopicWireFrames(atBoundary, {
          topic: atBoundary.topic,
          subscriptionId: atBoundary.subscriptionId,
          logicalFrameId,
          logicalFrameOrdinal: 1,
          maxPhysicalFrameBytes: requestedLimit,
          measurePhysicalFrameBytes: (wire) => actualMax(wire as ConversationTopicWireFrame),
        }),
      ).toHaveLength(1);
      expect(
        encodeTopicWireFrames(overBoundary, {
          topic: overBoundary.topic,
          subscriptionId: overBoundary.subscriptionId,
          logicalFrameId: `${logicalFrameId}-fragmented`,
          logicalFrameOrdinal: 1,
          maxPhysicalFrameBytes: requestedLimit,
          measurePhysicalFrameBytes: (wire) => actualMax(wire as ConversationTopicWireFrame),
        }).every((wire) => wire.kind === "fragment"),
      ).toBe(true);
    }

    const large = logicalFrame("中文🙂".repeat(250_000));
    const fragments = encodeTopicWireFrames(large, {
      topic: large.topic,
      subscriptionId: large.subscriptionId,
      logicalFrameId: "actual-maximal-fragment",
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (wire) => actualMax(wire as ConversationTopicWireFrame),
    }) as ConversationTopicWireFrame[];
    const first = fragments.find((wire) => wire.kind === "fragment");
    expect(first?.kind).toBe("fragment");
    if (!first || first.kind !== "fragment") return;
    expect(actualMax(first)).toBeLessThanOrEqual(hardMax);
    // encoder 以最坏 fragmentCount/index 位数选 chunk；再增加一个 base64 quantum
    // 就必须越过真实 serializer 上限，证明生产 chunk budget 已取到可达最大值。
    const worstEnvelope = {
      ...first,
      fragmentIndex: first.logicalBytes - 1,
      fragmentCount: first.logicalBytes,
      dataBase64: `${first.dataBase64}AAAA`,
    };
    expect(actualMax(worstEnvelope)).toBeGreaterThan(hardMax);
  });
});
