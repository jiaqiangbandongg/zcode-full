import { describe, expect, it } from "vitest";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  WebRemoteControlRpcTransportAssembler,
  WebRemoteControlRpcTransportEncodingError,
  encodeWebRemoteControlRpcTransportMessage,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
  parseWebRemoteControlRpcRelayEnvelopeJson,
  webRemoteControlRpcRelayEnvelopeSchema,
  webRemoteControlRpcTransportAckSchema,
  webRemoteControlRpcTransportFrameSchema,
  webRemoteControlRpcTransportPayloadSchema,
  type WebRemoteControlRpcTransportFramePayload,
  type WebRemoteControlRpcTransportIdentity,
} from "../src/web-remote-control-rpc-transport.js";

const identity: WebRemoteControlRpcTransportIdentity = {
  bridgeSessionId: "bridge-1",
  bridgeGeneration: 2,
  recoveryId: "recovery-1",
};

function frame(
  overrides: Partial<WebRemoteControlRpcTransportFramePayload> = {},
): WebRemoteControlRpcTransportFramePayload {
  return {
    zcode_type: "rpc-frame",
    ...identity,
    seq: 1,
    messageSeq: 1,
    fragmentIndex: 0,
    fragmentCount: 1,
    messageBytes: 3,
    checksum: { algorithm: "crc32", value: "55bc801d" },
    dataBase64: "AQID",
    ...overrides,
  };
}

function encoderOptions(
  overrides: Partial<{
    bridgeSessionId: string;
    bridgeGeneration: number;
    recoveryId: string;
    firstPhysicalSeq: number;
    messageSeq: number;
    maxPhysicalFrameBytes: number;
    maxMessageBytes: number;
    maxFragments: number;
  }> = {},
) {
  return {
    ...identity,
    firstPhysicalSeq: 1,
    messageSeq: 1,
    ...overrides,
  };
}

describe("mobile raw RPC transport schemas", () => {
  it("严格接受合法 frame/ACK，拒绝多余字段、非法联动与非安全整数", () => {
    expect(webRemoteControlRpcTransportFrameSchema.safeParse(frame()).success).toBe(true);
    expect(
      webRemoteControlRpcTransportAckSchema.safeParse({
        zcode_type: "rpc-frame-ack",
        ...identity,
        ackMessageSeq: 1,
      }).success,
    ).toBe(true);
    expect(webRemoteControlRpcTransportPayloadSchema.safeParse(frame()).success).toBe(true);
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({ ...frame(), extra: true }).success,
    ).toBe(false);
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({
        ...frame(),
        checksum: { algorithm: "crc32", value: "55bc801d", extra: true },
      }).success,
    ).toBe(false);
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({
        ...frame(),
        fragmentIndex: 1,
        fragmentCount: 1,
      }).success,
    ).toBe(false);
    for (const key of ["seq", "messageSeq", "bridgeGeneration"] as const) {
      expect(
        webRemoteControlRpcTransportFrameSchema.safeParse({
          ...frame(),
          [key]: Number.MAX_SAFE_INTEGER + 1,
        }).success,
      ).toBe(false);
    }
    expect(
      webRemoteControlRpcTransportAckSchema.safeParse({
        zcode_type: "rpc-frame-ack",
        ...identity,
        ackMessageSeq: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it("transport identity 只接受 1..256 个 JSON-safe ASCII 字符", () => {
    const maxId = "~".repeat(256);
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({
        ...frame(),
        bridgeSessionId: maxId,
        recoveryId: maxId,
      }).success,
    ).toBe(true);
    for (const invalid of ["", "x".repeat(257), "bad id", 'bad"id', "中文", "🙂"]) {
      expect(
        webRemoteControlRpcTransportFrameSchema.safeParse({
          ...frame(),
          bridgeSessionId: invalid,
        }).success,
      ).toBe(false);
    }
  });

  it("拒绝非 canonical base64、空 chunk、16MiB+1 与第 65 片", () => {
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({ ...frame(), dataBase64: "AB==" }).success,
    ).toBe(false);
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({ ...frame(), dataBase64: "" }).success,
    ).toBe(false);
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({
        ...frame(),
        messageBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes + 1,
      }).success,
    ).toBe(false);
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({
        ...frame(),
        fragmentCount: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments + 1,
        messageBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments + 1,
      }).success,
    ).toBe(false);
  });

  it("relay envelope 与 raw JSON parser 都 strict，并精确执行 1MiB-1/1MiB/+1", () => {
    const envelope = {
      type: "data" as const,
      payload: frame(),
      client_ts: Number.MAX_SAFE_INTEGER,
      server_ts: Number.MAX_SAFE_INTEGER,
    };
    expect(webRemoteControlRpcRelayEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      webRemoteControlRpcRelayEnvelopeSchema.safeParse({ ...envelope, extra: true }).success,
    ).toBe(false);
    const rawEnvelope = JSON.stringify(envelope);
    for (const exactBytes of [
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes - 1,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    ]) {
      const bounded = `${rawEnvelope}${" ".repeat(exactBytes - rawEnvelope.length)}`;
      expect(parseWebRemoteControlRpcRelayEnvelopeJson(bounded)).toMatchObject({
        kind: "accepted",
        bytes: exactBytes,
      });
    }
    const oversized = `${rawEnvelope}${" ".repeat(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 1 - rawEnvelope.length,
    )}`;
    const result = parseWebRemoteControlRpcRelayEnvelopeJson(oversized);
    expect(result).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.envelopeTooLarge" },
    });
  });
});

