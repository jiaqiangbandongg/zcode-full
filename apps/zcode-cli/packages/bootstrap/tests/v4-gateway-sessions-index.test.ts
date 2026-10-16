// ConversationV4Gateway 的 sessions-index 集成测试（M5 ①，14-sessions-index）：
//   1. subscribeSessionsIndex：store 摘要种子 + 已加载会话 live 投影覆盖 → snapshot 帧
//   2. ingest 非流式事件 → 列表订阅者收到 session.upserted 增量帧（流式 ModelStreaming 不触发）
//   3. disposeSession → session.removed 增量帧
//   4. 无 getSessionWorkspaceId 的旧宿主 → sessions-index 路径整体 no-op，不影响 conversation
//   5. unsubscribeSessionsIndex 后不再收帧
//   6. DynamicWorkflowRunProgress 按 leading + trailing 窗口节流（14-sessions-index「事件 fan-out 节奏」）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EventId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type {
  ConversationTopicFrame,
  SessionSummary,
  SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/index.js";

type AnyFrame = ConversationTopicFrame | SessionsIndexTopicFrame;

function event(
  sessionId: string,
  seq: number,
  type: SessionEventTypeUnion,
  payload: unknown,
  turnId?: string,
): SessionEvent {
  return {
    id: `event-${sessionId}-${seq}` as EventId,
    sessionId: sessionId as SessionId,
    turnId: turnId as TurnId | undefined,
    type,
    timestamp: new Date(1_700_000_000_000 + seq * 1000),
    traceId: "trace-1" as TraceId,
    sequenceNumber: seq,
    payload,
  };
}

function storedSummary(sessionId: string): SessionSummary {
  return {
    sessionId,
    workspaceId: "ws-1",
    title: `stored-${sessionId}`,
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 50,
    createdAt: 10,
  };
}

