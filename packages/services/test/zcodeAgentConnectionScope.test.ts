import type { ZCodeMcpResourceSample } from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import type { ZCodeMcpTelemetryEvent, ZCodeProcessResourceSample } from "@zcode/shared";
import type {
  ConversationTopicFrame,
  ConversationTopicWireFrame,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireFrame,
  TopicWireFrame,
  WorkspaceConfigTopicFrame,
  WorkspaceConfigTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { sessionsIndexTopic, workspaceConfigTopic } from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it, vi } from "vitest";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentCuaPermissionObservation,
} from "../src/zcode-agent/zcodeAgent.js";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  readTrustedZCodeAgentV4UnsubscribeRoute,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";

function makeFrame(topic: string, subscriptionId: string): ConversationTopicFrame {
  return {
    topic,
    subscriptionId,
    fromSeq: 1,
    toSeq: 1,
    sentAt: 1,
    payload: { kind: "deltas", deltas: [] },
  };
}

function completeWire<F extends { topic: string; subscriptionId: string }>(
  frame: F,
  logicalFrameId = `logical-${frame.subscriptionId}`,
  logicalFrameOrdinal = 1,
): TopicWireFrame<F> {
  return {
    wireVersion: 3,
    kind: "complete",
    logicalFrameId,
    logicalFrameOrdinal,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

function setupBase() {
  const conversationFrames = new Emitter<ConversationTopicWireFrame>();
  const telemetryFacts = new Emitter<ConversationTelemetryFact>();
  const cuaPermissionObservations = new Emitter<ZCodeAgentCuaPermissionObservation>();
  const processResourceSamples = new Emitter<ZCodeProcessResourceSample>();
  const mcpResourceSamples = new Emitter<ZCodeMcpResourceSample[]>();
  const mcpTelemetryEvents = new Emitter<ZCodeMcpTelemetryEvent>();
  const sessionsIndexFrames = new Emitter<SessionsIndexTopicWireFrame>();
  const workspaceConfigFrames = new Emitter<WorkspaceConfigTopicWireFrame>();
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  const nextSerialByConnection = new Map<string, number>();
  const nextId = (params: unknown) => {
    const connection = readTrustedZCodeAgentV4Connection(params);
    if (!connection) throw new Error("missing trusted connection");
    const serial = (nextSerialByConnection.get(connection.connectionId) ?? 0) + 1;
    nextSerialByConnection.set(connection.connectionId, serial);
    return `sub-${connection.connectionId}-${serial}`;
  };
  const base = {
    helloConversationV4: vi.fn(),
    initializeConversationV4: vi.fn(),
    subscribeConversationV4: vi.fn(async (params: unknown) => ({
      ack: {
        subscriptionId: nextId(params),
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      },
    })),
    unsubscribeConversationV4: vi.fn(async () => {}),
    resyncConversationV4: vi.fn(async (params: { subscriptionId: string }) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: "resume" as const,
        logEpoch: "epoch-1",
      },
    })),
    onDynamicConversationFrame: vi.fn(() => conversationFrames.event),
    onDynamicConversationTelemetryFact: vi.fn(() => telemetryFacts.event),
    onDynamicCuaPermissionObservation: vi.fn(() => cuaPermissionObservations.event),
    onDynamicProcessResourceSample: vi.fn(() => processResourceSamples.event),
    onDynamicMcpResourceSamples: vi.fn(() => mcpResourceSamples.event),
    onDynamicMcpTelemetry: vi.fn(() => mcpTelemetryEvents.event),
    subscribeSessionsIndexV4: vi.fn(async (params: unknown) => ({
      ack: {
        subscriptionId: nextId(params),
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      },
    })),
    unsubscribeSessionsIndexV4: vi.fn(async () => {}),
    onDynamicSessionsIndexFrame: vi.fn(() => sessionsIndexFrames.event),
    subscribeWorkspaceConfigV4: vi.fn(async (params: unknown) => ({
      ack: {
        subscriptionId: nextId(params),
        mode: "snapshot" as const,
        logEpoch: "epoch-1",
      },
    })),
    unsubscribeWorkspaceConfigV4: vi.fn(async () => {}),
    onDynamicWorkspaceConfigFrame: vi.fn(() => workspaceConfigFrames.event),
    onAgentRuntimeRestarted: vi.fn((listener: (event: { workspaceKey: string }) => void) =>
      runtimeRestarts.event(listener),
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
    backgroundBashOutputV4: vi.fn(async () => ({ kind: "unavailable", workId: "work" })),
    conversationRowsRangeV4: vi.fn(async () => ({
      rows: [],
      atSeq: 1,
      atLogEpoch: "epoch-1",
      hasMore: false,
    })),
    attachmentBeginV4: vi.fn(async (params: { uploadId: string }) => ({
      uploadId: params.uploadId,
      state: "staging" as const,
      nextChunkIndex: 0,
    })),
    attachmentChunkV4: vi.fn(async (params: { uploadId: string; chunkIndex: number }) => ({
      uploadId: params.uploadId,
      nextChunkIndex: params.chunkIndex + 1,
    })),
    attachmentCommitV4: vi.fn(async () => ({ ref: "zcode-artifact://attachment/test" })),
    attachmentAbortV4: vi.fn(async () => {}),
    attachmentReadV4: vi.fn(async () => ({
      dataBase64: "",
      mediaType: "image/png",
      totalBytes: 0,
      nextOffset: null,
    })),
    setConnectionFlowStateV4: vi.fn(async () => {}),
  } as unknown as IZCodeAgentService;
  return {
    base,
    conversationFrames,
    telemetryFacts,
    cuaPermissionObservations,
    processResourceSamples,
    mcpResourceSamples,
    mcpTelemetryEvents,
    sessionsIndexFrames,
    workspaceConfigFrames,
    runtimeRestarts,
  };
}

function attachRuntimeLifecycle(
  base: IZCodeAgentService,
): Emitter<ZCodeAgentRuntimeLifecycleEvent> {
  const runtimeLifecycle = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  Object.assign(base, {
    onAgentRuntimeLifecycle: vi.fn((listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) =>
      runtimeLifecycle.event(listener),
    ),
  });
  return runtimeLifecycle;
}

function makeRuntimeLifecycleEvent(
  target: { workspacePath: string; workspaceIdentity?: string },
  generation: number,
  state: ZCodeAgentRuntimeLifecycleEvent["state"],
): ZCodeAgentRuntimeLifecycleEvent {
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  return {
    ...target,
    workspaceKey,
    runtimeIdentity: {
      generation,
      identity: `${workspaceKey}:${generation}:100`,
      processId: 100,
      workspaceKey,
    },
    state,
  };
}

