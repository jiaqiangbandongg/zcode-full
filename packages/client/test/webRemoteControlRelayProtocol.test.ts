import { afterEach, describe, expect, it, vi } from "vitest";
import { VSBuffer, type ConnectionFlowControl } from "@zcode/rpc";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  encodeWebRemoteControlRpcTransportMessage,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
  type WebRemoteControlAppPayload,
  type WebRemoteControlRpcFramePayload,
  type WebRemoteControlRpcTransportFramePayload,
  type WebRemoteControlRpcTransportPayload,
} from "@zcode/shared";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  createWebRemoteControlRelayProtocol,
} from "../src/webRemoteControlRelayProtocol.js";
import { AcknowledgedRelayBatchQueue } from "../src/webRemoteControlAcknowledgedRelayBatchQueue.js";
import type { AcknowledgedRelayOutboundBatch } from "../src/webRemoteControlAcknowledgedRelayProtocolTypes.js";

const acknowledgedIdentity = {
  bridgeSessionId: "bridge-ack-1",
  bridgeGeneration: 2,
  recoveryId: "recovery-ack-1",
} as const;

function encodeAcknowledgedMessage(
  bytes: Uint8Array,
  overrides: Partial<{ firstPhysicalSeq: number; messageSeq: number }> = {},
): readonly WebRemoteControlRpcTransportFramePayload[] {
  return encodeWebRemoteControlRpcTransportMessage(bytes, {
    ...acknowledgedIdentity,
    firstPhysicalSeq: 1,
    messageSeq: 1,
    ...overrides,
  });
}

function isTransportFrame(
  payload: WebRemoteControlRpcTransportPayload,
): payload is WebRemoteControlRpcTransportFramePayload {
  return payload.zcode_type === "rpc-frame";
}

function queueBatch(messageSeq: number, outerBytes = 1): AcknowledgedRelayOutboundBatch {
  return {
    messageSeq,
    frames: [],
    outerBytes,
    queuedAt: 0,
    nextFrameIndex: 0,
  };
}

describe("AcknowledgedRelayBatchQueue", () => {
  it("releases sequential cumulative ACK prefixes with bounded amortized compaction", () => {
    const queue = new AcknowledgedRelayBatchQueue();
    for (let messageSeq = 1; messageSeq <= 5_000; messageSeq += 1) {
      queue.append(queueBatch(messageSeq));
    }

    let releasedBytes = 0;
    for (let ackMessageSeq = 1; ackMessageSeq < 5_000; ackMessageSeq += 1) {
      releasedBytes += queue.releaseThrough(ackMessageSeq).releasedBytes;
    }

    expect(releasedBytes).toBe(4_999);
    expect(queue.activeCount).toBe(1);
    expect(queue.oldest?.messageSeq).toBe(5_000);
    expect(queue.retainedStorageSlots).toBeLessThan(1_024);
  });

  it("drops released payload references immediately even before shell compaction", () => {
    const queue = new AcknowledgedRelayBatchQueue();
    const nearReplayLimit = 8 * 1024 * 1024;
    for (let messageSeq = 1; messageSeq <= 64; messageSeq += 1) {
      const batch = queueBatch(messageSeq, nearReplayLimit);
      Object.assign(batch, { payloadSentinel: new Uint8Array(1024) });
      queue.append(batch);
      queue.releaseThrough(messageSeq);
      expect(queue.retainedPayloadBytes).toBe(0);
      expect(queue.retainedBatchReferenceCount).toBe(0);
    }
    expect(queue.retainedStorageSlots).toBe(64);
  });
});

