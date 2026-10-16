// CUA Helper 冷启动就绪会回收 agent runtime，已打开的对话面板必须自愈。
//
// 线上/dev 复现时序（2026-08-22 dev 日志）：
//   17:26:41.5  用户点开已有对话 → subscribeConversationV4 在途（agent 仍在 warmup）
//   17:26:44.395 [cua-product-helper] cua helper ready
//                → reconcileRecoveredHelper → recycleUntilStable → disposeWorkspace
//   17:26:44.719 在途 subscribe 被 transport.onClose 的 rejectAll 打断：
//                Error: ZCode agent transport closed
//   17:26:44.96  ZCode agent process exited terminationReason='workspace-dispose'
//
// 修复前 store 的两处缺陷让面板永久卡死（SessionPane 的 errored 分支整块替换成红字+重连按钮）：
//   1. constructor 无条件只订阅 onRuntimeRestart。但 transport.ts 已写明：dispose 当场只有
//      onRuntimeLifecycle 的 unavailable 可观测，onRuntimeRestart 要等新进程 spawn 才发；
//      agent 是懒启动，用户只看历史不发消息则永不 spawn，换代信号永不到达。
//   2. connect() 的 catch 除 initialFrameStagingOverflow 外一律定格 status="error"，
//      没有 sessionsIndexStore 那样的有界退避。
//
// 自愈成立的前提（zcodeAgentService.ts:5581）：subscribeConversationV4 走
// getReadOnlyClient(params) 默认 start-if-needed，重订阅本身会把 agent 拉起来——这与侧栏
// subscribeSessionsIndexV4 显式用 existing-only + dormant 的策略差异是故意设计的。
import { Emitter } from "@zcode/rpc";
import type { ConversationTopicWireFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
  type IZCodeAgentService,
} from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { ReplaceableConversationTransport } from "@/v4/replaceableConversationTransport.js";

const TOPIC = "conversation/s1";
const WORKSPACE_PATH = "/repo";

type LifecycleEvent = {
  workspaceKey: string;
  workspacePath: string;
  runtimeIdentity: { generation: number; identity: string; workspaceKey: string };
  state: "available" | "unavailable";
};

/** connectionScope 的 unavailable 分支要读 runtimeIdentity.generation 来失效本地 owner。 */
function lifecycleEvent(state: "available" | "unavailable", generation: number): LifecycleEvent {
  return {
    workspaceKey: WORKSPACE_PATH,
    workspacePath: WORKSPACE_PATH,
    runtimeIdentity: {
      generation,
      identity: `runtime-${generation}`,
      workspaceKey: WORKSPACE_PATH,
    },
    state,
  };
}

/** workspace-dispose 打断在途 subscribe 时，ZCodeProtocolClient.rejectAll 抛出的真实文案。 */
const TRANSPORT_CLOSED = "ZCode agent transport closed";

/** 与实现的 RUNTIME_RECYCLE_RETRY_DELAYS_MS 长度一致（250/1000/3000ms）。 */
const RUNTIME_RECYCLE_RETRY_ATTEMPTS = 3;

function setupBase(options: { withLifecycle?: boolean } = {}) {
  const conversationFrames = new Emitter<ConversationTopicWireFrame>();
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  const runtimeLifecycle = new Emitter<LifecycleEvent>();
  const nextSerialByConnection = new Map<string, number>();
  const nextId = (params: unknown) => {
    const connection = readTrustedZCodeAgentV4Connection(params);
    if (!connection) throw new Error("missing trusted connection");
    const serial = (nextSerialByConnection.get(connection.connectionId) ?? 0) + 1;
    nextSerialByConnection.set(connection.connectionId, serial);
    return `sub-${connection.connectionId}-${serial}`;
  };
  /** 每次 subscribe 依次消费一个错误；用尽后正常 ACK。 */
  const pendingFailures: Error[] = [];
  const mocks = {
    helloConversationV4: vi.fn(),
    initializeConversationV4: vi.fn(),
    subscribeConversationV4: vi.fn(async (params: unknown) => {
      const failure = pendingFailures.shift();
      if (failure) throw failure;
      return {
        ack: {
          subscriptionId: nextId(params),
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      };
    }),
    unsubscribeConversationV4: vi.fn(async () => {}),
    resyncConversationV4: vi.fn(async (params: { subscriptionId: string }) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: "resume" as const,
        logEpoch: "epoch-1",
      },
    })),
    sendConversationCommandV4: vi.fn(async (params: { envelope: { commandId: string } }) => ({
      commandId: params.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
    })),
    onDynamicConversationFrame: vi.fn(() => conversationFrames.event),
    onAgentRuntimeRestarted: vi.fn((listener: (event: { workspaceKey: string }) => void) =>
      runtimeRestarts.event(listener),
    ),
    setConnectionFlowStateV4: vi.fn(async () => {}),
    ...(options.withLifecycle
      ? {
          onAgentRuntimeLifecycle: vi.fn((listener: (event: LifecycleEvent) => void) =>
            runtimeLifecycle.event(listener),
          ),
        }
      : {}),
  };
  return {
    base: mocks as unknown as IZCodeAgentService,
    mocks,
    runtimeLifecycle,
    runtimeRestarts,
    pendingFailures,
  };
}

