import { LocalTtftObserver, setLocalTtftObserver } from "../src/v4/telemetry/localTtftObserver.js";
import { Emitter } from "@zcode/rpc";
import type {
  ConversationTopicFrame,
  ConversationTopicWireFrame,
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it, vi } from "vitest";
import { createAgentConversationTransport } from "../src/v4/agentConversationTransport.js";
import { createAgentSessionsIndexTransport } from "../src/v4/agentSessionsIndexTransport.js";
import { ensureAgentV4ConnectionHandshake } from "../src/v4/agentV4ConnectionHandshake.js";
import { createCommandEnvelope, getV4ClientId } from "../src/v4/commandFactory.js";
import { createTopicWireDecoder } from "../src/v4/topicWireDecoder.js";
import { logger } from "../src/logger.js";

function setupAgent() {
  const conversationFrames = new Emitter<ConversationTopicWireFrame>();
  const sessionsIndexFrames = new Emitter<SessionsIndexTopicWireFrame>();
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  return {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello" as const,
      protocolVersion: 3 as const,
      connectionId: "host-rpc-1",
      clientMode: "desktop-continuous" as const,
      deliveryProfile: "continuous" as const,
      serverTime: 1,
      capabilities: {
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: false,
        compression: "none" as const,
      },
      auth: {},
    })),
    initializeConversationV4: vi.fn(async () => {}),
    subscribeConversationV4: vi.fn(async () => ({
      ack: {
        subscriptionId: "sub-conversation",
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      },
    })),
    unsubscribeConversationV4: vi.fn(async () => {}),
    resyncConversationV4: vi.fn(
      async (params: { subscriptionId: string; forceSnapshot?: boolean }) => ({
        ack: {
          subscriptionId: params.subscriptionId,
          mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
          logEpoch: "epoch-1",
        },
      }),
    ),
    sendConversationCommandV4: vi.fn(async (params: { envelope: { commandId: string } }) => ({
      commandId: params.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
    })),
    queryConversationCommandsV4: vi.fn(
      async (params: { commands: Array<{ commandId: string }> }) => ({
        results: params.commands.map((key) => ({ key, result: "unknown" as const })),
      }),
    ),
    conversationRowsRangeV4: vi.fn(),
    conversationPlansV4: vi.fn(),
    conversationFileChangesV4: vi.fn(),
    conversationFileRewindPreviewV4: vi.fn(),
    attachmentBeginV4: vi.fn(),
    attachmentChunkV4: vi.fn(),
    attachmentCommitV4: vi.fn(),
    attachmentAbortV4: vi.fn(),
    attachmentPreviewSourceV4: vi.fn(),
    attachmentReadV4: vi.fn(),
    onDynamicConversationFrame: vi.fn(() => conversationFrames.event),
    subscribeSessionsIndexV4: vi.fn(async () => ({
      ack: {
        subscriptionId: "sub-index",
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      },
    })),
    unsubscribeSessionsIndexV4: vi.fn(async () => {}),
    resyncSessionsIndexV4: vi.fn(
      async (params: { subscriptionId: string; forceSnapshot?: boolean }) => ({
        ack: {
          subscriptionId: params.subscriptionId,
          mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
          logEpoch: "epoch-1",
        },
      }),
    ),
    onDynamicSessionsIndexFrame: vi.fn(() => sessionsIndexFrames.event),
    onAgentRuntimeRestarted: vi.fn((listener: (event: { workspaceKey: string }) => void) =>
      runtimeRestarts.event(listener),
    ),
    conversationFrames,
    sessionsIndexFrames,
    runtimeRestarts,
  };
}

it("Plan 请求不发给会剥掉 Plan 字段的旧 Host；普通请求仍兼容", async () => {
  const agent = setupAgent();
  const transport = createAgentConversationTransport(agent as never, { workspacePath: "/work" });
  const envelope = createCommandEnvelope({
    type: "sendText",
    sessionId: "session",
    payload: { text: "plan", mode: "yolo", planEnabled: true },
  });
  await expect(transport.sendCommand(envelope)).rejects.toThrow("proto.independentPlanUnsupported");
  expect(agent.sendConversationCommandV4).not.toHaveBeenCalled();
  await transport.sendCommand({
    ...envelope,
    payload: { text: "build", mode: "yolo", planEnabled: false },
  });
  expect(agent.sendConversationCommandV4).toHaveBeenCalledOnce();
});

function emptyFrame(topic: string, subscriptionId: string): ConversationTopicFrame {
  return {
    topic,
    subscriptionId,
    fromSeq: 0,
    toSeq: 0,
    sentAt: 1,
    payload: { kind: "deltas", deltas: [] },
  };
}

