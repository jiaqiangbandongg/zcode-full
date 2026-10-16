import { describe, expect, it } from "vitest";
import {
  PROTOCOL_V4_LIMITS,
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
  conversationTopicWireCandidateSchema,
  conversationTopicWireFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  reassembleTopicWireFrames,
  routedTopicFrameSchema,
  routedTopicWireFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  workspaceConfigTopicWireFrameSchema,
  type ConversationTopicFrame,
  type RoutedTopicWireFrame,
  type SessionsIndexTopicFrame,
  type WorkspaceConfigTopicFrame,
} from "../src/zcode-protocol-v4/index.js";
import { crc32WireBytes, encodeWireBytesBase64 } from "../src/zcode-protocol-v4/wire-binary.js";

const encoder = new TextEncoder();
const TOPIC = "conversation/session-physical";
const SUBSCRIPTION_ID = "sub-physical";

function conversationFrame(text = "hello"): ConversationTopicFrame {
  return {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq: 1,
    toSeq: 2,
    sentAt: 1_700_000_000_000,
    payload: {
      kind: "deltas",
      deltas: [{ op: "row.delta", rowId: 1, path: "text", append: text }],
    },
  };
}

function sessionsIndexFrame(): SessionsIndexTopicFrame {
  return {
    topic: "sessions-index/workspace-physical",
    subscriptionId: "sub-index",
    fromSeq: 0,
    toSeq: 0,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "workspace-physical",
        logEpoch: "epoch-index",
        sessions: [],
      },
    },
  };
}

function workspaceConfigFrame(): WorkspaceConfigTopicFrame {
  return {
    topic: "workspace-config/workspace-physical",
    subscriptionId: "sub-config",
    fromSeq: 0,
    toSeq: 0,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "workspace-physical",
        logEpoch: "epoch-config",
        config: { configOptions: [], slashCommands: [] },
      },
    },
  };
}

