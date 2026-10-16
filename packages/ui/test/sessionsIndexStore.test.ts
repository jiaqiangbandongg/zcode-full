import { describe, expect, it, vi } from "vitest";
import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "@zcode/shared";
import type {
  SessionSummary,
  SessionsIndexTopicFrame,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  WIRE_FAULT_INVALID_PAYLOAD,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";
import { logger } from "@/logger.js";
import {
  EMPTY_SESSIONS_INDEX_STATE,
  SessionsIndexStore,
  applySessionsIndexFrame,
} from "@/v4/sessionsIndexStore.js";

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    workspaceId: "ws-1",
    title: sessionId,
    phase: "draft",
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: 100,
    createdAt: 1,
    ...overrides,
  };
}

function snapshotFrame(sessions: SessionSummary[], toSeq: number): SessionsIndexTopicFrame {
  return {
    topic: "sessions-index/ws-1",
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "ws-1",
        logEpoch: "epoch-1",
        sessions,
      },
    },
  };
}

type IndexDeltas = Extract<SessionsIndexTopicFrame["payload"], { kind: "deltas" }>["deltas"];

function deltaFrame(deltas: IndexDeltas, fromSeq: number, toSeq: number): SessionsIndexTopicFrame {
  return {
    topic: "sessions-index/ws-1",
    subscriptionId: "sub-1",
    fromSeq,
    toSeq,
    sentAt: 1,
    payload: { kind: "deltas", deltas },
  };
}

describe("applySessionsIndexFrame", () => {
  it("snapshot 全量替换 + 水位=toSeq", () => {
    const { state, gap } = applySessionsIndexFrame(
      EMPTY_SESSIONS_INDEX_STATE,
      snapshotFrame([summary("a"), summary("b")], 5),
    );
    expect(gap).toBe(false);
    expect(state.seq).toBe(5);
    expect(state.workspaceId).toBe("ws-1");
    expect([...state.sessions.keys()].sort()).toEqual(["a", "b"]);
  });

  it("delta 衔接（fromSeq===水位）→ upsert/remove 应用", () => {
    const seeded = applySessionsIndexFrame(
      EMPTY_SESSIONS_INDEX_STATE,
      snapshotFrame([summary("a")], 5),
    ).state;
    const { state, gap } = applySessionsIndexFrame(
      seeded,
      deltaFrame(
        [
          { op: "session.upserted", session: summary("b", { title: "B" }) },
          { op: "session.removed", sessionId: "a" },
        ],
        5,
        7,
      ),
    );
    expect(gap).toBe(false);
    expect(state.seq).toBe(7);
    expect([...state.sessions.keys()]).toEqual(["b"]);
    expect(state.sessions.get("b")?.title).toBe("B");
  });

  it("delta 断档（fromSeq !== 水位）→ gap=true，状态不变", () => {
    const seeded = applySessionsIndexFrame(
      EMPTY_SESSIONS_INDEX_STATE,
      snapshotFrame([summary("a")], 5),
    ).state;
    const { state, gap } = applySessionsIndexFrame(
      seeded,
      deltaFrame([{ op: "session.removed", sessionId: "a" }], 6, 7),
    );
    expect(gap).toBe(true);
    expect(state).toBe(seeded);
  });

  it("late duplicate toSeq<=watermark 静默丢弃，不判 gap", () => {
    const seeded = applySessionsIndexFrame(
      EMPTY_SESSIONS_INDEX_STATE,
      snapshotFrame([summary("a")], 5),
    ).state;
    const { state, gap } = applySessionsIndexFrame(
      seeded,
      deltaFrame([{ op: "session.removed", sessionId: "a" }], 0, 5),
    );
    expect(gap).toBe(false);
    expect(state).toBe(seeded);
  });
});

