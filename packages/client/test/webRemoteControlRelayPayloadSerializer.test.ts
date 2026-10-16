import { describe, expect, it } from "vitest";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  encodeWebRemoteControlRpcTransportMessage,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { WebRemoteControlRelayPayloadSerializer } from "../src/webRemoteControlRelayPayloadSerializer.js";

describe("WebRemoteControlRelayPayloadSerializer", () => {
  it("reuses the identical final JSON and byte count for one immutable raw payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const [payload] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });

    const first = serializer.prepare(payload, 100);
    const replay = serializer.prepare(payload, 200);

    expect(replay).toBe(first);
    expect(replay.json).toBe(first.json);
    expect(replay.message.client_ts).toBe(100);
    expect(replay.bytes).toBe(new TextEncoder().encode(replay.json).byteLength);
  });

  it("distinguishes a permanent oversize envelope from a bounded payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const bounded: WebRemoteControlAppPayload = {
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "中文🙂bounded",
    };
    const oversize: WebRemoteControlAppPayload = {
      zcode_type: "app-error",
      reason: "unexpected-error",
      error: "x".repeat(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes),
    };

    const preparedBounded = serializer.prepare(bounded, 1);
    expect(serializer.isOversize(preparedBounded)).toBe(false);
    expect(preparedBounded.bytes).toBe(new TextEncoder().encode(preparedBounded.json).byteLength);
    const preparedOversize = serializer.prepare(oversize, 1);
    expect(serializer.isOversize(preparedOversize)).toBe(true);
    expect(preparedOversize.bytes).toBeGreaterThan(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    );
  });
});
