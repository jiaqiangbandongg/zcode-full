// m3-ui-core：SessionDataLayer + ConversationProjectionStore 单测。
// 覆盖 04-sync-and-recovery 三条客户端规则、R-01 代际防护、引用计数 + keep-warm 生命周期、
// optimistic overlay 与权威投影的收口（R-07 sourceCommandId / pendingCommands 锚点）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  SubscribeParams,
  TopicFrameDeliveryKind,
  ToolCallRow,
  V4ConversationPlansParams,
  V4ConversationPlansResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS, conversationTopicFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  E2E_SESSION_DATA_LAYER_KEEP_WARM_MS,
  resolveSessionDataLayerKeepWarmMs,
  SESSION_DATA_LAYER_KEEP_WARM_MS,
  SessionDataLayer,
} from "@/v4/sessionDataLayer.js";
import {
  ACCEPTED_INPUT_PROJECTION_GRACE_MS,
  ConversationProjectionStore,
  hasOlderRows,
  mergeOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";
import {
  SUBSCRIPTION_CONTENT_REJECTED,
  WIRE_FAULT_INVALID_PAYLOAD,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

// ── 测试装置 ──

function makeSnapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "idleCannotCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    config: { provider: "", model: "", thought: "", followupMode: "queue" },
    modelTransition: null,
    usage: {
      contextWindow: null,
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
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
    ...overrides,
  };
}

function assistantRow(rowId: number, text: string): ConversationRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "assistantText",
    text,
    state: "streaming",
  };
}

function realUserRow(rowId: number, turnId: string): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: `问题 ${rowId}`,
  };
}

function turnHeaderRow(rowId: number, turnId = "t1"): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
    activeMs: 1,
  };
}

function planRow(rowId: number, status: ToolCallRow["status"] = "success"): ToolCallRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `plan-${rowId}`,
    toolName: "ExitPlanMode",
    status,
    input: { plan: `# 计划 ${rowId}` },
    inputText: JSON.stringify({ plan: `# 计划 ${rowId}` }),
  };
}

function makeFrame(
  subscriptionId: string,
  fromSeq: number,
  toSeq: number,
  payload: ConversationTopicFrame["payload"],
  topic = "conversation/s1",
): ConversationTopicFrame {
  return { topic, subscriptionId, fromSeq, toSeq, sentAt: 1, payload };
}

/** 一条最小 run：`nodes` 按 (siteId, ordinal) 键控，序号 1..n。 */
function workflowRun(runId: string, nodes: number): WorkflowRunState {
  return {
    runId,
    status: "running",
    usage: { spentTokens: 0, nodesUsed: nodes },
    actors: [],
    nodes: Array.from({ length: nodes }, (_, index) => ({
      siteId: "node",
      ordinal: index + 1,
      phase: "queued" as const,
    })),
    lastEventSequence: nodes,
  };
}

class FakeTransport implements ConversationTransport {
  subscribeCalls: SubscribeParams[] = [];
  unsubscribeCalls: string[] = [];
  activateCalls: string[] = [];
  private frameListeners = new Set<
    (frame: ConversationTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  private faultListeners = new Set<
    (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void
  >();
  private restartListeners = new Set<Parameters<ConversationTransport["onRuntimeRestart"]>[0]>();
  private initialFrames = new Map<string, ConversationTopicFrame>();
  private subCounter = 0;
  /** 每次 subscribe 的应答策略，测试按需覆盖。 */
  subscribeImpl: (
    params: SubscribeParams,
    subscriptionId: string,
  ) =>
    | (V4ConversationSubscribeResult & { initialFrame?: ConversationTopicFrame })
    | Promise<V4ConversationSubscribeResult & { initialFrame?: ConversationTopicFrame }> = (
    params,
    subscriptionId,
  ) => ({
    ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
    initialFrame: makeFrame(
      subscriptionId,
      0,
      5,
      {
        kind: "snapshot",
        snapshot: makeSnapshot({ seq: 5 }),
      },
      params.topic,
    ),
  });

  async subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
    this.subscribeCalls.push(params);
    const subscriptionId = `sub-${++this.subCounter}`;
    const dispatch = await this.subscribeImpl(params, subscriptionId);
    if (dispatch.initialFrame) {
      this.initialFrames.set(subscriptionId, dispatch.initialFrame);
    }
    return { ack: dispatch.ack };
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.unsubscribeCalls.push(subscriptionId);
    this.initialFrames.delete(subscriptionId);
  }

  resyncCalls: Array<{
    subscriptionId: string;
    base: { logEpoch: string; seq: number } | null;
    forceSnapshot?: boolean;
  }> = [];
  resyncImpl: (params: {
    subscriptionId: string;
    base: { logEpoch: string; seq: number } | null;
    forceSnapshot?: boolean;
  }) => V4ConversationResyncResult | Promise<V4ConversationResyncResult> = (params) => ({
    ack: {
      subscriptionId: params.subscriptionId,
      mode: params.forceSnapshot ? "snapshot" : "resume",
      logEpoch: "epoch-1",
    },
  });

  async resync(params: {
    subscriptionId: string;
    base: { logEpoch: string; seq: number } | null;
    forceSnapshot?: boolean;
  }): Promise<V4ConversationResyncResult> {
    this.resyncCalls.push(params);
    return this.resyncImpl(params);
  }

  activate(subscriptionId: string): void {
    this.activateCalls.push(subscriptionId);
    const initialFrame = this.initialFrames.get(subscriptionId);
    this.initialFrames.delete(subscriptionId);
    if (initialFrame) this.emitKind(initialFrame, "initial");
  }

  async sendCommand(_envelope: CommandEnvelope): Promise<CommandAck> {
    throw new Error("not used in this suite");
  }

  async queryCommands(_params: CommandsQueryParams): Promise<CommandsQueryResult> {
    throw new Error("not used in this suite");
  }

  rowsRangeCalls: V4ConversationRowsRangeParams[] = [];
  /** rows/range 应答策略，loadOlder 测试按需覆盖。 */
  rowsRangeImpl: (
    params: V4ConversationRowsRangeParams,
  ) => V4ConversationRowsRangeResult | Promise<V4ConversationRowsRangeResult> = () => ({
    rows: [],
    atSeq: 0,
    atRevision: 0,
    atLogEpoch: "epoch-1",
    hasMore: false,
  });

  async rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
    this.rowsRangeCalls.push(params);
    return this.rowsRangeImpl(params);
  }

  plansCalls: V4ConversationPlansParams[] = [];
  plansImpl: (
    params: V4ConversationPlansParams,
  ) => V4ConversationPlansResult | Promise<V4ConversationPlansResult> = () => ({
    plans: [],
    atSeq: 0,
    atLogEpoch: "epoch-1",
  });

  async plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult> {
    this.plansCalls.push(params);
    return this.plansImpl(params);
  }

