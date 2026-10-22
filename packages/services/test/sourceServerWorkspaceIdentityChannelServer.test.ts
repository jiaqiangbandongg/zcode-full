import { Emitter, type IChannelServer, type IServerChannel } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  type TopicWireFrameCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceServerWorkspaceIdentityChannelServer,
  SourceServerWorkspaceIdentityMapper,
} from "#src/source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";

function createCapturingServer(): {
  channels: Map<string, IServerChannel<string>>;
  server: IChannelServer<string>;
} {
  const channels = new Map<string, IServerChannel<string>>();
  return {
    channels,
    server: {
      registerChannel(name, channel) {
        channels.set(name, channel);
      },
    },
  };
}

describe("SourceServerWorkspaceIdentityChannelServer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps positional, object and event identities in Core without changing binary values", async () => {
    const stableIdentity = "remote:server:server-id:/workspace";
    const canonicalIdentity = "remote:ssh:host:22:user:/workspace";
    const mapper = new SourceServerWorkspaceIdentityMapper();
    mapper.register({ stableIdentity, canonicalIdentity });
    const captured = createCapturingServer();
    const server = new SourceServerWorkspaceIdentityChannelServer(captured.server, mapper);
    const events = new Emitter<unknown>();
    const requestBytes = new Uint8Array([0, 127, 255]);
    const responseBytes = new Uint8Array([255, 1, 0]);
    let receivedArguments: unknown;

    server.registerChannel("workspace-service", {
      async call(_context, _command, args) {
        receivedArguments = args;
        return {
          workspaceIdentity: canonicalIdentity,
          workspaceKey: canonicalIdentity,
          sessionsTopic: `sessions-index/${canonicalIdentity}`,
          configTopic: `workspace-config/${canonicalIdentity}`,
          ordinaryText: `prefix:${canonicalIdentity}:suffix`,
          bytes: responseBytes,
        };
      },
      listen() {
        return events.event;
      },
    });

    const channel = captured.channels.get("workspace-service");
    const result = await channel!.call<{
      workspaceIdentity: string;
      workspaceKey: string;
      sessionsTopic: string;
      configTopic: string;
      ordinaryText: string;
      bytes: Uint8Array;
    }>("core", "invoke", [
      stableIdentity,
      {
        workspaceIdentity: stableIdentity,
        workspaceKey: stableIdentity,
        sessionsTopic: `sessions-index/${stableIdentity}`,
        configTopic: `workspace-config/${stableIdentity}`,
        ordinaryText: `prefix:${stableIdentity}:suffix`,
        bytes: requestBytes,
      },
    ]);

    expect(receivedArguments).toEqual([
      canonicalIdentity,
      {
        workspaceIdentity: canonicalIdentity,
        workspaceKey: canonicalIdentity,
        sessionsTopic: `sessions-index/${canonicalIdentity}`,
        configTopic: `workspace-config/${canonicalIdentity}`,
        ordinaryText: `prefix:${stableIdentity}:suffix`,
        bytes: requestBytes,
      },
    ]);
    expect((receivedArguments as [unknown, { bytes: Uint8Array }])[1].bytes).toBe(requestBytes);
    expect(result).toEqual({
      workspaceIdentity: stableIdentity,
      workspaceKey: stableIdentity,
      sessionsTopic: `sessions-index/${stableIdentity}`,
      configTopic: `workspace-config/${stableIdentity}`,
      ordinaryText: `prefix:${canonicalIdentity}:suffix`,
      bytes: responseBytes,
    });
    expect(result.bytes).toBe(responseBytes);

    const receivedEvents: unknown[] = [];
    const subscription = channel!.listen(
      "core",
      "onDidChange",
    )((event) => {
      receivedEvents.push(event);
    });
    events.fire({
      workspaceKey: canonicalIdentity,
      topic: `sessions-index/${canonicalIdentity}`,
      bytes: responseBytes,
    });

    expect(receivedEvents).toEqual([
      {
        workspaceKey: stableIdentity,
        topic: `sessions-index/${stableIdentity}`,
        bytes: responseBytes,
      },
    ]);
    expect((receivedEvents[0] as { bytes: Uint8Array }).bytes).toBe(responseBytes);
    subscription.dispose();
  });

  it("keeps the workspace resolver channel on canonical diagnostic values", async () => {
    const stableIdentity = "remote:server:server-id:/workspace";
    const canonicalIdentity = "remote:docker:container:/workspace";
    const mapper = new SourceServerWorkspaceIdentityMapper();
    mapper.register({ stableIdentity, canonicalIdentity });
    const captured = createCapturingServer();
    const server = new SourceServerWorkspaceIdentityChannelServer(captured.server, mapper);

    server.registerChannel(ServiceChannels.SourceServerWorkspace, {
      async call() {
        return { canonicalWorkspaceKey: canonicalIdentity };
      },
      listen() {
        return new Emitter<unknown>().event;
      },
    });

    await expect(
      captured.channels
        .get(ServiceChannels.SourceServerWorkspace)!
        .call("core", "resolveWorkspace", [{ workspaceIdentity: stableIdentity }]),
    ).resolves.toEqual({ canonicalWorkspaceKey: canonicalIdentity });
  });

  it("maps a fragmented sessions-index logical frame before exposing the Source Server wire", () => {
    const stableIdentity = "remote:server:server-id:/workspace";
    const canonicalIdentity = "remote:ssh:host:22:user:/workspace";
    const canonicalTopic = sessionsIndexTopic(canonicalIdentity);
    const mapper = new SourceServerWorkspaceIdentityMapper();
    mapper.register({ stableIdentity, canonicalIdentity });
    const captured = createCapturingServer();
    const server = new SourceServerWorkspaceIdentityChannelServer(captured.server, mapper);
    const events = new Emitter<unknown>();
    server.registerChannel("zcode-agent", {
      async call() {
        return undefined;
      },
      listen() {
        return events.event;
      },
    });

    const channel = captured.channels.get("zcode-agent")!;
    const outputAssembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
    const outputEvents: ReturnType<typeof outputAssembler.accept> = [];
    const subscription = channel.listen("core", "onDynamicSessionsIndexFrame", [
      { workspaceIdentity: stableIdentity },
    ])((wire) => {
      outputEvents.push(...outputAssembler.accept(wire as never));
    });
    const frame = {
      topic: canonicalTopic,
      subscriptionId: "sub-1",
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot" as const,
        snapshot: {
          protocolVersion: 1 as const,
          workspaceId: canonicalIdentity,
          logEpoch: "epoch-1",
          sessions: [
            {
              sessionId: "session-1",
              workspaceId: canonicalIdentity,
              title: "Large session",
              phase: "running" as const,
              sessionEnded: false,
              hasBackgroundWork: false,
              lastActivityAt: 1,
              lastAssistantPreview: "x".repeat(900_000),
              createdAt: 1,
            },
          ],
        },
      },
    };
    const canonicalWires = encodeTopicWireFrames(frame, {
      deliveryKind: "initial",
      topic: canonicalTopic,
      subscriptionId: "sub-1",
      logicalFrameId: "logical-1",
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    });
    expect(canonicalWires.length).toBeGreaterThan(1);

    for (const wire of canonicalWires) events.fire(wire);

    const completed = outputEvents.find((event) => event.kind === "complete");
    expect(completed).toMatchObject({
      kind: "complete",
      frame: {
        topic: sessionsIndexTopic(stableIdentity),
        payload: {
          snapshot: {
            workspaceId: stableIdentity,
            sessions: [{ workspaceId: stableIdentity }],
          },
        },
      },
    });
    expect(outputEvents.some((event) => event.kind === "fault")).toBe(false);
    subscription.dispose();
  });

  it("keeps a completed fragmented route when another route expires in the same accept", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stableIdentity = "remote:server:server-id:/workspace";
    const canonicalIdentity = "remote:ssh:host:22:user:/workspace";
    const mapper = new SourceServerWorkspaceIdentityMapper();
    mapper.register({ stableIdentity, canonicalIdentity });
    const captured = createCapturingServer();
    const server = new SourceServerWorkspaceIdentityChannelServer(captured.server, mapper);
    const events = new Emitter<unknown>();
    server.registerChannel("zcode-agent", {
      async call() {
        return undefined;
      },
      listen() {
        return events.event;
      },
    });

    const outputAssembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
    const outputEvents: ReturnType<typeof outputAssembler.accept> = [];
    const subscription = captured.channels
      .get("zcode-agent")!
      .listen(
        "core",
        "onDynamicSessionsIndexFrame",
      )((wire) => {
      outputEvents.push(...outputAssembler.accept(wire as TopicWireFrameCandidate));
    });
    const makeFrame = (subscriptionId: string) => ({
      topic: sessionsIndexTopic(canonicalIdentity),
      subscriptionId,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot" as const,
        snapshot: {
          protocolVersion: 1 as const,
          workspaceId: canonicalIdentity,
          logEpoch: `epoch-${subscriptionId}`,
          sessions: [
            {
              sessionId: `session-${subscriptionId}`,
              workspaceId: canonicalIdentity,
              title: "x".repeat(900_000),
              phase: "running" as const,
              sessionEnded: false,
              hasBackgroundWork: false,
              lastActivityAt: 1,
              createdAt: 1,
            },
          ],
        },
      },
    });
    const encode = (frame: ReturnType<typeof makeFrame>, logicalFrameId: string) =>
      encodeTopicWireFrames(frame, {
        deliveryKind: "online",
        topic: frame.topic,
        subscriptionId: frame.subscriptionId,
        logicalFrameId,
        logicalFrameOrdinal: 1,
        measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
      });
    const expired = encode(makeFrame("sub-expired"), "logical-expired");
    const completed = encode(makeFrame("sub-completed"), "logical-completed");
    expect(expired.length).toBeGreaterThan(1);
    expect(completed.length).toBeGreaterThan(1);

    events.fire(expired[0]);
    vi.setSystemTime(1);
    for (const wire of completed.slice(0, -1)) events.fire(wire);
    vi.setSystemTime(30_000);
    events.fire(completed.at(-1)!);

    expect(outputEvents).toContainEqual(
      expect.objectContaining({
        kind: "fault",
        fault: expect.objectContaining({ subscriptionId: "sub-expired" }),
      }),
    );
    expect(outputEvents).toContainEqual(
      expect.objectContaining({
        kind: "complete",
        frame: expect.objectContaining({
          topic: sessionsIndexTopic(stableIdentity),
          subscriptionId: "sub-completed",
        }),
      }),
    );
    subscription.dispose();
  });

  it("maps workspace hook identity inside fragmented conversation frames", () => {
    const stableIdentity = "remote:server:server-id:/workspace";
    const canonicalIdentity = "remote:ssh:host:22:user:/workspace";
    const mapper = new SourceServerWorkspaceIdentityMapper();
    mapper.register({ stableIdentity, canonicalIdentity });
    const captured = createCapturingServer();
    const server = new SourceServerWorkspaceIdentityChannelServer(captured.server, mapper);
    const events = new Emitter<unknown>();
    server.registerChannel("zcode-agent", {
      async call() {
        return undefined;
      },
      listen() {
        return events.event;
      },
    });
    const frame = {
      topic: "conversation/session-1",
      subscriptionId: "sub-conversation",
      fromSeq: 1,
      toSeq: 2,
      sentAt: 1,
      payload: {
        kind: "deltas" as const,
        deltas: [
          {
            op: "state.updated" as const,
            patch: {
              workspaceHookAdmission: {
                pendingCount: 1,
                bundleDigest: "digest",
                workspaceIdentity: canonicalIdentity,
              },
              meta: { title: "x".repeat(900_000), titleSource: "custom" as const },
            },
          },
        ],
      },
    };
    const wires = encodeTopicWireFrames(frame, {
      deliveryKind: "online",
      topic: frame.topic,
      subscriptionId: frame.subscriptionId,
      logicalFrameId: "logical-conversation",
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    });
    expect(wires.length).toBeGreaterThan(1);
    const outputAssembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const outputEvents: ReturnType<typeof outputAssembler.accept> = [];
    const subscription = captured.channels
      .get("zcode-agent")!
      .listen(
        "core",
        "onDynamicConversationFrame",
      )((wire) => {
      outputEvents.push(...outputAssembler.accept(wire as TopicWireFrameCandidate));
    });

    for (const wire of wires) events.fire(wire);

    expect(outputEvents).toContainEqual(
      expect.objectContaining({
        kind: "complete",
        frame: expect.objectContaining({
          payload: expect.objectContaining({
            deltas: [
              expect.objectContaining({
                patch: expect.objectContaining({
                  workspaceHookAdmission: expect.objectContaining({
                    workspaceIdentity: stableIdentity,
                  }),
                }),
              }),
            ],
          }),
        }),
      }),
    );
    subscription.dispose();
  });

  it("converts mapped-frame encoding failures into a topic fault without throwing", () => {
    const canonicalIdentity = "remote:docker:c:/workspace";
    const stableIdentity = `remote:server:${"s".repeat(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    )}:/workspace`;
    const mapper = new SourceServerWorkspaceIdentityMapper();
    mapper.register({ stableIdentity, canonicalIdentity });
    const captured = createCapturingServer();
    const server = new SourceServerWorkspaceIdentityChannelServer(captured.server, mapper);
    const events = new Emitter<unknown>();
    server.registerChannel("zcode-agent", {
      async call() {
        return undefined;
      },
      listen() {
        return events.event;
      },
    });
    const received: unknown[] = [];
    const subscription = captured.channels
      .get("zcode-agent")!
      .listen(
        "core",
        "onDynamicSessionsIndexFrame",
      )((wire) => received.push(wire));
    const frame = {
      topic: sessionsIndexTopic(canonicalIdentity),
      subscriptionId: "sub-oversized-mapping",
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot" as const,
        snapshot: {
          protocolVersion: 1 as const,
          workspaceId: canonicalIdentity,
          logEpoch: "epoch-1",
          sessions: [],
        },
      },
    };

    expect(() =>
      events.fire({
        wireVersion: 3,
        kind: "complete",
        deliveryKind: "initial",
        logicalFrameId: "logical-oversized-mapping",
        logicalFrameOrdinal: 1,
        topic: frame.topic,
        subscriptionId: frame.subscriptionId,
        frame,
      }),
    ).not.toThrow();
    expect(received).toEqual([
      expect.objectContaining({
        kind: "complete",
        topic: sessionsIndexTopic(stableIdentity),
        subscriptionId: frame.subscriptionId,
      }),
    ]);
    expect(received[0]).not.toHaveProperty("frame");
    subscription.dispose();
  });

  it("keeps conversation identity mapping growth linear at the Source seam", () => {
    const stableIdentity = "remote:server:server-id:/workspace";
    const canonicalIdentity = "remote:ssh:host:22:user:/workspace";
    const mapper = new SourceServerWorkspaceIdentityMapper();
    mapper.register({ stableIdentity, canonicalIdentity });
    const measurePropertyReads = (rowCount: number): number => {
      let propertyReads = 0;
      const trackedRow = (index: number) => {
        const track = <T>(value: T) => ({
          enumerable: true,
          get: () => {
            propertyReads += 1;
            return value;
          },
        });
        const nested = Object.defineProperties(
          {},
          {
            workspaceKey: track(canonicalIdentity),
            text: track(`payload-${index}`),
          },
        );
        return Object.defineProperties(
          {},
          {
            id: track(`row-${index}`),
            workspaceIdentity: track(canonicalIdentity),
            nested: track(nested),
          },
        );
      };
      const payload = {
        workspaceIdentity: canonicalIdentity,
        rows: Array.from({ length: rowCount }, (_, index) => trackedRow(index)),
      };
      const mapped = mapper.mapOutgoing(payload) as {
        rows: Array<{ workspaceIdentity: string }>;
      };
      expect(mapped.rows.at(-1)?.workspaceIdentity).toBe(stableIdentity);
      return propertyReads;
    };

    const small = measurePropertyReads(1_000);
    const large = measurePropertyReads(2_000);
    // Bug 原因：墙钟比值会把 Vitest worker 抢占误判成复杂度回归。用可观察属性读取数
    // 机械守护单次深度遍历：行数翻倍时访问数必须精确翻倍。
    expect(small).toBe(5_000);
    expect(large).toBe(small * 2);
  });
});