describe("createWebRemoteControlRelayProtocol", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends rpc frames as base64 relay payloads", () => {
    const sent: WebRemoteControlRpcFramePayload[] = [];
    const { protocol } = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      sendFrame: (frame) => sent.push(frame),
    });

    protocol.send(VSBuffer.wrap(new Uint8Array([1, 2, 3])));

    expect(sent).toEqual([
      {
        zcode_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        seq: 1,
        dataBase64: "AQID",
      },
    ]);
  });

  it("encodes only the sliced bytes exposed by VSBuffer", () => {
    const sent: WebRemoteControlRpcFramePayload[] = [];
    const { protocol } = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      sendFrame: (frame) => sent.push(frame),
    });

    protocol.send(VSBuffer.wrap(new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4)));

    expect(sent[0]?.dataBase64).toBe("AQID");
  });

  it("emits matching incoming rpc frames and ignores other bridge sessions", () => {
    const received: number[][] = [];
    const adapter = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      sendFrame: () => {},
    });
    adapter.protocol.onMessage((buffer) => {
      received.push([...buffer.buffer]);
    });

    adapter.acceptPayload({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bridge-other",
      seq: 1,
      dataBase64: "CQk=",
    });
    adapter.acceptPayload({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bridge-1",
      seq: 1,
      dataBase64: "AQID",
    });

    expect(received).toEqual([[1, 2, 3]]);
  });

  it("disposal prevents future emissions", () => {
    const received: WebRemoteControlAppPayload[] = [];
    const adapter = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      sendFrame: (frame) => received.push(frame),
    });
    adapter.protocol.onMessage((buffer) => {
      received.push({
        zcode_type: "rpc-frame",
        bridgeSessionId: "received",
        seq: 1,
        dataBase64: String(buffer.byteLength),
      });
    });

    adapter.dispose();
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1, 2, 3])));
    adapter.acceptPayload({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bridge-1",
      seq: 1,
      dataBase64: "AQID",
    });

    expect(received).toEqual([]);
  });

  it("buffers outbound rpc frames while relay send is unavailable and flushes them in order", () => {
    const attempted: WebRemoteControlRpcFramePayload[] = [];
    const delivered: WebRemoteControlRpcFramePayload[] = [];
    let sendable = false;
    const adapter = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      sendFrame: (frame) => {
        attempted.push(frame);
        if (!sendable) {
          return false;
        }
        delivered.push(frame);
        return true;
      },
    });

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([2])));

    expect(attempted.map((frame) => frame.seq)).toEqual([1, 1]);
    expect(delivered).toEqual([]);

    sendable = true;
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([3])));

    expect(delivered.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(delivered.map((frame) => frame.dataBase64)).toEqual(["AQ==", "Ag==", "Aw=="]);
  });

  it("reports buffered rpc frames as failed when they cannot flush before timeout", async () => {
    vi.useFakeTimers();
    const failures: string[] = [];
    const adapter = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      sendFrame: () => false,
      bufferedFrameTimeoutMs: 50,
      onBufferedFrameTimeout: (count) => {
        failures.push(`timed-out:${count}`);
      },
    });

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    await vi.advanceTimersByTimeAsync(51);

    expect(failures).toEqual(["timed-out:1"]);
    expect(adapter.flushPendingFrames()).toBe(false);
  });

  it("keeps buffered rpc frames indefinitely when timeout is disabled", async () => {
    vi.useFakeTimers();
    const delivered: WebRemoteControlRpcFramePayload[] = [];
    let sendable = false;
    const adapter = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      sendFrame: (frame) => {
        if (!sendable) {
          return false;
        }
        delivered.push(frame);
        return true;
      },
      bufferedFrameTimeoutMs: null,
    });

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(delivered).toEqual([]);

    sendable = true;
    expect(adapter.flushPendingFrames()).toBe(true);
    expect(delivered.map((frame) => frame.dataBase64)).toEqual(["AQ=="]);
  });

  it("drops duplicate inbound frames and reports seq gaps without delivering them", () => {
    const received: number[][] = [];
    const gaps: Array<{ seq: number; expectedSeq: number; bridgeSessionId: string }> = [];
    const adapter = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      sendFrame: () => {},
      onFrameGap: (gap) => gaps.push(gap),
    });
    adapter.protocol.onMessage((buffer) => {
      received.push([...buffer.buffer]);
    });

    adapter.acceptPayload({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bridge-1",
      seq: 1,
      dataBase64: "AQ==",
    });
    adapter.acceptPayload({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bridge-1",
      seq: 1,
      dataBase64: "Ag==",
    });
    adapter.acceptPayload({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bridge-1",
      seq: 3,
      dataBase64: "Aw==",
    });
    adapter.acceptPayload({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bridge-1",
      seq: 2,
      dataBase64: "BA==",
    });

    expect(received).toEqual([[1]]);
    expect(gaps).toEqual([{ bridgeSessionId: "bridge-1", seq: 3, expectedSeq: 2 }]);
  });

  it("does not flush buffered outbound frames after the bridge is degraded", () => {
    const delivered: WebRemoteControlRpcFramePayload[] = [];
    let sendable = false;
    const adapter = createWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-1",
      sendFrame: (frame) => {
        if (!sendable) {
          return false;
        }
        delivered.push(frame);
        return true;
      },
      bufferedFrameTimeoutMs: null,
    });

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    expect(adapter.isDegraded()).toBe(false);
    adapter.markDegraded();
    expect(adapter.isDegraded()).toBe(true);
    sendable = true;

    expect(adapter.flushPendingFrames()).toBe(false);
    expect(delivered).toEqual([]);

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([2])));
    expect(delivered).toEqual([]);
  });
});

