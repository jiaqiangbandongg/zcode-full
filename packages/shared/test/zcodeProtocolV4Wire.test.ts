import { describe, expect, it } from "vitest";
import {
  PROTOCOL_V4_LIMITS,
  V4_NOTIFICATIONS,
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  conversationTopicFrameSchema,
  conversationTopicWireFrameSchema,
  encodeTopicWireFrames,
  helloMessageSchema,
  reassembleTopicWireFrames,
  toolCallRowSchema,
  toolOutputSchema,
  utf8JsonByteLength,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireFrame,
} from "../src/zcode-protocol-v4/index.js";
import {
  ZCODE_PROTOCOL_V4_WIRE_VERSION,
  ZCODE_PROTOCOL_VERSION,
} from "../src/zcode-protocol/index.js";

const TOPIC = "conversation/session-wire";
const SUBSCRIPTION_ID = "sub-wire";
const LOGICAL_FRAME_ID = "logical-wire";
const DELIVERY_KIND = "online" as const;

function makeFrame(append: string): ConversationTopicFrame {
  return {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq: 10,
    toSeq: 11,
    sentAt: 1_700_000_000_000,
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "row.delta",
          rowId: 1,
          path: "text",
          append,
        },
      ],
    },
  };
}

function makeSnapshotFrame(title: string): ConversationTopicFrame {
  const snapshot: ConversationSnapshot = {
    protocolVersion: 1,
    sessionId: "session-wire",
    logEpoch: "epoch-wire",
    seq: 11,
    revision: 1,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1_000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.noGoal" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title, titleSource: "custom" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: {
        usedTokens: 0,
        maxTokens: 200_000,
        autoCompactThresholdTokens: null,
      },
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    // 软门禁 additive 字段:归一化形态(带 default(null))
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
  return {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: 1_700_000_000_000,
    payload: { kind: "snapshot", snapshot },
  };
}

function notificationBytes(wire: ConversationTopicWireFrame): number {
  return new TextEncoder().encode(
    `${JSON.stringify({
      method: V4_NOTIFICATIONS.conversationFrame,
      params: wire,
    })}\n`,
  ).byteLength;
}

function encode(frame: ConversationTopicFrame, maxPhysicalFrameBytes?: number) {
  return encodeTopicWireFrames(frame, {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    logicalFrameId: LOGICAL_FRAME_ID,
    logicalFrameOrdinal: 1,
    deliveryKind: DELIVERY_KIND,
    ...(maxPhysicalFrameBytes === undefined ? {} : { maxPhysicalFrameBytes }),
    measurePhysicalFrameBytes: notificationBytes,
  });
}

function frameAtLogicalBytes(targetBytes: number): ConversationTopicFrame {
  const empty = makeFrame("");
  const overhead = utf8JsonByteLength(empty);
  expect(overhead).toBeLessThan(targetBytes);
  const frame = makeFrame("x".repeat(targetBytes - overhead));
  expect(utf8JsonByteLength(frame)).toBe(targetBytes);
  return frame;
}

function frameAtCompletePhysicalBytes(targetBytes: number): ConversationTopicFrame {
  const empty = makeFrame("");
  const emptyWire: ConversationTopicWireFrame = {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: DELIVERY_KIND,
    logicalFrameId: LOGICAL_FRAME_ID,
    logicalFrameOrdinal: 1,
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    frame: empty,
  };
  const overhead = notificationBytes(emptyWire);
  expect(overhead).toBeLessThan(targetBytes);
  const frame = makeFrame("x".repeat(targetBytes - overhead));
  const wire: ConversationTopicWireFrame = { ...emptyWire, frame };
  expect(notificationBytes(wire)).toBe(targetBytes);
  return frame;
}

