import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type {
  SessionSummary,
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  acquireSessionsIndex,
  buildSessionsIndexEntryKey,
  releaseSessionsIndex,
  sessionsIndexRegistrySize,
  type SessionsIndexAgentService,
} from "@/v4/sessionsIndexRegistry.js";
import { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import {
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";

function mockAgentService(): SessionsIndexAgentService {
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  return {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello" as const,
      protocolVersion: 3 as const,
      connectionId: "test-connection",
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
    subscribeSessionsIndexV4: vi.fn(async () => ({
      ack: {
        subscriptionId: "sub-1",
        mode: "snapshot" as const,
        logEpoch: "e1",
      },
    })),
    unsubscribeSessionsIndexV4: vi.fn(async () => {}),
    resyncSessionsIndexV4: vi.fn(async (params) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: "snapshot" as const,
        logEpoch: "e1",
      },
    })),
    onDynamicSessionsIndexFrame: vi.fn(() => () => ({ dispose: () => {} })),
    onAgentRuntimeRestarted: runtimeRestarts.event,
  } as unknown as SessionsIndexAgentService;
}

function createReplacingRemoteServices(
  workspaceKey: string,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  let nextSubscription = 1;
  let nextLogicalFrame = 1;
  let currentSeq = 1;
  let active: { serviceKey: string; subscriptionId: string } | null = null;
  const listenersByService = new Map<string, Set<(frame: SessionsIndexTopicWireFrame) => void>>();

  const physicalFrame = (
    frame: SessionsIndexTopicFrame,
    deliveryKind: "initial" | "online",
  ): SessionsIndexTopicWireFrame => ({
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `logical-${nextLogicalFrame}`,
    logicalFrameOrdinal: nextLogicalFrame++,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  });
  const snapshotFrame = (subscriptionId: string): SessionsIndexTopicFrame => ({
    topic: `sessions-index/${workspaceKey}`,
    subscriptionId,
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: workspaceKey,
        logEpoch: "epoch-1",
        sessions: [],
      },
    },
  });

  const createService = (serviceKey: string): SessionsIndexAgentService => {
    const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
    const listeners = new Set<(frame: SessionsIndexTopicWireFrame) => void>();
    listenersByService.set(serviceKey, listeners);
    return {
      helloConversationV4: vi.fn(async () => ({
        kind: "hello" as const,
        protocolVersion: 3 as const,
        connectionId: "shared-remote-connection",
        clientMode,
        deliveryProfile: clientMode === "desktop-continuous" ? "continuous" : "replayable",
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
      subscribeSessionsIndexV4: vi.fn(async () => {
        const subscriptionId = `sub-${nextSubscription++}`;
        // 真实 CLI 语义：同 connection/topic 的后订阅替换前订阅。
        active = { serviceKey, subscriptionId };
        const initial = physicalFrame(snapshotFrame(subscriptionId), "initial");
        for (const listener of listeners) listener(initial);
        return {
          ack: {
            subscriptionId,
            mode: "snapshot" as const,
            logEpoch: "epoch-1",
          },
        };
      }),
      unsubscribeSessionsIndexV4: vi.fn(async (params) => {
        if (active?.subscriptionId === params.subscriptionId) active = null;
      }),
      resyncSessionsIndexV4: vi.fn(async (params) => ({
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "snapshot" as const,
          logEpoch: "epoch-1",
        },
      })),
      onDynamicSessionsIndexFrame: vi.fn(
        () => (listener: (frame: SessionsIndexTopicWireFrame) => void) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      ),
      onAgentRuntimeRestarted: runtimeRestarts.event,
    } as unknown as SessionsIndexAgentService;
  };

  return {
    oldService: createService("old"),
    newService: createService("new"),
    emitUpsert(session: SessionSummary) {
      if (!active) return;
      const frame: SessionsIndexTopicFrame = {
        topic: `sessions-index/${workspaceKey}`,
        subscriptionId: active.subscriptionId,
        fromSeq: currentSeq,
        toSeq: currentSeq + 1,
        sentAt: 2,
        payload: {
          kind: "deltas",
          deltas: [{ op: "session.upserted", session }],
        },
      };
      for (const listener of listenersByService.get(active.serviceKey) ?? []) {
        listener(physicalFrame(frame, "online"));
      }
      currentSeq += 1;
    },
  };
}

describe("sessionsIndexRegistry", () => {
  it("引用计数：同 endpoint 同 workspaceKey 复用 store，归零才移除", async () => {
    const service = mockAgentService();
    const scope = { workspaceKey: "ws-1", workspacePath: "/ws" };

    const a = acquireSessionsIndex(scope, service);
    const b = acquireSessionsIndex(scope, service);
    // 同一 store 复用（一条订阅）
    expect(a).toBe(b);
    expect(sessionsIndexRegistrySize()).toBe(1);
    await vi.waitFor(() => expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));

    releaseSessionsIndex(scope, a);
    // 还有一个引用 → 不移除
    expect(sessionsIndexRegistrySize()).toBe(1);
    releaseSessionsIndex(scope, b);
    // 归零 → 移除
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it("不同 workspace 各自独立 store", async () => {
    const service = mockAgentService();
    const s1 = acquireSessionsIndex({ workspaceKey: "ws-a", workspacePath: "/a" }, service);
    const s2 = acquireSessionsIndex({ workspaceKey: "ws-b", workspacePath: "/b" }, service);
    expect(s1).not.toBe(s2);
    expect(sessionsIndexRegistrySize()).toBe(2);
    await vi.waitFor(() => expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2));
    releaseSessionsIndex({ workspaceKey: "ws-a" }, s1);
    releaseSessionsIndex({ workspaceKey: "ws-b" }, s2);
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it("M5 ③：同 workspaceKey 不同 endpoint 不共用 store，各走各的 agentService 订阅", async () => {
    const localService = mockAgentService();
    const remoteService = mockAgentService();
    const localScope = { workspaceKey: "ws-1", workspacePath: "/ws" };
    const remoteScope = {
      workspaceKey: "ws-1",
      workspacePath: "/ws",
      endpointKey: "remote-session-1",
    };

    const localStore = acquireSessionsIndex(localScope, localService);
    const remoteStore = acquireSessionsIndex(remoteScope, remoteService);
    expect(localStore).not.toBe(remoteStore);
    expect(sessionsIndexRegistrySize()).toBe(2);
    // 订阅落在各自 endpoint 的 agentService（remote 经 rpc proxy）
    await vi.waitFor(() => {
      expect(localService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(remoteService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    });

    // 同 endpoint 再次 acquire → 复用，不再发订阅
    const remoteStoreAgain = acquireSessionsIndex(remoteScope, remoteService);
    expect(remoteStoreAgain).toBe(remoteStore);
    expect(remoteService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);

    releaseSessionsIndex(localScope, localStore);
    releaseSessionsIndex(remoteScope, remoteStore);
    releaseSessionsIndex(remoteScope, remoteStoreAgain);
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "远程 agentService 换代时旧消费者继续从同一 store 收到后续任务（%s）",
    async (clientMode) => {
      const scope = {
        workspaceKey: "ssh:repo",
        workspacePath: "/repo",
        workspaceIdentity: "ssh:repo",
        endpointKey: "remote-1",
      };
      const { oldService, newService, emitUpsert } = createReplacingRemoteServices(
        scope.workspaceKey,
        clientMode,
      );

      const oldStore = acquireSessionsIndex(scope, oldService);
      await vi.waitFor(() => expect(oldStore.getState().workspaceId).toBe(scope.workspaceKey));
      const newStore = acquireSessionsIndex(scope, newService);
      await vi.waitFor(() => expect(newService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
      expect(
        vi.mocked(oldService.unsubscribeSessionsIndexV4).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(newService.subscribeSessionsIndexV4).mock.invocationCallOrder[0]!);

      // 旧 React consumer 的迟到 acquire 只能增加引用，不能把 transport 切回已退休 proxy。
      const staleOldStore = acquireSessionsIndex(scope, oldService);
      expect(staleOldStore).toBe(oldStore);
      expect(oldService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(newService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);

      emitUpsert({
        sessionId: "root-task",
        workspaceId: scope.workspaceKey,
        title: "root task",
        phase: "completedSuccess",
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: 2,
        createdAt: 1,
      });

      expect(newStore).toBe(oldStore);
      await vi.waitFor(() =>
        expect(oldStore.getSessions().map((session) => session.sessionId)).toEqual(["root-task"]),
      );
      expect(sessionsIndexRegistrySize()).toBe(1);

      // 新 consumer 先 cleanup 后，旧 consumer 仍持有同一有效订阅，不会退化成空的僵尸 store。
      releaseSessionsIndex(scope, newStore);
      expect(sessionsIndexRegistrySize()).toBe(1);
      expect(newService.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();
      emitUpsert({
        sessionId: "root-task-after-cleanup",
        workspaceId: scope.workspaceKey,
        title: "root task after cleanup",
        phase: "completedSuccess",
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: 3,
        createdAt: 1,
      });
      await vi.waitFor(() =>
        expect(oldStore.getSessions().map((session) => session.sessionId)).toEqual([
          "root-task-after-cleanup",
          "root-task",
        ]),
      );

      releaseSessionsIndex(scope, staleOldStore);
      releaseSessionsIndex(scope, oldStore);
      expect(sessionsIndexRegistrySize()).toBe(0);
    },
  );

  it("远程旧订阅一直未完成时，新 service 仍可立即接管 transport", async () => {
    const oldService = mockAgentService();
    const newService = mockAgentService();
    const scope = {
      workspaceKey: "ssh:repo",
      workspacePath: "/repo",
      workspaceIdentity: "ssh:repo",
      endpointKey: "remote-1",
    };
    vi.mocked(oldService.subscribeSessionsIndexV4).mockImplementation(() => new Promise(() => {}));

    const oldStore = acquireSessionsIndex(scope, oldService);
    const newStore = acquireSessionsIndex(scope, newService);

    try {
      expect(newStore).toBe(oldStore);
      await vi.waitFor(() => expect(newService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    } finally {
      releaseSessionsIndex(scope, newStore);
      releaseSessionsIndex(scope, oldStore);
    }
  });

  it("远程旧退订一直未完成时，新 service 仍可立即接管 transport", async () => {
    const oldService = mockAgentService();
    const newService = mockAgentService();
    const scope = {
      workspaceKey: "ssh:repo",
      workspacePath: "/repo",
      workspaceIdentity: "ssh:repo",
      endpointKey: "remote-1",
    };
    vi.mocked(oldService.unsubscribeSessionsIndexV4).mockImplementation(
      () => new Promise(() => {}),
    );

    const oldStore = acquireSessionsIndex(scope, oldService);
    await vi.waitFor(() => expect(oldService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    const newStore = acquireSessionsIndex(scope, newService);

    try {
      expect(newStore).toBe(oldStore);
      await vi.waitFor(() => expect(newService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    } finally {
      releaseSessionsIndex(scope, newStore);
      releaseSessionsIndex(scope, oldStore);
    }
  });

  it("远程中间代际订阅一直未完成时，更新 service 仍可立即接管 transport", async () => {
    const firstService = mockAgentService();
    const pendingMiddleService = mockAgentService();
    const latestService = mockAgentService();
    const scope = {
      workspaceKey: "ssh:repo",
      workspacePath: "/repo",
      workspaceIdentity: "ssh:repo",
      endpointKey: "remote-1",
    };
    vi.mocked(pendingMiddleService.subscribeSessionsIndexV4).mockImplementation(
      () => new Promise(() => {}),
    );

    const firstStore = acquireSessionsIndex(scope, firstService);
    await vi.waitFor(() => expect(firstService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    const pendingStore = acquireSessionsIndex(scope, pendingMiddleService);
    await vi.waitFor(() =>
      expect(pendingMiddleService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1),
    );
    const latestStore = acquireSessionsIndex(scope, latestService);

    try {
      expect(pendingStore).toBe(firstStore);
      expect(latestStore).toBe(firstStore);
      await vi.waitFor(() =>
        expect(latestService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1),
      );
    } finally {
      releaseSessionsIndex(scope, latestStore);
      releaseSessionsIndex(scope, pendingStore);
      releaseSessionsIndex(scope, firstStore);
    }
  });

  it("远程 service 连续换代时，迟到的中间代际不能把 transport 切回去", async () => {
    const firstService = mockAgentService();
    const staleMiddleService = mockAgentService();
    const latestService = mockAgentService();
    const scope = {
      workspaceKey: "ssh:repo",
      workspacePath: "/repo",
      workspaceIdentity: "ssh:repo",
      endpointKey: "remote-1",
    };
    const register = (agentService: SessionsIndexAgentService) =>
      registerRemoteWorkspaceSession({
        sessionId: scope.endpointKey,
        services: { zcodeAgentService: agentService } as unknown as IServiceAccessor,
      });
    register(firstService);
    register(staleMiddleService);
    register(latestService);

    const firstStore = acquireSessionsIndex(scope, firstService);
    const latestStore = acquireSessionsIndex(scope, latestService);
    await vi.waitFor(() => expect(latestService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    const staleStore = acquireSessionsIndex(scope, staleMiddleService);

    try {
      expect(latestStore).toBe(firstStore);
      expect(staleStore).toBe(firstStore);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(staleMiddleService.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    } finally {
      releaseSessionsIndex(scope, staleStore);
      releaseSessionsIndex(scope, latestStore);
      releaseSessionsIndex(scope, firstStore);
      unregisterRemoteWorkspaceSession(scope.endpointKey);
    }
  });

  it("本地 __base__ 的 service 换代仍创建独立 store，不改变原有生命周期", async () => {
    const oldService = mockAgentService();
    const newService = mockAgentService();
    const scope = { workspaceKey: "/repo", workspacePath: "/repo" };

    const oldStore = acquireSessionsIndex(scope, oldService);
    const newStore = acquireSessionsIndex(scope, newService);
    expect(newStore).not.toBe(oldStore);
    expect(sessionsIndexRegistrySize()).toBe(1);

    releaseSessionsIndex(scope, oldStore);
    expect(sessionsIndexRegistrySize()).toBe(1);
    expect(newService.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();

    releaseSessionsIndex(scope, newStore);
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it("hook signature 使用的 entry key 对 service generation 敏感且同引用稳定", () => {
    const scope = { workspaceKey: "ws-1", endpointKey: "remote-1" };
    const first = mockAgentService();
    const second = mockAgentService();
    const signatureFor = (service: SessionsIndexAgentService) =>
      Reflect.apply(buildSessionsIndexEntryKey, undefined, [scope, service]) as string;

    expect(signatureFor(first)).toBe(signatureFor(first));
    expect(signatureFor(first)).not.toBe(signatureFor(second));
  });

  it("release 未注册 key 为 no-op", () => {
    releaseSessionsIndex({ workspaceKey: "ws-unknown" }, new SessionsIndexStore());
    expect(sessionsIndexRegistrySize()).toBe(0);
  });
});