  onFrame(
    listener: (
      frame: ConversationTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void,
  ): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onAssemblyFault(
    listener: (fault: { topic: string; subscriptionId: string; reasonCode?: string }) => void,
  ): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  onRuntimeRestart(listener: Parameters<ConversationTransport["onRuntimeRestart"]>[0]): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  emit(frame: ConversationTopicFrame): void {
    this.emitKind(frame, "online");
  }

  emitRecovery(frame: ConversationTopicFrame): void {
    this.emitKind(frame, "recovery");
  }

  emitKind(frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind): void {
    for (const listener of this.frameListeners) listener(frame, { deliveryKind });
  }

  emitFault(
    topic = "conversation/s1",
    subscriptionId = "sub-1",
    deliveryKind: TopicFrameDeliveryKind = "online",
    reasonCode?: string,
  ): void {
    for (const listener of this.faultListeners) {
      listener({ topic, subscriptionId, deliveryKind, ...(reasonCode ? { reasonCode } : {}) });
    }
  }

  restart(): void {
    for (const listener of this.restartListeners) listener();
  }

  replaceTransport(): void {
    for (const listener of this.restartListeners) listener("transportReplaced");
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ── ConversationProjectionStore ──

describe("ConversationProjectionStore", () => {
  let transport: FakeTransport;
  let store: ConversationProjectionStore;

  beforeEach(() => {
    transport = new FakeTransport();
    store = new ConversationProjectionStore("conversation/s1", transport);
    // 帧路由在 SessionDataLayer；store 独测时手工接线。
    transport.onFrame((frame, context) => store.handleFrame(frame, context));
  });

  it("保留 subscribe ACK timing，并记录首帧到 projection apply 的 Renderer timing", async () => {
    transport.subscribeImpl = (params, subscriptionId) => ({
      ack: {
        subscriptionId,
        mode: "snapshot",
        logEpoch: "epoch-1",
        openTiming: {
          version: 1,
          cliSessionRestoreMs: 120,
          initialFrameEncodeMs: 4,
          sessionRuntimeState: "cold",
          snapshotRowCount: 1,
        },
      },
      initialFrame: makeFrame(
        subscriptionId,
        0,
        5,
        { kind: "snapshot", snapshot: makeSnapshot({ seq: 5 }) },
        params.topic,
      ),
    });

    await store.connect();

    expect(store.getState().openTiming).toMatchObject({
      cliSessionRestoreMs: 120,
      initialFrameEncodeMs: 4,
    });
    expect(store.getState().rendererTiming).toMatchObject({
      initialFrameTransportMs: expect.any(Number),
      rendererSnapshotApplyMs: expect.any(Number),
      snapshotAppliedAt: expect.any(Number),
    });
    expect(store.getSessionOpenRendererTiming()).toMatchObject({
      rendererPrepareMs: expect.any(Number),
      initialFrameTransportMs: expect.any(Number),
      rendererSnapshotApplyMs: expect.any(Number),
      snapshotAppliedAt: expect.any(Number),
    });
    await store.close();
  });

  it("从 Renderer acquire 起点计算 prepare timing", async () => {
    await store.connect({ rendererPrepareStartedAt: performance.now() - 100 });

    expect(store.getSessionOpenRendererTiming().rendererPrepareMs).toBeGreaterThanOrEqual(90);
    await store.close();
  });

  it("首连 base=none，snapshot 帧整体替换", async () => {
    await store.connect();
    expect(transport.subscribeCalls[0].base).toBeUndefined();
    const state = store.getState();
    expect(state.status).toBe("live");
    expect(state.snapshot?.seq).toBe(5);
    expect(state.subscriptionId).toBe("sub-1");
    expect(transport.activateCalls).toEqual(["sub-1"]);
  });

  it("proxy handoff 携当前水位重订阅，由服务端裁决 resume/snapshot", async () => {
    await store.connect();

    transport.replaceTransport();
    await flushMicrotasks();

    expect(transport.subscribeCalls).toHaveLength(2);
    expect(transport.subscribeCalls[1]?.base).toEqual({ logEpoch: "epoch-1", seq: 5 });
  });

  it("I56：只通知首次应用的 online fallback，initial/recovery/duplicate 只更新基线", async () => {
    transport.subscribeImpl = (params, subscriptionId) => ({
      ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
      initialFrame: makeFrame(
        subscriptionId,
        0,
        5,
        {
          kind: "snapshot",
          snapshot: makeSnapshot({
            seq: 5,
            modelTransition: {
              eventId: "event-initial",
              origin: "registryFallback",
              from: { provider: "provider-a", model: "model-a" },
              to: { provider: "provider-b", model: "model-b" },
            },
          }),
        },
        params.topic,
      ),
    });
    const listener = vi.fn();
    store.onOnlineModelTransition(listener);

    await store.connect();
    expect(listener).not.toHaveBeenCalled();

    const onlineFrame = makeFrame("sub-1", 5, 6, {
      kind: "deltas",
      deltas: [
        {
          op: "state.updated",
          patch: {
            modelTransition: {
              eventId: "event-online-1",
              origin: "registryFallback",
              from: { provider: "provider-b", model: "model-b" },
              to: { provider: "provider-c", model: "model-c" },
            },
          },
        },
      ],
    });
    transport.emit(onlineFrame);
    transport.emit(onlineFrame);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({
      eventId: "event-online-1",
      origin: "registryFallback",
      from: { provider: "provider-b", model: "model-b" },
      to: { provider: "provider-c", model: "model-c" },
    });

    transport.emitRecovery(
      makeFrame("sub-1", 6, 7, {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              modelTransition: {
                eventId: "event-recovery",
                origin: "registryFallback",
                from: { provider: "provider-c", model: "model-c" },
                to: { provider: "provider-d", model: "model-d" },
              },
            },
          },
        ],
      }),
    );
    transport.emit(
      makeFrame("sub-1", 7, 8, {
        kind: "deltas",
        deltas: [{ op: "state.updated", patch: { revision: 8 } }],
      }),
    );
    expect(listener).toHaveBeenCalledTimes(1);

    transport.emit(
      makeFrame("sub-1", 8, 9, {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              modelTransition: {
                eventId: "event-online-2",
                origin: "registryFallback",
                from: { provider: "provider-d", model: "model-d" },
                to: { provider: "provider-e", model: "model-e" },
              },
            },
          },
        ],
      }),
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("查询完整终态计划目录并保留服务端顺序", async () => {
    transport.plansImpl = () => ({
      plans: [planRow(9), planRow(4, "cancelled")],
      atSeq: 5,
      atLogEpoch: "epoch-1",
    });

    await store.connect();
    await store.refreshPlans();

    expect(transport.plansCalls).toEqual([{ sessionId: "s1" }]);
    expect(store.getState().sessionPlans.map((row) => row.rowId)).toEqual([9, 4]);
    expect(store.getState().plansLoading).toBe(false);
  });

  it("只在 snapshot、终态 ExitPlanMode 和分支裁剪时失效计划目录", async () => {
    transport.plansImpl = () => ({
      plans: [planRow(1)],
      atSeq: 5,
      atLogEpoch: "epoch-1",
    });
    await store.connect();
    await store.refreshPlans();
    const afterSnapshot = store.getState().planDirectoryRevision;

    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: planRow(1, "running") }],
      }),
    );
    expect(store.getState().planDirectoryRevision).toBe(afterSnapshot);

    transport.emit(
      makeFrame("sub-1", 6, 7, {
        kind: "deltas",
        deltas: [{ op: "row.upserted", row: planRow(1, "success") }],
      }),
    );
    expect(store.getState().planDirectoryRevision).toBe(afterSnapshot + 1);

    transport.emit(
      makeFrame("sub-1", 7, 8, {
        kind: "deltas",
        deltas: [{ op: "row.removed", fromRowId: 1 }],
      }),
    );
    expect(store.getState().planDirectoryRevision).toBe(afterSnapshot + 2);
    expect(store.getState().sessionPlans).toEqual([]);
  });

  it("合并并发查询并丢弃分支修订前的迟到目录", async () => {
    let resolveFirst!: (result: V4ConversationPlansResult) => void;
    let requestCount = 0;
    transport.plansImpl = () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise<V4ConversationPlansResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return {
        plans: [planRow(7)],
        atSeq: 6,
        atLogEpoch: "epoch-1",
      };
    };
    await store.connect();

    const first = store.refreshPlans();
    await flushMicrotasks();
    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: planRow(7) }],
      }),
    );
    await store.refreshPlans();
    resolveFirst({ plans: [planRow(3)], atSeq: 5, atLogEpoch: "epoch-1" });
    await first;
    await vi.waitFor(() => expect(transport.plansCalls).toHaveLength(2));
    await vi.waitFor(() =>
      expect(store.getState().sessionPlans.map((row) => row.rowId)).toEqual([7]),
    );
  });

  it("运行时重启后丢弃旧 generation 的迟到计划查询", async () => {
    let resolvePlans!: (result: V4ConversationPlansResult) => void;
    transport.plansImpl = () =>
      new Promise<V4ConversationPlansResult>((resolve) => {
        resolvePlans = resolve;
      });
    await store.connect();

    const pending = store.refreshPlans();
    await flushMicrotasks();
    transport.restart();
    resolvePlans({ plans: [planRow(3)], atSeq: 5, atLogEpoch: "epoch-1" });
    await pending;
    await flushMicrotasks();

    expect(store.getState().sessionPlans).toEqual([]);
    expect(transport.subscribeCalls).toHaveLength(2);
  });

  it("delta 帧区间衔接时 apply，seq 推进到 toSeq", async () => {
    await store.connect();
    transport.emit(
      makeFrame("sub-1", 5, 7, {
        kind: "deltas",
        deltas: [
          { op: "row.appended", row: assistantRow(1, "he") },
          { op: "row.delta", rowId: 1, path: "text", append: "llo" },
        ],
      }),
    );
    const snapshot = store.getState().snapshot!;
    expect(snapshot.seq).toBe(7);
    expect(snapshot.rows.window).toHaveLength(1);
    expect(snapshot.rows.window[0]).toMatchObject({ rowId: 1, text: "hello" });
  });

  // `workflowRun.updated` 是新的键级增量 op（shared delta.ts）。store 里**没有**、也不该有
  // 它的分支：语义整个住在 applyConversationDeltas 里，store 只转发。这条用例钉三件事——
  // 帧过得了 assembler 那道严格 zod；容器与被改的 run 换新对象（memo 要重算）；没被碰的 run
  // 与 rows 保持对象同一性（memo 不该重算）。
  it("workflowRun.updated 帧经严格 zod 与 apply 落库，只让被改的 run 换身份", async () => {
    await store.connect();
    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              workflowRuns: {
                revision: 1,
                runs: [workflowRun("run-a", 3), workflowRun("run-b", 1)],
              },
            },
          },
          { op: "row.appended", row: assistantRow(1, "hi") },
        ],
      }),
    );
    const seeded = store.getState().snapshot!;
    const untouched = seeded.workflowRuns!.runs[1]!;
    const rows = seeded.rows;

    const frame = makeFrame("sub-1", 6, 7, {
      kind: "deltas",
      deltas: [
        {
          op: "workflowRun.updated",
          runId: "run-a",
          revision: 2,
          run: { status: "completed", lastEventSequence: 9 },
          nodes: [{ siteId: "node", ordinal: 3, phase: "settled", outcome: "ok" }],
        },
      ],
    });
    expect(conversationTopicFrameSchema.safeParse(frame).success).toBe(true);
    transport.emit(frame);

    const next = store.getState().snapshot!;
    expect(next.workflowRuns).not.toBe(seeded.workflowRuns);
    expect(next.workflowRuns).toMatchObject({ revision: 2 });
    expect(next.workflowRuns!.runs[0]).toMatchObject({
      runId: "run-a",
      status: "completed",
      lastEventSequence: 9,
    });
    // upsert 按 (siteId, ordinal)：既有条目原地替换，不追加第二条。
    expect(next.workflowRuns!.runs[0]!.nodes).toHaveLength(3);
    expect(next.workflowRuns!.runs[0]!.nodes[2]).toMatchObject({ ordinal: 3, phase: "settled" });
    expect(next.workflowRuns!.runs[1]).toBe(untouched);
    expect(next.rows).toBe(rows);
  });

  it("首轮 rewind 后新分支的 rowId 空洞不触发加载更早", async () => {
    await store.connect();
    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [
          { op: "row.appended", row: assistantRow(1, "old-1") },
          { op: "row.appended", row: assistantRow(2, "old-2") },
        ],
      }),
    );
    transport.emit(
      makeFrame("sub-1", 6, 7, {
        kind: "deltas",
        deltas: [
          { op: "row.removed", fromRowId: 1 },
          { op: "row.appended", row: assistantRow(5, "edited") },
        ],
      }),
    );

    const snapshot = store.getState().snapshot!;
    expect(snapshot.rows.window.map((row) => row.rowId)).toEqual([5]);
    expect(snapshot.rows.totalCount).toBe(1);
    expect(snapshot.rows.firstRowId).toBe(5);
    expect(hasOlderRows(snapshot)).toBe(false);
  });

  it("late duplicate toSeq<=localSeq 静默丢弃且不触发 resync", async () => {
    await store.connect();
    transport.emit(makeFrame("sub-1", 0, 5, { kind: "deltas", deltas: [] }));
    expect(transport.resyncCalls).toEqual([]);
    expect(store.getState().snapshot?.seq).toBe(5);
  });

  it("三个同步 gap 共用一次 same-sub flight；resume ACK 后再 gap 升级 force snapshot", async () => {
    await store.connect();
    for (let index = 0; index < 3; index += 1) {
      transport.emit(makeFrame("sub-1", 99 + index, 100 + index, { kind: "deltas", deltas: [] }));
    }
    expect(transport.resyncCalls).toEqual([
      {
        subscriptionId: "sub-1",
        base: { logEpoch: "epoch-1", seq: 5 },
      },
    ]);
    await flushMicrotasks();
    transport.emitRecovery(makeFrame("sub-1", 120, 121, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    expect(transport.resyncCalls[1]).toEqual({
      subscriptionId: "sub-1",
      base: { logEpoch: "epoch-1", seq: 5 },
      forceSnapshot: true,
    });
    transport.emitRecovery(
      makeFrame("sub-1", 0, 121, {
        kind: "snapshot",
        snapshot: makeSnapshot({ seq: 121 }),
      }),
    );
    expect(store.getState().snapshot?.seq).toBe(121);
  });

  it("assembly fault 保留可见 snapshot，并且 burst fault 只触发一次恢复", async () => {
    await store.connect();
    const before = store.getState().snapshot;
    transport.emitFault();
    transport.emitFault();
    transport.emitFault();
    expect(store.getState().snapshot).toBe(before);
    expect(transport.resyncCalls).toHaveLength(1);
  });

  it("original initial assembly fault 无合法 base，首个 same-sub recovery 直接强制 snapshot", async () => {
    transport.subscribeImpl = (_params, subscriptionId) => ({
      ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
    });
    await store.connect();
    transport.emitFault("conversation/s1", "sub-1", "initial");
    await flushMicrotasks();

    expect(transport.subscribeCalls).toHaveLength(1);
    expect(transport.resyncCalls).toEqual([
      { subscriptionId: "sub-1", base: null, forceSnapshot: true },
    ]);
  });

  it("resync ACK 前迟到 online duplicate 不消费 recovery；真实 recovery gap 仍升级 force", async () => {
    await store.connect();
    let resolveFirst!: (result: V4ConversationResyncResult) => void;
    transport.resyncImpl = (params) => {
      if (params.forceSnapshot) {
        return {
          ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
        };
      }
      return new Promise<V4ConversationResyncResult>((resolve) => {
        resolveFirst = resolve;
      });
    };

    transport.emit(makeFrame("sub-1", 80, 81, { kind: "deltas", deltas: [] }));
    expect(transport.resyncCalls).toHaveLength(1);
    transport.emit(makeFrame("sub-1", 5, 5, { kind: "deltas", deltas: [] }));
    resolveFirst({
      ack: { subscriptionId: "sub-1", mode: "resume", logEpoch: "epoch-1" },
    });
    await flushMicrotasks();
    transport.emitRecovery(makeFrame("sub-1", 99, 100, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();

    expect(transport.resyncCalls).toHaveLength(2);
    expect(transport.resyncCalls[1]?.forceSnapshot).toBe(true);
  });

  it("aligned recovery frame 早于 resync Promise continuation 仍与 ACK 共同收口 flight", async () => {
    await store.connect();
    transport.resyncImpl = (params) => {
      // 模拟同一 read：response 已解析，但 Promise continuation 尚未运行时 notification 先 fire。
      transport.emitRecovery(
        makeFrame(params.subscriptionId, 5, 5, { kind: "deltas", deltas: [] }),
      );
      return {
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "resume",
          logEpoch: "epoch-1",
        },
      };
    };
    transport.emit(makeFrame("sub-1", 99, 100, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    expect(transport.resyncCalls).toHaveLength(1);

    transport.emit(makeFrame("sub-1", 101, 102, { kind: "deltas", deltas: [] }));
    expect(transport.resyncCalls).toHaveLength(2);
    expect(transport.resyncCalls[1]).not.toHaveProperty("forceSnapshot");
  });

  it("recovery 已 apply 后同 read residual online gap 会在 ACK 后启动 successor flight", async () => {
    await store.connect();
    let attempt = 0;
    transport.resyncImpl = (params) => {
      attempt += 1;
      if (attempt === 1) {
        transport.emitRecovery(
          makeFrame(params.subscriptionId, 5, 6, { kind: "deltas", deltas: [] }),
        );
        transport.emit(makeFrame(params.subscriptionId, 8, 9, { kind: "deltas", deltas: [] }));
      } else {
        transport.emitRecovery(
          makeFrame(params.subscriptionId, 6, 6, { kind: "deltas", deltas: [] }),
        );
      }
      return {
        ack: { subscriptionId: params.subscriptionId, mode: "resume", logEpoch: "epoch-1" },
      };
    };

    transport.emit(makeFrame("sub-1", 99, 100, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(transport.resyncCalls).toHaveLength(2);
    expect(transport.resyncCalls[1]).toEqual({
      subscriptionId: "sub-1",
      base: { logEpoch: "epoch-1", seq: 6 },
    });
    expect(store.getState().snapshot?.seq).toBe(6);
  });

  it("ACK(snapshot) 无 applied base 时拒绝 online delta，但接受完整 online snapshot", async () => {
    transport.subscribeImpl = (_params, subscriptionId) => ({
      ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-2" },
    });
    const listener = vi.fn();
    store.onOnlineModelTransition(listener);
    await store.connect();
    transport.emit(
      makeFrame("sub-1", 0, 1, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: assistantRow(1, "must-not-apply") }],
      }),
    );
    expect(store.getState().snapshot).toBeNull();
    expect(transport.resyncCalls[0]).toEqual({
      subscriptionId: "sub-1",
      base: null,
      forceSnapshot: true,
    });

    transport.emitKind(
      makeFrame("sub-1", 0, 1, {
        kind: "snapshot",
        snapshot: makeSnapshot({
          logEpoch: "epoch-2",
          seq: 1,
          modelTransition: {
            eventId: "event-before-applied-base",
            origin: "registryFallback",
            from: { provider: "provider-a", model: "model-a" },
            to: { provider: "provider-b", model: "model-b" },
          },
        }),
      }),
      "online",
    );
    transport.emitRecovery(makeFrame("sub-1", 0, 1, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    expect(store.getState().snapshot?.logEpoch).toBe("epoch-2");
    expect(store.getState().snapshot?.rows.window).toEqual([]);
    // Bug 回归：initial 丢失后的完整 online snapshot 只是首个 applied base，
    // 其中持久化的旧 fallback 只能播种观察基线，不能冒充订阅后的新事件。
    expect(listener).not.toHaveBeenCalled();

    transport.emit(
      makeFrame("sub-1", 1, 2, {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              modelTransition: {
                eventId: "event-after-applied-base",
                origin: "registryFallback",
                from: { provider: "provider-b", model: "model-b" },
                to: { provider: "provider-c", model: "model-c" },
              },
            },
          },
        ],
      }),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      eventId: "event-after-applied-base",
      origin: "registryFallback",
      from: { provider: "provider-b", model: "model-b" },
      to: { provider: "provider-c", model: "model-c" },
    });
  });

  it("resync ACK 后整批 recovery 缺失会在 30s 升级一次并最终 fail closed", async () => {
    vi.useFakeTimers();
    try {
      await store.connect();
      transport.emit(makeFrame("sub-1", 99, 100, { kind: "deltas", deltas: [] }));
      await flushMicrotasks();
      expect(transport.resyncCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      expect(transport.resyncCalls).toHaveLength(2);
      expect(transport.resyncCalls[1]?.forceSnapshot).toBe(true);
      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      expect(store.getState().status).toBe("error");
      expect(transport.resyncCalls).toHaveLength(2);
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });

  it("resume recovery gap 早于 ACK continuation 会在 ACK 后立即升级 force snapshot", async () => {
    await store.connect();
    transport.resyncImpl = (params) => {
      if (!params.forceSnapshot) {
        transport.emitRecovery(
          makeFrame(params.subscriptionId, 99, 100, { kind: "deltas", deltas: [] }),
        );
      } else {
        transport.emitRecovery(
          makeFrame(params.subscriptionId, 0, 100, {
            kind: "snapshot",
            snapshot: makeSnapshot({ seq: 100 }),
          }),
        );
      }
      return {
        ack: {
          subscriptionId: params.subscriptionId,
          mode: params.forceSnapshot ? "snapshot" : "resume",
          logEpoch: "epoch-1",
        },
      };
    };
    transport.emit(makeFrame("sub-1", 80, 81, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(transport.resyncCalls).toHaveLength(2);
    expect(transport.resyncCalls[1]?.forceSnapshot).toBe(true);
    expect(store.getState().snapshot?.seq).toBe(100);
  });

  it("force snapshot recovery 再 fault 时 fail closed，不无限重发", async () => {
    await store.connect();
    transport.emit(makeFrame("sub-1", 80, 81, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    transport.emitRecovery(makeFrame("sub-1", 99, 100, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    expect(transport.resyncCalls[1]?.forceSnapshot).toBe(true);
    transport.emitFault("conversation/s1", "sub-1", "recovery");
    await flushMicrotasks();
    expect(transport.resyncCalls).toHaveLength(2);
    expect(store.getState().status).toBe("error");
    expect(store.getState().snapshot?.seq).toBe(5);
  });

  // ── 确定性内容 fault（04-sync 封闭规则 11）──────────────────────────────────────────
  // 上面那条阶梯默认 fault 是瞬态的。schema 拒收不是：字节已过 checksum/JSON，被拒说明本端读不
  // 懂对端的**内容**，resume 档只会把同一批 delta 再投一遍。2026-09-21（sess_4142de31）实测代价
  // 是一条打不开的会话——三帧一轮，用户手动重连两次又各烧三帧。

  it("内容 fault 直接强制 snapshot，跳过必然失败的 resume 档", async () => {
    await store.connect();
    transport.emitFault("conversation/s1", "sub-1", "online", WIRE_FAULT_INVALID_PAYLOAD);
    await flushMicrotasks();
    expect(transport.resyncCalls).toHaveLength(1);
    expect(transport.resyncCalls[0]?.forceSnapshot).toBe(true);
    // 投影不动：坏帧从未被 apply，用户看到的仍是最后一份完整投影。
    expect(store.getState().snapshot?.seq).toBe(5);
  });

  it("强制 snapshot 再次被内容拒绝 → contentRejected 终态，只烧一次 resync", async () => {
    await store.connect();
    const before = store.getState().snapshot;
    transport.emitFault("conversation/s1", "sub-1", "online", WIRE_FAULT_INVALID_PAYLOAD);
    await flushMicrotasks();
    transport.emitFault("conversation/s1", "sub-1", "recovery", WIRE_FAULT_INVALID_PAYLOAD);
    await flushMicrotasks();

    expect(store.getState().status).toBe("error");
    // 与传输失败区分开：重连不会改变结果，遥测也不该把它聚合成一次链路抖动。
    expect(store.getState().lastError).toBe(SUBSCRIPTION_CONTENT_REJECTED);
    // 修复前这里是 resume + snapshot 两次 resync 且终态写成 recoveryFailed。
    expect(transport.resyncCalls).toHaveLength(1);
    // 最后一份好投影仍然可见（会话内容留在错误横幅后面）。
    expect(store.getState().snapshot).toBe(before);
  });

  it("内容 fault 的强制 snapshot 若读得懂，照常收口，不落 error", async () => {
    await store.connect();
    transport.resyncImpl = (params) => {
      // 新快照是重新生成的，可能已经不含那份读不懂的内容——这条自愈路径必须留着。
      transport.emitRecovery(
        makeFrame(params.subscriptionId, 0, 9, {
          kind: "snapshot",
          snapshot: makeSnapshot({ seq: 9 }),
        }),
      );
      return {
        ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
      };
    };
    transport.emitFault("conversation/s1", "sub-1", "online", WIRE_FAULT_INVALID_PAYLOAD);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(store.getState().status).toBe("live");
    expect(store.getState().lastError).toBeNull();
    expect(store.getState().snapshot?.seq).toBe(9);
  });

  it("内容 flight 上的 deadline 超时仍报 recoveryFrameTimedOut，不被内容 code 顶替", async () => {
    vi.useFakeTimers();
    try {
      await store.connect();
      // 强制 snapshot 发出去了，但一个 recovery 帧都没回来——这是传输症状，不是读不懂内容。
      transport.emitFault("conversation/s1", "sub-1", "online", WIRE_FAULT_INVALID_PAYLOAD);
      await flushMicrotasks();
      expect(transport.resyncCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      expect(store.getState().status).toBe("error");
      expect(store.getState().lastError).toBe("fault.subscription.recoveryFrameTimedOut");
    } finally {
      vi.useRealTimers();
    }
  });

  it("瞬态 fault 不被内容分类吞掉：无 reasonCode 仍先试 resume", async () => {
    await store.connect();
    transport.emitFault();
    await flushMicrotasks();
    expect(transport.resyncCalls).toHaveLength(1);
    expect(transport.resyncCalls[0]?.forceSnapshot).toBeUndefined();
  });

  it("瞬态 fault 走到 fail closed 时仍报 recoveryFailed，不被内容 code 顶替", async () => {
    await store.connect();
    transport.emit(makeFrame("sub-1", 80, 81, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    transport.emitRecovery(makeFrame("sub-1", 99, 100, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    transport.emitFault("conversation/s1", "sub-1", "recovery");
    await flushMicrotasks();
    expect(store.getState().status).toBe("error");
    expect(store.getState().lastError).toBe("fault.subscription.recoveryFailed");
  });

  it("规则 2：断档帧不 apply，携当前水位 same-sub resync", async () => {
    await store.connect();
    transport.resyncImpl = (params) => {
      transport.emitRecovery(
        makeFrame(params.subscriptionId, 5, 9, {
          kind: "deltas",
          deltas: [{ op: "row.appended", row: assistantRow(1, "resumed") }],
        }),
      );
      return {
        ack: { subscriptionId: params.subscriptionId, mode: "resume", logEpoch: "epoch-1" },
      };
    };
    // fromSeq=7 ≠ 本地 5 → 断档。
    transport.emit(
      makeFrame("sub-1", 7, 8, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: assistantRow(2, "gap") }],
      }),
    );
    await flushMicrotasks();
    // 断档帧被丢弃，same-sub resync 带 base（状态未污染，水位仍合法）。
    expect(transport.subscribeCalls).toHaveLength(1);
    expect(transport.resyncCalls).toEqual([
      { subscriptionId: "sub-1", base: { logEpoch: "epoch-1", seq: 5 } },
    ]);
    const snapshot = store.getState().snapshot!;
    expect(snapshot.seq).toBe(9);
    expect(snapshot.rows.window[0]).toMatchObject({ text: "resumed" });
  });

  it("same-sub resume recovery 仍断档 → 升级 force snapshot（防循环）", async () => {
    await store.connect();
    transport.resyncImpl = (params) => {
      if (params.forceSnapshot) {
        transport.emitRecovery(
          makeFrame(params.subscriptionId, 0, 100, {
            kind: "snapshot",
            snapshot: makeSnapshot({ seq: 100 }),
          }),
        );
      }
      return {
        ack: {
          subscriptionId: params.subscriptionId,
          mode: params.forceSnapshot ? "snapshot" : "resume",
          logEpoch: "epoch-1",
        },
      };
    };
    transport.emit(makeFrame("sub-1", 7, 8, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    transport.emitRecovery(makeFrame("sub-1", 99, 100, { kind: "deltas", deltas: [] }));
    await flushMicrotasks();
    expect(transport.subscribeCalls).toHaveLength(1);
    expect(transport.resyncCalls).toHaveLength(2);
    expect(transport.resyncCalls[1]?.forceSnapshot).toBe(true);
    expect(store.getState().snapshot?.seq).toBe(100);
  });

  it("subscribe ACK 后异步到达的 resume initial gap 仍按持久 ACK mode 强制 fresh snapshot", async () => {
    await store.connect();
    transport.subscribeImpl = (_params, subscriptionId) => ({
      ack: { subscriptionId, mode: "resume", logEpoch: "epoch-1" },
    });
    await store.connect();
    expect(store.getState().subscriptionId).toBe("sub-2");

    transport.emitKind(makeFrame("sub-2", 99, 100, { kind: "deltas", deltas: [] }), "initial");
    await flushMicrotasks();
    expect(transport.subscribeCalls).toHaveLength(3);
    expect(transport.subscribeCalls[2]?.base).toBeUndefined();
    expect(transport.resyncCalls).toEqual([]);
  });

  it("R-01 代际防护：旧 subscriptionId 的迟到帧丢弃", async () => {
    await store.connect();
    transport.emit(
      makeFrame("sub-stale", 5, 6, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: assistantRow(1, "stale") }],
      }),
    );
    expect(store.getState().snapshot?.rows.window).toHaveLength(0);
    // 丢弃 ≠ 断档：不触发重订阅。
    expect(transport.subscribeCalls).toHaveLength(1);
  });

  it("subscribe 失败 → status=error，retry 可恢复", async () => {
    transport.subscribeImpl = () => {
      throw new Error("boom");
    };
    await store.connect();
    expect(store.getState().status).toBe("error");
    expect(store.getState().lastError).toContain("boom");
    transport.subscribeImpl = (params, subscriptionId) => ({
      ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
      initialFrame: makeFrame(
        subscriptionId,
        0,
        1,
        {
          kind: "snapshot",
          snapshot: makeSnapshot({ seq: 1 }),
        },
        params.topic,
      ),
    });
    await store.retry();
    expect(store.getState().status).toBe("live");
  });

  it("initial pre-ACK staging overflow 自动 fresh subscribe 一次，仍失败才 error", async () => {
    let attempts = 0;
    transport.subscribeImpl = (params, subscriptionId) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("fault.subscription.initialFrameStagingOverflow");
      }
      return {
        ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
        initialFrame: makeFrame(
          subscriptionId,
          0,
          3,
          { kind: "snapshot", snapshot: makeSnapshot({ seq: 3 }) },
          params.topic,
        ),
      };
    };
    await store.connect();
    expect(transport.subscribeCalls).toHaveLength(2);
    expect(transport.subscribeCalls[1]?.base).toBeUndefined();
    expect(store.getState().status).toBe("live");
    expect(store.getState().snapshot?.seq).toBe(3);

    const failed = new ConversationProjectionStore("conversation/s1", transport);
    transport.subscribeImpl = () => {
      throw new Error("fault.subscription.initialFrameStagingOverflow");
    };
    await failed.connect();
    expect(failed.getState().status).toBe("error");
    await failed.close();
  });

  it("optimistic overlay：权威投影出现同 commandId 即退场", async () => {
    await store.connect();
    store.markCommandPending({ commandId: "c1", type: "sendText", issuedAt: 1 });
    store.markCommandPending({ commandId: "c2", type: "stop", issuedAt: 2 });
    expect(store.getState().optimisticCommands).toHaveLength(2);
    // c1 经 userInput.sourceCommandId 锚点收口（R-07）。
    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [
          {
            op: "row.appended",
            row: {
              rowId: 1,
              turnId: "t1",
              createdAt: 1,
              createdAtSeq: 1,
              kind: "userInput",
              text: "hi",
              origin: "realUser",
              sourceCommandId: "c1",
            },
          },
        ],
      }),
    );
    expect(store.getState().optimisticCommands.map((c) => c.commandId)).toEqual(["c2"]);
    // c2 经 pendingCommands 收口。
    transport.emit(
      makeFrame("sub-1", 6, 7, {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              pendingCommands: [
                {
                  commandId: "c2",
                  clientId: "client-1",
                  type: "stop",
                  state: "accepted",
                  at: 3,
                },
              ],
            },
          },
        ],
      }),
    );
    expect(store.getState().optimisticCommands).toHaveLength(0);
  });

  it("A12：accepted 输入投影完全静默时只触发一次 same-sub recovery", async () => {
    vi.useFakeTimers();
    try {
      await store.connect();
      store.markCommandPending({ commandId: "silent-input", type: "sendText", issuedAt: 1 });

      store.expectAcceptedInputProjection("silent-input");
      store.expectAcceptedInputProjection("silent-input");
      await vi.advanceTimersByTimeAsync(ACCEPTED_INPUT_PROJECTION_GRACE_MS - 1);
      expect(transport.resyncCalls).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(transport.resyncCalls).toEqual([
        {
          subscriptionId: "sub-1",
          base: { logEpoch: "epoch-1", seq: 5 },
        },
      ]);

      // 恢复只作用于订阅；store 没有重放 command 的写路径，同一 expectation 也不重启 timer。
      await vi.advanceTimersByTimeAsync(ACCEPTED_INPUT_PROJECTION_GRACE_MS);
      expect(transport.resyncCalls).toHaveLength(1);
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });

  it("A12：及时 user row 或 queue authority 会取消 accepted-input recovery", async () => {
    vi.useFakeTimers();
    try {
      await store.connect();
      store.markCommandPending({ commandId: "row-input", type: "sendText", issuedAt: 1 });

      // 覆盖 frame 先于 ACK Promise continuation 的正常竞态：登记 expectation 时事实已可见。
      transport.emit(
        makeFrame("sub-1", 5, 6, {
          kind: "deltas",
          deltas: [
            {
              op: "row.appended",
              row: {
                rowId: 1,
                turnId: "turn-row",
                createdAt: 1,
                createdAtSeq: 1,
                kind: "userInput",
                text: "row authority",
                origin: "realUser",
                sourceCommandId: "row-input",
              },
            },
          ],
        }),
      );
      store.expectAcceptedInputProjection("row-input");

      store.markCommandPending({ commandId: "queue-input", type: "sendText", issuedAt: 2 });
      store.expectAcceptedInputProjection("queue-input");
      transport.emit(
        makeFrame("sub-1", 6, 7, {
          kind: "deltas",
          deltas: [
            {
              op: "state.updated",
              patch: {
                queue: {
                  autoDrain: true,
                  items: [
                    {
                      queueItemId: "queue-1",
                      kind: "sendText",
                      text: "queue authority",
                      sourceCommandId: "queue-input",
                      clientId: "client-1",
                      attachments: [],
                      delivery: { requested: "queue", admitted: "queue" },
                      order: { admissionSeq: 1, queuePosition: 0 },
                      steer: { state: "notRequested" },
                      dispatch: { state: "queued" },
                      admittedAt: 2,
                    },
                  ],
                },
              },
            },
          ],
        }),
      );

      await vi.advanceTimersByTimeAsync(ACCEPTED_INPUT_PROJECTION_GRACE_MS);
      expect(transport.resyncCalls).toEqual([]);
      expect(store.getState().optimisticCommands).toEqual([]);
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });

  it("A12：本地失败结算或 store close 会取消 accepted-input timer", async () => {
    vi.useFakeTimers();
    try {
      await store.connect();
      store.markCommandPending({ commandId: "failed-input", type: "sendText", issuedAt: 1 });
      store.expectAcceptedInputProjection("failed-input");
      store.settleCommand("failed-input");
      await vi.advanceTimersByTimeAsync(ACCEPTED_INPUT_PROJECTION_GRACE_MS);
      expect(transport.resyncCalls).toEqual([]);

      store.markCommandPending({ commandId: "closed-input", type: "sendText", issuedAt: 2 });
      store.expectAcceptedInputProjection("closed-input");
      await store.close();
      await vi.advanceTimersByTimeAsync(ACCEPTED_INPUT_PROJECTION_GRACE_MS);
      expect(transport.resyncCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("close 退订且拒绝后续帧", async () => {
    await store.connect();
    await store.close();
    expect(transport.unsubscribeCalls).toEqual(["sub-1"]);
    expect(store.getState().status).toBe("closed");
    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: assistantRow(1, "late") }],
      }),
    );
    expect(store.getState().snapshot?.rows.window).toHaveLength(0);
  });

  it("并发 connect 只认最新代际，过期订阅立即退订", async () => {
    const gate: Array<() => void> = [];
    transport.subscribeImpl = (params, subscriptionId) =>
      new Promise((resolve) => {
        gate.push(() =>
          resolve({
            ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
            initialFrame: makeFrame(
              subscriptionId,
              0,
              1,
              {
                kind: "snapshot",
                snapshot: makeSnapshot({ seq: 1 }),
              },
              params.topic,
            ),
          }),
        );
      });
    const first = store.connect();
    const second = store.connect();
    // 两次应答都返回（顺序无关紧要，旧代际结果必须被退订）。
    gate[0]();
    gate[1]();
    await Promise.all([first, second]);
    await flushMicrotasks();
    expect(store.getState().subscriptionId).toBe("sub-2");
    expect(transport.unsubscribeCalls).toEqual(["sub-1"]);
  });
});

// ── SessionDataLayer ──

describe("SessionDataLayer", () => {
  let transport: FakeTransport;
  let layer: SessionDataLayer;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    layer = new SessionDataLayer({ transport, keepWarmMs: 30_000 });
  });

  it("只在 E2E store bridge build 中缩放 keep-warm 时间", () => {
    expect(resolveSessionDataLayerKeepWarmMs(false)).toBe(SESSION_DATA_LAYER_KEEP_WARM_MS);
    expect(resolveSessionDataLayerKeepWarmMs(true)).toBe(E2E_SESSION_DATA_LAYER_KEEP_WARM_MS);
  });

  afterEach(() => {
    layer.dispose();
    vi.useRealTimers();
  });

  it("首个 acquire 触发 subscribe，帧按 topic 路由到 store", async () => {
    const lease = layer.acquire("s1");
    await flushMicrotasks();
    expect(transport.subscribeCalls).toHaveLength(1);
    expect(transport.subscribeCalls[0].topic).toBe("conversation/s1");
    expect(lease.store.getState().snapshot?.seq).toBe(5);
    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: assistantRow(1, "hi") }],
      }),
    );
    expect(lease.store.getState().snapshot?.rows.window).toHaveLength(1);
  });

  describe("行结构共享（docs/performance/conversation-row-structural-sharing.md）", () => {
    function rowsSnapshot(rows: ConversationRow[], seq = 5): ConversationSnapshot {
      // JSON 往返模拟 wire 反序列化：内容相同、引用全新。
      return makeSnapshot({
        seq,
        rows: {
          window: JSON.parse(JSON.stringify(rows)) as ConversationRow[],
          totalCount: rows.length,
          firstRowId: rows[0]?.rowId ?? null,
        },
      });
    }

    function subscribeWithRows(rows: ConversationRow[]): void {
      transport.subscribeImpl = (params, subscriptionId) => ({
        ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
        initialFrame: makeFrame(
          subscriptionId,
          0,
          5,
          { kind: "snapshot", snapshot: rowsSnapshot(rows) },
          params.topic,
        ),
      });
    }

    it("整份 snapshot 重新下发时，内容未变的行与 window 保持引用", async () => {
      const rows = [planRow(1), assistantRow(2, "hello")];
      subscribeWithRows(rows);
      const lease = layer.acquire("s1");
      await flushMicrotasks();
      const before = lease.store.getState().snapshot!.rows.window;
      transport.emit(
        makeFrame("sub-1", 0, 6, { kind: "snapshot", snapshot: rowsSnapshot(rows, 6) }),
      );
      const after = lease.store.getState().snapshot!;
      expect(after.seq).toBe(6);
      expect(after.rows.window).toBe(before);

      const changed = [planRow(1), assistantRow(2, "hello world")];
      transport.emit(
        makeFrame("sub-1", 0, 7, { kind: "snapshot", snapshot: rowsSnapshot(changed, 7) }),
      );
      const window = lease.store.getState().snapshot!.rows.window;
      expect(window).not.toBe(before);
      expect(window[0]).toBe(before[0]);
      expect(window[1]).toEqual(changed[1]);
    });

    it("row.upserted 只改状态时复用未变的 input，内容相同则整行复用", async () => {
      subscribeWithRows([planRow(1, "running")]);
      const lease = layer.acquire("s1");
      await flushMicrotasks();
      const before = lease.store.getState().snapshot!.rows.window[0] as ToolCallRow;
      transport.emit(
        makeFrame("sub-1", 5, 6, {
          kind: "deltas",
          deltas: [{ op: "row.upserted", row: JSON.parse(JSON.stringify(before)) }],
        }),
      );
      expect(lease.store.getState().snapshot!.rows.window[0]).toBe(before);
      transport.emit(
        makeFrame("sub-1", 6, 7, {
          kind: "deltas",
          deltas: [{ op: "row.upserted", row: planRow(1, "success") }],
        }),
      );
      const after = lease.store.getState().snapshot!.rows.window[0] as ToolCallRow;
      expect(after.status).toBe("success");
      expect(after.input).toBe(before.input);
    });

    it("keep-warm 过期冷打开后，仍存活的旧行被新 store 复用", async () => {
      const rows = [planRow(1), assistantRow(2, "hello")];
      subscribeWithRows(rows);
      const first = layer.acquire("s1");
      await flushMicrotasks();
      // 模拟被闭包链留住的历史 snapshot。
      const retained = first.store.getState().snapshot!.rows.window;
      first.release();
      vi.advanceTimersByTime(30_000);
      await flushMicrotasks();

      const second = layer.acquire("s1");
      await flushMicrotasks();
      expect(second.openKind).toBe("cold");
      expect(second.store).not.toBe(first.store);
      const window = second.store.getState().snapshot!.rows.window;
      expect(window[0]).toBe(retained[0]);
      expect(window[1]).toBe(retained[1]);
    });

    it("不同 session 的同 rowId 行不共享", async () => {
      subscribeWithRows([planRow(1)]);
      const a = layer.acquire("s1");
      const b = layer.acquire("s2");
      await flushMicrotasks();
      const rowA = a.store.getState().snapshot!.rows.window[0];
      const rowB = b.store.getState().snapshot!.rows.window[0];
      expect(rowA).toEqual(rowB);
      expect(rowA).not.toBe(rowB);
    });
  });

  it("同 session 重复 acquire 共享 store，不再订阅", async () => {
    const a = layer.acquire("s1");
    const b = layer.acquire("s1");
    await flushMicrotasks();
    expect(a.store).toBe(b.store);
    expect(a.openKind).toBe("cold");
    expect(b.openKind).toBe("warm");
    expect(transport.subscribeCalls).toHaveLength(1);
  });

  it("记录 lease 引用计数与 keep-warm 生命周期", async () => {
    const info = vi.spyOn(logger.lifecycle, "info").mockImplementation(() => {});
    try {
      const lease = layer.acquire("s1");
      await flushMicrotasks();
      lease.release();
      vi.advanceTimersByTime(30_000);
      await flushMicrotasks();

      const events = info.mock.calls
        .map(([, context]) => (context as { event?: string } | undefined)?.event)
        .filter((event): event is string => Boolean(event));
      expect(events).toEqual(
        expect.arrayContaining([
          "v4.session_data.acquire",
          "v4.session_data.release",
          "v4.session_data.keep_warm_expired",
        ]),
      );
      expect(info.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            "v4 session data lease acquired",
            expect.objectContaining({ openKind: "cold", refCount: 1, sessionId: "s1" }),
          ]),
        ]),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("归零后 keep-warm 窗口内 re-acquire 复用；超时后退订", async () => {
    const a = layer.acquire("s1");
    await flushMicrotasks();
    const storeA = a.store;
    a.release();
    // keep-warm 内重新引用：复用，不退订。
    vi.advanceTimersByTime(10_000);
    const b = layer.acquire("s1");
    expect(b.store).toBe(storeA);
    expect(b.openKind).toBe("keep_warm");
    expect(transport.unsubscribeCalls).toHaveLength(0);
    b.release();
    // 超时：退订 + 移出注册表。
    vi.advanceTimersByTime(30_000);
    await flushMicrotasks();
    expect(transport.unsubscribeCalls).toEqual(["sub-1"]);
    expect(layer.size).toBe(0);
    // 再 acquire 是全新 subscribe（与刷新同一路径）。
    layer.acquire("s1");
    await flushMicrotasks();
    expect(transport.subscribeCalls).toHaveLength(2);
  });

  it("release 幂等：重复 release 不影响其他租约", async () => {
    const a = layer.acquire("s1");
    const b = layer.acquire("s1");
    await flushMicrotasks();
    a.release();
    a.release();
    vi.advanceTimersByTime(60_000);
    await flushMicrotasks();
    // b 仍持有引用，不得退订。
    expect(transport.unsubscribeCalls).toHaveLength(0);
    expect(b.store.getState().status).toBe("live");
  });

  it("dispose 清场：取消 keep-warm、关闭全部 store", async () => {
    const a = layer.acquire("s1");
    layer.acquire("s2");
    await flushMicrotasks();
    a.release();
    layer.dispose();
    await flushMicrotasks();
    expect(transport.unsubscribeCalls.sort()).toEqual(["sub-1", "sub-2"]);
    expect(() => layer.acquire("s3")).toThrow();
  });

  it("runtime restart 让 active 与 keep-warm stores 各 full subscribe 一次", async () => {
    layer.acquire("s1");
    const keepWarm = layer.acquire("s2");
    await flushMicrotasks();
    keepWarm.release();
    expect(transport.subscribeCalls).toHaveLength(2);

    transport.restart();
    await flushMicrotasks();
    expect(transport.subscribeCalls).toHaveLength(4);
    expect(transport.subscribeCalls.slice(2).every((call) => call.base === undefined)).toBe(true);
  });
});