describe("ZCodeAgent connection-scoped service facade", () => {
  it("desktop continuous 与 web replayable 都宣告 Host review domain capability", async () => {
    const { base } = setupBase();
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-hook-capability",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-hook-capability",
      clientMode: "web-remote-replayable",
    });

    await expect(desktop.service.helloConversationV4()).resolves.toMatchObject({
      clientMode: "desktop-continuous",
      capabilities: { workspaceHookReview: true },
    });
    await expect(mobile.service.helloConversationV4()).resolves.toMatchObject({
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      capabilities: { workspaceHookReview: true },
    });
  });
  // 增量能力是一条**单向**握手（shared transport.ts）：Host 先在 hello 里宣告，客户端才敢在
  // `.strict()` 的 clientHello capabilities 里回声明；host 再把这条连接的声明当可信位注入订阅。
  it("hello 宣告 workflowRunDeltas，clientHello 声明后才成为订阅上的可信位", async () => {
    const { base } = setupBase();
    const declared = createZCodeAgentConnectionScope(base, {
      connectionId: "deltas-declared",
      clientMode: "desktop-continuous",
    });
    const silent = createZCodeAgentConnectionScope(base, {
      connectionId: "deltas-silent",
      clientMode: "web-remote-replayable",
    });

    await expect(declared.service.helloConversationV4()).resolves.toMatchObject({
      capabilities: { workflowRunDeltas: true },
    });
    await silent.service.helloConversationV4();
    await declared.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "deltas-client",
      appVersion: "4.0.0",
      capabilities: { workflowRunDeltas: true },
    });
    await silent.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "deltas-client",
      appVersion: "4.0.0",
      capabilities: { workspaceHookReviewUi: true },
    });
    await declared.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-1",
      // UI 面自报的同名字段：facade 先清后写，伪造不了能力。
      workflowRunDeltas: false,
    } as never);
    await silent.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-1",
      workflowRunDeltas: true,
    } as never);

    const calls = vi.mocked(base.subscribeConversationV4).mock.calls;
    expect(readTrustedZCodeAgentV4Connection(calls[0]?.[0])).toEqual({
      connectionId: "deltas-declared",
      clientMode: "desktop-continuous",
      workflowRunDeltas: true,
    });
    expect(calls[0]?.[0]).not.toHaveProperty("workflowRunDeltas");
    expect(readTrustedZCodeAgentV4Connection(calls[1]?.[0])).toEqual({
      connectionId: "deltas-silent",
      clientMode: "web-remote-replayable",
    });
    expect(calls[1]?.[0]).not.toHaveProperty("workflowRunDeltas");
  });

  it("trusted relay 把下游 clientHello 的 workflowRunDeltas 原样带到上游订阅", async () => {
    const { base } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-upstream",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-downstream",
      clientMode: "web-remote-replayable",
    });
    await mobile.service.helloConversationV4();
    await mobile.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-client",
      appVersion: "4.0.0",
      capabilities: { workflowRunDeltas: true },
    });

    await mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-1",
    });

    // relay 自己没有 clientHello（它不消费帧）：这个位只能是下游那一端的事实。
    const forwarded = readTrustedZCodeAgentV4Connection(
      vi.mocked(base.subscribeConversationV4).mock.calls[0]?.[0],
    );
    expect(forwarded).toMatchObject({
      clientMode: "web-remote-replayable",
      workflowRunDeltas: true,
    });
    expect(forwarded?.connectionId).toContain("mobile-downstream");
  });

  it("rows/range forwards the connection-owned Desktop/Web mode as trusted metadata", async () => {
    const { base } = setupBase();
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-rows",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-rows",
      clientMode: "web-remote-replayable",
    });
    for (const scope of [desktop, mobile]) {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "rows-client",
        appVersion: "4.0.0",
      });
      await scope.service.conversationRowsRangeV4({
        workspacePath: "/repo",
        sessionId: "session-1",
        limit: 20,
      });
    }

    const calls = vi.mocked(base.conversationRowsRangeV4).mock.calls;
    expect(readTrustedZCodeAgentV4Connection(calls[0]?.[0])).toEqual({
      connectionId: "desktop-rows",
      clientMode: "desktop-continuous",
    });
    expect(readTrustedZCodeAgentV4Connection(calls[1]?.[0])).toEqual({
      connectionId: "mobile-rows",
      clientMode: "web-remote-replayable",
    });
  });

  it("只有 trusted Host relay 能跨连接订阅 CLI 进程资源样本", () => {
    const { base, processResourceSamples } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-upstream",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const desktop = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "desktop-downstream",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-downstream",
      clientMode: "web-remote-replayable",
    });
    const relaySeen: ZCodeProcessResourceSample[] = [];
    const desktopSeen: ZCodeProcessResourceSample[] = [];
    const mobileSeen: ZCodeProcessResourceSample[] = [];

    relay.service.onDynamicProcessResourceSample()((sample) => relaySeen.push(sample));
    desktop.service.onDynamicProcessResourceSample()((sample) => desktopSeen.push(sample));
    mobile.service.onDynamicProcessResourceSample()((sample) => mobileSeen.push(sample));
    const sample: ZCodeProcessResourceSample = {
      arch: "x64",
      cpuCores: 1,
      cpuPercent: 12.5,
      intervalMs: 60_000,
      logicalCpuCount: 8,
      platform: "linux",
      rssKb: 64_000,
    };
    processResourceSamples.fire(sample);

    expect(relaySeen).toEqual([sample]);
    expect(desktopSeen).toEqual([]);
    expect(mobileSeen).toEqual([]);
    expect(base.onDynamicProcessResourceSample).toHaveBeenCalledTimes(1);
  });

  it("只有 trusted Host relay 能订阅 MCP 遥测", () => {
    const { base, mcpTelemetryEvents } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-upstream",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const desktop = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "desktop-downstream",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-downstream",
      clientMode: "web-remote-replayable",
    });
    const sample: ZCodeMcpTelemetryEvent = {
      arch: "x64",
      kind: "process_start",
      mcpId: "builtin:node_repl",
      mcpInstanceId: "mcp-instance-1",
      mcpIsolation: "workspace",
      mcpSource: "builtin",
      occurredAt: 1,
      platform: "linux",
    };
    const relaySeen: ZCodeMcpTelemetryEvent[] = [];
    const desktopSeen: ZCodeMcpTelemetryEvent[] = [];
    const mobileSeen: ZCodeMcpTelemetryEvent[] = [];

    relay.service.onDynamicMcpTelemetry()((event) => relaySeen.push(event));
    desktop.service.onDynamicMcpTelemetry()((event) => desktopSeen.push(event));
    mobile.service.onDynamicMcpTelemetry()((event) => mobileSeen.push(event));
    mcpTelemetryEvents.fire(sample);

    expect(relaySeen).toEqual([sample]);
    expect(desktopSeen).toEqual([]);
    expect(mobileSeen).toEqual([]);
    expect(base.onDynamicMcpTelemetry).toHaveBeenCalledTimes(1);
  });

  it("只有 trusted Host relay 能订阅 MCP 资源数组", () => {
    const { base, mcpResourceSamples } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-upstream",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const desktop = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "desktop-downstream",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-downstream",
      clientMode: "web-remote-replayable",
    });
    const sample: ZCodeMcpResourceSample[] = [
      {
        mcpId: "builtin:node_repl",
        instanceToken: "cli-instance-01",
        sampledAt: 300000,
        intervalMs: 300000,
        processCount: 1,
        rssKbTotal: 100,
        rssKbMaxProcess: 100,
        cpuTimeMsDelta: 0,
        uptimeMinutes: 5,
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 8,
        totalMemoryGb: 32,
      },
    ];
    const relaySeen: ZCodeMcpResourceSample[][] = [];
    const desktopSeen: ZCodeMcpResourceSample[][] = [];
    const mobileSeen: ZCodeMcpResourceSample[][] = [];

    relay.service.onDynamicMcpResourceSamples()((event) => relaySeen.push(event));
    desktop.service.onDynamicMcpResourceSamples()((event) => desktopSeen.push(event));
    mobile.service.onDynamicMcpResourceSamples()((event) => mobileSeen.push(event));
    mcpResourceSamples.fire(sample);

    expect(relaySeen).toEqual([sample]);
    expect(desktopSeen).toEqual([]);
    expect(mobileSeen).toEqual([]);
    expect(base.onDynamicMcpResourceSamples).toHaveBeenCalledTimes(1);
  });

  it("只有可信 desktop-continuous attachment 能订阅 workspace telemetry fact", async () => {
    const { base, telemetryFacts } = setupBase();
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-telemetry",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-telemetry",
      clientMode: "web-remote-replayable",
    });
    const desktopSeen: ConversationTelemetryFact[] = [];
    const mobileSeen: ConversationTelemetryFact[] = [];
    // Root supervisor 在协议握手前挂载；可信 desktop 的只读 emitter 订阅必须可提前建立。
    desktop.service.onDynamicConversationTelemetryFact({ workspacePath: "/repo" })((fact) =>
      desktopSeen.push(fact),
    );
    mobile.service.onDynamicConversationTelemetryFact({ workspacePath: "/repo" })((fact) =>
      mobileSeen.push(fact),
    );
    for (const scope of [desktop, mobile]) {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: `${scope === desktop ? "desktop" : "mobile"}-client`,
        appVersion: "4.0.0",
      });
    }

    telemetryFacts.fire({
      version: 1,
      eventId: "event-1",
      eventSeq: 1,
      occurredAt: 1,
      sessionId: "session-1",
      kind: "turn.started",
      sourceCommandId: "command-1",
    });

    expect(desktopSeen).toHaveLength(1);
    expect(mobileSeen).toHaveLength(0);
    expect(base.onDynamicConversationTelemetryFact).toHaveBeenCalledTimes(1);
  });

  it("trusted host relay 只向 desktop-continuous 下游转发 telemetry fact", () => {
    const { base, telemetryFacts } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-telemetry-relay",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const desktop = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "desktop-telemetry-downstream",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-telemetry-downstream",
      clientMode: "web-remote-replayable",
    });
    const relaySeen: ConversationTelemetryFact[] = [];
    const desktopSeen: ConversationTelemetryFact[] = [];
    const mobileSeen: ConversationTelemetryFact[] = [];
    relay.service.onDynamicConversationTelemetryFact({ workspacePath: "/repo" })((fact) =>
      relaySeen.push(fact),
    );
    desktop.service.onDynamicConversationTelemetryFact({ workspacePath: "/repo" })((fact) =>
      desktopSeen.push(fact),
    );
    mobile.service.onDynamicConversationTelemetryFact({ workspacePath: "/repo" })((fact) =>
      mobileSeen.push(fact),
    );

    const fact: ConversationTelemetryFact = {
      version: 1,
      eventId: "relay-event-1",
      eventSeq: 1,
      occurredAt: 1,
      sessionId: "session-1",
      kind: "turn.started",
      sourceCommandId: "command-1",
    };
    telemetryFacts.fire(fact);

    expect(relaySeen).toHaveLength(0);
    expect(desktopSeen).toEqual([fact]);
    expect(mobileSeen).toHaveLength(0);
    expect(base.onDynamicConversationTelemetryFact).toHaveBeenCalledOnce();
    expect(
      readTrustedZCodeAgentV4Connection(
        vi.mocked(base.onDynamicConversationTelemetryFact).mock.calls[0]?.[0],
      ),
    ).toEqual({
      connectionId: "relay:22:server-telemetry-relay28:desktop-telemetry-downstream",
      clientMode: "desktop-continuous",
    });
  });

  it("只有可信 desktop-continuous attachment 能订阅窗口级 CUA 权限观察", () => {
    const { base, cuaPermissionObservations } = setupBase();
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-cua-permission",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-cua-permission",
      clientMode: "web-remote-replayable",
    });
    const desktopSeen: ZCodeAgentCuaPermissionObservation[] = [];
    const mobileSeen: ZCodeAgentCuaPermissionObservation[] = [];

    desktop.service.onDynamicCuaPermissionObservation()((event) => desktopSeen.push(event));
    mobile.service.onDynamicCuaPermissionObservation()((event) => mobileSeen.push(event));

    const observation: CuaPermissionObservation = {
      schemaVersion: 1,
      eventId: "event-1",
      eventSeq: 1,
      occurredAt: 1,
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      permissionStatus: {
        schemaVersion: 1,
        platform: "darwin",
        grantOwner: "dev.zcode.cua-helper.dev",
        accessibility: "denied",
        screenRecording: "granted",
      },
    };
    cuaPermissionObservations.fire({ ...observation, workspacePath: "/repo" });

    expect(desktopSeen).toHaveLength(1);
    expect(mobileSeen).toHaveLength(0);
    expect(base.onDynamicCuaPermissionObservation).toHaveBeenCalledTimes(1);
  });

  it("physical ACK staging 超 1024 片时清空整批、拒绝 subscribe 并反向退订", async () => {
    const { base, conversationFrames } = setupBase();
    let resolveSubscribe!: (value: {
      ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string };
    }) => void;
    vi.mocked(base.subscribeConversationV4).mockImplementationOnce(
      () => new Promise((resolve) => (resolveSubscribe = resolve)),
    );
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "physical-overflow",
      clientMode: "desktop-continuous",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "physical-overflow-client",
      appVersion: "4.0.0",
    });
    const seen: ConversationTopicWireFrame[] = [];
    scope.service.onDynamicConversationFrame({ workspacePath: "/repo" })((wire) => seen.push(wire));
    const subscribing = scope.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "physical-overflow-session",
    });
    for (let fragmentIndex = 0; fragmentIndex < 1_025; fragmentIndex += 1) {
      conversationFrames.fire({
        wireVersion: 3,
        kind: "fragment",
        logicalFrameId: "logical-overflow",
        logicalFrameOrdinal: 1,
        topic: "conversation/physical-overflow-session",
        subscriptionId: "sub-physical-overflow",
        fragmentIndex: fragmentIndex % 1_024,
        fragmentCount: 1_024,
        logicalBytes: 1_024,
        checksum: { algorithm: "crc32", value: "00000000" },
        dataBase64: "AA==",
      });
    }
    resolveSubscribe({
      ack: {
        subscriptionId: "sub-physical-overflow",
        mode: "snapshot",
        logEpoch: "epoch-overflow",
      },
    });
    await expect(subscribing).rejects.toThrow("fault.subscription.initialFrameStagingOverflow");
    expect(seen).toEqual([]);
    expect(base.unsubscribeConversationV4).toHaveBeenCalled();
    await scope.dispose();
  });

  it("host mode 决定 hello/profile，双端同 session 只收到 owned subscription", async () => {
    const { base, conversationFrames } = setupBase();
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-a",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-b",
      clientMode: "web-remote-replayable",
    });

    await expect(
      desktop.service.subscribeConversationV4({
        workspacePath: "/repo",
        sessionId: "before-handshake",
      }),
    ).rejects.toThrow("fault.connection.handshakeRequired");
    const desktopHello = await desktop.service.helloConversationV4();
    await desktop.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "same-client-metadata",
      clientKind: "mobileRemote",
      appVersion: "4.0.0",
    });
    const mobileHello = await mobile.service.helloConversationV4();
    await mobile.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "same-client-metadata",
      clientKind: "desktop",
      appVersion: "4.0.0",
    });
    expect(desktopHello).toMatchObject({
      connectionId: "desktop-a",
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
    });
    expect(mobileHello).toMatchObject({
      connectionId: "mobile-b",
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
    });

    const desktopSeen: string[] = [];
    const mobileSeen: string[] = [];
    desktop.service.onDynamicConversationFrame({
      workspacePath: "/repo",
      workspaceIdentity: "local:repo",
    })((frame) => desktopSeen.push(frame.subscriptionId));
    mobile.service.onDynamicConversationFrame({
      workspacePath: "/repo",
      workspaceIdentity: "local:repo",
    })((frame) => mobileSeen.push(frame.subscriptionId));
    const desktopSub = await desktop.service.subscribeConversationV4({
      workspacePath: "/repo",
      workspaceIdentity: "local:repo",
      sessionId: "session-1",
    });
    const mobileSub = await mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      workspaceIdentity: "local:repo",
      sessionId: "session-1",
    });

    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-1", desktopSub.ack.subscriptionId)),
    );
    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-1", mobileSub.ack.subscriptionId)),
    );
    expect(desktopSeen).toEqual([desktopSub.ack.subscriptionId]);
    expect(mobileSeen).toEqual([mobileSub.ack.subscriptionId]);

    const desktopForwarded = vi.mocked(base.subscribeConversationV4).mock.calls[0]?.[0];
    expect(desktopForwarded).toMatchObject({
      workspacePath: "/repo",
      workspaceIdentity: "local:repo",
      sessionId: "session-1",
    });
    expect(readTrustedZCodeAgentV4Connection(desktopForwarded)).toEqual({
      connectionId: "desktop-a",
      clientMode: "desktop-continuous",
    });
    expect(desktopForwarded).not.toHaveProperty("deliveryProfile");
  });

  it("same-sub resync 只允许 owner，并从 registry 注入 topic/trusted connection", async () => {
    const { base } = setupBase();
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-resync",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-resync",
      clientMode: "web-remote-replayable",
    });
    for (const [scope, clientId] of [
      [desktop, "desktop-client"],
      [mobile, "mobile-client"],
    ] as const) {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId,
        appVersion: "4.0.0",
      });
    }
    const subscribed = await mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-resync",
    });

    await expect(
      desktop.service.resyncConversationV4({
        workspacePath: "/repo",
        subscriptionId: subscribed.ack.subscriptionId,
        base: null,
      }),
    ).rejects.toThrow("fault.subscription.notOwned");
    const result = await mobile.service.resyncConversationV4({
      workspacePath: "/repo",
      subscriptionId: subscribed.ack.subscriptionId,
      base: { logEpoch: "epoch-1", seq: 4 },
    });
    expect(result.ack.subscriptionId).toBe(subscribed.ack.subscriptionId);
    const forwarded = vi.mocked(base.resyncConversationV4).mock.calls[0]?.[0];
    expect(forwarded).toMatchObject({
      workspacePath: "/repo",
      subscriptionId: subscribed.ack.subscriptionId,
      base: { logEpoch: "epoch-1", seq: 4 },
    });
    expect(readTrustedZCodeAgentV4UnsubscribeRoute(forwarded)).toEqual({
      topic: "conversation/session-resync",
      connectionId: "mobile-resync",
    });
  });

  it("双端同 topic 同时 pending 时，ACK 前帧只在对应 ACK owner 激活后释放", async () => {
    const { base, conversationFrames } = setupBase();
    const resolvers = new Map<
      string,
      (value: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }) => void
    >();
    vi.mocked(base.subscribeConversationV4).mockImplementation(
      (params: unknown) =>
        new Promise((resolve) => {
          const connection = readTrustedZCodeAgentV4Connection(params);
          if (!connection) throw new Error("missing trusted connection");
          resolvers.set(connection.connectionId, resolve);
        }),
    );
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-pending",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-pending",
      clientMode: "web-remote-replayable",
    });
    for (const [scope, clientId] of [
      [desktop, "desktop-client"],
      [mobile, "mobile-client"],
    ] as const) {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId,
        appVersion: "4.0.0",
      });
    }

    const desktopSeen: string[] = [];
    const mobileSeen: string[] = [];
    desktop.service.onDynamicConversationFrame({ workspacePath: "/repo" })((frame) =>
      desktopSeen.push(frame.subscriptionId),
    );
    mobile.service.onDynamicConversationFrame({ workspacePath: "/repo" })((frame) =>
      mobileSeen.push(frame.subscriptionId),
    );
    const desktopSubscribe = desktop.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-pending",
    });
    const mobileSubscribe = mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-pending",
    });
    await vi.waitFor(() => expect(resolvers.size).toBe(2));

    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-pending", "sub-desktop-pending")),
    );
    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-pending", "sub-mobile-pending")),
    );
    expect(desktopSeen).toEqual([]);
    expect(mobileSeen).toEqual([]);

    resolvers.get("mobile-pending")?.({
      ack: {
        subscriptionId: "sub-mobile-pending",
        mode: "snapshot",
        logEpoch: "epoch-mobile",
      },
    });
    await mobileSubscribe;
    expect(desktopSeen).toEqual([]);
    expect(mobileSeen).toEqual(["sub-mobile-pending"]);

    resolvers.get("desktop-pending")?.({
      ack: {
        subscriptionId: "sub-desktop-pending",
        mode: "snapshot",
        logEpoch: "epoch-desktop",
      },
    });
    await desktopSubscribe;
    expect(desktopSeen).toEqual(["sub-desktop-pending"]);
    expect(mobileSeen).toEqual(["sub-mobile-pending"]);
  });

  it("unowned unsubscribe 不越权，dispose 清理本连接全部 topic", async () => {
    const { base, sessionsIndexFrames, workspaceConfigFrames } = setupBase();
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-a",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-b",
      clientMode: "web-remote-replayable",
    });
    const target = { workspacePath: "/repo", workspaceIdentity: "ssh:repo" };
    await mobile.service.helloConversationV4();
    await mobile.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-client",
      appVersion: "4.0.0",
    });
    const conversation = await mobile.service.subscribeConversationV4({
      ...target,
      sessionId: "session-1",
    });
    const index = await mobile.service.subscribeSessionsIndexV4(target);
    const config = await mobile.service.subscribeWorkspaceConfigV4(target);
    const indexSeen: string[] = [];
    const configSeen: string[] = [];
    mobile.service.onDynamicSessionsIndexFrame(target)((frame) =>
      indexSeen.push(frame.subscriptionId),
    );
    mobile.service.onDynamicWorkspaceConfigFrame(target)((frame) =>
      configSeen.push(frame.subscriptionId),
    );
    sessionsIndexFrames.fire(
      completeWire({
        topic: sessionsIndexTopic("ssh:repo"),
        subscriptionId: "foreign-index",
      } as SessionsIndexTopicFrame),
    );
    sessionsIndexFrames.fire(
      completeWire({
        topic: sessionsIndexTopic("ssh:repo"),
        subscriptionId: index.ack.subscriptionId,
      } as SessionsIndexTopicFrame),
    );
    workspaceConfigFrames.fire(
      completeWire({
        topic: workspaceConfigTopic("ssh:repo"),
        subscriptionId: "foreign-config",
      } as WorkspaceConfigTopicFrame),
    );
    workspaceConfigFrames.fire(
      completeWire({
        topic: workspaceConfigTopic("ssh:repo"),
        subscriptionId: config.ack.subscriptionId,
      } as WorkspaceConfigTopicFrame),
    );
    expect(indexSeen).toEqual([index.ack.subscriptionId]);
    expect(configSeen).toEqual([config.ack.subscriptionId]);

    await desktop.service.unsubscribeConversationV4({
      ...target,
      subscriptionId: conversation.ack.subscriptionId,
    });
    expect(base.unsubscribeConversationV4).not.toHaveBeenCalled();

    await mobile.dispose();
    expect(base.unsubscribeConversationV4).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        subscriptionId: conversation.ack.subscriptionId,
      }),
    );
    expect(base.unsubscribeSessionsIndexV4).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        subscriptionId: index.ack.subscriptionId,
      }),
    );
    expect(base.unsubscribeWorkspaceConfigV4).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        subscriptionId: config.ack.subscriptionId,
      }),
    );
    expect(
      readTrustedZCodeAgentV4UnsubscribeRoute(
        vi.mocked(base.unsubscribeConversationV4).mock.calls[0]?.[0],
      ),
    ).toEqual({
      topic: "conversation/session-1",
      connectionId: "mobile-b",
    });
  });

  it("port close 与迟到 subscribe ACK 竞态时立即反向 unsubscribe", async () => {
    const { base } = setupBase();
    let resolveSubscribe!: (value: {
      ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string };
    }) => void;
    vi.mocked(base.subscribeConversationV4).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve;
        }),
    );
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-race",
      clientMode: "web-remote-replayable",
    });
    await mobile.service.helloConversationV4();
    await mobile.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-race-client",
      appVersion: "4.0.0",
    });
    const subscribing = mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-race",
    });

    await mobile.dispose();
    resolveSubscribe({
      ack: {
        subscriptionId: "sub-race-late",
        mode: "snapshot",
        logEpoch: "epoch-race",
      },
    });
    await expect(subscribing).rejects.toThrow("fault.connection.closed");
    expect(base.unsubscribeConversationV4).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/repo",
        subscriptionId: "sub-race-late",
      }),
    );
    expect(
      readTrustedZCodeAgentV4UnsubscribeRoute(
        vi.mocked(base.unsubscribeConversationV4).mock.calls[0]?.[0],
      ),
    ).toEqual({
      topic: "conversation/session-race",
      connectionId: "mobile-race",
    });
  });

  it("首次 runtime available 先于冷启动 subscribe ACK 时保留当前 ownership", async () => {
    const { base } = setupBase();
    const runtimeLifecycle = attachRuntimeLifecycle(base);
    const resolvers: Array<
      (value: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }) => void
    > = [];
    vi.mocked(base.subscribeConversationV4).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-cold-start",
      clientMode: "web-remote-replayable",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-cold-start-client",
      appVersion: "4.0.0",
    });
    const target = {
      workspacePath: "/repo",
      workspaceIdentity: "ssh://cold-start/repo",
    };

    const subscribing = scope.service.subscribeConversationV4({
      ...target,
      sessionId: "session-cold-start",
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    runtimeLifecycle.fire(makeRuntimeLifecycleEvent(target, 1, "available"));
    resolvers[0]!({
      ack: {
        subscriptionId: "sub-cold-start",
        mode: "snapshot",
        logEpoch: "epoch-cold-start",
      },
    });

    await expect(subscribing).resolves.toEqual(
      expect.objectContaining({
        ack: expect.objectContaining({ subscriptionId: "sub-cold-start" }),
      }),
    );
    await scope.service.unsubscribeConversationV4({
      ...target,
      subscriptionId: "sub-cold-start",
    });
    expect(base.unsubscribeConversationV4).toHaveBeenCalledTimes(1);

    await scope.dispose();
    runtimeLifecycle.dispose();
  });

  it("runtime unavailable 失效旧 ACK，但换代 available 不误伤边界后的新 subscribe", async () => {
    const { base } = setupBase();
    const runtimeLifecycle = attachRuntimeLifecycle(base);
    const resolvers: Array<
      (value: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }) => void
    > = [];
    vi.mocked(base.subscribeConversationV4).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-lifecycle-boundary",
      clientMode: "desktop-continuous",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "desktop-lifecycle-boundary-client",
      appVersion: "4.0.0",
    });
    const target = { workspacePath: "/repo" };

    runtimeLifecycle.fire(makeRuntimeLifecycleEvent(target, 1, "available"));
    const oldPending = scope.service.subscribeConversationV4({
      ...target,
      sessionId: "session-lifecycle-boundary",
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    runtimeLifecycle.fire(makeRuntimeLifecycleEvent(target, 1, "unavailable"));

    const fresh = scope.service.subscribeConversationV4({
      ...target,
      sessionId: "session-lifecycle-boundary",
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    runtimeLifecycle.fire(makeRuntimeLifecycleEvent(target, 2, "available"));
    resolvers[1]!({
      ack: { subscriptionId: "sub-new", mode: "snapshot", logEpoch: "epoch-new" },
    });
    await expect(fresh).resolves.toEqual(
      expect.objectContaining({ ack: expect.objectContaining({ subscriptionId: "sub-new" }) }),
    );

    resolvers[0]!({
      ack: { subscriptionId: "sub-old", mode: "snapshot", logEpoch: "epoch-old" },
    });
    await expect(oldPending).rejects.toThrow("fault.subscription.runtimeRestarted");
    expect(base.unsubscribeConversationV4).not.toHaveBeenCalled();

    await scope.dispose();
    runtimeLifecycle.dispose();
  });

  it("runtime restart 清旧 ownership；迟到旧 ACK 不 remember 也不误退新 runtime 同名 sub", async () => {
    const { base, conversationFrames, runtimeRestarts } = setupBase();
    const resolvers: Array<
      (value: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }) => void
    > = [];
    vi.mocked(base.subscribeConversationV4).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "restart-scope",
      clientMode: "desktop-continuous",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "restart-client",
      appVersion: "4.0.0",
    });
    const seen: string[] = [];
    scope.service.onDynamicConversationFrame({ workspacePath: "/repo" })((wire) =>
      seen.push(wire.logicalFrameId),
    );

    const oldPending = scope.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-restart",
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    runtimeRestarts.fire({ workspaceKey: "/repo" });
    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-restart", "sub-reused"), "old-runtime-wire"),
    );
    expect(seen).toEqual([]);

    const fresh = scope.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-restart",
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!({
      ack: { subscriptionId: "sub-reused", mode: "snapshot", logEpoch: "epoch-new" },
    });
    await fresh;
    resolvers[0]!({
      ack: { subscriptionId: "sub-reused", mode: "snapshot", logEpoch: "epoch-old" },
    });
    await expect(oldPending).rejects.toThrow("fault.subscription.runtimeRestarted");
    expect(base.unsubscribeConversationV4).not.toHaveBeenCalled();

    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-restart", "sub-reused"), "new-runtime-wire"),
    );
    expect(seen).toEqual(["new-runtime-wire"]);
    await scope.dispose();
  });

  it("workspace A restart 不清 workspace B 的 owner/pending", async () => {
    const { base, conversationFrames, runtimeRestarts } = setupBase();
    const resolvers = new Map<
      string,
      (value: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }) => void
    >();
    vi.mocked(base.subscribeConversationV4).mockImplementation(
      (params: { sessionId: string }) =>
        new Promise((resolve) => resolvers.set(params.sessionId, resolve)),
    );
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "workspace-isolation",
      clientMode: "desktop-continuous",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "workspace-client",
      appVersion: "4.0.0",
    });
    const seen: string[] = [];
    scope.service.onDynamicConversationFrame({ workspacePath: "/workspace-b" })((wire) =>
      seen.push(wire.logicalFrameId),
    );
    const pendingA = scope.service.subscribeConversationV4({
      workspacePath: "/workspace-a",
      sessionId: "session-a",
    });
    const pendingB = scope.service.subscribeConversationV4({
      workspacePath: "/workspace-b",
      sessionId: "session-b",
    });
    await vi.waitFor(() => expect(resolvers.size).toBe(2));

    runtimeRestarts.fire({ workspaceKey: "/workspace-a" });
    resolvers.get("session-b")?.({
      ack: { subscriptionId: "sub-b", mode: "snapshot", logEpoch: "epoch-b" },
    });
    await pendingB;
    resolvers.get("session-a")?.({
      ack: { subscriptionId: "sub-a", mode: "snapshot", logEpoch: "epoch-a" },
    });
    await expect(pendingA).rejects.toThrow("fault.subscription.runtimeRestarted");

    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-b", "sub-b"), "workspace-b-wire"),
    );
    expect(seen).toEqual(["workspace-b-wire"]);
    await scope.dispose();
  });

  it("trusted host relay 为 desktop/mobile 下游保留 mode 并 namespace connectionId", async () => {
    const { base } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-upstream",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const desktop = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "desktop-downstream",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-downstream",
      clientMode: "web-remote-replayable",
    });
    for (const scope of [desktop, mobile]) {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "downstream-client",
        appVersion: "4.0.0",
      });
    }

    await desktop.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-1",
    });
    await mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-1",
    });

    const forwarded = vi.mocked(base.subscribeConversationV4).mock.calls;
    expect(readTrustedZCodeAgentV4Connection(forwarded[0]?.[0])).toEqual({
      connectionId: "relay:15:server-upstream18:desktop-downstream",
      clientMode: "desktop-continuous",
    });
    expect(readTrustedZCodeAgentV4Connection(forwarded[1]?.[0])).toEqual({
      connectionId: "relay:15:server-upstream17:mobile-downstream",
      clientMode: "web-remote-replayable",
    });
  });

  it("stores pre-subscribe flow state, forwards one trusted route, and serializes edges", async () => {
    const { base } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-flow",
      clientMode: "web-remote-replayable",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-flow-client",
      appVersion: "4.0.0",
    });

    await scope.setTransportFlowState("saturated");
    expect(base.setConnectionFlowStateV4).not.toHaveBeenCalled();

    await scope.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-flow",
    });
    expect(base.setConnectionFlowStateV4).toHaveBeenCalledTimes(1);
    const first = vi.mocked(base.setConnectionFlowStateV4).mock.calls[0]?.[0];
    expect(first).toMatchObject({ workspacePath: "/repo", state: "saturated" });
    expect(readTrustedZCodeAgentV4Connection(first)).toEqual({
      connectionId: "mobile-flow",
      clientMode: "web-remote-replayable",
    });

    await scope.service.subscribeSessionsIndexV4({ workspacePath: "/repo" });
    expect(base.setConnectionFlowStateV4).toHaveBeenCalledTimes(1);

    await Promise.all([
      scope.setTransportFlowState("drained"),
      scope.setTransportFlowState("saturated"),
      scope.setTransportFlowState("drained"),
      scope.setTransportFlowState("drained"),
    ]);
    expect(
      vi
        .mocked(base.setConnectionFlowStateV4)
        .mock.calls.map(([params]) => (params as { state: string }).state),
    ).toEqual(["saturated", "drained", "saturated", "drained"]);

    await expect(
      scope.service.setConnectionFlowStateV4({
        workspacePath: "/repo",
        state: "saturated",
      }),
    ).rejects.toThrow("fault.connection.flowControlForbidden");
    await scope.dispose();
    expect(
      vi
        .mocked(base.setConnectionFlowStateV4)
        .mock.calls.map(([params]) => (params as { state: string }).state),
    ).toEqual(["saturated", "drained", "saturated", "drained", "closed"]);
    await scope.setTransportFlowState("saturated");
    expect(base.setConnectionFlowStateV4).toHaveBeenCalledTimes(5);
  });

  it("trusted relay namespaces downstream flow control and rejects terminal injection", async () => {
    const { base } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-upstream",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-downstream",
      clientMode: "web-remote-replayable",
    });
    await mobile.service.helloConversationV4();
    await mobile.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-client",
      appVersion: "4.0.0",
    });
    const subscribed = await mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-flow",
    });

    await mobile.setTransportFlowState("saturated");
    const forwarded = vi.mocked(base.setConnectionFlowStateV4).mock.calls[0]?.[0];
    expect(readTrustedZCodeAgentV4Connection(forwarded)).toEqual({
      connectionId: "relay:15:server-upstream17:mobile-downstream",
      clientMode: "web-remote-replayable",
    });
    expect(forwarded).toMatchObject({ workspacePath: "/repo", state: "saturated" });

    await expect(
      mobile.service.setConnectionFlowStateV4({
        workspacePath: "/repo",
        state: "drained",
      }),
    ).rejects.toThrow("fault.connection.flowControlForbidden");

    await mobile.service.unsubscribeConversationV4({
      workspacePath: "/repo",
      subscriptionId: subscribed.ack.subscriptionId,
    });
    expect(
      vi
        .mocked(base.setConnectionFlowStateV4)
        .mock.calls.map(([params]) => (params as { state: string }).state),
    ).toEqual(["saturated", "closed"]);
    expect(base.unsubscribeConversationV4).toHaveBeenCalledOnce();
    expect(vi.mocked(base.setConnectionFlowStateV4).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(base.unsubscribeConversationV4).mock.invocationCallOrder[0]!,
    );
    await mobile.dispose();
    await relay.dispose();
  });

  it("trusted relay 允许 attachment-only downstream close 清理 namespaced staging", async () => {
    const { base } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-attachment",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-attachment",
      clientMode: "web-remote-replayable",
    });
    await mobile.service.helloConversationV4();
    await mobile.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-attachment-client",
      appVersion: "4.0.0",
    });
    await mobile.service.attachmentBeginV4({
      workspacePath: "/repo",
      sessionId: "session-attachment",
      uploadId: "upload-remote",
      fileName: "remote.bin",
      mime: "application/octet-stream",
      totalBytes: 1,
      totalChunks: 1,
      checksum: `sha256:${"0".repeat(64)}`,
    });

    await mobile.dispose();
    const closed = vi
      .mocked(base.setConnectionFlowStateV4)
      .mock.calls.map(([params]) => params)
      .find((params) => params.state === "closed");
    expect(readTrustedZCodeAgentV4Connection(closed)).toEqual({
      connectionId: "relay:17:server-attachment17:mobile-attachment",
      clientMode: "web-remote-replayable",
    });
    expect(closed).toMatchObject({ workspacePath: "/repo", state: "closed" });
    await relay.dispose();
  });

  it("trusted relay 对相同裸 subId 使用下游 topic/connection 精确退订", async () => {
    const { base } = setupBase();
    vi.mocked(base.subscribeConversationV4).mockImplementation(async () => ({
      ack: {
        subscriptionId: "sub-shared",
        mode: "snapshot" as const,
        logEpoch: "epoch-shared",
      },
    }));
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-upstream",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const desktop = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "desktop-downstream",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(relay.service, {
      connectionId: "mobile-downstream",
      clientMode: "web-remote-replayable",
    });
    for (const [scope, clientId] of [
      [desktop, "desktop-client"],
      [mobile, "mobile-client"],
    ] as const) {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId,
        appVersion: "4.0.0",
      });
    }
    await desktop.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "desktop-session",
    });
    await mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "mobile-session",
    });

    await mobile.service.unsubscribeConversationV4({
      workspacePath: "/repo",
      subscriptionId: "sub-shared",
    });
    const firstRoute = readTrustedZCodeAgentV4UnsubscribeRoute(
      vi.mocked(base.unsubscribeConversationV4).mock.calls[0]?.[0],
    );
    expect(firstRoute).toEqual({
      topic: "conversation/mobile-session",
      connectionId: "relay:15:server-upstream17:mobile-downstream",
    });

    await desktop.service.unsubscribeConversationV4({
      workspacePath: "/repo",
      subscriptionId: "sub-shared",
    });
    const secondRoute = readTrustedZCodeAgentV4UnsubscribeRoute(
      vi.mocked(base.unsubscribeConversationV4).mock.calls[1]?.[0],
    );
    expect(secondRoute).toEqual({
      topic: "conversation/desktop-session",
      connectionId: "relay:15:server-upstream18:desktop-downstream",
    });
  });

  it("connectionId 拒绝空值/超长值，relay namespace 不使用可歧义分隔符拼接", () => {
    const { base } = setupBase();
    expect(() =>
      createZCodeAgentConnectionScope(base, {
        connectionId: "",
        clientMode: "desktop-continuous",
      }),
    ).toThrow("fault.connection.invalidConnectionId");
    expect(() =>
      createZCodeAgentConnectionScope(base, {
        connectionId: "x".repeat(257),
        clientMode: "desktop-continuous",
      }),
    ).toThrow("fault.connection.invalidConnectionId");
  });

  it("terminal command/attachment 受握手门禁约束，且 command clientId 必须匹配绑定身份", async () => {
    const { base } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "terminal-command",
      clientMode: "desktop-continuous",
    });
    const command = {
      workspacePath: "/repo",
      envelope: {
        commandId: "cmd-1",
        clientId: "client-bound",
        sessionId: "session-1",
        type: "sendText" as const,
        payload: { text: "hello" },
        issuedAt: 1,
      },
    };

    await expect(scope.service.sendConversationCommandV4(command)).rejects.toThrow(
      "fault.connection.handshakeRequired",
    );
    await expect(
      scope.service.attachmentBeginV4({
        workspacePath: "/repo",
        sessionId: "session-1",
        uploadId: "upload-1",
        fileName: "test.txt",
        mime: "text/plain",
        totalBytes: 1,
        totalChunks: 1,
        checksum: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow("fault.connection.handshakeRequired");

    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "client-bound",
      appVersion: "4.0.0",
    });
    await expect(
      scope.service.sendConversationCommandV4({
        ...command,
        envelope: { ...command.envelope, clientId: "client-forged" },
      }),
    ).rejects.toThrow("fault.command.clientMismatch");
    expect(base.sendConversationCommandV4).not.toHaveBeenCalled();

    await expect(scope.service.sendConversationCommandV4(command)).resolves.toMatchObject({
      commandId: "cmd-1",
      status: "accepted",
    });
    const forwardedCommand = vi.mocked(base.sendConversationCommandV4).mock.calls.at(-1)?.[0];
    expect(forwardedCommand).toMatchObject(command);
    expect(readTrustedZCodeAgentV4Connection(forwardedCommand)).toEqual({
      connectionId: "terminal-command",
      clientMode: "desktop-continuous",
    });

    await scope.service.attachmentBeginV4({
      workspacePath: "/repo",
      sessionId: "session-1",
      uploadId: "upload-1",
      fileName: "test.txt",
      mime: "text/plain",
      totalBytes: 1,
      totalChunks: 1,
      checksum: `sha256:${"0".repeat(64)}`,
    });
    const forwardedAttachment = vi.mocked(base.attachmentBeginV4).mock.calls.at(-1)?.[0];
    expect(readTrustedZCodeAgentV4Connection(forwardedAttachment)).toEqual({
      connectionId: "terminal-command",
      clientMode: "desktop-continuous",
    });
  });

  it("手机 replayable command 原样透传 canonical plugin link，不新增 selection state", async () => {
    const { base } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-plugin-reference",
      clientMode: "web-remote-replayable",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-plugin-client",
      appVersion: "4.0.0",
    });
    const canonicalText = "请使用 [@Demo](plugin://demo@mkt-a) 完成任务";
    const command = {
      workspacePath: "/remote/work",
      workspaceIdentity: "ssh://host/remote/work",
      remoteSessionId: "remote-runtime-1",
      // renderer/mobile 传入的 mode 不可信；facade 必须用 host 绑定的 replayable 真值覆盖。
      clientMode: "desktop-continuous" as const,
      envelope: {
        commandId: "cmd-plugin-reference",
        clientId: "mobile-plugin-client",
        sessionId: "session-plugin",
        type: "sendText" as const,
        payload: { text: canonicalText },
        issuedAt: 1,
      },
    };

    await scope.service.sendConversationCommandV4(command);

    const forwarded = vi.mocked(base.sendConversationCommandV4).mock.calls[0]?.[0];
    expect(forwarded).toMatchObject({
      workspacePath: command.workspacePath,
      workspaceIdentity: command.workspaceIdentity,
      remoteSessionId: command.remoteSessionId,
      envelope: command.envelope,
    });
    expect(forwarded).not.toHaveProperty("clientMode");
    expect(forwarded?.envelope.payload).toEqual({ text: canonicalText });
    expect(readTrustedZCodeAgentV4Connection(forwarded)).toEqual({
      connectionId: "mobile-plugin-reference",
      clientMode: "web-remote-replayable",
    });
    await scope.dispose();
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "Bash output query preserves remote routing and trusted %s mode",
    async (clientMode) => {
      const { base } = setupBase();
      const scope = createZCodeAgentConnectionScope(base, {
        connectionId: "bash-output",
        clientMode,
      });
      const query = {
        workspacePath: "/remote/repo",
        workspaceIdentity: "remote:ssh:host:/remote/repo",
        remoteSessionId: "remote-session",
        sessionId: "child-session",
        workId: "work",
      };
      await expect(scope.service.backgroundBashOutputV4(query)).rejects.toThrow();
      expect(base.backgroundBashOutputV4).not.toHaveBeenCalled();
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "bash-output",
        appVersion: "test",
      });
      await scope.service.backgroundBashOutputV4(query);
      const forwarded = vi.mocked(base.backgroundBashOutputV4).mock.calls[0]?.[0];
      expect(forwarded).toMatchObject(query);
      expect(readTrustedZCodeAgentV4Connection(forwarded)).toEqual({
        connectionId: "bash-output",
        clientMode,
      });
      expect(base.sendConversationCommandV4).not.toHaveBeenCalled();
      await scope.dispose();
    },
  );

  it("commands/query 必须握手、注入 trusted connection，并拒绝跨 workspace 复用", async () => {
    const { base } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "terminal-query",
      clientMode: "desktop-continuous",
    });
    const query = {
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:a:/repo",
      commands: [{ sessionId: "session-1", commandId: "command-1" }],
    };

    await expect(scope.service.queryConversationCommandsV4(query)).rejects.toThrow(
      "fault.connection.handshakeRequired",
    );
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "query-client",
      appVersion: "4.0.0",
    });
    await scope.service.queryConversationCommandsV4({
      workspacePath: "/clock-only",
      clock: true,
      commands: [{ sessionId: null, commandId: "ttft-clock-probe" }],
    });
    await expect(scope.service.queryConversationCommandsV4(query)).resolves.toMatchObject({
      results: [{ result: "unknown" }],
    });
    const forwarded = vi.mocked(base.queryConversationCommandsV4).mock.calls.at(-1)?.[0];
    expect(readTrustedZCodeAgentV4Connection(forwarded)).toEqual({
      connectionId: "terminal-query",
      clientMode: "desktop-continuous",
    });

    await expect(
      scope.service.queryConversationCommandsV4({
        ...query,
        workspaceIdentity: "remote:ssh:b:/repo",
      }),
    ).rejects.toThrow("fault.command.queryForeignWorkspace");
  });

  it("attachment staging 即使没有 subscription，scope dispose 也向该 trusted connection 发 closed", async () => {
    const { base } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "attachment-only",
      clientMode: "web-remote-replayable",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "attachment-client",
      appVersion: "4.0.0",
    });
    await scope.service.attachmentBeginV4({
      workspacePath: "/repo",
      sessionId: "session-1",
      uploadId: "upload-only",
      fileName: "only.bin",
      mime: "application/octet-stream",
      totalBytes: 1,
      totalChunks: 1,
      checksum: `sha256:${"0".repeat(64)}`,
    });
    await scope.dispose();

    const closed = vi.mocked(base.setConnectionFlowStateV4).mock.calls.at(-1)?.[0];
    expect(closed?.state).toBe("closed");
    expect(readTrustedZCodeAgentV4Connection(closed)).toEqual({
      connectionId: "attachment-only",
      clientMode: "web-remote-replayable",
    });
  });

  it("迟到的 attachment begin ACK 在 scope close 后立即 abort，不遗留 staging", async () => {
    const { base } = setupBase();
    let resolveBegin!: (value: {
      uploadId: string;
      state: "staging";
      nextChunkIndex: number;
    }) => void;
    vi.mocked(base.attachmentBeginV4).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBegin = resolve;
        }),
    );
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "attachment-late",
      clientMode: "web-remote-replayable",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "attachment-late-client",
      appVersion: "4.0.0",
    });
    const pending = scope.service.attachmentBeginV4({
      workspacePath: "/repo",
      sessionId: "session-1",
      uploadId: "upload-late",
      fileName: "late.bin",
      mime: "application/octet-stream",
      totalBytes: 1,
      totalChunks: 1,
      checksum: `sha256:${"0".repeat(64)}`,
    });
    await vi.waitFor(() => expect(base.attachmentBeginV4).toHaveBeenCalledTimes(1));
    await scope.dispose();
    resolveBegin({ uploadId: "upload-late", state: "staging", nextChunkIndex: 0 });

    await expect(pending).rejects.toThrow("fault.connection.closed");
    expect(base.attachmentAbortV4).toHaveBeenCalledTimes(1);
    expect(
      readTrustedZCodeAgentV4Connection(vi.mocked(base.attachmentAbortV4).mock.calls[0][0]),
    ).toEqual({
      connectionId: "attachment-late",
      clientMode: "web-remote-replayable",
    });
  });

  it("已发送媒体精确 row target 沿当前 mobile connection 注入可信 workspace 路由", async () => {
    const { base } = setupBase();
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-preview",
      clientMode: "web-remote-replayable",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "mobile-preview-client",
      appVersion: "4.0.0",
    });
    const params = {
      workspacePath: "/remote/work",
      workspaceIdentity: "ssh://host/remote/work",
      sessionId: "session-video",
      ref: "/remote/work/demo.mov",
      target: { rowId: 42, entityId: "message-42" },
      attachmentIndex: 1,
      offset: 0,
      limit: 512 * 1024,
    };

    await scope.service.attachmentReadV4(params);
    const forwarded = vi.mocked(base.attachmentReadV4).mock.calls[0]?.[0];
    expect(forwarded).toMatchObject(params);
    expect(readTrustedZCodeAgentV4Connection(forwarded)).toEqual({
      connectionId: "mobile-preview",
      clientMode: "web-remote-replayable",
    });
    await scope.dispose();
  });

  it("trusted relay 保留下游 terminal 已校验的 command envelope", async () => {
    const { base } = setupBase();
    const relay = createZCodeAgentConnectionScope(base, {
      connectionId: "server-relay",
      clientMode: "desktop-continuous",
      role: "trusted-host-relay",
    });
    const params = {
      workspacePath: "/repo",
      envelope: {
        commandId: "cmd-relay",
        clientId: "downstream-client",
        sessionId: "session-1",
        type: "sendText" as const,
        payload: { text: "relay" },
        issuedAt: 1,
      },
    };

    await relay.service.sendConversationCommandV4(params);
    const forwarded = vi.mocked(base.sendConversationCommandV4).mock.calls.at(-1)?.[0];
    expect(forwarded).toMatchObject(params);
    expect(readTrustedZCodeAgentV4Connection(forwarded)).toEqual({
      connectionId: "server-relay",
      clientMode: "desktop-continuous",
    });
  });

  it("subscriptionId 跨 topic 碰撞时仍按 topic 隔离端口", async () => {
    const { base, conversationFrames } = setupBase();
    vi.mocked(base.subscribeConversationV4).mockResolvedValue({
      ack: {
        subscriptionId: "sub-collision",
        mode: "snapshot",
        logEpoch: "epoch-collision",
      },
    });
    const desktop = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-collision",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(base, {
      connectionId: "mobile-collision",
      clientMode: "web-remote-replayable",
    });
    for (const [scope, clientId] of [
      [desktop, "desktop-client"],
      [mobile, "mobile-client"],
    ] as const) {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId,
        appVersion: "4.0.0",
      });
    }

    await desktop.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-desktop",
    });
    await mobile.service.subscribeConversationV4({
      workspacePath: "/repo",
      sessionId: "session-mobile",
    });
    const desktopSeen: string[] = [];
    const mobileSeen: string[] = [];
    desktop.service.onDynamicConversationFrame({ workspacePath: "/repo" })((frame) =>
      desktopSeen.push(frame.topic),
    );
    mobile.service.onDynamicConversationFrame({ workspacePath: "/repo" })((frame) =>
      mobileSeen.push(frame.topic),
    );

    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-desktop", "sub-collision")),
    );
    conversationFrames.fire(
      completeWire(makeFrame("conversation/session-mobile", "sub-collision")),
    );

    expect(desktopSeen).toEqual(["conversation/session-desktop"]);
    expect(mobileSeen).toEqual(["conversation/session-mobile"]);
  });

  it("被动 topic 清理保留 existing-only，runtime unavailable 后直接丢弃 attachment owner", async () => {
    const { base } = setupBase();
    const runtimeLifecycle = attachRuntimeLifecycle(base);
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "desktop-passive-runtime",
      clientMode: "desktop-continuous",
    });
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: 3,
      clientId: "desktop-passive-runtime-client",
      appVersion: "4.0.0",
    });
    const target = { workspacePath: "/repo", workspaceIdentity: "ssh:repo" };

    const first = await scope.service.subscribeSessionsIndexV4({
      ...target,
      runtimePolicy: "existing-only",
    });
    await scope.service.unsubscribeSessionsIndexV4({
      ...target,
      subscriptionId: first.ack.subscriptionId,
      runtimePolicy: "existing-only",
    });
    expect(base.unsubscribeSessionsIndexV4).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimePolicy: "existing-only" }),
    );

    const second = await scope.service.subscribeSessionsIndexV4({
      ...target,
      runtimePolicy: "existing-only",
    });
    runtimeLifecycle.fire(makeRuntimeLifecycleEvent(target, 1, "unavailable"));
    await scope.service.unsubscribeSessionsIndexV4({
      ...target,
      subscriptionId: second.ack.subscriptionId,
      runtimePolicy: "existing-only",
    });
    expect(base.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1);

    await scope.dispose();
    runtimeLifecycle.dispose();
  });
});