interface Stub {
  frames: AnyFrame[];
  sessions: Set<string>;
  sessionWorkspace: Map<string, string>;
  stored: SessionSummary[];
  /** 模拟 record.updatedAt：每条活动事件都会 bump，摘要因此条条有变化。 */
  lastActivityAt?: number;
  drafts?: Set<string>;
  loadPersistedEvents?: (sessionId: string) => Promise<{
    events: SessionEvent[];
    synthesized: boolean;
    sourceEventSeq?: number;
  }>;
  loadStored?: (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => Promise<SessionSummary[]> | SessionSummary[];
}

function makeGateway(stub: Stub, opts: { withIndexHooks: boolean }) {
  return new ConversationV4Gateway(
    {
      sessionExists: (sessionId) => stub.sessions.has(sessionId),
      emitWireFrame: (wire) => {
        if (wire.kind !== "complete") {
          throw new Error("sessions-index test adapter only accepts complete wires");
        }
        stub.frames.push(wire.frame);
      },
      executeCommand: async () => undefined,
      loadPersistedEvents: async (sessionId) =>
        stub.loadPersistedEvents?.(sessionId) ?? { events: [], synthesized: false },
      ...(opts.withIndexHooks
        ? {
            getSessionWorkspaceId: (sessionId: string) =>
              stub.sessionWorkspace.get(sessionId) ?? null,
            getSessionIndexMeta: () => ({
              createdAt: 10,
              lastActivityAt: stub.lastActivityAt ?? 99,
            }),
            listWorkspaceSessionIds: (workspaceId: string) =>
              [...stub.sessionWorkspace.entries()]
                .filter(([, ws]) => ws === workspaceId)
                .map(([id]) => id),
            getStoredSessionSummaries: (workspaceId: string) =>
              stub.loadStored?.(workspaceId) ?? stub.stored,
            refreshLegacySessionSummaries: (
              workspaceId: string,
              legacyTaskIds: readonly string[],
            ) => stub.loadStored?.(workspaceId, legacyTaskIds) ?? stub.stored,
            isDraftSession: (sessionId: string) => stub.drafts?.has(sessionId) ?? false,
          }
        : {}),
    },
    { now: () => 1_700_000_999_000, createLogEpoch: () => "epoch-1" },
  );
}

function indexFrames(stub: Stub): SessionsIndexTopicFrame[] {
  return stub.frames.filter((f) =>
    f.topic.startsWith("sessions-index/"),
  ) as SessionsIndexTopicFrame[];
}

describe("ConversationV4Gateway sessions-index 集成", () => {
  it("saturated mobile index subscriber does not block desktop and drains only itself", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const desktop = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "desktop-index",
      clientMode: "desktop-continuous",
    });
    const mobile = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "mobile-index",
      clientMode: "web-remote-replayable",
    });

    gateway.setConnectionFlowState({ connectionId: "mobile-index", state: "saturated" });
    gateway.ingest(
      "live-1",
      event("live-1", 2, SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "changed-while-paused",
      }),
    );
    expect(indexFrames(stub).map((frame) => frame.subscriptionId)).toEqual([
      desktop.ack.subscriptionId,
    ]);

    gateway.setConnectionFlowState({ connectionId: "mobile-index", state: "drained" });
    expect(indexFrames(stub).map((frame) => frame.subscriptionId)).toEqual([
      desktop.ack.subscriptionId,
      mobile.ack.subscriptionId,
    ]);
  });

  it("sessions-index recovery commit 后无新 ingest 也会 flush 在途期间增量", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const subscribed = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    const recovery = gateway.resyncReserved({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      subscriptionId: subscribed.ack.subscriptionId,
      base: {
        logEpoch: subscribed.ack.logEpoch,
        seq: subscribed.initialFrame?.toSeq ?? 0,
      },
    });

    gateway.ingest(
      "live-1",
      event("live-1", 2, SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "during-recovery",
      }),
    );
    expect(indexFrames(stub)).toEqual([]);
    expect(recovery.commit()).toBe(true);
    expect(indexFrames(stub)).toHaveLength(1);
    expect(indexFrames(stub)[0]).toMatchObject({
      payload: { kind: "deltas" },
    });
  });

  it("initial physical encode 失败会回滚 sessions-index subscription", async () => {
    const summary = storedSummary("oversized");
    summary.title = "x".repeat(17 * 1024 * 1024);
    const stub: Stub = {
      frames: [],
      sessions: new Set(),
      sessionWorkspace: new Map(),
      stored: [summary],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    await expect(
      gateway.subscribeSessionsIndex({
        topic: "sessions-index/ws-1",
        connectionId: "conn-1",
        clientMode: "desktop-continuous",
      }),
    ).rejects.toThrow("proto.frameAssemblyTooLarge");
    const publishers = (
      gateway as unknown as {
        indexPublishers: Map<string, { hasSubscribers(): boolean }>;
      }
    ).indexPublishers;
    expect(publishers.get("ws-1")?.hasSubscribers()).toBe(false);
  });

  it("subscribe：store 种子 + live 覆盖 → snapshot 含两会话", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [storedSummary("cold-1")],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    // 先让 live-1 有 conversation 投影
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const res = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    expect(res.ack.mode).toBe("snapshot");
    expect(res.initialFrame?.payload.kind).toBe("snapshot");
    if (res.initialFrame?.payload.kind === "snapshot") {
      const ids = res.initialFrame.payload.snapshot.sessions.map((s) => s.sessionId).sort();
      expect(ids).toEqual(["cold-1", "live-1"]);
    }
  });

  it("首次无 allowlist 后可用 allowlist 重订阅：重读 store 并向已有订阅增量补齐", async () => {
    const storedCurrent = storedSummary("current-1");
    const storedLegacy = storedSummary("legacy-1");
    const calls: Array<readonly string[] | undefined> = [];
    const stub: Stub = {
      frames: [],
      sessions: new Set(),
      sessionWorkspace: new Map(),
      stored: [],
      loadStored: (_workspaceId, legacyTaskIds) => {
        calls.push(legacyTaskIds);
        return legacyTaskIds?.length
          ? [{ ...storedCurrent, title: "不能覆盖已有摘要" }, storedLegacy]
          : [storedCurrent];
      },
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    const first = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-old",
      clientMode: "desktop-continuous",
    });
    const before = indexFrames(stub).length;

    const retried = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-new",
      clientMode: "desktop-continuous",
      legacyTaskIds: ["legacy-1"],
    });

    expect(calls).toEqual([undefined, ["legacy-1"]]);
    expect(first.initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: { sessions: [expect.objectContaining({ sessionId: "current-1" })] },
    });
    if (retried.initialFrame?.payload.kind === "snapshot") {
      expect(retried.initialFrame.payload.snapshot.sessions).toEqual([
        expect.objectContaining({ sessionId: "current-1", title: "stored-current-1" }),
        expect.objectContaining({ sessionId: "legacy-1" }),
      ]);
    } else {
      throw new Error("Expected retried sessions-index snapshot");
    }
    const emitted = indexFrames(stub).slice(before);
    expect(emitted).toEqual([
      expect.objectContaining({
        subscriptionId: first.ack.subscriptionId,
        payload: {
          kind: "deltas",
          deltas: [
            expect.objectContaining({
              op: "session.upserted",
              session: expect.objectContaining({ sessionId: "legacy-1" }),
            }),
          ],
        },
      }),
    ]);
  });

  it("携带 allowlist 的重读失败后不会封死后续重试", async () => {
    let allowlistAttempts = 0;
    const stub: Stub = {
      frames: [],
      sessions: new Set(),
      sessionWorkspace: new Map(),
      stored: [],
      loadStored: (_workspaceId, legacyTaskIds) => {
        if (!legacyTaskIds?.length) return [];
        allowlistAttempts += 1;
        // 模拟 bridge 将 claim/list 失败降级为空摘要；下一次订阅必须再次调用宿主钩子。
        return allowlistAttempts === 1 ? [] : [storedSummary("legacy-1")];
      },
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-initial",
      clientMode: "desktop-continuous",
    });
    await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-failed",
      clientMode: "desktop-continuous",
      legacyTaskIds: ["legacy-1"],
    });

    const recovered = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-recovered",
      clientMode: "desktop-continuous",
      legacyTaskIds: ["legacy-1"],
    });

    expect(allowlistAttempts).toBe(2);
    if (recovered.initialFrame?.payload.kind === "snapshot") {
      expect(recovered.initialFrame.payload.snapshot.sessions).toEqual([
        expect.objectContaining({ sessionId: "legacy-1" }),
      ]);
    } else {
      throw new Error("Expected recovered sessions-index snapshot");
    }
  });

  it("同 workspace 并发初始化按顺序执行，迁移后快照不会被较早的空种子赢走", async () => {
    let releaseFirst!: (summaries: SessionSummary[]) => void;
    let secondLoadStarted = false;
    let loadCount = 0;
    const stub: Stub = {
      frames: [],
      sessions: new Set(),
      sessionWorkspace: new Map(),
      stored: [],
      loadStored: () => {
        loadCount += 1;
        if (loadCount === 1) {
          return new Promise<SessionSummary[]>((resolve) => {
            releaseFirst = resolve;
          });
        }
        secondLoadStarted = true;
        return [storedSummary("legacy-1")];
      },
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });

    const first = gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-first",
      clientMode: "desktop-continuous",
    });
    const second = gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-second",
      clientMode: "desktop-continuous",
      legacyTaskIds: ["legacy-1"],
    });
    expect(secondLoadStarted).toBe(false);

    releaseFirst([]);
    await first;
    const migrated = await second;

    expect(secondLoadStarted).toBe(true);
    if (migrated.initialFrame?.payload.kind === "snapshot") {
      expect(migrated.initialFrame.payload.snapshot.sessions).toEqual([
        expect.objectContaining({ sessionId: "legacy-1" }),
      ]);
    } else {
      throw new Error("Expected migrated sessions-index snapshot");
    }
  });

  it("异步冷种子未完成时 dispose：不得在销毁后重新注册 publisher 或完成订阅", async () => {
    let releaseLoad!: (summaries: SessionSummary[]) => void;
    const stub: Stub = {
      frames: [],
      sessions: new Set(),
      sessionWorkspace: new Map(),
      stored: [],
      loadStored: () =>
        new Promise<SessionSummary[]>((resolve) => {
          releaseLoad = resolve;
        }),
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    const subscribing = gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-disposed",
      clientMode: "desktop-continuous",
    });

    gateway.dispose();
    releaseLoad([storedSummary("late-session")]);

    await expect(subscribing).rejects.toThrow("fault.gateway.disposed");
    const publishers = (
      gateway as unknown as {
        indexPublishers: { get(workspaceId: string): unknown };
      }
    ).indexPublishers;
    expect(publishers.get("ws-1")).toBeUndefined();
    expect(indexFrames(stub)).toEqual([]);
  });

  it("draft（deferred 未发首条）不进列表：种子跳过 + ingest 跳过，提升后入列", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["draft-1"]),
      sessionWorkspace: new Map([["draft-1", "ws-1"]]),
      stored: [],
      drafts: new Set(["draft-1"]),
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "draft-1",
      event("draft-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    // 订阅种子：draft 不出现在 snapshot。
    const res = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    if (res.initialFrame?.payload.kind === "snapshot") {
      expect(res.initialFrame.payload.snapshot.sessions).toEqual([]);
    }
    // draft 期间的事件也不产列表帧。
    const framesBefore = indexFrames(stub).length;
    gateway.ingest(
      "draft-1",
      event("draft-1", 2, SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "draft 期标题",
      }),
    );
    expect(indexFrames(stub).length).toBe(framesBefore);
    // 首发提升 persistence 后（draft 标记消失），事件驱动入列。
    stub.drafts?.delete("draft-1");
    gateway.ingest(
      "draft-1",
      event("draft-1", 3, SessionEventType.SessionTitleUpdated, {
        previousTitle: "draft 期标题",
        source: "custom",
        title: "已提升",
      }),
    );
    const upserts = indexFrames(stub).filter(
      (f) =>
        f.payload.kind === "deltas" &&
        f.payload.deltas.some(
          (d) => d.op === "session.upserted" && d.session.sessionId === "draft-1",
        ),
    );
    expect(upserts.length).toBeGreaterThan(0);
  });

  it("fork 暂态 publisher 在 hydration 后无后续事件也会发布 visible summary", async () => {
    const childId = "fork-child";
    const persistedEvents = [
      event(childId, 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
      event(
        childId,
        2,
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "继承问题" },
        "turn-1",
      ),
      event(
        childId,
        3,
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "继承回答", done: false },
        "turn-1",
      ),
      event(
        childId,
        4,
        SessionEventType.TurnComplete,
        {
          response: "继承回答",
          tokenCount: 1,
          toolCallCount: 0,
          duration: 1,
          resultType: "success",
        },
        "turn-1",
      ),
    ];
    const stub: Stub = {
      frames: [],
      sessions: new Set([childId]),
      sessionWorkspace: new Map([[childId, "ws-1"]]),
      stored: [],
      loadPersistedEvents: async () => ({
        events: persistedEvents,
        synthesized: true,
        sourceEventSeq: persistedEvents.length,
      }),
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });

    // fork resume 先建立只有 SessionCreated 的暂态 publisher；此时列表基线是 draft。
    gateway.ingest(
      childId,
      event(childId, 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const indexSubscription = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "index-conn",
      clientMode: "desktop-continuous",
    });
    expect(indexSubscription.initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: {
        sessions: [expect.objectContaining({ sessionId: childId, phase: "draft" })],
      },
    });

    const framesBeforeHydration = indexFrames(stub).length;
    await gateway.subscribe({
      topic: `conversation/${childId}`,
      connectionId: "conversation-conn",
      clientMode: "desktop-continuous",
    });

    const emitted = indexFrames(stub).slice(framesBeforeHydration);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subscriptionId: indexSubscription.ack.subscriptionId,
          payload: {
            kind: "deltas",
            deltas: [
              expect.objectContaining({
                op: "session.upserted",
                session: expect.objectContaining({
                  sessionId: childId,
                  phase: "completedSuccess",
                }),
              }),
            ],
          },
        }),
      ]),
    );
  });

  it("ingest 非流式事件 → 列表订阅者收到 upserted 增量帧", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    const before = indexFrames(stub).length;
    // 标题变化（非流式）→ 应产 upserted
    gateway.ingest(
      "live-1",
      event("live-1", 2, SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "新标题",
      }),
    );
    const emitted = indexFrames(stub).slice(before);
    expect(emitted.length).toBeGreaterThan(0);
    const deltaFrame = emitted.find((f) => f.payload.kind === "deltas");
    expect(deltaFrame).toBeDefined();
    if (deltaFrame?.payload.kind === "deltas") {
      expect(deltaFrame.payload.deltas[0]).toMatchObject({
        op: "session.upserted",
      });
    }
  });

  it("ModelStreaming 高频增量不触发列表帧", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    const before = indexFrames(stub).length;
    gateway.ingest(
      "live-1",
      event("live-1", 2, SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, "t1"),
    );
    gateway.ingest(
      "live-1",
      event(
        "live-1",
        3,
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false },
        "t1",
      ),
    );
    gateway.ingest(
      "live-1",
      event(
        "live-1",
        4,
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "abc", done: false },
        "t1",
      ),
    );
    const emitted = indexFrames(stub).slice(before);
    // TurnStarted 触发一帧（phase→running），两条 ModelStreaming 不再触发
    expect(emitted.length).toBe(1);
  });

  it("disposeSession → session.removed 增量帧", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    const before = indexFrames(stub).length;
    gateway.disposeSession("live-1");
    const emitted = indexFrames(stub).slice(before);
    const removed = emitted.find(
      (f) =>
        f.payload.kind === "deltas" && f.payload.deltas.some((d) => d.op === "session.removed"),
    );
    expect(removed).toBeDefined();
  });

  it("无订阅者时 disposeSession 仍移除 index projection，重订阅 snapshot 不复活", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const first = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    gateway.unsubscribe({
      topic: "sessions-index/ws-1",
      subscriptionId: first.ack.subscriptionId,
      connectionId: "conn-1",
    });

    // disposeSession 的删除必须更新无订阅者 publisher；否则已有 publisher 会把已删除会话
    // 带进下一次 snapshot，造成任务复活。
    gateway.disposeSession("live-1");

    const second = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-2",
      clientMode: "desktop-continuous",
    });
    if (second.initialFrame?.payload.kind === "snapshot") {
      expect(second.initialFrame.payload.snapshot.sessions).toEqual([]);
    } else {
      throw new Error("Expected sessions-index snapshot");
    }
  });

  it("旧宿主（无 index hooks）→ sessions-index 路径 no-op，conversation ingest 不受影响", () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map(),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: false });
    expect(() =>
      gateway.ingest(
        "live-1",
        event("live-1", 1, SessionEventType.SessionCreated, {
          mode: "default",
          contextWindow: 200_000,
        }),
      ),
    ).not.toThrow();
    expect(indexFrames(stub)).toHaveLength(0);
  });

  it("unsubscribeSessionsIndex 后 ingest 不再产列表帧", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const res = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    gateway.unsubscribe({
      topic: "sessions-index/ws-1",
      subscriptionId: res.ack.subscriptionId,
      connectionId: "conn-1",
    });
    const before = indexFrames(stub).length;
    gateway.ingest(
      "live-1",
      event("live-1", 2, SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "退订后",
      }),
    );
    expect(indexFrames(stub).length).toBe(before);
  });

  it("无订阅者窗口仍推进 index projection，重订阅 snapshot 返回当前 phase", async () => {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const first = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    expect(first.initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: { sessions: [expect.objectContaining({ sessionId: "live-1" })] },
    });
    gateway.unsubscribe({
      topic: "sessions-index/ws-1",
      subscriptionId: first.ack.subscriptionId,
      connectionId: "conn-1",
    });

    // 退订窗口内没有任何列表消费者；修复前 publishCurrentSummaryToIndex 会直接
    // return，导致之后的 snapshot 仍停留在窗口前的 phase。
    gateway.ingest(
      "live-1",
      event("live-1", 2, SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, "t1"),
    );

    const second = await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-2",
      clientMode: "desktop-continuous",
    });
    expect(second.initialFrame?.payload).toMatchObject({
      kind: "snapshot",
      snapshot: {
        sessions: [expect.objectContaining({ sessionId: "live-1", phase: "running" })],
      },
    });
  });
});