describe("ZCode Protocol V4 wire v3", () => {
  it("硬切 V4 wire/hello 到 v3，但不改变 legacy 主协议版本", () => {
    expect(V4_WIRE_PROTOCOL_VERSION).toBe(3);
    expect(ZCODE_PROTOCOL_V4_WIRE_VERSION).toBe(3);
    expect(ZCODE_PROTOCOL_VERSION).toBe(1);
    expect(
      helloMessageSchema.safeParse({
        kind: "hello",
        protocolVersion: 3,
        connectionId: "connection-1",
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: 1,
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      }).success,
    ).toBe(true);
    expect(
      helloMessageSchema.safeParse({
        kind: "hello",
        protocolVersion: 1,
        connectionId: "connection-1",
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: 1,
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      }).success,
    ).toBe(false);

    expect(
      clientHelloSchema.safeParse({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "client-1",
        clientKind: "desktop",
        appVersion: "4.0.0",
      }).success,
    ).toBe(true);
    expect(
      clientHelloSchema.safeParse({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "client-1",
        clientMode: "mobileRemote",
        appVersion: "4.0.0",
      }).success,
    ).toBe(false);
    expect(
      helloMessageSchema.safeParse({
        kind: "hello",
        protocolVersion: 3,
        connectionId: "connection-1",
        clientMode: "desktop-continuous",
        deliveryProfile: "replayable",
        serverTime: 1,
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "done",
    },
    {
      kind: "respond_to_coordinator",
      status: "success",
    },
  ] as const)("ToolCallRow wire 接受 $kind display", (display) => {
    expect(
      toolCallRowSchema.safeParse({
        rowId: 1,
        turnId: "turn-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "toolCall",
        toolCallId: "call-1",
        toolName: "TaskOutput",
        status: "success",
        inputText: "{}",
        display,
      }).success,
    ).toBe(true);
  });

  it("ToolCallRow wire 接受 CUA App 身份并拒绝非法 PID", () => {
    const row = {
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "toolCall",
      toolCallId: "call-1",
      toolName: "mcp__computer-use__key",
      status: "running",
      inputText: "{}",
      cuaApp: { pid: 42, name: "Zed", bundleId: "dev.zed.Zed" },
    };
    expect(toolCallRowSchema.safeParse(row).success).toBe(true);
    expect(toolCallRowSchema.safeParse({ ...row, cuaApp: { pid: 0, name: "Zed" } }).success).toBe(
      false,
    );
  });

  it.each([
    {
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "done",
    },
    {
      kind: "respond_to_coordinator",
      status: "success",
    },
    {
      kind: "mcp_tool",
      serverName: "browser",
      toolName: "open",
    },
  ] as const)("ToolOutput wire 接受 $kind display", (display) => {
    expect(toolOutputSchema.safeParse({ text: "done", display }).success).toBe(true);
  });

  // file_diff 仍然不是本端开放的 wire display kind——但"不开放"的代价只是这张卡没有载荷，
  // 不再是整条 row 被拒（display 在信封层不设门，见 zcodeProtocolV4DisplayTolerance.test.ts）。
  it("ToolCallRow wire 丢弃未开放的 file_diff display，但不拒整条 row", () => {
    const parsed = toolCallRowSchema.safeParse({
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "toolCall",
      toolCallId: "call-1",
      toolName: "Edit",
      status: "success",
      inputText: "{}",
      display: {
        kind: "file_diff",
        filePath: "/workspace/app.ts",
        additions: 1,
        deletions: 0,
        structuredPatch: [],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  it("按完整 notification envelope 执行 1MiB 前一字节、正好、后一字节边界", () => {
    const max = PROTOCOL_V4_LIMITS.maxFrameBytes;
    for (const target of [max - 1, max]) {
      const wires = encode(frameAtCompletePhysicalBytes(target));
      expect(wires).toHaveLength(1);
      expect(wires[0]?.kind).toBe("complete");
      expect(notificationBytes(wires[0]!)).toBe(target);
    }

    const fragmented = encode(frameAtCompletePhysicalBytes(max + 1));
    expect(fragmented.length).toBeGreaterThan(1);
    expect(fragmented.every((wire) => wire.kind === "fragment")).toBe(true);
    for (const wire of fragmented) {
      expect(notificationBytes(wire)).toBeLessThanOrEqual(max);
    }
  });

  it("在多字节 UTF-8 byte stream 中分片并逐字段无损重组", () => {
    const frame = makeFrame("中文🙂边界".repeat(400));
    const wires = encode(frame, 480);
    expect(wires.length).toBeGreaterThan(2);
    const result = reassembleTopicWireFrames(wires, conversationTopicFrameSchema);
    expect(result).toEqual({
      kind: "complete",
      frame,
      deliveryKind: DELIVERY_KIND,
    });
  });

  it("分片不改变 logical frame 的 seq 区间", () => {
    const frame = makeFrame("resume".repeat(500));
    const wires = encode(frame, 512);
    const result = reassembleTopicWireFrames(wires, conversationTopicFrameSchema);
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.frame.fromSeq).toBe(10);
      expect(result.frame.toSeq).toBe(11);
      expect(result.frame).toEqual(frame);
    }
  });

  it("超大 snapshot 分片后完整校验并原子重组", () => {
    const frame = makeSnapshotFrame("snapshot-title".repeat(600));
    const wires = encode(frame, 480);
    expect(wires.length).toBeGreaterThan(2);
    expect(reassembleTopicWireFrames(wires, conversationTopicFrameSchema)).toEqual({
      kind: "complete",
      frame,
      deliveryKind: DELIVERY_KIND,
    });
  });

  it("乱序 fragment 与完全相同的重复片仍只组装一次", () => {
    const frame = makeFrame("out-of-order".repeat(500));
    const wires = encode(frame, 480);
    const reordered = [...wires].reverse();
    reordered.splice(1, 0, reordered[0]!);
    expect(reassembleTopicWireFrames(reordered, conversationTopicFrameSchema)).toEqual({
      kind: "complete",
      frame,
      deliveryKind: DELIVERY_KIND,
    });
  });

  it("缺失中间 fragment 时只返回 incomplete，不产生 partial logical frame", () => {
    const wires = encode(makeFrame("missing".repeat(600)), 480);
    expect(wires.length).toBeGreaterThan(2);
    const withoutMiddle = wires.filter((_, index) => index !== 1);
    expect(reassembleTopicWireFrames(withoutMiddle, conversationTopicFrameSchema)).toEqual({
      kind: "incomplete",
      logicalFrameId: LOGICAL_FRAME_ID,
      missingIndexes: [1],
    });
  });

  it("checksum 或 logicalBytes 被篡改时明确拒绝", () => {
    const wires = encode(makeFrame("checksum".repeat(500)), 480);
    const first = wires[0]!;
    expect(first.kind).toBe("fragment");
    if (first.kind !== "fragment") return;

    const tamperedChecksum = wires.map((wire) =>
      wire.kind === "fragment"
        ? {
            ...wire,
            checksum: { algorithm: "crc32" as const, value: "00000000" },
          }
        : wire,
    );
    expect(reassembleTopicWireFrames(tamperedChecksum, conversationTopicFrameSchema)).toMatchObject(
      {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyChecksumMismatch",
      },
    );

    const tamperedLength = [{ ...first, logicalBytes: first.logicalBytes + 1 }, ...wires.slice(1)];
    expect(reassembleTopicWireFrames(tamperedLength, conversationTopicFrameSchema)).toMatchObject({
      kind: "rejected",
      reasonCode: "proto.frameAssemblyMetadataMismatch",
    });

    const mixedOrdinal = [
      first,
      ...wires
        .slice(1)
        .map((wire) =>
          wire.kind === "fragment"
            ? { ...wire, logicalFrameOrdinal: wire.logicalFrameOrdinal + 1 }
            : wire,
        ),
    ];
    expect(reassembleTopicWireFrames(mixedOrdinal, conversationTopicFrameSchema)).toMatchObject({
      kind: "rejected",
      reasonCode: "proto.frameAssemblyMetadataMismatch",
    });
  });

  it("logical assembly 正好 16MiB 可重组，超一字节明确拒绝", () => {
    const max = PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes;
    const exact = frameAtLogicalBytes(max);
    const result = reassembleTopicWireFrames(encode(exact), conversationTopicFrameSchema);
    expect(result.kind).toBe("complete");

    expect(() => encode(frameAtLogicalBytes(max + 1))).toThrowError(
      expect.objectContaining({ reasonCode: "proto.frameAssemblyTooLarge" }),
    );

    expect(
      reassembleTopicWireFrames(
        [
          {
            wireVersion: 3,
            kind: "fragment",
            logicalFrameId: "oversized",
            logicalFrameOrdinal: 1,
            topic: TOPIC,
            subscriptionId: SUBSCRIPTION_ID,
            fragmentIndex: 0,
            fragmentCount: 1,
            logicalBytes: max + 1,
            checksum: { algorithm: "crc32", value: "00000000" },
            dataBase64: "AA==",
          },
        ],
        conversationTopicFrameSchema,
      ),
    ).toEqual({
      kind: "rejected",
      reasonCode: "proto.frameAssemblyTooLarge",
    });

    const oversizedComplete: ConversationTopicWireFrame = {
      wireVersion: 3,
      kind: "complete",
      logicalFrameId: "oversized-complete",
      logicalFrameOrdinal: 1,
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      frame: makeFrame("x".repeat(200)),
    };
    expect(
      reassembleTopicWireFrames([oversizedComplete], conversationTopicFrameSchema, {
        maxAssemblyBytes: 100,
      }),
    ).toEqual({
      kind: "rejected",
      reasonCode: "proto.frameAssemblyTooLarge",
    });

    const cumulativeOverflow = {
      wireVersion: 3 as const,
      kind: "fragment" as const,
      logicalFrameId: "cumulative-overflow",
      logicalFrameOrdinal: 1,
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fragmentIndex: 0,
      fragmentCount: 2,
      logicalBytes: 100,
      checksum: { algorithm: "crc32" as const, value: "00000000" },
      // 102 个零字节；即使其余分片尚未到达，也不能把超限 staging 留在内存。
      dataBase64: "A".repeat(136),
    };
    expect(
      reassembleTopicWireFrames([cumulativeOverflow], conversationTopicFrameSchema, {
        maxAssemblyBytes: 100,
      }),
    ).toEqual({
      kind: "rejected",
      reasonCode: "proto.frameAssemblyTooLarge",
    });
  });

  it("wire schema fail-closed 拒绝非法 fragment metadata", () => {
    const invalid = {
      wireVersion: 3,
      kind: "fragment",
      logicalFrameId: "logical-invalid",
      logicalFrameOrdinal: 1,
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fragmentIndex: 2,
      fragmentCount: 2,
      logicalBytes: 10,
      checksum: { algorithm: "crc32", value: "12345678" },
      dataBase64: "AA==",
    };
    expect(conversationTopicWireFrameSchema.safeParse(invalid).success).toBe(false);
    expect(
      conversationTopicWireFrameSchema.safeParse({
        ...invalid,
        fragmentIndex: 0,
        fragmentCount: 11,
        logicalBytes: 10,
      }).success,
    ).toBe(false);

    const excessiveCount = {
      ...invalid,
      fragmentIndex: 0,
      fragmentCount: 1_025,
      logicalBytes: 1_025,
    };
    expect(conversationTopicWireFrameSchema.safeParse(excessiveCount).success).toBe(false);
    expect(reassembleTopicWireFrames([excessiveCount], conversationTopicFrameSchema)).toEqual({
      kind: "rejected",
      reasonCode: "proto.frameFragmentCountExceeded",
    });

    expect(() =>
      encodeTopicWireFrames(makeFrame("encoder-limit".repeat(100)), {
        topic: TOPIC,
        subscriptionId: SUBSCRIPTION_ID,
        logicalFrameId: "encoder-fragment-limit",
        logicalFrameOrdinal: 1,
        maxPhysicalFrameBytes: 1,
        // 强制每片只承载一个 logical byte，单独验证 encoder 的 admission guard。
        measurePhysicalFrameBytes: (wire) => (wire.kind === "complete" ? 2 : 1),
      }),
    ).toThrowError(
      expect.objectContaining({
        reasonCode: "proto.frameFragmentCountExceeded",
      }),
    );
  });
});