function completeConversationWire(
  frame: ConversationTopicFrame,
  logicalFrameId = "logical-conversation-complete",
  logicalFrameOrdinal = 1,
  deliveryKind: TopicFrameDeliveryKind = "online",
): ConversationTopicWireFrame {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId,
    logicalFrameOrdinal,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

function completeSessionsIndexWire(
  frame: SessionsIndexTopicFrame,
  logicalFrameId = "logical-index-complete",
  logicalFrameOrdinal = 1,
  deliveryKind: TopicFrameDeliveryKind = "online",
): SessionsIndexTopicWireFrame {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId,
    logicalFrameOrdinal,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

describe("agent V4 connection transports", () => {
  it("assembles sent media chunks and preserves the exact row attachment target", async () => {
    const agent = setupAgent();
    agent.attachmentReadV4
      .mockResolvedValueOnce({
        dataBase64: Buffer.from("abc").toString("base64"),
        mediaType: "video/quicktime",
        totalBytes: 5,
        nextOffset: 3,
      })
      .mockResolvedValueOnce({
        dataBase64: Buffer.from("de").toString("base64"),
        mediaType: "video/quicktime",
        totalBytes: 5,
        nextOffset: null,
      });
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/remote/work",
      workspaceIdentity: "ssh://host/remote/work",
    });

    await expect(
      transport.attachmentRead({
        sessionId: "session-video",
        ref: "/remote/work/demo.mov",
        target: { rowId: 42, entityId: "message-42" },
        attachmentIndex: 1,
      }),
    ).resolves.toEqual({
      bytes: new Uint8Array(Buffer.from("abcde")),
      mediaType: "video/quicktime",
    });
    expect(agent.attachmentReadV4).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspacePath: "/remote/work",
        workspaceIdentity: "ssh://host/remote/work",
        sessionId: "session-video",
        ref: "/remote/work/demo.mov",
        target: { rowId: 42, entityId: "message-42" },
        attachmentIndex: 1,
        offset: 0,
      }),
    );
    expect(agent.attachmentReadV4).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { rowId: 42, entityId: "message-42" },
        attachmentIndex: 1,
        offset: 3,
      }),
    );
  });

  it("uses an authorized Desktop local video URL without requesting chunks", async () => {
    const agent = setupAgent();
    agent.attachmentPreviewSourceV4.mockResolvedValue({
      kind: "local_path",
      path: "/Users/test/.zcode/cli/video-cache/session/demo.mov",
      mediaType: "video/quicktime",
    });
    const createLocalMediaPreviewUrl = vi.fn(
      (path: string) => `zcode-media://local/${encodeURIComponent(path)}`,
    );
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
      createLocalMediaPreviewUrl,
    });

    await expect(
      transport.attachmentRead({
        sessionId: "session-video",
        ref: "/repo/demo.mov",
        mediaType: "video/quicktime",
        target: { rowId: 42, entityId: "message-42" },
        attachmentIndex: 1,
      }),
    ).resolves.toEqual({
      url: expect.stringMatching(/^zcode-media:\/\/local\//u),
      mediaType: "video/quicktime",
    });
    expect(agent.attachmentPreviewSourceV4).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/repo",
        sessionId: "session-video",
        target: { rowId: 42, entityId: "message-42" },
        attachmentIndex: 1,
      }),
    );
    expect(createLocalMediaPreviewUrl).toHaveBeenCalledWith(
      "/Users/test/.zcode/cli/video-cache/session/demo.mov",
    );
    expect(agent.attachmentReadV4).not.toHaveBeenCalled();
  });

  it("keeps remote and local-source fallback previews on the existing chunk path", async () => {
    const remoteAgent = setupAgent();
    remoteAgent.attachmentReadV4.mockResolvedValue({
      dataBase64: Buffer.from("remote").toString("base64"),
      mediaType: "video/mp4",
      totalBytes: 6,
      nextOffset: null,
    });
    const remoteTransport = createAgentConversationTransport(remoteAgent as never, {
      workspacePath: "/remote/work",
    });
    await expect(
      remoteTransport.attachmentRead({ sessionId: "remote", ref: "/remote/work/demo.mp4" }),
    ).resolves.toEqual({ bytes: new Uint8Array(Buffer.from("remote")), mediaType: "video/mp4" });
    expect(remoteAgent.attachmentPreviewSourceV4).not.toHaveBeenCalled();

    const localAgent = setupAgent();
    localAgent.attachmentPreviewSourceV4.mockResolvedValue({ kind: "chunked" });
    localAgent.attachmentReadV4.mockResolvedValue({
      dataBase64: Buffer.from("local").toString("base64"),
      mediaType: "video/mp4",
      totalBytes: 5,
      nextOffset: null,
    });
    const localTransport = createAgentConversationTransport(localAgent as never, {
      workspacePath: "/repo",
      createLocalMediaPreviewUrl: vi.fn(),
    });
    await expect(
      localTransport.attachmentRead({
        sessionId: "local",
        ref: "zcode-artifact://video",
        mediaType: "video/mp4",
      }),
    ).resolves.toEqual({ bytes: new Uint8Array(Buffer.from("local")), mediaType: "video/mp4" });
    expect(localAgent.attachmentPreviewSourceV4).toHaveBeenCalledOnce();
    expect(localAgent.attachmentReadV4).toHaveBeenCalledOnce();
  });

  it("keeps Desktop image previews on the existing chunk path", async () => {
    const agent = setupAgent();
    agent.attachmentReadV4.mockResolvedValue({
      dataBase64: Buffer.from("image").toString("base64"),
      mediaType: "image/png",
      totalBytes: 5,
      nextOffset: null,
    });
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
      createLocalMediaPreviewUrl: vi.fn(),
    });

    await expect(
      transport.attachmentRead({
        sessionId: "image",
        ref: "zcode-artifact://image",
        mediaType: "image/png",
      }),
    ).resolves.toEqual({ bytes: new Uint8Array(Buffer.from("image")), mediaType: "image/png" });
    expect(agent.attachmentPreviewSourceV4).not.toHaveBeenCalled();
    expect(agent.attachmentReadV4).toHaveBeenCalledOnce();
  });

  it("stops requesting sent media chunks after the caller aborts", async () => {
    const agent = setupAgent();
    const abortController = new AbortController();
    agent.attachmentReadV4
      .mockImplementationOnce(async () => {
        abortController.abort();
        return {
          dataBase64: Buffer.from("a").toString("base64"),
          mediaType: "video/mp4",
          totalBytes: 2,
          nextOffset: 1,
        };
      })
      .mockResolvedValueOnce({
        dataBase64: Buffer.from("b").toString("base64"),
        mediaType: "video/mp4",
        totalBytes: 2,
        nextOffset: null,
      });
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/remote/work",
    });

    await expect(
      transport.attachmentRead({
        sessionId: "session-aborted-video",
        ref: "zcode-artifact://aborted-video",
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(agent.attachmentReadV4).toHaveBeenCalledOnce();
  });

  it("allows sent video preview to use more chunks than the upload byte limit", async () => {
    const agent = setupAgent();
    const uploadByteLimitChunks = Math.floor(
      PROTOCOL_V4_LIMITS.attachmentMaxBytes / PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
    );
    const chunkCount = uploadByteLimitChunks + 2;
    expect(chunkCount).toBeLessThanOrEqual(PROTOCOL_V4_LIMITS.attachmentPreviewMaxChunks);
    for (let index = 0; index < chunkCount; index += 1) {
      agent.attachmentReadV4.mockResolvedValueOnce({
        dataBase64: Buffer.from("x").toString("base64"),
        mediaType: "video/mp4",
        totalBytes: chunkCount,
        nextOffset: index + 1 < chunkCount ? index + 1 : null,
      });
    }
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/remote/work",
    });

    await expect(
      transport.attachmentRead({
        sessionId: "session-large-video",
        ref: "zcode-artifact://large-video",
      }),
    ).resolves.toEqual({
      bytes: new Uint8Array(Buffer.alloc(chunkCount, "x")),
      mediaType: "video/mp4",
    });
    expect(agent.attachmentReadV4).toHaveBeenCalledTimes(chunkCount);
  });

  it("route A timeout 与 route B complete 同批时只 fail-close A，不误丢 B", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const delivered: ConversationTopicFrame[] = [];
      const decoder = createTopicWireDecoder(
        new TopicWireFrameAssembler(conversationTopicFrameSchema),
        (frame) => delivered.push(frame),
      );
      const routeA: ConversationTopicFrame = {
        ...emptyFrame("conversation/session-a", "sub-a"),
        toSeq: 1,
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "A".repeat(2_000) }],
        },
      };
      const routeAWires = encodeTopicWireFrames(routeA, {
        deliveryKind: "online",
        topic: routeA.topic,
        subscriptionId: routeA.subscriptionId,
        logicalFrameId: "logical-route-a-timeout",
        logicalFrameOrdinal: 1,
        maxPhysicalFrameBytes: 500,
        measurePhysicalFrameBytes: utf8JsonByteLength,
      }) as ConversationTopicWireFrame[];
      expect(routeAWires.length).toBeGreaterThan(1);
      decoder.accept(routeAWires[0]!);

      vi.setSystemTime(30_000);
      const routeB = emptyFrame("conversation/session-b", "sub-b");
      decoder.accept(completeConversationWire(routeB, "logical-route-b", 1));
      expect(delivered).toEqual([routeB]);
      decoder.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("旧 online 残片恰在 recovery complete 同次 accept 超时时，权威 recovery 原子治愈", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const topic = "conversation/session-timeout-heal";
      const subscriptionId = "sub-timeout-heal";
      const delivered: Array<{
        frame: ConversationTopicFrame;
        deliveryKind: TopicFrameDeliveryKind;
      }> = [];
      const faults: string[] = [];
      const decoder = createTopicWireDecoder(
        new TopicWireFrameAssembler(conversationTopicFrameSchema),
        (frame, deliveryKind) => delivered.push({ frame, deliveryKind }),
        (fault) => faults.push(fault.reasonCode),
      );
      const old = encodeTopicWireFrames(
        {
          ...emptyFrame(topic, subscriptionId),
          toSeq: 1,
          payload: {
            kind: "deltas",
            deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "old".repeat(2_000) }],
          },
        },
        {
          deliveryKind: "online",
          topic,
          subscriptionId,
          logicalFrameId: "logical-timeout-online",
          logicalFrameOrdinal: 1,
          maxPhysicalFrameBytes: 500,
          measurePhysicalFrameBytes: utf8JsonByteLength,
        },
      ) as ConversationTopicWireFrame[];
      decoder.accept(old[0]!);

      vi.setSystemTime(30_000);
      const recovery = emptyFrame(topic, subscriptionId);
      decoder.accept(completeConversationWire(recovery, "logical-timeout-recovery", 2, "recovery"));

      expect(faults).toEqual([]);
      expect(delivered).toEqual([{ frame: recovery, deliveryKind: "recovery" }]);
      decoder.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("旧 online 残片恰在 fragmented recovery 首片到达时超时，不丢 recovery 已收分片", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const topic = "conversation/session-timeout-fragment-heal";
      const subscriptionId = "sub-timeout-fragment-heal";
      const delivered: ConversationTopicFrame[] = [];
      const faults: string[] = [];
      const decoder = createTopicWireDecoder(
        new TopicWireFrameAssembler(conversationTopicFrameSchema),
        (frame) => delivered.push(frame),
        (fault) => faults.push(fault.reasonCode),
      );
      const old = encodeTopicWireFrames(
        {
          ...emptyFrame(topic, subscriptionId),
          toSeq: 1,
          payload: {
            kind: "deltas",
            deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "old".repeat(2_000) }],
          },
        },
        {
          deliveryKind: "online",
          topic,
          subscriptionId,
          logicalFrameId: "logical-timeout-online-fragment",
          logicalFrameOrdinal: 1,
          maxPhysicalFrameBytes: 500,
          measurePhysicalFrameBytes: utf8JsonByteLength,
        },
      ) as ConversationTopicWireFrame[];
      decoder.accept(old[0]!);

      const recovery: ConversationTopicFrame = {
        ...emptyFrame(topic, subscriptionId),
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "recovery".repeat(2_000) }],
        },
      };
      const recoveryWires = encodeTopicWireFrames(recovery, {
        deliveryKind: "recovery",
        topic,
        subscriptionId,
        logicalFrameId: "logical-timeout-recovery-fragmented",
        logicalFrameOrdinal: 2,
        maxPhysicalFrameBytes: 500,
        measurePhysicalFrameBytes: utf8JsonByteLength,
      }) as ConversationTopicWireFrame[];
      expect(recoveryWires.length).toBeGreaterThan(1);
      vi.setSystemTime(30_000);
      for (const wire of recoveryWires) decoder.accept(wire);

      expect(faults).toEqual([]);
      expect(delivered).toEqual([recovery]);
      decoder.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("assembly fault 后 same-sub recover 保留 ordinal tombstone 并接受更高 recovery frame", () => {
    const delivered: ConversationTopicFrame[] = [];
    const decoder = createTopicWireDecoder(
      new TopicWireFrameAssembler(conversationTopicFrameSchema),
      (frame) => delivered.push(frame),
    );
    const topic = "conversation/session-recover";
    const subscriptionId = "sub-recover";
    const partial = encodeTopicWireFrames(
      {
        ...emptyFrame(topic, subscriptionId),
        toSeq: 1,
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "x".repeat(2_000) }],
        },
      },
      {
        deliveryKind: "online",
        topic,
        subscriptionId,
        logicalFrameId: "logical-faulted",
        logicalFrameOrdinal: 1,
        maxPhysicalFrameBytes: 500,
        measurePhysicalFrameBytes: utf8JsonByteLength,
      },
    ) as ConversationTopicWireFrame[];
    decoder.accept(partial[0]!);
    decoder.accept(
      completeConversationWire(
        { ...emptyFrame(topic, subscriptionId), fromSeq: 1, toSeq: 2 },
        "logical-supersede",
        2,
      ),
    );
    expect(delivered).toEqual([]);

    decoder.recover(topic, subscriptionId);
    // fault ordinal tombstone 仍在，旧片不能复活；更高 recovery ordinal 可以原子进入。
    decoder.accept(partial[1]!);
    decoder.accept(
      completeConversationWire(
        emptyFrame(topic, subscriptionId),
        "logical-recovery",
        3,
        "recovery",
      ),
    );
    expect(delivered).toEqual([emptyFrame(topic, subscriptionId)]);
  });

  it("resync RPC Promise continuation 前到达的更高 ordinal physical recovery 不被 fault 门吞掉", async () => {
    const agent = setupAgent();
    const transport = createAgentConversationTransport(agent as never, { workspacePath: "/repo" });
    const seen: Array<{ frame: ConversationTopicFrame; deliveryKind?: TopicFrameDeliveryKind }> =
      [];
    transport.onFrame((frame, context) => {
      seen.push({ frame, deliveryKind: context?.deliveryKind });
    });
    const subscribed = await transport.subscribe({ topic: "conversation/session-1" });
    transport.activate(subscribed.ack.subscriptionId);

    const old = encodeTopicWireFrames(
      {
        ...emptyFrame("conversation/session-1", subscribed.ack.subscriptionId),
        toSeq: 1,
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "x".repeat(2_000) }],
        },
      },
      {
        deliveryKind: "online",
        topic: "conversation/session-1",
        subscriptionId: subscribed.ack.subscriptionId,
        logicalFrameId: "logical-old",
        logicalFrameOrdinal: 1,
        maxPhysicalFrameBytes: 500,
        measurePhysicalFrameBytes: utf8JsonByteLength,
      },
    ) as ConversationTopicWireFrame[];
    agent.conversationFrames.fire(old[0]!);
    agent.conversationFrames.fire(
      completeConversationWire(
        { ...emptyFrame("conversation/session-1", subscribed.ack.subscriptionId), toSeq: 2 },
        "logical-fault",
        2,
      ),
    );
    expect(seen).toEqual([]);

    const recovery = emptyFrame("conversation/session-1", subscribed.ack.subscriptionId);
    const lateOnline = encodeTopicWireFrames(
      {
        ...recovery,
        toSeq: 3,
        payload: {
          kind: "deltas",
          deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "late".repeat(2_000) }],
        },
      },
      {
        deliveryKind: "online",
        topic: recovery.topic,
        subscriptionId: recovery.subscriptionId,
        logicalFrameId: "logical-late-online-partial",
        logicalFrameOrdinal: 4,
        maxPhysicalFrameBytes: 500,
        measurePhysicalFrameBytes: utf8JsonByteLength,
      },
    ) as ConversationTopicWireFrame[];
    agent.resyncConversationV4.mockImplementationOnce(async (params) => {
      // 模拟 response 与 notification 同 read：request Promise continuation 尚未执行。
      // 迟到 online duplicate 不能消费 recovery 身份；真正 recovery 由信封证明。
      agent.conversationFrames.fire(
        completeConversationWire(recovery, "logical-stale-online", 3, "online"),
      );
      // in-flight resync 期间迟到 online 残片 fault 不得永久关掉 recovery gate。
      agent.conversationFrames.fire(lateOnline[0]!);
      agent.conversationFrames.fire(
        completeConversationWire({ ...recovery, toSeq: 4 }, "logical-online-fault", 5, "online"),
      );
      agent.conversationFrames.fire(
        completeConversationWire(recovery, "logical-recovery-early", 6, "recovery"),
      );
      return {
        ack: { subscriptionId: params.subscriptionId, mode: "resume", logEpoch: "epoch-1" },
      };
    });
    await transport.resync({
      subscriptionId: subscribed.ack.subscriptionId,
      base: { logEpoch: "epoch-1", seq: 0 },
    });
    expect(seen).toEqual([
      { frame: recovery, deliveryKind: "online" },
      { frame: recovery, deliveryKind: "recovery" },
    ]);
  });

  it("runtime restart 清 barrier/assembler，允许相同 subId 与 ordinal=1 的新 initial", async () => {
    const agent = setupAgent();
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
    });
    const seen: string[] = [];
    transport.onFrame((frame) => seen.push(String(frame.sentAt)));
    const restarted = vi.fn();
    transport.onRuntimeRestart(restarted);
    const first = await transport.subscribe({ topic: "conversation/session-1" });
    transport.activate(first.ack.subscriptionId);
    agent.conversationFrames.fire(
      completeConversationWire(
        { ...emptyFrame("conversation/session-1", first.ack.subscriptionId), sentAt: 1 },
        "logical-old-runtime",
        1,
      ),
    );
    agent.runtimeRestarts.fire({ workspaceKey: "/repo" });
    expect(restarted).toHaveBeenCalledTimes(1);

    const second = await transport.subscribe({ topic: "conversation/session-1" });
    expect(second.ack.subscriptionId).toBe(first.ack.subscriptionId);
    transport.activate(second.ack.subscriptionId);
    agent.conversationFrames.fire(
      completeConversationWire(
        { ...emptyFrame("conversation/session-1", second.ack.subscriptionId), sentAt: 2 },
        "logical-new-runtime",
        1,
      ),
    );
    expect(seen).toEqual(["1", "2"]);
  });

  it("记录生产包可见的订阅生命周期阶段，不记录消息内容", async () => {
    const agent = setupAgent();
    const info = vi.spyOn(logger.lifecycle, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger.lifecycle, "warn").mockImplementation(() => {});
    try {
      const transport = createAgentConversationTransport(agent as never, {
        workspacePath: "/repo",
        workspaceIdentity: "ssh:repo",
      });
      const subscribed = await transport.subscribe({ topic: "conversation/session-1" });
      transport.activate(subscribed.ack.subscriptionId);
      await transport.unsubscribe(subscribed.ack.subscriptionId);

      const events = info.mock.calls
        .map(([, context]) => (context as { event?: string } | undefined)?.event)
        .filter((event): event is string => Boolean(event));
      expect(events).toEqual(
        expect.arrayContaining([
          "v4.conversation.subscribe.started",
          "v4.conversation.subscribe.acknowledged",
          "v4.conversation.subscribe.activated",
          "v4.conversation.unsubscribe.started",
          "v4.conversation.unsubscribe.completed",
        ]),
      );
      expect(warn).not.toHaveBeenCalled();
      expect(info.mock.calls.flat().join(" ")).not.toContain("prompt");
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("同一 RPC service 只握手一次，subscribe 不透传 UI 自报 profile", async () => {
    const agent = setupAgent();
    const target = { workspacePath: "/repo", workspaceIdentity: "ssh:repo" };
    const conversation = createAgentConversationTransport(agent as never, target);
    const sessionsIndex = createAgentSessionsIndexTransport(agent as never, target);

    await Promise.all([
      conversation.subscribe({
        topic: "conversation/session-1",
        deliveryProfile: "replayable",
      } as never),
      sessionsIndex.subscribe({ visibility: "foreground" }),
    ]);

    expect(agent.initializeConversationV4).toHaveBeenCalledTimes(1);
    expect(agent.initializeConversationV4).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: expect.any(String),
      }),
    );
    expect(agent.subscribeConversationV4).toHaveBeenCalledWith({
      ...target,
      sessionId: "session-1",
    });
    expect(agent.subscribeSessionsIndexV4).toHaveBeenCalledWith({
      ...target,
      runtimePolicy: "existing-only",
      visibility: "foreground",
    });
  });

  // `workflowRunDeltas` 的声明是单向的（shared transport.ts）：clientHello 的 capabilities 是
  // `.strict()` 的，向一台没宣告这个位的旧 Host 发它 = 整条 clientHello 解析失败、连接握不上手。
  // 两条用例把「只在宣告之后才回声明」钉住，因为出错的代价不是降级而是会话打不开。
  it("Host 未宣告 workflowRunDeltas 时 clientHello 不带这个键", async () => {
    const agent = setupAgent();

    await ensureAgentV4ConnectionHandshake(agent as never);

    const clientHello = agent.initializeConversationV4.mock.calls[0]?.[0] as
      | { capabilities?: Record<string, unknown> }
      | undefined;
    expect(clientHello?.capabilities).toEqual({ workspaceHookReviewUi: true });
  });

  it("Host 宣告 workflowRunDeltas 后 clientHello 回声明，与既有 review 能力并存", async () => {
    const agent = setupAgent();
    const hello = await agent.helloConversationV4();
    agent.helloConversationV4.mockResolvedValue({
      ...hello,
      capabilities: { ...hello.capabilities, workflowRunDeltas: true },
    });

    await ensureAgentV4ConnectionHandshake(agent as never);

    const clientHello = agent.initializeConversationV4.mock.calls[0]?.[0] as
      | { capabilities?: Record<string, unknown> }
      | undefined;
    expect(clientHello?.capabilities).toEqual({
      workspaceHookReviewUi: true,
      workflowRunDeltas: true,
    });
  });

  it("非法 server hello 时不允许发送 subscribe", async () => {
    const agent = setupAgent();
    agent.helloConversationV4.mockResolvedValueOnce({
      ...(await agent.helloConversationV4()),
      deliveryProfile: "replayable",
    });
    agent.helloConversationV4.mockClear();
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
    });

    await expect(transport.subscribe({ topic: "conversation/session-1" })).rejects.toThrow();
    expect(agent.subscribeConversationV4).not.toHaveBeenCalled();
  });

  it("conversation transport 在 subscribe ACK 前暂存通知，显式 activate 后恰好释放一次", async () => {
    const agent = setupAgent();
    let resolveSubscribe!: (value: {
      ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string };
    }) => void;
    agent.subscribeConversationV4.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSubscribe = resolve)),
    );
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
    });
    const seen: string[] = [];
    transport.onFrame((frame) => seen.push(frame.subscriptionId));

    const subscribing = transport.subscribe({ topic: "conversation/session-1" });
    await vi.waitFor(() => expect(agent.subscribeConversationV4).toHaveBeenCalledTimes(1));
    agent.conversationFrames.fire(
      completeConversationWire(emptyFrame("conversation/session-1", "sub-conversation-early")),
    );
    expect(seen).toEqual([]);

    resolveSubscribe({
      ack: {
        subscriptionId: "sub-conversation-early",
        mode: "snapshot",
        logEpoch: "epoch-1",
      },
    });
    const result = await subscribing;
    expect(seen).toEqual([]);
    const activatable = transport as typeof transport & {
      activate(subscriptionId: string): void;
    };
    expect(typeof activatable.activate).toBe("function");
    activatable.activate(result.ack.subscriptionId);
    activatable.activate(result.ack.subscriptionId);
    expect(seen).toEqual(["sub-conversation-early"]);
  });

  it("sessions-index transport 在 subscribe ACK 前暂存通知，显式 activate 后恰好释放一次", async () => {
    const agent = setupAgent();
    let resolveSubscribe!: (value: {
      ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string };
    }) => void;
    agent.subscribeSessionsIndexV4.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSubscribe = resolve)),
    );
    const transport = createAgentSessionsIndexTransport(agent as never, {
      workspacePath: "/repo",
    });
    const seen: string[] = [];
    transport.onFrame((frame) => seen.push(frame.subscriptionId));

    const subscribing = transport.subscribe({});
    await vi.waitFor(() => expect(agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    agent.sessionsIndexFrames.fire(
      completeSessionsIndexWire({
        ...emptyFrame("sessions-index//repo", "sub-index-early"),
        payload: {
          kind: "deltas",
          deltas: [],
        },
      } as SessionsIndexTopicFrame),
    );
    expect(seen).toEqual([]);

    resolveSubscribe({
      ack: {
        subscriptionId: "sub-index-early",
        mode: "snapshot",
        logEpoch: "epoch-1",
      },
    });
    const result = await subscribing;
    expect(seen).toEqual([]);
    const activatable = transport as typeof transport & {
      activate(subscriptionId: string): void;
    };
    expect(typeof activatable.activate).toBe("function");
    activatable.activate(result.ack.subscriptionId);
    activatable.activate(result.ack.subscriptionId);
    expect(seen).toEqual(["sub-index-early"]);
  });

  it("conversation physical 分片只在最后一片后原子交付 logical frame", async () => {
    const agent = setupAgent();
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
    });
    const seen: ConversationTopicFrame[] = [];
    transport.onFrame((frame) => seen.push(frame));
    const result = await transport.subscribe({ topic: "conversation/session-1" });
    transport.activate(result.ack.subscriptionId);

    const append = "中文🙂".repeat(400);
    const logical: ConversationTopicFrame = {
      topic: "conversation/session-1",
      subscriptionId: result.ack.subscriptionId,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.delta", rowId: 1, path: "text", append }],
      },
    };
    const wires = encodeTopicWireFrames(logical, {
      deliveryKind: "initial",
      topic: logical.topic,
      subscriptionId: logical.subscriptionId,
      logicalFrameId: "logical-conversation-fragmented",
      logicalFrameOrdinal: 1,
      maxPhysicalFrameBytes: 500,
      measurePhysicalFrameBytes: utf8JsonByteLength,
    }) as ConversationTopicWireFrame[];
    expect(wires.length).toBeGreaterThan(2);

    for (const wire of wires.slice(0, -1)) agent.conversationFrames.fire(wire);
    expect(seen).toEqual([]);
    agent.conversationFrames.fire(wires.at(-1)!);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(logical);
  });

  it("conversation 同批 superseded fault + newer complete 时 fail closed 不交付", async () => {
    const agent = setupAgent();
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
    });
    const seen: ConversationTopicFrame[] = [];
    transport.onFrame((frame) => seen.push(frame));
    const result = await transport.subscribe({ topic: "conversation/session-1" });
    transport.activate(result.ack.subscriptionId);

    const old: ConversationTopicFrame = {
      ...emptyFrame("conversation/session-1", result.ack.subscriptionId),
      toSeq: 1,
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "old".repeat(500) }],
      },
    };
    const oldWires = encodeTopicWireFrames(old, {
      deliveryKind: "online",
      topic: old.topic,
      subscriptionId: old.subscriptionId,
      logicalFrameId: "logical-old-partial",
      logicalFrameOrdinal: 1,
      maxPhysicalFrameBytes: 500,
      measurePhysicalFrameBytes: utf8JsonByteLength,
    }) as ConversationTopicWireFrame[];
    expect(oldWires.length).toBeGreaterThan(1);
    agent.conversationFrames.fire(oldWires[0]!);

    const newer: ConversationTopicFrame = {
      ...emptyFrame("conversation/session-1", result.ack.subscriptionId),
      fromSeq: 1,
      toSeq: 2,
    };
    agent.conversationFrames.fire(completeConversationWire(newer, "logical-newer", 2));
    expect(seen).toEqual([]);
  });

  it("sessions-index physical 分片只在最后一片后原子交付 logical frame", async () => {
    const agent = setupAgent();
    const transport = createAgentSessionsIndexTransport(agent as never, {
      workspacePath: "/repo",
    });
    const seen: SessionsIndexTopicFrame[] = [];
    transport.onFrame((frame) => seen.push(frame));
    const result = await transport.subscribe({});
    transport.activate(result.ack.subscriptionId);

    const logical: SessionsIndexTopicFrame = {
      topic: "sessions-index//repo",
      subscriptionId: result.ack.subscriptionId,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "session.upserted",
            session: {
              sessionId: "session-1",
              workspaceId: "/repo",
              title: "中文🙂".repeat(400),
              phase: "completedSuccess",
              sessionEnded: true,
              hasBackgroundWork: false,
              lastActivityAt: 1,
              createdAt: 1,
            },
          },
        ],
      },
    };
    const wires = encodeTopicWireFrames(logical, {
      deliveryKind: "initial",
      topic: logical.topic,
      subscriptionId: logical.subscriptionId,
      logicalFrameId: "logical-index-fragmented",
      logicalFrameOrdinal: 1,
      maxPhysicalFrameBytes: 500,
      measurePhysicalFrameBytes: utf8JsonByteLength,
    }) as SessionsIndexTopicWireFrame[];
    expect(wires.length).toBeGreaterThan(2);

    for (const wire of wires.slice(0, -1)) agent.sessionsIndexFrames.fire(wire);
    expect(seen).toEqual([]);
    agent.sessionsIndexFrames.fire(wires.at(-1)!);
    expect(seen).toEqual([logical]);
  });

  it("subscribe ACK 前物理 staging 第 1025 帧整批失败，不丢头部继续激活", async () => {
    const agent = setupAgent();
    let resolveSubscribe!: (value: {
      ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string };
    }) => void;
    agent.subscribeConversationV4.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSubscribe = resolve)),
    );
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
    });
    const seen: ConversationTopicFrame[] = [];
    transport.onFrame((frame) => seen.push(frame));

    const subscribing = transport.subscribe({ topic: "conversation/session-1" });
    await vi.waitFor(() => expect(agent.subscribeConversationV4).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 1025; index += 1) {
      agent.conversationFrames.fire(
        completeConversationWire(
          emptyFrame("conversation/session-1", "sub-conversation-overflow"),
          `logical-overflow-${index}`,
        ),
      );
    }
    resolveSubscribe({
      ack: {
        subscriptionId: "sub-conversation-overflow",
        mode: "snapshot",
        logEpoch: "epoch-1",
      },
    });

    await expect(subscribing).rejects.toThrow("fault.subscription.initialFrameStagingOverflow");
    expect(seen).toEqual([]);
    expect(agent.unsubscribeConversationV4).toHaveBeenCalledWith({
      workspacePath: "/repo",
      subscriptionId: "sub-conversation-overflow",
    });
  });

  it("UI handshake 与 commandFactory 复用同一个稳定 clientId", async () => {
    const agent = setupAgent();
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
    });
    const envelope = createCommandEnvelope({
      type: "sendText",
      sessionId: "session-1",
      payload: { text: "hello" },
    });

    await expect(transport.sendCommand(envelope)).resolves.toMatchObject({
      commandId: envelope.commandId,
      status: "accepted",
    });
    expect(envelope.clientId).toBe(getV4ClientId());
    expect(agent.initializeConversationV4).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: envelope.clientId }),
    );
  });

  it("commands/query 先完成 handshake，并保留 workspaceIdentity 与 key 顺序", async () => {
    const agent = setupAgent();
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:host:/repo",
    });
    const commands = [
      { sessionId: "session-1", commandId: "command-1" },
      { sessionId: null, commandId: "create-command" },
    ];

    await expect(transport.queryCommands({ commands })).resolves.toEqual({
      results: commands.map((key) => ({ key, result: "unknown" })),
    });
    expect(agent.initializeConversationV4).toHaveBeenCalledTimes(1);
    expect(agent.queryConversationCommandsV4).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:host:/repo",
      commands,
    });
  });

  it("plans query 通过同一 shared-host 身份路由转发", async () => {
    const agent = setupAgent();
    agent.conversationPlansV4.mockResolvedValue({
      plans: [],
      atSeq: 12,
      atLogEpoch: "epoch-1",
    });
    const transport = createAgentConversationTransport(agent as never, {
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:host:/repo",
    });

    await expect(transport.plans({ sessionId: "session-1" })).resolves.toEqual({
      plans: [],
      atSeq: 12,
      atLogEpoch: "epoch-1",
    });
    expect(agent.initializeConversationV4).toHaveBeenCalledTimes(1);
    expect(agent.conversationPlansV4).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:host:/repo",
      sessionId: "session-1",
    });
  });
});