it("本地 TTFT 检查点只向本地 desktop continuous attachment 暴露", () => {
  const { base } = setupBase();
  const facts = new Emitter<import("@zcode/shared").LocalTtftFacts>();
  base.onDynamicLocalTtftFacts = vi.fn(() => facts.event);
  const desktop = createZCodeAgentConnectionScope(base, {
    connectionId: "desktop",
    clientMode: "desktop-continuous",
  });
  const mobile = createZCodeAgentConnectionScope(base, {
    connectionId: "mobile",
    clientMode: "web-remote-replayable",
  });
  const localSeen = vi.fn();
  const remoteSeen = vi.fn();
  const mobileSeen = vi.fn();
  desktop.service.onDynamicLocalTtftFacts({ workspacePath: "/same" })(localSeen);
  desktop.service.onDynamicLocalTtftFacts({
    workspacePath: "/same",
    workspaceIdentity: "ssh:remote",
    remoteSessionId: "remote",
  })(remoteSeen);
  mobile.service.onDynamicLocalTtftFacts({ workspacePath: "/same" })(mobileSeen);
  facts.fire({
    version: 1,
    observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0",
    commandId: "input",
    instanceId: "cli",
    receivedAt: 100,
  });
  expect(localSeen).toHaveBeenCalledOnce();
  expect(remoteSeen).not.toHaveBeenCalled();
  expect(mobileSeen).not.toHaveBeenCalled();
  expect(base.onDynamicLocalTtftFacts).toHaveBeenCalledOnce();
  desktop.dispose();
  mobile.dispose();
});