describe("mobile raw RPC exact encoder", () => {
  it("小消息单片编码，meter 与最终双 timestamp JSON UTF-8 bytes 完全一致", () => {
    const encoded = encodeWebRemoteControlRpcTransportMessage(
      new Uint8Array([1, 2, 3]),
      encoderOptions(),
    );
    expect(encoded).toHaveLength(1);
    expect(encoded[0]).toMatchObject({
      ...identity,
      seq: 1,
      messageSeq: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: 3,
      dataBase64: "AQID",
    });
    const actual = new TextEncoder().encode(
      JSON.stringify({
        type: "data",
        payload: encoded[0],
        client_ts: Number.MAX_SAFE_INTEGER,
        server_ts: Number.MAX_SAFE_INTEGER,
      }),
    ).byteLength;
    expect(measureWebRemoteControlRpcRelayEnvelopeBytes(encoded[0]!)).toBe(actual);
  });

  it("最大 identity/sequence 下二分分片，每个最终 relay JSON 都 <=1MiB", () => {
    const maxId = "x".repeat(256);
    const bytes = new Uint8Array(2 * 1024 * 1024 + 7);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;
    const encoded = encodeWebRemoteControlRpcTransportMessage(bytes, {
      bridgeSessionId: maxId,
      bridgeGeneration: Number.MAX_SAFE_INTEGER,
      recoveryId: maxId,
      firstPhysicalSeq: Number.MAX_SAFE_INTEGER - 10,
      messageSeq: Number.MAX_SAFE_INTEGER,
    });
    expect(encoded.length).toBeGreaterThan(1);
    for (const payload of encoded) {
      expect(measureWebRemoteControlRpcRelayEnvelopeBytes(payload)).toBeLessThanOrEqual(
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      );
    }
    expect(encoded.at(-1)?.seq).toBe(Number.MAX_SAFE_INTEGER - 10 + encoded.length - 1);
  });

  it("16MiB 正好可编码；empty、16MiB+1 与 physical seq range overflow 明确拒绝", () => {
    expect(
      encodeWebRemoteControlRpcTransportMessage(
        new Uint8Array(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes),
        encoderOptions(),
      ).length,
    ).toBeLessThanOrEqual(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments);

    for (const operation of [
      () => encodeWebRemoteControlRpcTransportMessage(new Uint8Array(), encoderOptions()),
      () =>
        encodeWebRemoteControlRpcTransportMessage(
          new Uint8Array(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes + 1),
          encoderOptions(),
        ),
      () =>
        encodeWebRemoteControlRpcTransportMessage(
          new Uint8Array(1024 * 1024),
          encoderOptions({ firstPhysicalSeq: Number.MAX_SAFE_INTEGER }),
        ),
    ]) {
      expect(operation).toThrow(WebRemoteControlRpcTransportEncodingError);
    }
  });

  it("调用方不能放宽 hard limits，极小 outer budget 会触发 fragment limit", () => {
    expect(() =>
      encodeWebRemoteControlRpcTransportMessage(
        new Uint8Array(256 * 1024),
        encoderOptions({ maxPhysicalFrameBytes: 1024, maxFragments: 2 }),
      ),
    ).toThrow(WebRemoteControlRpcTransportEncodingError);
    const encoded = encodeWebRemoteControlRpcTransportMessage(
      new Uint8Array([1]),
      encoderOptions({
        maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 1,
        maxMessageBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes + 1,
        maxFragments: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments + 1,
      }),
    );
    expect(encoded).toHaveLength(1);
  });

  it("exact 64 fragments 可编码并还原，第 65 片需求由 encoder 明确拒绝", () => {
    const bytes = new Uint8Array(192);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;
    const exactThreeByteBudget = measureWebRemoteControlRpcRelayEnvelopeBytes(
      frame({
        seq: 64,
        messageSeq: 1,
        fragmentIndex: 63,
        fragmentCount: 64,
        messageBytes: bytes.byteLength,
        dataBase64: "AQID",
      }),
    );
    const encoded = encodeWebRemoteControlRpcTransportMessage(
      bytes,
      encoderOptions({
        maxPhysicalFrameBytes: exactThreeByteBudget,
        maxFragments: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments,
      }),
    );
    expect(encoded).toHaveLength(64);
    expect(() =>
      encodeWebRemoteControlRpcTransportMessage(
        bytes,
        encoderOptions({
          maxPhysicalFrameBytes: exactThreeByteBudget,
          maxFragments: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments - 1,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ reasonCode: "remote.rpcFrame.fragmentLimitExceeded" }),
    );
    expect(() =>
      encodeWebRemoteControlRpcTransportMessage(
        new Uint8Array(bytes.byteLength + 1),
        encoderOptions({
          maxPhysicalFrameBytes: exactThreeByteBudget,
          maxFragments: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ reasonCode: "remote.rpcFrame.fragmentLimitExceeded" }),
    );

    const assembler = new WebRemoteControlRpcTransportAssembler({
      identity,
      maxPhysicalFrameBytes: exactThreeByteBudget,
    });
    let result = assembler.accept(encoded[0]!);
    for (const payload of encoded.slice(1)) result = assembler.accept(payload);
    expect(result).toMatchObject({ kind: "complete", messageSeq: 1 });
    if (result.kind !== "complete") throw new Error("expected complete");
    expect(result.bytes).toEqual(bytes);
  });
});

describe("mobile raw RPC one-message assembler", () => {
  it("最后一片前不交付，完整后只原子交付一次，旧 replay 只报 duplicate", () => {
    const bytes = new TextEncoder().encode("中🙂".repeat(200_000));
    const encoded = encodeWebRemoteControlRpcTransportMessage(bytes, encoderOptions());
    const assembler = new WebRemoteControlRpcTransportAssembler({ identity });
    for (const payload of encoded.slice(0, -1)) {
      expect(assembler.accept(payload)).toMatchObject({ kind: "incomplete" });
    }
    const completed = assembler.accept(encoded.at(-1)!);
    expect(completed).toMatchObject({ kind: "complete", messageSeq: 1 });
    if (completed.kind !== "complete") throw new Error("expected complete");
    expect(completed.bytes).toEqual(bytes);
    for (const replayed of encoded) {
      expect(assembler.accept(replayed)).toMatchObject({
        kind: "duplicate",
        ackMessageSeq: 1,
      });
    }
    expect(assembler.accept({ ...encoded[0]!, dataBase64: "AA==" })).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.conflictingDuplicate" },
    });
  });

  it("相同 active duplicate no-op 且不续期；冲突 duplicate typed fault", () => {
    const encoded = encodeWebRemoteControlRpcTransportMessage(
      new Uint8Array(1024 * 1024),
      encoderOptions(),
    );
    expect(encoded.length).toBeGreaterThan(1);
    const assembler = new WebRemoteControlRpcTransportAssembler({ identity, timeoutMs: 10 });
    expect(assembler.accept(encoded[0]!, 0).kind).toBe("incomplete");
    expect(assembler.accept(encoded[0]!, 9)).toEqual({
      kind: "duplicate",
      ackMessageSeq: null,
    });
    expect(assembler.expire(10)).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.assemblyTimeout" },
    });

    const conflicting = new WebRemoteControlRpcTransportAssembler({ identity });
    expect(conflicting.accept(encoded[0]!).kind).toBe("incomplete");
    expect(conflicting.accept({ ...encoded[0]!, dataBase64: "AA==" })).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.conflictingDuplicate" },
    });
  });

  it("physical/message/fragment gap 与 metadata/length/CRC 错误均 typed fault", () => {
    const two = encodeWebRemoteControlRpcTransportMessage(
      new Uint8Array(1024 * 1024),
      encoderOptions(),
    );
    expect(two.length).toBeGreaterThan(1);
    const cases: Array<{
      mutate(payloads: WebRemoteControlRpcTransportFramePayload[]): unknown;
      reasonCode: string;
    }> = [
      {
        mutate: (payloads) => ({ ...payloads[0], seq: payloads[0]!.seq + 1 }),
        reasonCode: "remote.rpcFrame.physicalGap",
      },
      {
        mutate: (payloads) => ({ ...payloads[0], messageSeq: 2 }),
        reasonCode: "remote.rpcFrame.messageGap",
      },
      {
        mutate: (payloads) => ({ ...payloads[0], fragmentIndex: 1 }),
        reasonCode: "remote.rpcFrame.fragmentGap",
      },
      {
        mutate: (payloads) => ({
          ...payloads[0],
          checksum: { algorithm: "crc32", value: "00000000" },
        }),
        reasonCode: "remote.rpcFrame.checksumMismatch",
      },
      {
        mutate: (payloads) => ({
          ...payloads[0],
          messageBytes: payloads[0]!.fragmentCount,
        }),
        reasonCode: "remote.rpcFrame.lengthMismatch",
      },
    ];
    for (const testCase of cases) {
      const assembler = new WebRemoteControlRpcTransportAssembler({ identity });
      const mutated = testCase.mutate([...two]);
      let result = assembler.accept(mutated);
      if (result.kind === "incomplete") {
        for (const payload of two.slice(1)) result = assembler.accept(payload);
      }
      expect(result).toMatchObject({
        kind: "fault",
        fault: { reasonCode: testCase.reasonCode },
      });
    }
  });

  it("跨片 metadata/checksum 冲突与最终 whole-message CRC 错误可区分", () => {
    const encoded = encodeWebRemoteControlRpcTransportMessage(
      new Uint8Array(1024 * 1024),
      encoderOptions(),
    );
    expect(encoded.length).toBeGreaterThan(1);

    const metadataConflict = new WebRemoteControlRpcTransportAssembler({ identity });
    expect(metadataConflict.accept(encoded[0]!).kind).toBe("incomplete");
    expect(
      metadataConflict.accept({
        ...encoded[1]!,
        messageBytes: encoded[1]!.messageBytes + 1,
      }),
    ).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.metadataMismatch" },
    });

    const checksumConflict = new WebRemoteControlRpcTransportAssembler({ identity });
    expect(checksumConflict.accept(encoded[0]!).kind).toBe("incomplete");
    expect(
      checksumConflict.accept({
        ...encoded[1]!,
        checksum: { algorithm: "crc32", value: "00000000" },
      }),
    ).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.checksumMismatch" },
    });

    const finalCrcMismatch = new WebRemoteControlRpcTransportAssembler({ identity });
    let finalResult = finalCrcMismatch.accept({
      ...encoded[0]!,
      checksum: { algorithm: "crc32", value: "00000000" },
    });
    for (const payload of encoded.slice(1)) {
      finalResult = finalCrcMismatch.accept({
        ...payload,
        checksum: { algorithm: "crc32", value: "00000000" },
      });
    }
    expect(finalResult).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.checksumMismatch" },
    });
  });

  it("foreign identity/generation/recovery 不推进、解码或清空 owning assembly", () => {
    const bytes = new Uint8Array(1024 * 1024);
    bytes[0] = 7;
    const encoded = encodeWebRemoteControlRpcTransportMessage(bytes, encoderOptions());
    const assembler = new WebRemoteControlRpcTransportAssembler({ identity });
    expect(assembler.accept(encoded[0]!).kind).toBe("incomplete");
    for (const foreignIdentity of [
      { bridgeSessionId: "foreign" },
      { bridgeGeneration: identity.bridgeGeneration! + 1 },
      { recoveryId: "foreign" },
    ]) {
      expect(assembler.accept({ ...encoded[1]!, ...foreignIdentity })).toMatchObject({
        kind: "fault",
        fault: { reasonCode: "remote.rpcFrame.identityMismatch", terminal: false },
      });
    }
    let result = assembler.accept(encoded[1]!);
    for (const payload of encoded.slice(2)) result = assembler.accept(payload);
    expect(result).toMatchObject({ kind: "complete", messageSeq: 1 });

    const timeoutAssembler = new WebRemoteControlRpcTransportAssembler({
      identity,
      timeoutMs: 10,
    });
    expect(timeoutAssembler.accept(encoded[0]!, 0).kind).toBe("incomplete");
    expect(
      timeoutAssembler.accept(
        { ...encoded[1]!, bridgeSessionId: "foreign", dataBase64: "AB==" },
        10,
      ),
    ).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.identityMismatch", terminal: false },
    });
    expect(timeoutAssembler.expire(10)).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.assemblyTimeout", terminal: true },
    });
  });

  it("连续 message 累计 tombstone 防二次交付，并只回最新 completed ACK", () => {
    const first = encodeWebRemoteControlRpcTransportMessage(
      new TextEncoder().encode("first"),
      encoderOptions(),
    );
    const second = encodeWebRemoteControlRpcTransportMessage(
      new TextEncoder().encode("second"),
      encoderOptions({ firstPhysicalSeq: first.length + 1, messageSeq: 2 }),
    );
    const assembler = new WebRemoteControlRpcTransportAssembler({ identity });
    expect(assembler.accept(first[0]!)).toMatchObject({ kind: "complete", messageSeq: 1 });
    expect(assembler.accept(second[0]!)).toMatchObject({ kind: "complete", messageSeq: 2 });
    for (const replayed of [...first, ...second]) {
      expect(assembler.accept(replayed)).toEqual({ kind: "duplicate", ackMessageSeq: 2 });
    }
  });

  it("MAX_SAFE physical/message sequence 收口后要求新 bridge generation", () => {
    const physical = new WebRemoteControlRpcTransportAssembler({
      identity,
      initialPhysicalSeq: Number.MAX_SAFE_INTEGER,
    });
    const lastPhysical = frame({ seq: Number.MAX_SAFE_INTEGER });
    expect(physical.accept(lastPhysical)).toMatchObject({ kind: "complete" });
    expect(physical.accept(lastPhysical)).toEqual({ kind: "duplicate", ackMessageSeq: 1 });
    expect(physical.accept({ ...lastPhysical, messageSeq: 2, dataBase64: "AA==" })).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.physicalSequenceExhausted" },
    });

    const unfinishedPhysical = new WebRemoteControlRpcTransportAssembler({
      identity,
      initialPhysicalSeq: Number.MAX_SAFE_INTEGER,
    });
    expect(
      unfinishedPhysical.accept(
        frame({
          seq: Number.MAX_SAFE_INTEGER,
          fragmentCount: 2,
          messageBytes: 6,
        }),
      ),
    ).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.physicalSequenceExhausted" },
    });

    const message = new WebRemoteControlRpcTransportAssembler({
      identity,
      initialMessageSeq: Number.MAX_SAFE_INTEGER,
    });
    expect(message.accept(frame({ messageSeq: Number.MAX_SAFE_INTEGER }))).toMatchObject({
      kind: "complete",
    });
    expect(message.accept(frame({ seq: 2, messageSeq: Number.MAX_SAFE_INTEGER }))).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.messageSequenceExhausted" },
    });
  });

  it("invalid base64 candidate 产生 typed fault，而不是异常或静默丢弃", () => {
    const assembler = new WebRemoteControlRpcTransportAssembler({ identity });
    expect(assembler.accept({ ...frame(), dataBase64: "AB==" })).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.invalidBase64" },
    });
    const oversizedBase64 = new WebRemoteControlRpcTransportAssembler({ identity });
    expect(
      oversizedBase64.accept({
        ...frame(),
        dataBase64: "A".repeat(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 4),
      }),
    ).toMatchObject({
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.invalidBase64" },
    });
  });
});