describe("SessionsIndexStore", () => {
  it("applyFrame 通知 listener；getSessions 按 lastActivityAt 降序 + 稳定引用", () => {
    const store = new SessionsIndexStore();
    let notified = 0;
    const unsub = store.subscribe(() => (notified += 1));

    const gap = store.applyFrame(
      snapshotFrame(
        [summary("old", { lastActivityAt: 10 }), summary("new", { lastActivityAt: 20 })],
        3,
      ),
    );
    expect(gap).toBe(false);
    expect(notified).toBe(1);
    const list1 = store.getSessions();
    expect(list1.map((s) => s.sessionId)).toEqual(["new", "old"]);
    // 稳定引用（未变则同一数组）
    expect(store.getSessions()).toBe(list1);

    unsub();
  });

  it("断档帧 → applyFrame 返回 true，状态不动", () => {
    const store = new SessionsIndexStore();
    store.applyFrame(snapshotFrame([summary("a")], 5));
    const before = store.getState();
    const gap = store.applyFrame(deltaFrame([{ op: "session.removed", sessionId: "a" }], 99, 100));
    expect(gap).toBe(true);
    expect(store.getState()).toBe(before);
  });

  function mockTransport(
    overrides: Partial<SessionsIndexTransport> = {},
    options: { runtimeLifecycle?: boolean } = {},
  ) {
    let frameListener:
      | ((
          frame: SessionsIndexTopicFrame,
          context?: { deliveryKind: TopicFrameDeliveryKind },
        ) => void)
      | null = null;
    let faultListener:
      | ((fault: {
          topic: string;
          subscriptionId: string;
          reasonCode?: string;
          deliveryKind?: TopicFrameDeliveryKind;
        }) => void)
      | null = null;
    let restartListener: (() => void) | null = null;
    let lifecycleListener: ((state: "available" | "unavailable") => void) | null = null;
    const transport: SessionsIndexTransport = {
      subscribe: vi.fn(async () => ({
        ack: {
          subscriptionId: "sub-1",
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      })),
      unsubscribe: vi.fn(async () => {}),
      resync: vi.fn(async (params) => ({
        ack: {
          subscriptionId: params.subscriptionId,
          mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
          logEpoch: "epoch-1",
        },
      })),
      activate: vi.fn(() =>
        frameListener?.(snapshotFrame([summary("a")], 2), { deliveryKind: "initial" }),
      ),
      onFrame: vi.fn(
        (
          listener: (
            frame: SessionsIndexTopicFrame,
            context?: { deliveryKind: TopicFrameDeliveryKind },
          ) => void,
        ) => {
          frameListener = listener;
          return () => {
            frameListener = null;
          };
        },
      ),
      onAssemblyFault: vi.fn((listener) => {
        faultListener = listener;
        return () => {
          faultListener = null;
        };
      }),
      onRuntimeRestart: vi.fn((listener) => {
        restartListener = listener;
        return () => {
          restartListener = null;
        };
      }),
      ...(options.runtimeLifecycle
        ? {
            onRuntimeLifecycle: vi.fn((listener) => {
              lifecycleListener = listener;
              return () => {
                lifecycleListener = null;
              };
            }),
          }
        : {}),
      ...overrides,
    };
    return {
      transport,
      pushFrame: (frame: SessionsIndexTopicFrame) =>
        frameListener?.(frame, { deliveryKind: "online" }),
      pushRecoveryFrame: (frame: SessionsIndexTopicFrame) =>
        frameListener?.(frame, { deliveryKind: "recovery" }),
      pushFault: (deliveryKind: TopicFrameDeliveryKind = "online", reasonCode?: string) =>
        faultListener?.({
          topic: "sessions-index/ws-1",
          subscriptionId: "sub-1",
          deliveryKind,
          ...(reasonCode === undefined ? {} : { reasonCode }),
        }),
      restart: () => restartListener?.(),
      runtimeLifecycle: (state: "available" | "unavailable") => lifecycleListener?.(state),
    };
  }

  it("connect：ACK 后 activate 释放 initial notification，status→live", async () => {
    const store = new SessionsIndexStore();
    const { transport, pushFrame } = mockTransport();
    await store.connect(transport, { forceSnapshot: true });
    expect(store.getStatus()).toBe("live");
    expect([...store.getState().sessions.keys()]).toEqual(["a"]);
    expect(transport.activate).toHaveBeenCalledWith("sub-1");
    // 后续增量帧经 onFrame 进入
    pushFrame(deltaFrame([{ op: "session.upserted", session: summary("b") }], 2, 3));
    expect([...store.getState().sessions.keys()].sort()).toEqual(["a", "b"]);
  });

  it("断档 burst → same-sub single-flight resync；recovery gap 升级 force snapshot", async () => {
    const store = new SessionsIndexStore();
    const { transport, pushFrame, pushRecoveryFrame } = mockTransport();
    await store.connect(transport, { forceSnapshot: true });
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    // 三个普通 burst gap 只触发一次 same-sub resync。
    pushFrame(deltaFrame([{ op: "session.removed", sessionId: "a" }], 99, 100));
    pushFrame(deltaFrame([], 100, 101));
    pushFrame(deltaFrame([], 101, 102));
    await vi.waitFor(() => {
      expect(transport.resync).toHaveBeenCalledTimes(1);
    });
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport.resync).mock.calls[0]?.[0]).toEqual({
      subscriptionId: "sub-1",
      base: { logEpoch: "epoch-1", seq: 2 },
    });
    pushRecoveryFrame(deltaFrame([], 103, 104));
    await vi.waitFor(() => expect(transport.resync).toHaveBeenCalledTimes(2));
    expect(vi.mocked(transport.resync).mock.calls[1]?.[0]).toMatchObject({
      subscriptionId: "sub-1",
      forceSnapshot: true,
    });
  });

  it("recovery apply 后同 read residual online gap 在 ACK 后启动普通 successor", async () => {
    const store = new SessionsIndexStore();
    let pushFrame!: (frame: SessionsIndexTopicFrame) => void;
    let pushRecoveryFrame!: (frame: SessionsIndexTopicFrame) => void;
    let attempt = 0;
    const kit = mockTransport({
      resync: vi.fn(async (params) => {
        attempt += 1;
        if (attempt === 1) {
          pushRecoveryFrame(deltaFrame([], 2, 3));
          pushFrame(deltaFrame([], 8, 9));
        } else {
          pushRecoveryFrame(deltaFrame([], 3, 3));
        }
        return {
          ack: {
            subscriptionId: params.subscriptionId,
            mode: "resume" as const,
            logEpoch: "epoch-1",
          },
        };
      }),
    });
    pushFrame = kit.pushFrame;
    pushRecoveryFrame = kit.pushRecoveryFrame;
    await store.connect(kit.transport, { forceSnapshot: true });
    pushFrame(deltaFrame([], 99, 100));

    await vi.waitFor(() => expect(kit.transport.resync).toHaveBeenCalledTimes(2));
    expect(vi.mocked(kit.transport.resync).mock.calls[1]?.[0]).toEqual({
      subscriptionId: "sub-1",
      base: { logEpoch: "epoch-1", seq: 3 },
    });
    expect(store.getState().seq).toBe(3);
    store.close();
  });

  it("无 applied base 时 online delta 不建 baseline，online snapshot 可建立", async () => {
    const store = new SessionsIndexStore();
    const kit = mockTransport({ activate: vi.fn() });
    await store.connect(kit.transport, { forceSnapshot: true });
    kit.pushFrame(deltaFrame([{ op: "session.upserted", session: summary("bad") }], 0, 1));
    expect(store.getState().sessions.size).toBe(0);
    expect(vi.mocked(kit.transport.resync).mock.calls[0]?.[0]).toEqual({
      subscriptionId: "sub-1",
      base: null,
      forceSnapshot: true,
    });
    kit.pushFrame(snapshotFrame([summary("good")], 1));
    kit.pushRecoveryFrame(deltaFrame([], 0, 1));
    await Promise.resolve();
    expect([...store.getState().sessions.keys()]).toEqual(["good"]);
    store.close();
  });

  it("resync ACK 后零 recovery frame 在 deadline 升级一次并 fail closed", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      const kit = mockTransport();
      await store.connect(kit.transport, { forceSnapshot: true });
      kit.pushFrame(deltaFrame([], 99, 100));
      await Promise.resolve();
      await Promise.resolve();
      expect(kit.transport.resync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      expect(kit.transport.resync).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      expect(store.getStatus()).toBe("error");
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 确定性内容 fault（04-sync 封闭规则 11）──────────────────────────────────────────
  // 瞬态阶梯对 schema 拒收是错的：resume 只会重投同一批读不懂的内容，而本 store 的 fail closed
  // 会清空投影并有界退避重订阅——对确定性失败那就是一个永不收敛的循环。2026-09-21
  // （sess_4142de31）实测：一张工具卡多带两个键，桌面会话就此打不开。

  it("内容 fault 直接强制 snapshot，不先试必然失败的 resume", async () => {
    const store = new SessionsIndexStore();
    const kit = mockTransport();
    await store.connect(kit.transport, { forceSnapshot: true });
    kit.pushFault("online", WIRE_FAULT_INVALID_PAYLOAD);
    await vi.waitFor(() => expect(kit.transport.resync).toHaveBeenCalledTimes(1));
    // 对照组见「断档 burst → same-sub single-flight resync」：瞬态 fault 的首次 resync 不带
    // forceSnapshot（先试 resume）。内容 fault 跳过那一档。
    expect(vi.mocked(kit.transport.resync).mock.calls[0]?.[0]).toMatchObject({
      subscriptionId: "sub-1",
      forceSnapshot: true,
    });
    store.close();
  });

  it("强制 snapshot 再次被内容拒绝 → contentRejected 终态，且不排退避重订阅", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const store = new SessionsIndexStore();
      const kit = mockTransport();
      await store.connect(kit.transport, { forceSnapshot: true });
      expect(store.getState().sessions.size).toBe(1);

      kit.pushFault("online", WIRE_FAULT_INVALID_PAYLOAD);
      await vi.advanceTimersByTimeAsync(0);
      expect(kit.transport.resync).toHaveBeenCalledTimes(1);

      // 强制 snapshot 的那一帧同样读不懂：没有更强的手段了。
      kit.pushFault("recovery", WIRE_FAULT_INVALID_PAYLOAD);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getStatus()).toBe("error");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(SUBSCRIPTION_CONTENT_REJECTED));

      // 关键回归：退避重订阅不再排。修复前这里会每 5s/15s 清空投影再订阅一次，永不收敛。
      await vi.advanceTimersByTimeAsync(60_000);
      expect(kit.transport.subscribe).toHaveBeenCalledTimes(1);
      expect(kit.transport.resync).toHaveBeenCalledTimes(1);
      store.close();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("内容 fault 后强制 snapshot 若读得懂，照常收口回 live（不是一击即死）", async () => {
    const store = new SessionsIndexStore();
    const kit = mockTransport();
    await store.connect(kit.transport, { forceSnapshot: true });
    kit.pushFault("online", WIRE_FAULT_INVALID_PAYLOAD);
    await vi.waitFor(() => expect(kit.transport.resync).toHaveBeenCalledTimes(1));
    // 快照是新生成的，内容可能已经不含那一行——这条路必须留着。
    kit.pushRecoveryFrame(snapshotFrame([summary("b")], 9));
    await vi.waitFor(() => expect(store.getStatus()).toBe("live"));
    expect([...store.getState().sessions.keys()]).toEqual(["b"]);
    store.close();
  });

  it("内容 flight 上的 deadline 超时仍报 timeout 终态，并保留退避重订阅", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const store = new SessionsIndexStore();
      const kit = mockTransport();
      await store.connect(kit.transport, { forceSnapshot: true });
      kit.pushFault("online", WIRE_FAULT_INVALID_PAYLOAD);
      await vi.advanceTimersByTimeAsync(0);
      expect(kit.transport.resync).toHaveBeenCalledTimes(1);
      // 一个 recovery 帧都没回来：传输症状，重试仍有意义，不能被内容分类连带取消。
      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      expect(store.getStatus()).toBe("error");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("fault.subscription.recoveryFrameTimedOut"),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      expect(kit.transport.subscribe).toHaveBeenCalledTimes(2);
      store.close();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("瞬态 fault 不被内容分类吞掉：无 reasonCode 仍走原阶梯", async () => {
    const store = new SessionsIndexStore();
    const kit = mockTransport();
    await store.connect(kit.transport, { forceSnapshot: true });
    kit.pushFault("online");
    await vi.waitFor(() => expect(kit.transport.resync).toHaveBeenCalledTimes(1));
    expect(vi.mocked(kit.transport.resync).mock.calls[0]?.[0]).not.toMatchObject({
      forceSnapshot: true,
    });
    store.close();
  });

  it("recovery fail-closed 清空旧投影并在有界退避后 fresh subscribe", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      let subscribeSerial = 0;
      const kit = mockTransport({
        subscribe: vi.fn(async () => ({
          ack: {
            subscriptionId: `sub-${++subscribeSerial}`,
            mode: "snapshot" as const,
            logEpoch: "epoch-1",
          },
        })),
        resync: vi.fn(async (params) => ({
          ack: {
            subscriptionId: params.subscriptionId,
            mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
            logEpoch: "epoch-1",
          },
        })),
      });

      await store.connect(kit.transport, { forceSnapshot: true });
      kit.pushFrame({
        ...snapshotFrame([summary("a", { phase: "running" })], 3),
        subscriptionId: "sub-1",
      });
      expect(store.getState().sessions.get("a")?.phase).toBe("running");

      // 两次 recovery deadline：先由 resume 升级 snapshot，再由 snapshot 超时进入
      // fail-closed。修复前这里会保留 running 投影且永远不再 subscribe。
      kit.pushFrame({
        ...deltaFrame([], 99, 100),
        subscriptionId: "sub-1",
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);

      expect(store.getStatus()).toBe("error");
      expect(store.getState().sessions.size).toBe(0);
      expect(kit.transport.unsubscribe).toHaveBeenCalledWith("sub-1");

      await vi.advanceTimersByTimeAsync(4_999);
      expect(kit.transport.subscribe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(kit.transport.subscribe).toHaveBeenCalledTimes(2);
      expect(store.getStatus()).toBe("live");

      // fresh subscribe 的新代际必须能重新建立权威 snapshot。
      kit.pushFrame({
        ...snapshotFrame([summary("a", { phase: "completedSuccess" })], 4),
        subscriptionId: "sub-2",
      });
      expect(store.getState().sessions.get("a")?.phase).toBe("completedSuccess");
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("connect 非瞬态失败清空旧投影并按 5s/15s 退避重试", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      store.applyFrame(snapshotFrame([summary("a", { phase: "running" })], 3));
      let subscribeAttempts = 0;
      const kit = mockTransport({
        subscribe: vi.fn(async () => {
          subscribeAttempts += 1;
          if (subscribeAttempts < 3) throw new Error("bridge disconnected");
          return {
            ack: {
              subscriptionId: "sub-1",
              mode: "snapshot" as const,
              logEpoch: "epoch-1",
            },
          };
        }),
      });

      await store.connect(kit.transport, { forceSnapshot: true });
      expect(store.getStatus()).toBe("error");
      expect(store.getState().sessions.size).toBe(0);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(subscribeAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(subscribeAttempts).toBe(2);
      expect(store.getStatus()).toBe("error");

      await vi.advanceTimersByTimeAsync(14_999);
      expect(subscribeAttempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(subscribeAttempts).toBe(3);
      expect(store.getStatus()).toBe("live");
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resync notOwned → 自动 fresh subscribe 自愈，不落 error", async () => {
    const store = new SessionsIndexStore();
    let sub = 0;
    const kit = mockTransport({
      subscribe: vi.fn(async () => ({
        ack: {
          subscriptionId: `sub-${++sub}`,
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      })),
      activate: vi.fn(),
      resync: vi.fn(async () => {
        throw new Error("fault.subscription.notOwned");
      }),
    });
    await store.connect(kit.transport, { forceSnapshot: true });
    expect(store.getStatus()).toBe("live");
    // 无 applied base 的 online delta → same-sub resync → notOwned（host 侧 ownership
    // 已被错位 unsubscribe/换代驱逐）。修复后自动 fresh subscribe 自愈，而不是落 error。
    kit.pushFrame(deltaFrame([], 99, 100));
    await vi.waitFor(() => expect(kit.transport.subscribe).toHaveBeenCalledTimes(2));
    expect(store.getStatus()).toBe("live");
    store.close();
  });

  it("换代 subscribe ACK 丢弃 await 窗口内创建的旧 recovery；迟到 resync 失败不污染新订阅", async () => {
    const store = new SessionsIndexStore();
    let sub = 0;
    const subscribeGates: Array<() => void> = [];
    let rejectResync!: (error: Error) => void;
    const kit = mockTransport({
      subscribe: vi.fn(async () => {
        // 第二次 subscribe（换代）被挂起，制造 ACK 前的 await 窗口。
        if (sub >= 1) await new Promise<void>((release) => subscribeGates.push(release));
        return {
          ack: {
            subscriptionId: `sub-${++sub}`,
            mode: "snapshot" as const,
            logEpoch: "epoch-1",
          },
        };
      }),
      activate: vi.fn(),
      resync: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectResync = reject;
          }),
      ),
    });
    await store.connect(kit.transport, { forceSnapshot: true });
    const reconnect = store.connect(kit.transport, { forceSnapshot: true });
    // await 窗口内旧订阅断档 → resync(S1) 在途。
    kit.pushFrame(deltaFrame([], 99, 100));
    await vi.waitFor(() => expect(kit.transport.resync).toHaveBeenCalledTimes(1));
    // S2 ACK 抵达：换代成功必须丢弃 S1 的 recovery。
    subscribeGates.shift()?.();
    await reconnect;
    expect(store.getStatus()).toBe("live");
    // 迟到的 resync(S1) 失败必须被静默忽略——不打 error，也不触发多余重订阅。
    rejectResync(new Error("fault.subscription.notOwned"));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getStatus()).toBe("live");
    expect(kit.transport.subscribe).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("runtime restart 清旧代际并 fresh subscribe 一次", async () => {
    const store = new SessionsIndexStore();
    const { transport, restart } = mockTransport();
    await store.connect(transport, { forceSnapshot: true });
    restart();
    await vi.waitFor(() => expect(transport.subscribe).toHaveBeenCalledTimes(2));
    expect(vi.mocked(transport.subscribe).mock.calls[1]?.[0]).toEqual({});
  });

  it("runtime restart burst 合并并指数退避，只执行一次 fresh subscribe", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      const { transport, restart } = mockTransport();
      await store.connect(transport, { forceSnapshot: true });

      restart();
      restart();
      restart();
      await vi.advanceTimersByTimeAsync(199);
      expect(transport.subscribe).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(transport.subscribe).toHaveBeenCalledTimes(2);
      expect(vi.mocked(transport.subscribe).mock.calls[1]?.[0]).toEqual({});
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runtime 缺失进入 dormant，不轮询；available 自动恢复，unavailable 清空 live 投影", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      store.applyFrame(snapshotFrame([summary("stale", { phase: "running" })], 1));
      let attempts = 0;
      const kit = mockTransport(
        {
          subscribe: vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) {
              throw Object.assign(new Error("agent runtime is unavailable"), {
                code: "ZCODE_AGENT_RUNTIME_UNAVAILABLE",
              });
            }
            return {
              ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
            };
          }),
        },
        { runtimeLifecycle: true },
      );

      await store.connect(kit.transport, { forceSnapshot: true });
      expect(store.getStatus()).toBe("dormant");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(kit.transport.subscribe).toHaveBeenCalledTimes(1);

      kit.runtimeLifecycle("available");
      await vi.advanceTimersByTimeAsync(0);
      expect(kit.transport.subscribe).toHaveBeenCalledTimes(2);
      expect(store.getStatus()).toBe("live");
      expect([...store.getState().sessions.keys()]).toEqual(["a"]);

      kit.runtimeLifecycle("unavailable");
      expect(store.getStatus()).toBe("dormant");
      expect(store.getState()).toBe(EMPTY_SESSIONS_INDEX_STATE);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(kit.transport.subscribe).toHaveBeenCalledTimes(2);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resync ACK subscriptionId 不匹配时 fail closed", async () => {
    const store = new SessionsIndexStore();
    const { transport, pushFrame } = mockTransport({
      resync: vi.fn(async () => ({
        ack: { subscriptionId: "foreign-sub", mode: "resume", logEpoch: "epoch-1" },
      })),
    });
    await store.connect(transport, { forceSnapshot: true });
    pushFrame(deltaFrame([], 99, 100));
    await vi.waitFor(() => expect(store.getStatus()).toBe("error"));
    expect(transport.resync).toHaveBeenCalledTimes(1);
  });

  it("initial staging overflow fresh retry 一次", async () => {
    const store = new SessionsIndexStore();
    let attempts = 0;
    const { transport } = mockTransport({
      subscribe: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("fault.subscription.initialFrameStagingOverflow");
        return {
          ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
        };
      }),
    });
    await store.connect(transport, { forceSnapshot: true });
    expect(transport.subscribe).toHaveBeenCalledTimes(2);
    expect(store.getStatus()).toBe("live");
  });

  it("配置锁导致首次 subscribe 瞬时失败时保持 hydrating 并自动恢复", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      let attempts = 0;
      const { transport } = mockTransport({
        subscribe: vi.fn(async () => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(
              new Error("EEXIST: file already exists, open '/tmp/config.json.lock'"),
              { code: "EEXIST" },
            );
          }
          return {
            ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
          };
        }),
      });

      await store.connect(transport, { forceSnapshot: true });
      expect(store.getStatus()).toBe("connecting");
      expect(store.getState().workspaceId).toBeNull();
      expect(transport.subscribe).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);

      expect(transport.subscribe).toHaveBeenCalledTimes(2);
      expect(store.getStatus()).toBe("live");
      expect([...store.getState().sessions.keys()]).toEqual(["a"]);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("配置锁超时错误码导致首次 subscribe 瞬时失败时自动恢复", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      let attempts = 0;
      const { transport } = mockTransport({
        subscribe: vi.fn(async () => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("lock timeout without a path"), {
              code: ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE,
            });
          }
          return {
            ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
          };
        }),
      });

      await store.connect(transport, { forceSnapshot: true });
      expect(store.getStatus()).toBe("connecting");
      await vi.advanceTimersByTimeAsync(250);

      expect(transport.subscribe).toHaveBeenCalledTimes(2);
      expect(store.getStatus()).toBe("live");
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("瞬时失败退避期间 close 会取消重订阅", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      const { transport } = mockTransport({
        subscribe: vi.fn(async () => {
          throw Object.assign(new Error("EBUSY: config.json.lock"), { code: "EBUSY" });
        }),
      });

      await store.connect(transport, { forceSnapshot: true });
      expect(store.getStatus()).toBe("connecting");

      store.close();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(transport.subscribe).toHaveBeenCalledTimes(1);
      expect(store.getStatus()).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("瞬时失败重试耗尽后进入 error，不会永久停在 hydrating", async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionsIndexStore();
      const { transport } = mockTransport({
        subscribe: vi.fn(async () => {
          throw Object.assign(new Error("EBUSY: config.json.lock"), { code: "EBUSY" });
        }),
      });

      await store.connect(transport, { forceSnapshot: true });
      await vi.advanceTimersByTimeAsync(250 + 1_000 + 3_000);

      expect(transport.subscribe).toHaveBeenCalledTimes(4);
      expect(store.getStatus()).toBe("error");
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("非配置锁 EEXIST 不按瞬时故障重试", async () => {
    const store = new SessionsIndexStore();
    const { transport } = mockTransport({
      subscribe: vi.fn(async () => {
        throw Object.assign(new Error("EEXIST: workspace path is a file"), { code: "EEXIST" });
      }),
    });

    await store.connect(transport, { forceSnapshot: true });

    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(store.getStatus()).toBe("error");
    store.close();
  });

  it("忽略其他订阅代际的帧（R-01：syncer 常驻订阅与侧栏共 topic，不得误判断档）", async () => {
    const store = new SessionsIndexStore();
    const { transport, pushFrame } = mockTransport();
    await store.connect(transport, { forceSnapshot: true });
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    // host 侧 task-index syncer 用独立 connectionId 订阅同一 workspace topic，
    // 其帧经 workspace 级 fan-out 也会到达本 store；subscriptionId 不同必须整帧忽略，
    // 不应用、不触发断档重订阅。
    pushFrame({
      ...deltaFrame([{ op: "session.removed", sessionId: "a" }], 99, 100),
      subscriptionId: "six-task-index-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(store.getState().sessions.has("a")).toBe(true);
  });

  it("close：退订 + 后续帧不再进入；再次 connect 可复活（StrictMode 双调）", async () => {
    const store = new SessionsIndexStore();
    const { transport, pushFrame } = mockTransport();
    await store.connect(transport, { forceSnapshot: true });
    store.close();
    expect(transport.unsubscribe).toHaveBeenCalledWith("sub-1");
    pushFrame(deltaFrame([{ op: "session.upserted", session: summary("b") }], 2, 3));
    expect(store.getState().sessions.has("b")).toBe(false);
    // 复活
    await store.connect(transport, { forceSnapshot: true });
    expect(store.getStatus()).toBe("live");
  });

  it("close：旧 service proxy 退订失败被消费并记录，不产生 unhandled rejection", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const store = new SessionsIndexStore();
    const { transport } = mockTransport({
      unsubscribe: vi.fn(async () => {
        throw new Error("old proxy disconnected");
      }),
    });
    await store.connect(transport, { forceSnapshot: true });

    store.close();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsubscribe sub-1 失败（忽略）")),
    );
    expect(store.getStatus()).toBe("idle");
    warn.mockRestore();
  });
});