it("runtime unavailable 结束对应 workspace 的 TTFT，保留其他 workspace", () => {
  const agent = setupAgent();
  const lifecycle = new Emitter<{ workspaceKey: string; state: "available" | "unavailable" }>();
  const service = {
    ...agent,
    onDynamicLocalTtftFacts: () => new Emitter<import("@zcode/shared").LocalTtftFacts>().event,
    onAgentRuntimeLifecycle: (
      listener: (event: { workspaceKey: string; state: "available" | "unavailable" }) => void,
    ) => lifecycle.event(listener),
  };
  const records: import("@zcode/shared").LocalTtftRecord[] = [];
  const observer = new LocalTtftObserver((record) => records.push(record));
  observer.enabled = true;
  setLocalTtftObserver(observer);
  const a = observer.start("/a", false)!;
  observer.start("/b", false);
  const transport = createAgentConversationTransport(service, { workspacePath: "/a" });
  const off = transport.onRuntimeLifecycle!(() => {});
  try {
    lifecycle.fire({ workspaceKey: "/b", state: "unavailable" });
    expect(records.filter((record) => record.kind === "excluded")).toHaveLength(0);
    lifecycle.fire({ workspaceKey: "/a", state: "unavailable" });
    expect(records.filter((record) => record.kind === "excluded")).toMatchObject([
      { observationId: a.observationId, outcome: "interrupted" },
    ]);
  } finally {
    off();
    setLocalTtftObserver(undefined);
  }
});