describe("createAcknowledgedWebRemoteControlRelayProtocol", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the deprecated legacy factory separate from the production acknowledged adapter", () => {
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => true,
    });
    const flow: ConnectionFlowControl = adapter;

    expect(adapter.protocol).toBeDefined();
    expect(flow.unacknowledgedBytes).toBe(0);
    expect(flow.onSaturated).toBeTypeOf("function");
    expect(flow.onDrained).toBeTypeOf("function");
    expect(createWebRemoteControlRelayProtocol).toBeTypeOf("function");
    adapter.dispose();
  });

  it("splits oversized raw messages and only delivers/ACKs after the final fragment", () => {
    const outbound: WebRemoteControlRpcTransportPayload[] = [];
    const sender = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        outbound.push(payload);
        return true;
      },
    });
    const bytes = new Uint8Array(2 * 1024 * 1024 + 7);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;

    sender.protocol.send(VSBuffer.wrap(bytes));

    const frames = outbound.filter(isTransportFrame);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(measureWebRemoteControlRpcRelayEnvelopeBytes(frame)).toBeLessThanOrEqual(
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      );
    }

    let delivered = false;
    const acknowledgements: WebRemoteControlRpcTransportPayload[] = [];
    const receiver = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        expect(delivered).toBe(true);
        acknowledgements.push(payload);
        return true;
      },
    });
    const received: Uint8Array[] = [];
    receiver.protocol.onMessage((buffer) => {
      delivered = true;
      received.push(buffer.buffer);
    });

    for (const frame of frames.slice(0, -1)) {
      receiver.acceptPayload(frame);
      expect(received).toHaveLength(0);
      expect(acknowledgements).toHaveLength(0);
    }
    receiver.acceptPayload(frames.at(-1)!);

    expect(received).toEqual([bytes]);
    expect(acknowledgements).toEqual([
      {
        zcode_type: "rpc-frame-ack",
        ...acknowledgedIdentity,
        ackMessageSeq: 1,
      },
    ]);
    sender.dispose();
    receiver.dispose();
  });

  it("uses cumulative ACKs for exact byte accounting and high/low flow edges", () => {
    const firstBatchBytes = encodeAcknowledgedMessage(new Uint8Array([1])).reduce(
      (total, frame) => total + measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
      0,
    );
    const sent: WebRemoteControlRpcTransportPayload[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        sent.push(payload);
        return true;
      },
      saturationHighWaterMarkBytes: firstBatchBytes,
      saturationLowWaterMarkBytes: 0,
    });
    let saturated = 0;
    let drained = 0;
    adapter.onSaturated(() => {
      saturated += 1;
    });
    adapter.onDrained(() => {
      drained += 1;
    });

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    expect(adapter.unacknowledgedBytes).toBe(firstBatchBytes);
    expect(saturated).toBe(0);
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([2])));
    expect(adapter.unacknowledgedBytes).toBeGreaterThan(firstBatchBytes);
    expect(saturated).toBe(1);

    const totalBeforeAck = adapter.unacknowledgedBytes;
    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 2,
      bridgeSessionId: "foreign-bridge",
    });
    expect(adapter.unacknowledgedBytes).toBe(totalBeforeAck);
    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 1,
    });
    expect(adapter.unacknowledgedBytes).toBeGreaterThan(0);
    expect(adapter.unacknowledgedBytes).toBeLessThan(totalBeforeAck);
    expect(drained).toBe(0);
    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 2,
    });
    expect(adapter.unacknowledgedBytes).toBe(0);
    expect(drained).toBe(1);
    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 1,
    });
    expect(drained).toBe(1);

    const faults: string[] = [];
    adapter.onDegraded((fault) => {
      faults.push(fault.reasonCode);
    });
    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 3,
    });
    expect(faults).toEqual(["remote.rpcFrame.futureAck"]);
    expect(adapter.isDegraded()).toBe(true);
    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 4,
    });
    expect(faults).toEqual(["remote.rpcFrame.futureAck"]);
    adapter.dispose();

    const partialFaults: string[] = [];
    const partial = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => false,
    });
    partial.onDegraded((fault) => {
      partialFaults.push(fault.reasonCode);
    });
    partial.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    partial.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 1,
    });
    expect(partialFaults).toEqual(["remote.rpcFrame.futureAck"]);
    partial.dispose();
  });

  it("uses the injected final-envelope meter as the production byte-accounting seam", () => {
    const measured: WebRemoteControlRpcTransportFramePayload[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => true,
      measureFrameBytes: (frame) => {
        measured.push(frame);
        return 37;
      },
    });

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([2])));

    expect(measured).toHaveLength(2);
    expect(adapter.unacknowledgedBytes).toBe(74);
    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 1,
    });
    expect(adapter.unacknowledgedBytes).toBe(37);
    adapter.dispose();
  });

  it("prioritizes the latest queued ACK and preserves immutable ids across flush/replay", () => {
    let sendAll = false;
    let initiallyAcceptedDataFrames = 0;
    const attempts: WebRemoteControlRpcTransportPayload[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        attempts.push(payload);
        if (sendAll) {
          return true;
        }
        if (isTransportFrame(payload) && initiallyAcceptedDataFrames === 0) {
          initiallyAcceptedDataFrames += 1;
          return true;
        }
        return false;
      },
    });
    adapter.protocol.onMessage(() => {});
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array(1024 * 1024)));
    const initialFrames = attempts.filter(isTransportFrame);
    expect(initialFrames).toHaveLength(2);
    const [firstAttempt, secondAttempt] = initialFrames;
    const expectedOutbound = encodeAcknowledgedMessage(new Uint8Array(1024 * 1024));
    expect(expectedOutbound.length).toBeGreaterThan(1);

    adapter.acceptPayload(encodeAcknowledgedMessage(new Uint8Array([1]))[0]!);
    adapter.acceptPayload(
      encodeAcknowledgedMessage(new Uint8Array([2]), {
        firstPhysicalSeq: 2,
        messageSeq: 2,
      })[0]!,
    );
    expect(attempts.at(-1)?.zcode_type).toBe("rpc-frame-ack");

    sendAll = true;
    attempts.length = 0;
    expect(adapter.flushPendingFrames()).toBe(true);
    expect(attempts[0]).toMatchObject({ zcode_type: "rpc-frame-ack", ackMessageSeq: 2 });
    const flushedFrames = attempts.filter(isTransportFrame);
    expect(flushedFrames).toHaveLength(expectedOutbound.length - 1);
    expect(flushedFrames[0]).toBe(secondAttempt);
    expect(flushedFrames.map((frame) => frame.seq)).toEqual(
      expectedOutbound.slice(1).map((frame) => frame.seq),
    );

    attempts.length = 0;
    expect(adapter.replayUnacknowledged()).toBe(true);
    const replayedFrames = attempts.filter(isTransportFrame);
    expect(replayedFrames).toHaveLength(expectedOutbound.length);
    expect(replayedFrames[0]).toBe(firstAttempt);
    expect(replayedFrames.slice(1)).toEqual(flushedFrames);
    adapter.dispose();
  });

  it("handles synchronous reentrant ACK and lost-ACK replay without duplicate delivery", () => {
    let left: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
    let right: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
    let deliverAcknowledgement = true;
    const leftFrames: WebRemoteControlRpcTransportFramePayload[] = [];
    left = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        if (isTransportFrame(payload)) {
          leftFrames.push(payload);
        }
        right.acceptPayload(payload);
        return true;
      },
    });
    right = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        if (!deliverAcknowledgement) {
          return false;
        }
        left.acceptPayload(payload);
        return true;
      },
    });
    const received: number[][] = [];
    right.protocol.onMessage((buffer) => {
      received.push([...buffer.buffer]);
    });

    left.protocol.send(VSBuffer.wrap(new Uint8Array([1, 2, 3])));
    expect(received).toEqual([[1, 2, 3]]);
    expect(left.unacknowledgedBytes).toBe(0);
    expect(left.isDegraded()).toBe(false);

    deliverAcknowledgement = false;
    left.protocol.send(VSBuffer.wrap(new Uint8Array([4, 5, 6])));
    expect(received).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(left.unacknowledgedBytes).toBeGreaterThan(0);
    const replayedSeq = leftFrames.at(-1)?.seq;

    deliverAcknowledgement = true;
    expect(left.replayUnacknowledged()).toBe(true);
    expect(received).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(leftFrames.at(-1)?.seq).toBe(replayedSeq);
    expect(left.unacknowledgedBytes).toBe(0);
    left.dispose();
    right.dispose();
  });

  it("degrades before sending any fragment when exact replay bytes exceed 8 MiB", () => {
    let sends = 0;
    const faults: string[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => {
        sends += 1;
        return true;
      },
    });
    adapter.onDegraded((fault) => {
      faults.push(fault.reasonCode);
    });
    const bytes = new Uint8Array(6_300_000);
    const exactOuterBytes = encodeAcknowledgedMessage(bytes).reduce(
      (total, frame) => total + measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
      0,
    );
    expect(exactOuterBytes).toBeGreaterThan(8 * 1024 * 1024);

    adapter.protocol.send(VSBuffer.wrap(bytes));

    expect(sends).toBe(0);
    expect(adapter.unacknowledgedBytes).toBe(0);
    expect(faults).toEqual(["remote.rpcFrame.replayBufferExceeded"]);
    adapter.dispose();
  });

  it("does not extend the 45s replay age when a same-bridge replay is attempted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const faults: string[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => false,
    });
    adapter.onDegraded((fault) => {
      faults.push(fault.reasonCode);
    });
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));

    await vi.advanceTimersByTimeAsync(44_000);
    adapter.replayUnacknowledged();
    await vi.advanceTimersByTimeAsync(1_001);

    expect(faults).toEqual(["remote.rpcFrame.replayGraceExceeded"]);
    expect(adapter.isDegraded()).toBe(true);
    adapter.dispose();
  });

  it("checks the hard 45s age synchronously before reserve, flush, or replay", () => {
    for (const trigger of ["reserve", "flush", "replay"] as const) {
      let now = 0;
      let sendable = false;
      const sent: WebRemoteControlRpcTransportPayload[] = [];
      const faults: string[] = [];
      const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
        ...acknowledgedIdentity,
        sendFrame: (payload) => {
          sent.push(payload);
          return sendable;
        },
        now: () => now,
        replayBufferGraceMs: Number.MAX_SAFE_INTEGER,
      });
      adapter.onDegraded((fault) => {
        faults.push(fault.reasonCode);
      });
      adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
      expect(sent).toHaveLength(1);

      now = 45_001;
      sendable = true;
      if (trigger === "reserve") {
        adapter.protocol.send(VSBuffer.wrap(new Uint8Array([2])));
      } else if (trigger === "flush") {
        adapter.flushPendingFrames();
      } else {
        adapter.replayUnacknowledged();
      }

      expect(sent).toHaveLength(1);
      expect(faults).toEqual(["remote.rpcFrame.replayGraceExceeded"]);
      adapter.dispose();
    }
  });

  it("rechecks age before every physical send when a send callback advances time", () => {
    let now = 0;
    const sent: WebRemoteControlRpcTransportPayload[] = [];
    const faults: string[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        sent.push(payload);
        now = 45_001;
        return true;
      },
      now: () => now,
    });
    adapter.onDegraded((fault) => {
      faults.push(fault.reasonCode);
    });

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array(1024 * 1024)));

    expect(sent).toHaveLength(1);
    expect(faults).toEqual(["remote.rpcFrame.replayGraceExceeded"]);
    adapter.dispose();
  });

  it("checks age after identity gating so a matching late ACK cannot revive expired replay", () => {
    let now = 0;
    const faults: string[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => true,
      now: () => now,
    });
    adapter.onDegraded((fault) => {
      faults.push(fault.reasonCode);
    });
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    now = 45_001;

    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      bridgeSessionId: "foreign-bridge",
      ackMessageSeq: 1,
    });
    expect(faults).toHaveLength(0);
    adapter.acceptPayload({
      zcode_type: "rpc-frame-ack",
      ...acknowledgedIdentity,
      ackMessageSeq: 1,
    });

    expect(faults).toEqual(["remote.rpcFrame.replayGraceExceeded"]);
    expect(adapter.isDegraded()).toBe(true);
    adapter.dispose();
  });

  it("does not let public options loosen the 8MiB replay or 30s assembly hard limits", async () => {
    let sends = 0;
    const replayFaults: string[] = [];
    const replay = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => {
        sends += 1;
        return true;
      },
      replayBufferMaxBytes: Number.MAX_SAFE_INTEGER,
    });
    replay.onDegraded((fault) => {
      replayFaults.push(fault.reasonCode);
    });
    replay.protocol.send(VSBuffer.wrap(new Uint8Array(6_300_000)));
    expect(sends).toBe(0);
    expect(replayFaults).toEqual(["remote.rpcFrame.replayBufferExceeded"]);
    replay.dispose();

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const assemblyFaults: string[] = [];
    const assembly = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => true,
      assemblyTimeoutMs: Number.MAX_SAFE_INTEGER,
    });
    assembly.onDegraded((fault) => {
      assemblyFaults.push(fault.reasonCode);
    });
    assembly.acceptPayload(encodeAcknowledgedMessage(new Uint8Array(1024 * 1024))[0]!);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(assemblyFaults).toEqual(["remote.rpcFrame.assemblyTimeout"]);
    assembly.dispose();
  });

  it("bounds a queued cumulative ACK by 45s without extending age for a higher ACK", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const faults: string[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => false,
    });
    adapter.protocol.onMessage(() => {});
    adapter.onDegraded((fault) => {
      faults.push(fault.reasonCode);
    });
    adapter.acceptPayload(encodeAcknowledgedMessage(new Uint8Array([1]))[0]!);

    await vi.advanceTimersByTimeAsync(44_000);
    adapter.acceptPayload(
      encodeAcknowledgedMessage(new Uint8Array([2]), {
        firstPhysicalSeq: 2,
        messageSeq: 2,
      })[0]!,
    );
    await vi.advanceTimersByTimeAsync(1_001);

    expect(faults).toEqual(["remote.rpcFrame.ackGraceExceeded"]);
    expect(adapter.isDegraded()).toBe(true);
    adapter.dispose();
  });

  it("does not ACK failed synchronous delivery and degrades on assembly timeout", async () => {
    const sent: WebRemoteControlRpcTransportPayload[] = [];
    const deliveryFaults: string[] = [];
    const delivery = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        sent.push(payload);
        return true;
      },
    });
    delivery.onDegraded((fault) => {
      deliveryFaults.push(fault.reasonCode);
    });
    delivery.protocol.onMessage(() => {
      throw new Error("channel parser failed");
    });
    delivery.acceptPayload(encodeAcknowledgedMessage(new Uint8Array([1]))[0]!);
    expect(sent).toHaveLength(0);
    expect(deliveryFaults).toEqual(["remote.rpcFrame.deliveryFailed"]);
    delivery.dispose();

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeoutFaults: string[] = [];
    const timeout = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => true,
    });
    timeout.onDegraded((fault) => {
      timeoutFaults.push(fault.reasonCode);
    });
    const fragments = encodeAcknowledgedMessage(new Uint8Array(1024 * 1024));
    expect(fragments.length).toBeGreaterThan(1);
    timeout.acceptPayload(fragments[0]!);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(timeoutFaults).toEqual(["remote.rpcFrame.assemblyTimeout"]);
    timeout.dispose();
  });

  it("dispose releases timers, assembly, replay bytes, and future emissions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: WebRemoteControlRpcTransportPayload[] = [];
    const faults: string[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        sent.push(payload);
        return false;
      },
    });
    adapter.onDegraded((fault) => {
      faults.push(fault.reasonCode);
    });
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
    const fragments = encodeAcknowledgedMessage(new Uint8Array(1024 * 1024));
    adapter.acceptPayload(fragments[0]!);
    expect(adapter.unacknowledgedBytes).toBeGreaterThan(0);

    adapter.dispose();
    expect(adapter.unacknowledgedBytes).toBe(0);
    const sendsBeforeDispose = sent.length;
    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([2])));
    adapter.acceptPayload(fragments[1]!);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(sendsBeforeDispose);
    expect(faults).toHaveLength(0);
  });

  it("does not revive ACK state or timers when final delivery disposes reentrantly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: WebRemoteControlRpcTransportPayload[] = [];
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: (payload) => {
        sent.push(payload);
        return true;
      },
    });
    adapter.protocol.onMessage(() => {
      adapter.dispose();
    });

    adapter.acceptPayload(encodeAcknowledgedMessage(new Uint8Array([1]))[0]!);

    expect(sent).toHaveLength(0);
    expect(adapter.unacknowledgedBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(0);
  });

  it("does not revive replay state when saturation listener disposes reentrantly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let sends = 0;
    const adapter = createAcknowledgedWebRemoteControlRelayProtocol({
      ...acknowledgedIdentity,
      sendFrame: () => {
        sends += 1;
        return true;
      },
      saturationHighWaterMarkBytes: 1,
      saturationLowWaterMarkBytes: 0,
    });
    adapter.onSaturated(() => {
      adapter.dispose();
    });

    adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));

    expect(sends).toBe(0);
    expect(adapter.unacknowledgedBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a non-drained flush when data or ACK send callback disposes reentrantly", () => {
    for (const payloadKind of ["data", "ack"] as const) {
      let disposeDuringSend = false;
      let adapter: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
      adapter = createAcknowledgedWebRemoteControlRelayProtocol({
        ...acknowledgedIdentity,
        sendFrame: () => {
          if (disposeDuringSend) {
            adapter.dispose();
            return true;
          }
          return false;
        },
      });
      adapter.protocol.onMessage(() => {});
      if (payloadKind === "data") {
        adapter.protocol.send(VSBuffer.wrap(new Uint8Array([1])));
      } else {
        adapter.acceptPayload(encodeAcknowledgedMessage(new Uint8Array([1]))[0]!);
      }

      disposeDuringSend = true;
      expect(adapter.flushPendingFrames()).toBe(false);
      expect(adapter.unacknowledgedBytes).toBe(0);
    }
  });
});
