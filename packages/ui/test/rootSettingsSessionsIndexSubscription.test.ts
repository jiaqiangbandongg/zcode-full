import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type {
  SessionSummary,
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  sessionsIndexRegistrySize,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";

const workspacePath = "/root/src/plancov";
const workspaceIdentity = "remote:wsl:default:root:/root/src/plancov";
const remoteSessionId = "df0312a2-2628-4215-8556-2f5e4c33b394";

/**
 * 模拟一条远程 attachment 连接上的 CLI sessions-index publisher：
 * 同 connection/topic 的后一次 subscribe 会静默替换前一次（`SessionsIndexPublisher.subscribeReserved`），
 * 被替换的订阅再也收不到帧，也不会收到任何信号。
 */
function createSingleConnectionRemoteService(): {
  service: SessionsIndexAgentService;
  emitUpsert(session: SessionSummary): void;
} {
  let nextSubscription = 1;
  let nextLogicalFrame = 1;
  let currentSeq = 1;
  let activeSubscriptionId: string | null = null;
  const listeners = new Set<(frame: SessionsIndexTopicWireFrame) => void>();
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  const topic = `sessions-index/${workspaceIdentity}`;

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

  const service = {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello" as const,
      protocolVersion: 3 as const,
      connectionId: "host-rpc-plancov-attachment",
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
    subscribeSessionsIndexV4: vi.fn(async () => {
      const subscriptionId = `six-${nextSubscription++}`;
      activeSubscriptionId = subscriptionId;
      const initial = physicalFrame(
        {
          topic,
          subscriptionId,
          fromSeq: 0,
          toSeq: currentSeq,
          sentAt: 1,
          payload: {
            kind: "snapshot",
            snapshot: {
              protocolVersion: 1,
              workspaceId: workspaceIdentity,
              logEpoch: "epoch-1",
              sessions: [],
            },
          },
        },
        "initial",
      );
      for (const listener of listeners) listener(initial);
      return { ack: { subscriptionId, mode: "snapshot" as const, logEpoch: "epoch-1" } };
    }),
    unsubscribeSessionsIndexV4: vi.fn(async (params: { subscriptionId: string }) => {
      if (activeSubscriptionId === params.subscriptionId) activeSubscriptionId = null;
    }),
    resyncSessionsIndexV4: vi.fn(async (params: { subscriptionId: string }) => ({
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

  return {
    service,
    emitUpsert(session) {
      if (!activeSubscriptionId) return;
      const frame: SessionsIndexTopicFrame = {
        topic,
        subscriptionId: activeSubscriptionId,
        fromSeq: currentSeq,
        toSeq: currentSeq + 1,
        sentAt: 2,
        payload: { kind: "deltas", deltas: [{ op: "session.upserted", session }] },
      };
      currentSeq += 1;
      for (const listener of listeners) listener(physicalFrame(frame, "online"));
    },
  };
}

function summary(phase: SessionSummary["phase"], lastActivityAt: number): SessionSummary {
  return {
    sessionId: "sess_b8d3c760",
    workspaceId: workspaceIdentity,
    title: "EDGES视图覆盖情况可视化方案",
    phase,
    sessionEnded: phase === "completedSuccess",
    hasBackgroundWork: false,
    lastActivityAt,
    createdAt: 1,
  };
}

/** 与 App.useWorkspaceTerminalTaskNotifications 同口径：Root 的外壳目标 → 注册表 scope。 */
function notificationScopeFromShellTarget(target: {
  workspaceShellPath: string | null;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): SessionsIndexScope {
  const path = target.workspaceShellPath ?? "";
  return {
    workspaceKey: target.workspaceIdentity ?? path,
    workspacePath: path,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.workspaceRemoteSessionId ? { endpointKey: target.workspaceRemoteSessionId } : {}),
  };
}

describe("Settings 覆盖远程 workspace 时的 sessions-index 单订阅不变量", () => {
  it("通知 hook 复用侧栏订阅；关闭 Settings 后侧栏仍能收到任务完成", async () => {
    const { service, emitUpsert } = createSingleConnectionRemoteService();
    const remoteTab = { workspacePath, workspaceIdentity, remoteSessionId };
    // 侧栏 useWorkspaceTaskLists 的远程 shard scope（endpointKey = remoteSessionId）。
    const sidebarScope: SessionsIndexScope = {
      workspaceKey: workspaceIdentity,
      workspacePath,
      workspaceIdentity,
      endpointKey: remoteSessionId,
    };

    const sidebarStore = acquireSessionsIndex(sidebarScope, service);
    await vi.waitFor(() => expect(sidebarStore.getState().workspaceId).toBe(workspaceIdentity));
    emitUpsert(summary("running", 100));
    await vi.waitFor(() => expect(sidebarStore.getSessions()[0]?.phase).toBe("running"));

    // 用户打开 Settings：active tab 不再是 workspace tab，Root 按 fallback 解析外壳目标。
    const shellTarget = resolveRootWorkspaceShellTarget({
      activeWorkspaceTab: null,
      activeWorkspacePath: workspacePath,
      activeWorkspaceIdentity: workspaceIdentity,
      workspaceTabs: [remoteTab],
    });
    const notificationStore = acquireSessionsIndex(
      notificationScopeFromShellTarget(shellTarget),
      service,
    );

    // 不变量：同一远程 workspace 在这条 attachment 上只能有一条 sessions-index 订阅。
    expect(notificationStore).toBe(sidebarStore);
    expect(sessionsIndexRegistrySize()).toBe(1);
    expect(service.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);

    // 用户关闭 Settings：通知 hook 释放引用，不能让 CLI 侧该 topic 归零。
    releaseSessionsIndex(notificationScopeFromShellTarget(shellTarget), notificationStore);
    expect(service.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();

    // 任务完成：侧栏必须收敛，而不是停留在冻结的 running/lastActivityAt。
    emitUpsert(summary("completedSuccess", 200));
    await vi.waitFor(() => {
      const [session] = sidebarStore.getSessions();
      expect(session?.phase).toBe("completedSuccess");
      expect(session?.lastActivityAt).toBe(200);
    });

    releaseSessionsIndex(sidebarScope, sidebarStore);
    expect(sessionsIndexRegistrySize()).toBe(0);
  });
});