it("校准过期后收到 CLI 检查点或内容帧会重新探测时钟，有效期内不重复", async () => {
  const agent = setupAgent();
  const facts = new Emitter<import("@zcode/shared").LocalTtftFacts>();
  const service = { ...agent, onDynamicLocalTtftFacts: () => facts.event };
  let now = 100_000;
  const observer = new LocalTtftObserver(
    () => {},
    () => now,
    () => now,
  );
  observer.enabled = true;
  setLocalTtftObserver(observer);
  const context = observer.start("/a", true)!;
  observer.dispatch(context, "/a", "c", "s");
  // 发送时已校准；排队等待期间没有任何传输调用，旧逻辑不会再刷新校准。
  observer.calibrate("/a", { instanceId: "cli", offsetMs: 0, errorMs: 1, measuredAt: now });
  const transport = createAgentConversationTransport(service, { workspacePath: "/a" });
  const off = transport.onFrame(() => {});
  const clockProbes = () =>
    agent.queryConversationCommandsV4.mock.calls.filter(
      ([params]) => (params as { clock?: true }).clock === true,
    ).length;
  try {
    const checkpoint = {
      ...context,
      instanceId: "cli",
      commandId: "c",
      sessionId: "s",
      receivedAt: 100_000,
      admittedAt: 100_010,
    };
    facts.fire(checkpoint);
    expect(clockProbes()).toBe(0);
    now += 61_000;
    facts.fire({ ...checkpoint, executionAt: now });
    await Promise.resolve();
    expect(clockProbes()).toBe(1);
    // 同一在途探测未返回前，再多检查点也只保留一次探测。
    facts.fire({ ...checkpoint, executionAt: now, requestAt: now + 1 });
    expect(clockProbes()).toBe(1);
  } finally {
    off();
    setLocalTtftObserver(undefined);
  }
});