function createStore(
  base: IZCodeAgentService,
  connectionId: string,
  clientMode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous",
) {
  const scope = createZCodeAgentConnectionScope(base, {
    connectionId,
    clientMode,
  });
  const transport = createAgentConversationTransport(scope.service, {
    workspacePath: WORKSPACE_PATH,
  });
  return { transport, store: new ConversationProjectionStore(TOPIC, transport) };
}

describe("conversation projection 在 CUA Helper 回收 agent runtime 后自愈", () => {
  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "%s 冷订阅期间收到 restart，过期 ACK 后自动重新订阅",
    async (clientMode) => {
      vi.useFakeTimers();
      try {
        const { base, mocks, runtimeLifecycle, runtimeRestarts } = setupBase({
          withLifecycle: true,
        });
        const { store } = createStore(base, "cold-restart", clientMode);
        mocks.subscribeConversationV4.mockImplementationOnce(async () => {
          runtimeRestarts.fire({ workspaceKey: WORKSPACE_PATH });
          runtimeLifecycle.fire(lifecycleEvent("available", 2));
          return { ack: { subscriptionId: "stale", mode: "snapshot", logEpoch: "epoch-1" } };
        });
        await store.connect();
        expect(store.getState().status).toBe("connecting");
        await vi.advanceTimersByTimeAsync(250);
        expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
        expect(store.getState().status).toBe("live");
        expect(store.getState().lastError).toBeNull();
        expect(mocks.unsubscribeConversationV4).not.toHaveBeenCalledWith(
          expect.objectContaining({ subscriptionId: "stale" }),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("runtime available 到达时重新订阅（transport 暴露 lifecycle 时不能只依赖 onRuntimeRestart）", async () => {
    const { base, mocks, runtimeLifecycle } = setupBase({ withLifecycle: true });
    const { transport, store } = createStore(base, "conn-lifecycle");
    expect(transport.onRuntimeLifecycle).toBeTypeOf("function");

    await store.connect();
    expect(store.getState().status).toBe("live");
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    // workspace-dispose 当场：唯一可观测信号。此时新 runtime 尚不存在，不可重订阅。
    runtimeLifecycle.fire(lifecycleEvent("unavailable", 2));
    await Promise.resolve();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    // 新 runtime 就绪：必须自动重订阅，否则面板永久停在旧订阅/错误态。
    runtimeLifecycle.fire(lifecycleEvent("available", 2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("live");
  });

  it("首次 subscribe 在途时 runtime available 不应再开第二条订阅", async () => {
    const { base, mocks, runtimeLifecycle } = setupBase({ withLifecycle: true });
    let resolveSubscribe:
      | ((value: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }) => void)
      | null = null;
    mocks.subscribeConversationV4.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve;
        }),
    );
    const { store } = createStore(base, "conn-initial-available");

    const connectPromise = store.connect();
    await vi.waitFor(() => expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1));

    // 冷启动时 agent spawn 会先广播 available；首次 subscribe 已在途时，
    // 该通知不应把同一个 pane 再推进一轮 connect，避免旧 ACK 立刻被退订。
    runtimeLifecycle.fire(lifecycleEvent("available", 1));
    await Promise.resolve();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    resolveSubscribe?.({
      ack: { subscriptionId: "sub-initial-available", mode: "snapshot", logEpoch: "epoch-1" },
    });
    await connectPromise;
    expect(store.getState().status).toBe("live");
    expect(store.getState().subscriptionId).toBe("sub-initial-available");
  });

  it("live 订阅被回收且 available 永不到达时，退避重连自行拉起 runtime", async () => {
    vi.useFakeTimers();
    try {
      const { base, mocks, runtimeLifecycle } = setupBase({ withLifecycle: true });
      const { store } = createStore(base, "conn-dormant");

      await store.connect();
      expect(store.getState().status).toBe("live");

      // 只发 unavailable，不发 available——正是懒启动下的真实情形：dispose 后无人拉起
      // agent，onRuntimeRestart/available 都永不到达。若此处仅 dormant，面板会永久转圈。
      runtimeLifecycle.fire(lifecycleEvent("unavailable", 2));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

      // 重订阅走 start-if-needed，自身会把 runtime 拉起来。
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
      expect(store.getState().status).toBe("live");
    } finally {
      vi.useRealTimers();
    }
  });

  // 回归保护（非 TDD 驱动，实现时已正确）：退避必须有界，耗尽后把失败暴露成 error，
  // SessionPane 的 errored 分支才会渲染「重新连接」按钮。
  it("退避耗尽后落 error 暴露「重新连接」入口", async () => {
    vi.useFakeTimers();
    try {
      const { base, mocks, runtimeLifecycle, pendingFailures } = setupBase({
        withLifecycle: true,
      });
      const { store } = createStore(base, "conn-exhausted");

      await store.connect();
      expect(store.getState().status).toBe("live");

      for (let i = 0; i < 8; i += 1) pendingFailures.push(new Error(TRANSPORT_CLOSED));
      runtimeLifecycle.fire(lifecycleEvent("unavailable", 2));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(store.getState().status).toBe("error");
      expect(store.getState().lastError).toContain(TRANSPORT_CLOSED);
      expect(mocks.subscribeConversationV4.mock.calls.length).toBeLessThanOrEqual(
        1 + RUNTIME_RECYCLE_RETRY_ATTEMPTS,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runtime 反复回收（连续 unavailable）耗尽退避后落 error，不静默停在 connecting", async () => {
    vi.useFakeTimers();
    try {
      const { base, runtimeLifecycle } = setupBase({ withLifecycle: true });
      const { store } = createStore(base, "conn-flapping");

      await store.connect();
      expect(store.getState().status).toBe("live");

      // Helper 反复崩溃/liveness 反复判死时，unavailable 会连续到达而中间没有 available，
      // 每一次都消耗一格退避额度。额度用尽的那次若只清状态不落 error，面板永久转圈。
      for (let i = 0; i < RUNTIME_RECYCLE_RETRY_ATTEMPTS + 1; i += 1) {
        runtimeLifecycle.fire(lifecycleEvent("unavailable", i + 2));
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(store.getState().status).toBe("error");
      expect(store.getState().lastError).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // CR-01 回归：远程 workspace 的 proxy 换代只走 onRuntimeRestart("transportReplaced")，
  // ReplaceableConversationTransport.replace() 不发任何 lifecycle 事件。若 store 在
  // lifecycle 模式下完全放弃 restart 通道，这条通知无人接收——replace() 已 best-effort
  // 退订旧 proxy 上的订阅，store 却停在 live + 旧 subscriptionId，帧流静默中断且不自愈。
  it("lifecycle 模式下仍接收 proxy 换代（transportReplaced），携原水位重订阅", async () => {
    const { base, mocks } = setupBase({ withLifecycle: true });
    const scope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-proxy-1",
      clientMode: "desktop-continuous",
    });
    const replaceable = new ReplaceableConversationTransport(
      createAgentConversationTransport(scope.service, { workspacePath: WORKSPACE_PATH }),
    );
    // 远程 registry 的真实形态：底层支持 lifecycle，故 Replaceable 也暴露它。
    expect(replaceable.onRuntimeLifecycle).toBeTypeOf("function");
    const store = new ConversationProjectionStore(TOPIC, replaceable);

    await store.connect();
    expect(store.getState().status).toBe("live");
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    // activateRemoteService() → replace()：新 proxy 接管，旧订阅已被退订。
    const nextScope = createZCodeAgentConnectionScope(base, {
      connectionId: "conn-proxy-2",
      clientMode: "desktop-continuous",
    });
    replaceable.replace(
      createAgentConversationTransport(nextScope.service, { workspacePath: WORKSPACE_PATH }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("live");
  });

  // CR-01 的对偶约束：加回 restart 通道后不能让同一次 runtime 换代被两条通道各处理一次
  // （会白建订阅、重复拉起 runtime）。判据是 reason——直连 transport 转发时传 "runtimeRestart"，
  // Replaceable 转发底层时传 undefined，两者都必须被过滤掉，只有 "transportReplaced" 放行。
  it("runtime 换代同时到达两条通道时只重订阅一次", async () => {
    const { base, mocks, runtimeLifecycle, runtimeRestarts } = setupBase({ withLifecycle: true });
    const { store } = createStore(base, "conn-no-double");

    await store.connect();
    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

    // 真实的 runtime 换代：available 与 onAgentRuntimeRestarted 同刻到达。
    runtimeRestarts.fire({ workspaceKey: WORKSPACE_PATH });
    runtimeLifecycle.fire(lifecycleEvent("available", 2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe("live");
  });

  it("在途 subscribe 被 workspace-dispose 打断后有界退避重连，不定格 error", async () => {
    vi.useFakeTimers();
    try {
      const { base, mocks, pendingFailures } = setupBase();
      pendingFailures.push(new Error(TRANSPORT_CLOSED));
      const { store } = createStore(base, "conn-retry");

      await store.connect();
      // 修复前：这里已是 status="error" + lastError="ZCode agent transport closed"，
      // 且没有任何 timer——面板从此只能靠用户点「重新连接」。
      expect(store.getState().status).not.toBe("error");
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(1);

      // 退避窗口内自动重订阅并恢复 live。
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.subscribeConversationV4).toHaveBeenCalledTimes(2);
      expect(store.getState().status).toBe("live");
      expect(store.getState().lastError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