// ── 工作流进度事件的 fan-out 节流（14-sessions-index「事件 fan-out 节奏」）──
// 现场事故：一次 run 在 8s 内发出 4000 条 DynamicWorkflowRunProgress，每条都 bump
// record.updatedAt，旧实现于是条条 flush 一帧 sessions-index 增量 → 宿主重算 task 行 →
// renderer 按事件频率重拉三份任务列表。节流只改帧节奏，终态仍在一个窗口内送达。
describe("ConversationV4Gateway sessions-index 工作流进度节流", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** 与 WORKFLOW_PROGRESS_INDEX_FANOUT_MS 对齐；测试不导入常量，窗口值本身也是被测事实。 */
  const WINDOW_MS = 250;
  const RUN_ID = "dwfrun-1";

  function progress(seq: number, eventType: string, payload: Record<string, unknown>): SessionEvent {
    return event("live-1", seq, SessionEventType.DynamicWorkflowRunProgress, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: seq,
      eventType,
      payload,
    });
  }

  /** 建好一个在跑的 run，并把建 run 时开的那扇窗关掉：断言从静默态开始。 */
  function setup(): { stub: Stub; gateway: ReturnType<typeof makeGateway> } {
    const stub: Stub = {
      frames: [],
      sessions: new Set(["live-1"]),
      sessionWorkspace: new Map([["live-1", "ws-1"]]),
      stored: [],
      lastActivityAt: 1000,
    };
    const gateway = makeGateway(stub, { withIndexHooks: true });
    gateway.ingest(
      "live-1",
      event("live-1", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    gateway.ingest(
      "live-1",
      progress(2, "run-started", { runId: RUN_ID, caps: { maxConcurrency: 4 } }),
    );
    vi.advanceTimersByTime(WINDOW_MS);
    return { stub, gateway };
  }

  /** 模拟 onSessionEvent 的 record.updatedAt bump，再喂事件。 */
  function ingestProgress(
    stub: Stub,
    gateway: ReturnType<typeof makeGateway>,
    seq: number,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    stub.lastActivityAt = (stub.lastActivityAt ?? 0) + 1;
    gateway.ingest("live-1", progress(seq, eventType, payload));
  }

  function lastUpsertedSummary(stub: Stub): SessionSummary | undefined {
    for (const frame of [...indexFrames(stub)].reverse()) {
      if (frame.payload.kind !== "deltas") continue;
      for (const delta of [...frame.payload.deltas].reverse()) {
        if (delta.op === "session.upserted") return delta.session;
      }
    }
    return undefined;
  }

  async function subscribed(stub: Stub, gateway: ReturnType<typeof makeGateway>): Promise<number> {
    await gateway.subscribeSessionsIndex({
      topic: "sessions-index/ws-1",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    });
    return indexFrames(stub).length;
  }

  it("一窗内的 N 条进度只出 1 帧立即 + 1 帧窗末，窗末帧带最终摘要", async () => {
    const { stub, gateway } = setup();
    const before = await subscribed(stub, gateway);

    for (let index = 1; index <= 6; index += 1) {
      ingestProgress(stub, gateway, 2 + index, "phase-entered", { name: `phase-${index}` });
      vi.advanceTimersByTime(10);
    }
    // leading edge：静默后的第一条立即到；其余 5 条合并，窗内不再发帧。
    expect(indexFrames(stub).length).toBe(before + 1);
    expect(lastUpsertedSummary(stub)?.workflowActivity?.runs[0]?.currentPhase).toBe("phase-1");

    vi.advanceTimersByTime(WINDOW_MS);
    expect(indexFrames(stub).length).toBe(before + 2);
    const trailing = lastUpsertedSummary(stub);
    expect(trailing?.workflowActivity?.runs[0]?.currentPhase).toBe("phase-6");
    expect(trailing?.lastActivityAt).toBe(1006);

    // 持续高频：窗末补发后窗口续开，下一窗同样只出 1 帧 → 侧栏运行行不超过 4Hz。
    for (let index = 7; index <= 12; index += 1) {
      ingestProgress(stub, gateway, 2 + index, "phase-entered", { name: `phase-${index}` });
      vi.advanceTimersByTime(10);
    }
    expect(indexFrames(stub).length).toBe(before + 2);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(indexFrames(stub).length).toBe(before + 3);
    expect(lastUpsertedSummary(stub)?.workflowActivity?.runs[0]?.currentPhase).toBe("phase-12");
  });

  it("窗内的非进度事件立即发帧，并满足/取消待发的窗末帧", async () => {
    const { stub, gateway } = setup();
    const before = await subscribed(stub, gateway);

    ingestProgress(stub, gateway, 3, "phase-entered", { name: "phase-1" });
    vi.advanceTimersByTime(10);
    ingestProgress(stub, gateway, 4, "phase-entered", { name: "phase-2" });
    vi.advanceTimersByTime(10);
    expect(indexFrames(stub).length).toBe(before + 1);

    stub.lastActivityAt = (stub.lastActivityAt ?? 0) + 1;
    gateway.ingest(
      "live-1",
      event("live-1", 5, SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "窗内改名",
      }),
    );
    // 非进度事件照旧即时 publish，且捎带了窗内合并的进度。
    expect(indexFrames(stub).length).toBe(before + 2);
    const immediate = lastUpsertedSummary(stub);
    expect(immediate?.title).toBe("窗内改名");
    expect(immediate?.workflowActivity?.runs[0]?.currentPhase).toBe("phase-2");

    // 待发的窗末帧已被它满足：窗口走完不再补一帧空增量。
    vi.advanceTimersByTime(WINDOW_MS * 2);
    expect(indexFrames(stub).length).toBe(before + 2);
  });

  it("dispose 清掉窗口定时器：不再发帧，也不拖住进程", async () => {
    const { stub, gateway } = setup();
    const before = await subscribed(stub, gateway);

    ingestProgress(stub, gateway, 3, "phase-entered", { name: "phase-1" });
    ingestProgress(stub, gateway, 4, "phase-entered", { name: "phase-2" });
    expect(indexFrames(stub).length).toBe(before + 1);

    gateway.dispose();
    vi.advanceTimersByTime(10_000);
    expect(indexFrames(stub).length).toBe(before + 1);
    // 网关自己的定时器（attachment prune、flush、fan-out 窗口）必须一个不剩。
    expect(vi.getTimerCount()).toBe(0);
  });

  it("窗内的 run-settled 在一个窗口内送达终态", async () => {
    const { stub, gateway } = setup();
    const before = await subscribed(stub, gateway);

    ingestProgress(stub, gateway, 3, "phase-entered", { name: "phase-1" });
    vi.advanceTimersByTime(10);
    ingestProgress(stub, gateway, 4, "run-settled", { status: "completed" });
    // 终态也在窗内被合并，所以此刻列表还停在 leading 那一帧。
    expect(indexFrames(stub).length).toBe(before + 1);
    expect(lastUpsertedSummary(stub)?.workflowActivity?.runs[0]?.status).toBe("running");

    vi.advanceTimersByTime(WINDOW_MS);
    expect(indexFrames(stub).length).toBe(before + 2);
    expect(lastUpsertedSummary(stub)?.workflowActivity?.runs[0]?.status).toBe("completed");
  });
});