// ── M5④ R-06：loadOlder 游标分页（store 侧合并规范） ──

describe("ConversationProjectionStore.loadOlder", () => {
  let transport: FakeTransport;
  let store: ConversationProjectionStore;

  /** 窗口 41..100（60 行）、全序首行 1 的截断快照。 */
  function truncatedSnapshot(): ConversationSnapshot {
    const window: ConversationRow[] = [];
    for (let rowId = 41; rowId <= 100; rowId++) {
      window.push(assistantRow(rowId, `行 ${rowId}`));
    }
    return makeSnapshot({
      seq: 5,
      rows: { window, totalCount: 100, firstRowId: 1 },
    });
  }

  function olderRows(from: number, to: number): ConversationRow[] {
    const rows: ConversationRow[] = [];
    for (let rowId = from; rowId <= to; rowId++) {
      rows.push(assistantRow(rowId, `行 ${rowId}`));
    }
    return rows;
  }

  beforeEach(async () => {
    transport = new FakeTransport();
    store = new ConversationProjectionStore("conversation/s1", transport);
    transport.onFrame((frame) => store.handleFrame(frame));
    transport.subscribeImpl = (params, subscriptionId) => ({
      ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
      initialFrame: makeFrame(
        subscriptionId,
        0,
        5,
        {
          kind: "snapshot",
          snapshot: truncatedSnapshot(),
        },
        params.topic,
      ),
    });
    await store.connect();
  });

  it("hasOlderRows：窗口首行 > 全序首行 → true；到顶/空/未知 → false", () => {
    expect(hasOlderRows(store.getState().snapshot)).toBe(true);
    expect(hasOlderRows(null)).toBe(false);
    expect(hasOlderRows(makeSnapshot())).toBe(false);
    expect(
      hasOlderRows(
        makeSnapshot({
          rows: { window: [assistantRow(1, "a")], totalCount: 1, firstRowId: 1 },
        }),
      ),
    ).toBe(false);
  });

  it("HLP01：尾窗首 turn 缺 header 时自动补页，完整/在途/到顶时不补", () => {
    const partial = makeSnapshot({
      rows: {
        window: [assistantRow(41, "仅有 assistant")],
        totalCount: 41,
        firstRowId: 1,
      },
    });
    const complete = makeSnapshot({
      rows: {
        window: [turnHeaderRow(40), assistantRow(41, "完整 turn")],
        totalCount: 41,
        firstRowId: 1,
      },
    });

    expect(shouldAutoLoadIncompleteLeadingTurn(partial, false)).toBe(true);
    expect(shouldAutoLoadIncompleteLeadingTurn(partial, true)).toBe(false);
    expect(shouldAutoLoadIncompleteLeadingTurn(complete, false)).toBe(false);
    expect(
      shouldAutoLoadIncompleteLeadingTurn(
        makeSnapshot({
          rows: {
            window: [assistantRow(1, "已到全序首行")],
            totalCount: 1,
            firstRowId: 1,
          },
        }),
        false,
      ),
    ).toBe(false);
  });

  it("以窗口首行为游标拉取并前插；到顶后 hasOlderRows=false", async () => {
    transport.rowsRangeImpl = (params) => {
      expect(params.sessionId).toBe("s1");
      expect(params.beforeRowId).toBe(41);
      return {
        rows: olderRows(1, 40),
        atSeq: 5,
        atRevision: 5,
        atLogEpoch: "epoch-1",
        hasMore: false,
      };
    };
    await store.loadOlder();
    const state = store.getState();
    expect(state.loadingOlder).toBe(false);
    expect(state.snapshot!.rows.window).toHaveLength(100);
    expect(state.snapshot!.rows.window[0]!.rowId).toBe(1);
    // 全序 rowId 升序（前插后仍有序）。
    const ids = state.snapshot!.rows.window.map((row) => row.rowId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(hasOlderRows(state.snapshot)).toBe(false);
  });

  it("TN07：完整目录按协议上限分页，全部成功后只提交一次 projection", async () => {
    transport.rowsRangeImpl = (params) => {
      if (params.beforeRowId === 41) {
        return {
          rows: [realUserRow(21, "turn-2"), ...olderRows(22, 40)],
          atSeq: 5,
          atRevision: 5,
          atLogEpoch: "epoch-1",
          hasMore: true,
        };
      }
      expect(params.beforeRowId).toBe(21);
      return {
        rows: [realUserRow(1, "turn-1"), ...olderRows(2, 20)],
        atSeq: 5,
        atRevision: 5,
        atLogEpoch: "epoch-1",
        hasMore: false,
      };
    };
    const snapshotChanges: ConversationSnapshot[] = [];
    let previousSnapshot = store.getState().snapshot;
    const unsubscribe = store.subscribe(() => {
      const nextSnapshot = store.getState().snapshot;
      if (nextSnapshot && nextSnapshot !== previousSnapshot) {
        snapshotChanges.push(nextSnapshot);
        previousSnapshot = nextSnapshot;
      }
    });

    const result = await store.loadAllOlder();
    unsubscribe();

    expect(transport.rowsRangeCalls).toEqual([
      { sessionId: "s1", beforeRowId: 41, limit: 200 },
      { sessionId: "s1", beforeRowId: 21, limit: 200 },
    ]);
    expect(snapshotChanges).toHaveLength(1);
    expect(store.getState().snapshot!.rows.window).toHaveLength(100);
    expect(store.getState().snapshot!.rows.window[0]!.rowId).toBe(1);
    expect(hasOlderRows(store.getState().snapshot)).toBe(false);
    expect(result.status).toBe("hydrated");
  });

  it("TN07：完整目录后续页失败时整批丢弃，不暴露半份目录", async () => {
    transport.rowsRangeImpl = (params) => {
      if (params.beforeRowId === 41) {
        return {
          rows: olderRows(21, 40),
          atSeq: 5,
          atRevision: 5,
          atLogEpoch: "epoch-1",
          hasMore: true,
        };
      }
      throw new Error("range unavailable");
    };
    const before = store.getState().snapshot!.rows.window;

    const result = await store.loadAllOlder();

    expect(store.getState().loadingOlder).toBe(false);
    expect(store.getState().snapshot!.rows.window).toBe(before);
    expect(result.status).toBe("retryable-failure");
  });

  it("TN07：tail 只有一个 query 时仍向前探测，发现第二个后提交完整目录", async () => {
    const tail = store.getState().snapshot!;
    store.handleFrame(
      makeFrame("sub-1", 5, 6, {
        kind: "snapshot",
        snapshot: {
          ...tail,
          seq: 6,
          rows: {
            ...tail.rows,
            window: [...tail.rows.window.slice(0, -1), realUserRow(100, "tail")],
          },
        },
      }),
    );
    transport.rowsRangeImpl = () => ({
      rows: [realUserRow(20, "older"), ...olderRows(21, 40)],
      atSeq: 6,
      atLogEpoch: "epoch-1",
      hasMore: false,
    });

    const result = await store.loadAllOlder();

    expect(transport.rowsRangeCalls).toHaveLength(1);
    expect(store.getState().snapshot!.rows.window.some((row) => row.rowId === 20)).toBe(true);
    expect(result.status).toBe("hydrated");
  });

  it("TN01：完整历史只有一个 query 时扫描到起点但不常驻探测 rows", async () => {
    const tail = store.getState().snapshot!;
    store.handleFrame(
      makeFrame("sub-1", 5, 6, {
        kind: "snapshot",
        snapshot: {
          ...tail,
          seq: 6,
          rows: {
            ...tail.rows,
            window: [turnHeaderRow(41), ...tail.rows.window.slice(1, -1), realUserRow(100, "t1")],
          },
        },
      }),
    );
    const before = store.getState().snapshot!.rows.window;
    transport.rowsRangeImpl = () => ({
      rows: olderRows(1, 40),
      atSeq: 6,
      atLogEpoch: "epoch-1",
      hasMore: false,
    });

    const result = await store.loadAllOlder();

    expect(transport.rowsRangeCalls).toHaveLength(1);
    expect(store.getState().snapshot!.rows.window).toBe(before);
    expect(result.status).toBe("not-enough-queries");

    transport.rowsRangeImpl = () => ({
      rows: olderRows(31, 40),
      atSeq: 6,
      atLogEpoch: "epoch-1",
      hasMore: true,
    });
    await store.loadOlder(10);
    expect(store.getState().snapshot!.rows.window[0]?.rowId).toBe(31);
    const repeated = await store.loadAllOlder();
    expect(repeated.status).toBe("not-enough-queries");
    expect(transport.rowsRangeCalls).toHaveLength(2);
  });

  it("HLP01/TN01：navigator 先取得 single-flight 时仍保留单 query 首轮补齐 rows", async () => {
    const tail = store.getState().snapshot!;
    store.handleFrame(
      makeFrame("sub-1", 5, 6, {
        kind: "snapshot",
        snapshot: {
          ...tail,
          seq: 6,
          rows: {
            ...tail.rows,
            window: olderRows(41, 100),
          },
        },
      }),
    );
    transport.rowsRangeImpl = () => ({
      rows: [turnHeaderRow(1), realUserRow(2, "t1"), ...olderRows(3, 40)],
      atSeq: 6,
      atLogEpoch: "epoch-1",
      hasMore: false,
    });

    const result = await store.loadAllOlder();

    expect(result.status).toBe("not-enough-queries");
    expect(store.getState().snapshot!.rows.window).toHaveLength(100);
    expect(store.getState().snapshot!.rows.window[0]).toMatchObject({
      kind: "turnHeader",
      rowId: 1,
      turnId: "t1",
    });
  });

  it("TN09：not-enough-queries 后追加第二条 realUser query → revision 递增 → 重新探测得 hydrated", async () => {
    // 与 TN01 相同的单-query 场景，但首轮已完整；本 case 只验证目录 revision，
    // 不与 HLP01 的首轮截断补齐语义重叠。
    const tail = store.getState().snapshot!;
    store.handleFrame(
      makeFrame("sub-1", 5, 6, {
        kind: "snapshot",
        snapshot: {
          ...tail,
          seq: 6,
          rows: {
            ...tail.rows,
            window: [turnHeaderRow(41), ...tail.rows.window.slice(1, -1), realUserRow(100, "t1")],
          },
        },
      }),
    );
    transport.rowsRangeImpl = () => ({
      rows: olderRows(1, 40),
      atSeq: 6,
      atLogEpoch: "epoch-1",
      hasMore: false,
    });

    // 首次探测：完整分支不足 2 条 query，终态缓存。
    const firstResult = await store.loadAllOlder();
    expect(firstResult.status).toBe("not-enough-queries");
    expect(transport.rowsRangeCalls).toHaveLength(1);
    const revisionAfterProbe = store.getState().turnNavigatorDirectoryRevision;

    // 用户在同一 logEpoch 内提交第二条 realUser query（row.appended delta）。
    transport.emit(
      makeFrame("sub-1", 6, 7, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: realUserRow(101, "tail-2") }],
      }),
    );

    // Bug 根因（CR-01）：logEpoch 未变，但 realUser query 集合已变化。
    // turnNavigatorDirectoryRevision 必须递增，使终态缓存失效。
    expect(store.getState().turnNavigatorDirectoryRevision).toBe(revisionAfterProbe + 1);

    // 第二次探测：现在 tail 有 2 条 query，无需补拉即可判定。
    const secondResult = await store.loadAllOlder();
    expect(secondResult.status).toBe("hydrated");
    expect(transport.rowsRangeCalls).toHaveLength(2);
  });

  it("TN09：row.removed 截断分支后 turnNavigatorDirectoryRevision 递增", async () => {
    const beforeRevision = store.getState().turnNavigatorDirectoryRevision;
    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [{ op: "row.removed", fromRowId: 50 }],
      }),
    );
    expect(store.getState().turnNavigatorDirectoryRevision).toBe(beforeRevision + 1);
  });

  it("TN09：普通 assistant delta 不递增 turnNavigatorDirectoryRevision", async () => {
    const beforeRevision = store.getState().turnNavigatorDirectoryRevision;
    transport.emit(
      makeFrame("sub-1", 5, 6, {
        kind: "deltas",
        deltas: [{ op: "row.appended", row: assistantRow(101, "流式 assistant") }],
      }),
    );
    expect(store.getState().turnNavigatorDirectoryRevision).toBe(beforeRevision);
  });

  it("单飞：在途期间重复调用不发第二次请求", async () => {
    let resolveFetch: (result: V4ConversationRowsRangeResult) => void;
    transport.rowsRangeImpl = () =>
      new Promise<V4ConversationRowsRangeResult>((resolve) => {
        resolveFetch = resolve;
      });
    const first = store.loadOlder();
    const second = store.loadOlder();
    expect(store.getState().loadingOlder).toBe(true);
    resolveFetch!({
      rows: olderRows(31, 40),
      atSeq: 5,
      atRevision: 5,
      atLogEpoch: "epoch-1",
      hasMore: true,
    });
    await Promise.all([first, second]);
    expect(transport.rowsRangeCalls).toHaveLength(1);
    expect(store.getState().snapshot!.rows.window[0]!.rowId).toBe(31);
  });

  it("陈旧读（atLogEpoch 不匹配）→ 整体丢弃，窗口不变", async () => {
    transport.rowsRangeImpl = () => ({
      rows: olderRows(1, 40),
      atSeq: 99,
      atRevision: 5,
      atLogEpoch: "epoch-0",
      hasMore: false,
    });
    const before = store.getState().snapshot!.rows.window;
    await store.loadOlder();
    expect(store.getState().snapshot!.rows.window).toBe(before);
  });

  it("在途期间游标失效（snapshot 整体替换）→ 结果作废，不复活旧行", async () => {
    let resolveFetch: (result: V4ConversationRowsRangeResult) => void;
    transport.rowsRangeImpl = () =>
      new Promise<V4ConversationRowsRangeResult>((resolve) => {
        resolveFetch = resolve;
      });
    const inflight = store.loadOlder();
    // 权威侧 resync：窗口整体替换为另一段（首行改变 → 游标失效）。
    store.handleFrame(
      makeFrame(store.getState().subscriptionId!, 0, 9, {
        kind: "snapshot",
        snapshot: makeSnapshot({
          seq: 9,
          rows: {
            window: olderRows(90, 100),
            totalCount: 100,
            firstRowId: 1,
          },
        }),
      }),
    );
    resolveFetch!({
      rows: olderRows(1, 40),
      atSeq: 5,
      atRevision: 5,
      atLogEpoch: "epoch-1",
      hasMore: false,
    });
    await inflight;
    expect(store.getState().snapshot!.rows.window[0]!.rowId).toBe(90);
  });

  it("到顶/无快照时 no-op（不发请求）", async () => {
    // 先拉到顶。
    transport.rowsRangeImpl = () => ({
      rows: olderRows(1, 40),
      atSeq: 5,
      atRevision: 5,
      atLogEpoch: "epoch-1",
      hasMore: false,
    });
    await store.loadOlder();
    expect(transport.rowsRangeCalls).toHaveLength(1);
    await store.loadOlder();
    expect(transport.rowsRangeCalls).toHaveLength(1);
  });

  it("mergeOlderRows：按 rowId 键控，只收窗口首行之前的行", () => {
    const window = olderRows(41, 45);
    // 与窗口重叠/越界的行被丢弃；纯旧行前插。
    const merged = mergeOlderRows(window, [...olderRows(39, 42), assistantRow(50, "越界")]);
    expect(merged!.map((row) => row.rowId)).toEqual([39, 40, 41, 42, 43, 44, 45]);
    // 无可并入行 → null（引用不换）。
    expect(mergeOlderRows(window, olderRows(41, 45))).toBeNull();
    expect(mergeOlderRows(window, [])).toBeNull();
  });
});