function completeWire<F extends { topic: string; subscriptionId: string }>(
  logicalFrameId: string,
  frame: F,
  logicalFrameOrdinal = 1,
  deliveryKind: "initial" | "online" | "recovery" = "online",
) {
  return {
    wireVersion: 3 as const,
    kind: "complete" as const,
    deliveryKind,
    logicalFrameId,
    logicalFrameOrdinal,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

function fragmentedWire(
  frame: ConversationTopicFrame,
  logicalFrameId: string,
  fragmentCount: number,
  logicalFrameOrdinal = 1,
): RoutedTopicWireFrame[] {
  const logical = encoder.encode(JSON.stringify(frame));
  expect(logical.byteLength).toBeGreaterThanOrEqual(fragmentCount);
  const checksum = { algorithm: "crc32" as const, value: crc32WireBytes(logical) };
  const wires: RoutedTopicWireFrame[] = [];
  let offset = 0;
  for (let index = 0; index < fragmentCount; index += 1) {
    const remainingBytes = logical.byteLength - offset;
    const remainingFragments = fragmentCount - index;
    const size = Math.ceil(remainingBytes / remainingFragments);
    const bytes = logical.subarray(offset, offset + size);
    offset += size;
    wires.push({
      wireVersion: 3,
      kind: "fragment",
      deliveryKind: "online",
      logicalFrameId,
      logicalFrameOrdinal,
      topic: frame.topic,
      subscriptionId: frame.subscriptionId,
      fragmentIndex: index,
      fragmentCount,
      logicalBytes: logical.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(bytes),
    });
  }
  return wires;
}

function singleFragment(params: {
  logicalFrameId: string;
  logicalFrameOrdinal?: number;
  topic?: string;
  subscriptionId?: string;
  bytes: Uint8Array;
  logicalBytes?: number;
  checksum?: string;
}): RoutedTopicWireFrame {
  return {
    wireVersion: 3,
    kind: "fragment",
    deliveryKind: "online",
    logicalFrameId: params.logicalFrameId,
    logicalFrameOrdinal: params.logicalFrameOrdinal ?? 1,
    topic: params.topic ?? TOPIC,
    subscriptionId: params.subscriptionId ?? SUBSCRIPTION_ID,
    fragmentIndex: 0,
    fragmentCount: 1,
    logicalBytes: params.logicalBytes ?? params.bytes.byteLength,
    checksum: {
      algorithm: "crc32",
      value: params.checksum ?? crc32WireBytes(params.bytes),
    },
    dataBase64: encodeWireBytesBase64(params.bytes),
  };
}

describe("V4 三 topic physical schema 与真实 envelope", () => {
  it("三 topic physical schema 与 routed logical/physical union 均 strict", () => {
    const conversation = conversationFrame();
    const index = sessionsIndexFrame();
    const config = workspaceConfigFrame();
    expect(conversationTopicWireFrameSchema.parse(completeWire("c", conversation))).toBeTruthy();
    expect(sessionsIndexTopicWireFrameSchema.parse(completeWire("i", index))).toBeTruthy();
    expect(workspaceConfigTopicWireFrameSchema.parse(completeWire("w", config))).toBeTruthy();
    expect(routedTopicFrameSchema.parse(conversation)).toEqual(conversation);
    expect(routedTopicFrameSchema.parse(index)).toEqual(index);
    expect(routedTopicFrameSchema.parse(config)).toEqual(config);
    expect(routedTopicWireFrameSchema.parse(completeWire("i", index))).toBeTruthy();

    const validDelivery = completeWire("delivery", conversation, 1, "recovery");
    expect(conversationTopicWireFrameSchema.parse(validDelivery).deliveryKind).toBe("recovery");
    const { deliveryKind: _deliveryKind, ...missingDeliveryKind } = validDelivery;
    for (const invalidDelivery of [missingDeliveryKind, { ...validDelivery, deliveryKind: "guessed" }]) {
      const ownedCandidate = conversationTopicWireCandidateSchema.parse(invalidDelivery);
      expect(
        new TopicWireFrameAssembler(conversationTopicFrameSchema).accept(ownedCandidate),
      ).toMatchObject([
        { kind: "fault", fault: { reasonCode: "proto.frameAssemblyMetadataMismatch" } },
      ]);
      expect(conversationTopicWireFrameSchema.safeParse(invalidDelivery).success).toBe(false);
    }

    expect(
      sessionsIndexTopicWireFrameSchema.safeParse(completeWire("bad", conversation)).success,
    ).toBe(false);
    expect(
      workspaceConfigTopicWireFrameSchema.safeParse({
        ...completeWire("extra", config),
        unexpected: true,
      }).success,
    ).toBe(false);

    const invalidBase64 = {
      ...fragmentedWire(conversation, "candidate", 1)[0]!,
      dataBase64: "%%%",
    };
    expect(conversationTopicWireCandidateSchema.safeParse(invalidBase64).success).toBe(true);
    expect(conversationTopicWireFrameSchema.safeParse(invalidBase64).success).toBe(false);

    const validFragment = fragmentedWire(conversation, "candidate-inner", 1)[0]!;
    const { checksum: _checksum, ...missingChecksum } = validFragment;
    const routeableInvalid = [
      missingChecksum,
      { ...validFragment, checksum: { algorithm: "crc32", value: 1 } },
      { ...validFragment, dataBase64: 1 },
      { ...validFragment, unexpected: true },
      { ...validFragment, checksum: { ...validFragment.checksum, unexpected: true } },
    ];
    for (const candidate of routeableInvalid) {
      const outer = conversationTopicWireCandidateSchema.parse(candidate);
      expect(
        new TopicWireFrameAssembler(conversationTopicFrameSchema).accept(outer),
      ).toMatchObject([
        { kind: "fault", fault: { reasonCode: "proto.frameAssemblyMetadataMismatch" } },
      ]);
    }
  });

  it("CLI NDJSON、Channel/Socket 与 mobile relay outer 都机械保持 1MiB 边界", () => {
    const max = PROTOCOL_V4_LIMITS.maxFrameBytes;
    for (const limit of [max - 1, max, max + 1]) {
      const frame = conversationFrame("中文🙂".repeat(160_000));
      const wires = encodeTopicWireFrames(frame, {
        deliveryKind: "online",
        topic: frame.topic,
        subscriptionId: frame.subscriptionId,
        logicalFrameId: `meter-${limit}`,
        logicalFrameOrdinal: 1,
        maxPhysicalFrameBytes: limit,
        measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
      });
      expect(wires.length).toBeGreaterThan(1);
      for (const wire of wires) {
        const measured = measureTopicNotificationEnvelopeBytes(wire);
        const productionLimit = Math.min(limit, max);
        expect(measured.cliNdjsonBytes).toBeLessThanOrEqual(productionLimit);
        expect(measured.channelSocketBytes).toBeLessThanOrEqual(productionLimit);
        expect(measured.mobileRelayBytes).toBeLessThanOrEqual(productionLimit);
      }
    }

    const boundary = conversationFrame("boundary");
    for (const completeBytes of [max - 1, max]) {
      expect(
        encodeTopicWireFrames(boundary, {
          deliveryKind: "initial",
          topic: boundary.topic,
          subscriptionId: boundary.subscriptionId,
          logicalFrameId: `exact-${completeBytes}`,
          logicalFrameOrdinal: 1,
          measurePhysicalFrameBytes: (wire) => (wire.kind === "complete" ? completeBytes : max),
        }),
      ).toHaveLength(1);
    }
    const plusOne = encodeTopicWireFrames(boundary, {
      deliveryKind: "recovery",
      topic: boundary.topic,
      subscriptionId: boundary.subscriptionId,
      logicalFrameId: "exact-plus-one",
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (wire) => (wire.kind === "complete" ? max + 1 : max),
    });
    expect(plusOne.every((wire) => wire.kind === "fragment")).toBe(true);
  });
});

describe("TopicWireFrameAssembler incremental 原子状态机", () => {
  it("最后一片前不产 logical frame；乱序、相同重复片只完成一次", () => {
    const frame = conversationFrame("中文🙂".repeat(300));
    const wires = fragmentedWire(frame, "logical-atomic", 12);
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const apply: ConversationTopicFrame[] = [];
    for (const wire of [...wires].reverse().slice(0, -1)) {
      for (const event of assembler.accept(wire, 1)) {
        if (event.kind === "complete") apply.push(event.frame);
      }
    }
    expect(apply).toEqual([]);
    expect(assembler.accept(wires.at(-1)!, 2)).toEqual([]); // identical duplicate
    const final = assembler.accept(wires[0]!, 3);
    expect(final).toEqual([{ kind: "complete", frame, deliveryKind: "online" }]);
    expect(assembler.accept(wires[0]!, 4)).toEqual([]); // completed id duplicate
  });

  it("冲突重复片、checksum、base64、UTF-8、JSON、schema mismatch 都 typed fault 并释放", () => {
    const frame = conversationFrame("conflict".repeat(100));
    const wires = fragmentedWire(frame, "logical-conflict", 2);
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    expect(assembler.accept(wires[0]!, 0)).toEqual([]);
    const conflict = {
      ...wires[0]!,
      dataBase64: encodeWireBytesBase64(Uint8Array.of(1, 2, 3)),
    };
    expect(assembler.accept(conflict, 1)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyFragmentConflict" } },
    ]);
    expect(assembler.getStats()).toEqual({ assemblies: 0, stagedDecodedBytes: 0 });

    const checksum = fragmentedWire(frame, "logical-checksum", 2, 2).map((wire) => ({
      ...wire,
      checksum: { algorithm: "crc32" as const, value: "00000000" },
    }));
    expect(checksum.flatMap((wire) => assembler.accept(wire, 2))).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyChecksumMismatch" } },
    ]);

    expect(
      assembler.accept(
        {
          ...singleFragment({
            logicalFrameId: "bad-base64",
            logicalFrameOrdinal: 3,
            bytes: Uint8Array.of(0),
          }),
          dataBase64: "%%%=",
        },
        3,
      ),
    ).toMatchObject([{ kind: "fault", fault: { reasonCode: "proto.frameAssemblyInvalidBase64" } }]);
    expect(
      assembler.accept(
        singleFragment({
          logicalFrameId: "bad-utf8",
          logicalFrameOrdinal: 4,
          bytes: Uint8Array.of(0xff),
        }),
        4,
      ),
    ).toMatchObject([{ kind: "fault", fault: { reasonCode: "proto.frameAssemblyInvalidUtf8" } }]);
    const invalidJson = encoder.encode("not-json");
    expect(
      assembler.accept(
        singleFragment({
          logicalFrameId: "bad-json",
          logicalFrameOrdinal: 5,
          bytes: invalidJson,
        }),
        5,
      ),
    ).toMatchObject([{ kind: "fault", fault: { reasonCode: "proto.frameAssemblyInvalidJson" } }]);
    const invalidSchema = encoder.encode(
      JSON.stringify({ topic: TOPIC, subscriptionId: SUBSCRIPTION_ID }),
    );
    expect(
      assembler.accept(
        singleFragment({
          logicalFrameId: "bad-schema",
          logicalFrameOrdinal: 6,
          bytes: invalidSchema,
        }),
        6,
      ),
    ).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyInvalidPayload" } },
    ]);
  });

  it("新 logical id supersede 旧 assembly；超时从首片计算且重复片不续期", () => {
    const first = fragmentedWire(conversationFrame("first".repeat(100)), "logical-old", 2, 1);
    const next = fragmentedWire(conversationFrame("next".repeat(100)), "logical-new", 2, 2);
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema, {
      timeoutMs: 30_000,
    });
    expect(assembler.accept(first[0]!, 100)).toEqual([]);
    expect(assembler.accept(next[0]!, 200)).toMatchObject([
      {
        kind: "fault",
        fault: { logicalFrameId: "logical-old", reasonCode: "proto.frameAssemblySuperseded" },
      },
    ]);
    expect(assembler.accept(next[0]!, 29_999)).toEqual([]);
    expect(assembler.expire(30_199)).toEqual([]);
    expect(assembler.expire(30_200)).toMatchObject([
      {
        kind: "fault",
        fault: { logicalFrameId: "logical-new", reasonCode: "proto.frameAssemblyTimedOut" },
      },
    ]);
  });

  it("权威 recovery 可原子 supersede 旧 online 残片；fragment deliveryKind 不一致 fail closed", () => {
    const old = fragmentedWire(conversationFrame("old".repeat(100)), "logical-old-online", 2, 1);
    const recoveryFrame = conversationFrame("recovered");
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    expect(assembler.accept(old[0]!, 0)).toEqual([]);
    expect(
      assembler.accept(completeWire("logical-recovery", recoveryFrame, 2, "recovery"), 1),
    ).toEqual([{ kind: "complete", frame: recoveryFrame, deliveryKind: "recovery" }]);

    const mismatched = fragmentedWire(conversationFrame("mixed".repeat(100)), "logical-mixed-kind", 2, 3);
    expect(assembler.accept(mismatched[0]!, 2)).toEqual([]);
    expect(
      assembler.accept({ ...mismatched[1]!, deliveryKind: "recovery" }, 3),
    ).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyMetadataMismatch" } },
    ]);
  });

  it("ordinal 阻止 completed replay、反向 supersede 与同 ordinal 换 id", () => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const a = conversationFrame("A");
    const b = conversationFrame("B");
    const completeA = completeWire("logical-a", a, 1);
    const completeB = completeWire("logical-b", b, 2);
    expect(assembler.accept(completeA, 0)).toEqual([
      { kind: "complete", frame: a, deliveryKind: "online" },
    ]);
    expect(assembler.accept(completeB, 1)).toEqual([
      { kind: "complete", frame: b, deliveryKind: "online" },
    ]);
    expect(assembler.accept(completeA, 2)).toEqual([]);
    expect(assembler.accept(completeB, 3)).toEqual([]);
    expect(assembler.accept(completeWire("logical-b-conflict", b, 2), 4)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyOrdinalConflict" } },
    ]);

    const partial = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const old = fragmentedWire(conversationFrame("old".repeat(100)), "logical-old", 2, 1);
    const next = fragmentedWire(conversationFrame("next".repeat(100)), "logical-next", 2, 2);
    expect(partial.accept(old[0]!, 0)).toEqual([]);
    expect(partial.accept(next[0]!, 1)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblySuperseded" } },
    ]);
    expect(partial.accept(old[1]!, 2)).toEqual([]);
    expect(partial.accept(next[1]!, 3)).toEqual([
      {
        kind: "complete",
        frame: conversationFrame("next".repeat(100)),
        deliveryKind: "online",
      },
    ]);
  });

  it("同 ordinal/id 的 fragment 与 complete 混用只 fault，不同时 complete", () => {
    const frame = conversationFrame("mixed".repeat(100));
    const fragments = fragmentedWire(frame, "logical-mixed", 2, 1);
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    expect(assembler.accept(fragments[0]!, 0)).toEqual([]);
    expect(assembler.accept(completeWire("logical-mixed", frame, 1), 1)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyMetadataMismatch" } },
    ]);
    expect(assembler.getStats()).toEqual({ assemblies: 0, stagedDecodedBytes: 0 });
  });

  it("timeout 会 retire ordinal；触发 timeout 的迟到片与后续同 ordinal 不得重建", () => {
    const frame = conversationFrame("timeout".repeat(100));
    const fragments = fragmentedWire(frame, "logical-timeout", 2, 1);
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema, {
      timeoutMs: 30_000,
    });
    expect(assembler.accept(fragments[0]!, 100)).toEqual([]);
    expect(assembler.accept(fragments[0]!, 30_100)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyTimedOut" } },
    ]);
    expect(assembler.getStats()).toEqual({ assemblies: 0, stagedDecodedBytes: 0 });
    expect(assembler.accept(fragments[1]!, 30_101)).toEqual([]);
    expect(assembler.getStats()).toEqual({ assemblies: 0, stagedDecodedBytes: 0 });
  });

  it("16MiB 正好可完成，+1 明确拒绝；1024 片可完成、1025 schema 拒绝", () => {
    const max = PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes;
    const empty = conversationFrame("");
    const overhead = encoder.encode(JSON.stringify(empty)).byteLength;
    const exact = conversationFrame("x".repeat(max - overhead));
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const exactWires = encodeTopicWireFrames(exact, {
      deliveryKind: "online",
      topic: exact.topic,
      subscriptionId: exact.subscriptionId,
      logicalFrameId: "exact-16m",
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    });
    expect(exactWires.length).toBeGreaterThan(1);
    expect(exactWires.flatMap((wire) => assembler.accept(wire, 0))).toEqual([
      { kind: "complete", frame: exact, deliveryKind: "online" },
    ]);
    const tooLargeMetadata = {
      ...singleFragment({
        logicalFrameId: "over-16m",
        logicalFrameOrdinal: 2,
        bytes: Uint8Array.of(0),
        logicalBytes: max + 1,
      }),
      logicalBytes: max + 1,
    };
    expect(assembler.accept(tooLargeMetadata, 1)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyTooLarge" } },
    ]);
    expect(assembler.accept(completeWire("oversized-complete", exact, 3), 1)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameEnvelopeTooLarge" } },
    ]);

    const many = conversationFrame("y".repeat(2_000));
    const fragments = fragmentedWire(many, "logical-1024", 1_024, 4);
    const events = fragments.flatMap((wire) => assembler.accept(wire, 2));
    expect(events).toEqual([{ kind: "complete", frame: many, deliveryKind: "online" }]);
    expect(
      conversationTopicWireFrameSchema.safeParse({
        ...fragments[0],
        fragmentCount: 1_025,
        logicalBytes: 1_025,
      }).success,
    ).toBe(false);
  });

  it("调用方不能用 options 放宽 assembler/codec/reassembly 协议硬上限", () => {
    const limits = PROTOCOL_V4_LIMITS;
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema, {
      maxAssemblyBytes: limits.logicalFrameAssemblyMaxBytes + 1,
      maxFragments: limits.logicalFrameAssemblyMaxFragments + 1,
      maxConcurrentAssemblies: limits.logicalFrameAssemblyMaxConcurrent + 1,
      maxStagedDecodedBytes: limits.logicalFrameAssemblyMaxStagedBytes + 1,
      timeoutMs: limits.logicalFrameAssemblyTimeoutMs + 1,
      maxPhysicalFrameBytes: limits.maxFrameBytes + 1,
    });
    expect(
      assembler as unknown as {
        maxAssemblyBytes: number;
        maxFragments: number;
        maxConcurrentAssemblies: number;
        maxStagedDecodedBytes: number;
        timeoutMs: number;
        maxPhysicalFrameBytes: number;
      },
    ).toMatchObject({
      maxAssemblyBytes: limits.logicalFrameAssemblyMaxBytes,
      maxFragments: limits.logicalFrameAssemblyMaxFragments,
      maxConcurrentAssemblies: limits.logicalFrameAssemblyMaxConcurrent,
      maxStagedDecodedBytes: limits.logicalFrameAssemblyMaxStagedBytes,
      timeoutMs: limits.logicalFrameAssemblyTimeoutMs,
      maxPhysicalFrameBytes: limits.maxFrameBytes,
    });
    expect(
      () => new TopicWireFrameAssembler(conversationTopicFrameSchema, { maxAssemblyBytes: NaN }),
    ).toThrow(/positive finite/u);

    const oversized = conversationFrame("x".repeat(limits.logicalFrameAssemblyMaxBytes));
    expect(() =>
      encodeTopicWireFrames(oversized, {
        deliveryKind: "online",
        topic: oversized.topic,
        subscriptionId: oversized.subscriptionId,
        logicalFrameId: "codec-hard-cap",
        logicalFrameOrdinal: 1,
        maxAssemblyBytes: limits.logicalFrameAssemblyMaxBytes + 1,
        maxPhysicalFrameBytes: limits.maxFrameBytes + 1,
        measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
      }),
    ).toThrow("proto.frameAssemblyTooLarge");
    expect(() =>
      encodeTopicWireFrames(conversationFrame(), {
        deliveryKind: "online",
        topic: TOPIC,
        subscriptionId: SUBSCRIPTION_ID,
        logicalFrameId: "codec-invalid-limit",
        logicalFrameOrdinal: 1,
        maxPhysicalFrameBytes: Number.POSITIVE_INFINITY,
        measurePhysicalFrameBytes: () => 1,
      }),
    ).toThrow("proto.invalidLimit.maxPhysicalFrameBytes");

    expect(
      reassembleTopicWireFrames(
        [completeWire("reassembly-hard-cap", oversized)],
        conversationTopicFrameSchema,
        { maxAssemblyBytes: limits.logicalFrameAssemblyMaxBytes + 1 },
      ),
    ).toEqual({ kind: "rejected", reasonCode: "proto.frameAssemblyTooLarge" });
    expect(
      reassembleTopicWireFrames(
        [completeWire("reassembly-invalid-limit", conversationFrame())],
        conversationTopicFrameSchema,
        { maxAssemblyBytes: NaN },
      ),
    ).toEqual({ kind: "rejected", reasonCode: "proto.invalidLimit.maxAssemblyBytes" });
  });

  it("第 33 个并发 assembly 与总 staging budget 溢出显式 fault，不驱逐健康项", () => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema, {
      maxConcurrentAssemblies: 32,
      maxStagedDecodedBytes: 32,
    });
    for (let index = 0; index < 32; index += 1) {
      const wire = {
        ...singleFragment({
          logicalFrameId: `logical-${index}`,
          topic: `conversation/session-${index}`,
          subscriptionId: `sub-${index}`,
          bytes: Uint8Array.of(index),
          logicalBytes: 2,
        }),
        fragmentCount: 2,
      };
      expect(assembler.accept(wire, index)).toEqual([]);
    }
    expect(assembler.getStats()).toEqual({ assemblies: 32, stagedDecodedBytes: 32 });
    const overflow = {
      ...singleFragment({
        logicalFrameId: "logical-33",
        topic: "conversation/session-33",
        subscriptionId: "sub-33",
        bytes: Uint8Array.of(33),
        logicalBytes: 2,
      }),
      fragmentCount: 2,
    };
    expect(assembler.accept(overflow, 33)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyConcurrentLimit" } },
    ]);
    expect(assembler.getStats()).toEqual({ assemblies: 32, stagedDecodedBytes: 32 });

    const budget = new TopicWireFrameAssembler(conversationTopicFrameSchema, {
      maxStagedDecodedBytes: 1,
    });
    expect(budget.accept({ ...overflow, logicalFrameId: "budget-one" }, 0)).toEqual([]);
    expect(
      budget.accept(
        { ...overflow, logicalFrameId: "budget-two", topic: "conversation/budget-two" },
        1,
      ),
    ).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblyBudgetExceeded" } },
    ]);
    expect(budget.getStats()).toEqual({ assemblies: 1, stagedDecodedBytes: 1 });
  });

  it("consumer fail-closed abort 释放 active bytes 但保留 ordinal tombstone", () => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const old = fragmentedWire(conversationFrame("old".repeat(100)), "logical-old", 2, 1);
    const newer = fragmentedWire(conversationFrame("newer".repeat(100)), "logical-newer", 2, 2);
    expect(assembler.accept(old[0]!, 0)).toEqual([]);
    expect(assembler.accept(newer[0]!, 1)).toMatchObject([
      { kind: "fault", fault: { reasonCode: "proto.frameAssemblySuperseded" } },
    ]);

    // consumer 对 [fault, possible complete] 整批 fail closed；abort 不能调用 discard，
    // 否则迟到旧片/当前片会从 ordinal 1 重新建 assembly 并复活已判坏序列。
    assembler.abort(TOPIC, SUBSCRIPTION_ID);
    expect(assembler.getStats()).toEqual({ assemblies: 0, stagedDecodedBytes: 0 });
    expect(assembler.accept(old[1]!, 2)).toEqual([]);
    expect(assembler.accept(newer[1]!, 3)).toEqual([]);

    const latest = conversationFrame("latest");
    expect(assembler.accept(completeWire("logical-latest", latest, 3), 4)).toEqual([
      { kind: "complete", frame: latest, deliveryKind: "online" },
    ]);
  });

  it("discard/clear 释放指定 subscription 与全部 assembly", () => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const a = fragmentedWire(conversationFrame("a".repeat(100)), "a", 2)[0]!;
    const b = { ...a, topic: "conversation/b", subscriptionId: "sub-b", logicalFrameId: "b" };
    assembler.accept(a, 0);
    assembler.accept(b, 0);
    assembler.discard(a.topic, a.subscriptionId);
    expect(assembler.getStats().assemblies).toBe(1);
    assembler.clear();
    expect(assembler.getStats()).toEqual({ assemblies: 0, stagedDecodedBytes: 0 });
  });
});
