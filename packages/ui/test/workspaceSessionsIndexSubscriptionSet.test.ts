import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { SessionSummary, SessionsIndexTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  sessionsIndexRegistrySize,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import {
  WorkspaceSessionsIndexSubscriptionSet,
  type WorkspaceSessionsIndexBinding,
} from "@/v4/workspaceSessionsIndexSubscriptionSet.js";

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

function mockAgentService(): SessionsIndexAgentService {
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  let nextSubscription = 1;
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
        subscriptionId: `sub-${nextSubscription++}`,
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

function binding(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): WorkspaceSessionsIndexBinding {
  return { scope, agentService };
}

function summary(workspaceId: string, sessionId: string): SessionSummary {
  return {
    sessionId,
    workspaceId,
    title: sessionId,
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 100,
    createdAt: 1,
  };
}

function snapshotFrame(
  workspaceId: string,
  sessions: SessionSummary[],
  toSeq: number,
): SessionsIndexTopicFrame {
  return {
    topic: `sessions-index/${workspaceId}`,
    subscriptionId: "test-direct-apply",
    fromSeq: 0,
    toSeq,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId,
        logEpoch: `epoch-${workspaceId}`,
        sessions,
      },
    },
  };
}

describe("WorkspaceSessionsIndexSubscriptionSet", () => {
  it("TSL11：删除 A 只释放 A，B/C 的 store、水位和任务快照保持原引用", async () => {
    const service = mockAgentService();
    const subscriptions = new WorkspaceSessionsIndexSubscriptionSet(vi.fn());
    const a = binding({ workspaceKey: "a", workspacePath: "/a" }, service);
    const b = binding({ workspaceKey: "b", workspacePath: "/b" }, service);
    const c = binding({ workspaceKey: "c", workspacePath: "/c" }, service);

    try {
      expect(subscriptions.reconcile([a, b, c])).toBe(true);
      await vi.waitFor(() => expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(3));

      const bStore = subscriptions.getStore(b.scope)!;
      const cStore = subscriptions.getStore(c.scope)!;
      bStore.applyFrame(snapshotFrame("b", [summary("b", "b-task")], 5));
      cStore.applyFrame(snapshotFrame("c", [summary("c", "c-task")], 7));
      const bState = bStore.getState();
      const cState = cStore.getState();
      const bItems = bStore.getSessions();
      const cItems = cStore.getSessions();

      expect(subscriptions.reconcile([b, c])).toBe(true);
      expect(subscriptions.size()).toBe(2);
      expect(subscriptions.getStore(b.scope)).toBe(bStore);
      expect(subscriptions.getStore(c.scope)).toBe(cStore);
      expect(bStore.getState()).toBe(bState);
      expect(cStore.getState()).toBe(cState);
      expect(bStore.getSessions()).toBe(bItems);
      expect(cStore.getSessions()).toBe(cItems);
      expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(3);
      await vi.waitFor(() => expect(service.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
      expect(sessionsIndexRegistrySize()).toBe(2);
    } finally {
      subscriptions.dispose();
    }
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it("TSL12：重排无副作用，新增和 service 换代只变更目标 scope", async () => {
    const localService = mockAgentService();
    const nextRemoteService = mockAgentService();
    const subscriptions = new WorkspaceSessionsIndexSubscriptionSet(vi.fn());
    const a = binding({ workspaceKey: "a", workspacePath: "/a" }, localService);
    const b = binding(
      {
        workspaceKey: "remote:ssh:host:/repo",
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:host:/repo",
        endpointKey: "remote-1",
      },
      localService,
    );
    const c = binding({ workspaceKey: "c", workspacePath: "/c" }, localService);

    try {
      subscriptions.reconcile([a, b]);
      await vi.waitFor(() =>
        expect(localService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2),
      );
      const aStore = subscriptions.getStore(a.scope)!;
      const bStore = subscriptions.getStore(b.scope)!;

      expect(subscriptions.reconcile([b, a])).toBe(false);
      expect(subscriptions.getStore(a.scope)).toBe(aStore);
      expect(subscriptions.getStore(b.scope)).toBe(bStore);
      expect(localService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
      expect(localService.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();

      expect(subscriptions.reconcile([a, b, c])).toBe(true);
      await vi.waitFor(() =>
        expect(localService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(3),
      );
      const cStore = subscriptions.getStore(c.scope)!;
      expect(subscriptions.getStore(a.scope)).toBe(aStore);
      expect(subscriptions.getStore(b.scope)).toBe(bStore);

      bStore.applyFrame(
        snapshotFrame("remote:ssh:host:/repo", [summary("remote:ssh:host:/repo", "b-task")], 5),
      );
      const bState = bStore.getState();

      const nextB = binding(b.scope, nextRemoteService);
      expect(subscriptions.reconcile([a, nextB, c])).toBe(true);
      expect(subscriptions.getStore(a.scope)).toBe(aStore);
      expect(subscriptions.getStore(c.scope)).toBe(cStore);
      expect(subscriptions.getStore(b.scope)).toBe(bStore);
      expect(bStore.getState()).toBe(bState);
      expect(bStore.getSessions().map((session) => session.sessionId)).toEqual(["b-task"]);
      await vi.waitFor(() => {
        expect(localService.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
        expect(nextRemoteService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      });
    } finally {
      subscriptions.dispose();
    }
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it("相同 workspacePath 的不同 identity/remoteSessionId 各自持有订阅", async () => {
    const firstService = mockAgentService();
    const secondService = mockAgentService();
    const subscriptions = new WorkspaceSessionsIndexSubscriptionSet(vi.fn());
    const first = binding(
      {
        workspaceKey: "remote:ssh:first:/repo",
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:first:/repo",
        endpointKey: "remote-session-first",
      },
      firstService,
    );
    const second = binding(
      {
        workspaceKey: "remote:ssh:second:/repo",
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:second:/repo",
        endpointKey: "remote-session-second",
      },
      secondService,
    );

    try {
      subscriptions.reconcile([first, second]);
      await vi.waitFor(() => {
        expect(firstService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
        expect(secondService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      });
      const secondStore = subscriptions.getStore(second.scope)!;

      subscriptions.reconcile([second]);
      expect(subscriptions.getStore(second.scope)).toBe(secondStore);
      expect(secondService.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(secondService.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(firstService.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1),
      );
    } finally {
      subscriptions.dispose();
    }
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it("远程 service 未换代但 scope 路径变化时重建 transport", async () => {
    const service = mockAgentService();
    const subscriptions = new WorkspaceSessionsIndexSubscriptionSet(vi.fn());
    const original = binding(
      {
        workspaceKey: "remote:ssh:host:/repo",
        workspacePath: "/repo-old",
        workspaceIdentity: "remote:ssh:host:/repo",
        endpointKey: "remote-1",
      },
      service,
    );
    const moved = binding(
      {
        ...original.scope,
        workspacePath: "/repo-new",
      },
      service,
    );

    try {
      subscriptions.reconcile([original]);
      await vi.waitFor(() => expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
      const originalStore = subscriptions.getStore(original.scope)!;

      expect(subscriptions.reconcile([moved])).toBe(true);
      expect(subscriptions.getStore(moved.scope)).not.toBe(originalStore);
      await vi.waitFor(() => {
        expect(service.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
        expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
      });
    } finally {
      subscriptions.dispose();
    }
    expect(sessionsIndexRegistrySize()).toBe(0);
  });

  it("StrictMode cleanup 后同一 subscription set 可以重新 reconcile，且不泄漏 registry", async () => {
    const service = mockAgentService();
    const subscriptions = new WorkspaceSessionsIndexSubscriptionSet(vi.fn());
    const a = binding({ workspaceKey: "a", workspacePath: "/a" }, service);

    subscriptions.reconcile([a]);
    await vi.waitFor(() => expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    subscriptions.dispose();
    expect(sessionsIndexRegistrySize()).toBe(0);

    subscriptions.reconcile([a]);
    await vi.waitFor(() => expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2));
    expect(subscriptions.size()).toBe(1);
    subscriptions.dispose();
    expect(sessionsIndexRegistrySize()).toBe(0);
  });
});
