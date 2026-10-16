import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionsIndexTopicWireFrame,
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentSessionTarget,
} from "../src/zcode-agent/zcodeAgent.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { setDataBaseDir } from "../src/paths.js";
import { createZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import type {
  ModelSelection,
  ZCodeSessionStateSnapshot,
  ZCodeTaskMeta,
  ZCodeWorkspaceEvent,
} from "@zcode/shared";
import { elideSessionSnapshotForIndex, ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";
import type {
  SessionSummary,
  ErrorAttribution,
  SessionsIndexTopicFrame,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
  WorkspaceConfigTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  encodeTopicWireFrames,
  PROTOCOL_V4_LIMITS,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";

let tempDir: string;
// 跟踪当前测试的 env，用于 afterEach 清理
let currentEnv: TestEnv | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-syncer-"));
  setDataBaseDir(tempDir);
});

afterEach(async () => {
  // 先关闭 repo 确保 SQLite 连接释放，避免 Windows EPERM
  currentEnv?.repo?.close();
  currentEnv = undefined;
  setDataBaseDir(null);
  // Windows 需要等待一下让文件句柄释放
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows 有时仍会有权限问题，忽略即可
  }
});

interface TestEnv {
  agent: IZCodeAgentService;
  indexEmitter: TestTopicEmitter<SessionsIndexTopicFrame, SessionsIndexTopicWireFrame>;
  configEmitter: TestTopicEmitter<WorkspaceConfigTopicFrame, WorkspaceConfigTopicWireFrame>;
  lifecycleEmitter: Emitter<ZCodeAgentRuntimeLifecycleEvent>;
  repo: TaskIndexRepo;
}

interface TestTopicEmitter<F extends { topic: string; subscriptionId: string }, W> {
  event: Event<W>;
  fire(frame: F, deliveryKind?: "initial" | "online" | "recovery"): void;
  fireWire(wire: W): void;
  dispose(): void;
}

function createTestTopicEmitter<
  F extends { topic: string; subscriptionId: string },
  W,
>(): TestTopicEmitter<F, W> {
  const emitter = new Emitter<W>();
  let serial = 1;
  return {
    event: emitter.event,
    fire(frame, deliveryKind = "online") {
      const logicalFrameOrdinal = serial++;
      emitter.fire({
        wireVersion: 3,
        kind: "complete",
        logicalFrameId: `test-logical-${logicalFrameOrdinal}`,
        logicalFrameOrdinal,
        deliveryKind,
        topic: frame.topic,
        subscriptionId: frame.subscriptionId,
        frame,
      } as W);
    },
    fireWire: (wire) => emitter.fire(wire),
    dispose: () => emitter.dispose(),
  };
}

const INDEX_SUBSCRIPTION_ID = "six-test-1";
const CONFIG_SUBSCRIPTION_ID = "wcs-test-1";
type IndexSubscribeResult = Awaited<ReturnType<IZCodeAgentService["subscribeSessionsIndexV4"]>>;
type IndexResyncResult = Awaited<ReturnType<IZCodeAgentService["resyncSessionsIndexV4"]>>;
type ConfigResyncResult = Awaited<ReturnType<IZCodeAgentService["resyncWorkspaceConfigV4"]>>;

function summaryOf(
  sessionId: string,
  phase: SessionSummary["phase"],
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId,
    workspaceId: "/repo",
    title: "",
    phase,
    sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted",
    hasBackgroundWork: false,
    lastActivityAt: 100,
    createdAt: 1,
    ...overrides,
  };
}

function indexSnapshotFrame(
  sessions: SessionSummary[],
  seq = 1,
  workspaceKey = "/repo",
): SessionsIndexTopicFrame {
  return {
    topic: `sessions-index/${workspaceKey}`,
    subscriptionId: INDEX_SUBSCRIPTION_ID,
    fromSeq: 0,
    toSeq: seq,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: workspaceKey,
        logEpoch: "epoch-test",
        sessions,
      },
    },
  };
}

function indexUpsertFrame(session: SessionSummary, seq = 2): SessionsIndexTopicFrame {
  return {
    topic: "sessions-index//repo",
    subscriptionId: INDEX_SUBSCRIPTION_ID,
    fromSeq: seq - 1,
    toSeq: seq,
    sentAt: 2,
    payload: { kind: "deltas", deltas: [{ op: "session.upserted", session }] },
  };
}

function configFrame(config: WorkspaceConfigState, seq = 1): WorkspaceConfigTopicFrame {
  return {
    topic: "workspace-config//repo",
    subscriptionId: CONFIG_SUBSCRIPTION_ID,
    fromSeq: 0,
    toSeq: seq,
    sentAt: 3,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "/repo",
        logEpoch: "epoch-cfg",
        config,
      },
    },
  };
}

function configDeltaFrame(config: WorkspaceConfigState, seq: number): WorkspaceConfigTopicFrame {
  return {
    topic: "workspace-config//repo",
    subscriptionId: CONFIG_SUBSCRIPTION_ID,
    fromSeq: seq - 1,
    toSeq: seq,
    sentAt: 4,
    payload: {
      kind: "deltas",
      deltas: [{ op: "config.updated", config }],
    },
  };
}

function setupEnv(
  options: {
    initialSessions?: SessionSummary[];
    workspaceKey?: string;
    runtimeLifecycle?: boolean;
  } = {},
): TestEnv {
  const indexEmitter = createTestTopicEmitter<
    SessionsIndexTopicFrame,
    SessionsIndexTopicWireFrame
  >();
  const configEmitter = createTestTopicEmitter<
    WorkspaceConfigTopicFrame,
    WorkspaceConfigTopicWireFrame
  >();
  const lifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  const agent: IZCodeAgentService = {
    subscribeSessionsIndexV4: vi.fn(async () => {
      const ack = {
        subscriptionId: INDEX_SUBSCRIPTION_ID,
        mode: "snapshot" as const,
        logEpoch: "epoch-test",
      };
      // 04A 真链路：response 与 initial 在同一 read；Promise continuation 尚未运行时
      // notification 已同步 fire，syncer 必须先 staging，ACK 后再按 subId 释放。
      indexEmitter.fire(
        indexSnapshotFrame(options.initialSessions ?? [], 1, options.workspaceKey),
        "initial",
      );
      return { ack };
    }),
    unsubscribeSessionsIndexV4: vi.fn(async () => {}),
    resyncSessionsIndexV4: vi.fn(async (params) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
        logEpoch: "epoch-test",
      },
    })),
    onDynamicSessionsIndexFrame: vi.fn(() => indexEmitter.event),
    subscribeWorkspaceConfigV4: vi.fn(async () => ({
      ack: {
        subscriptionId: CONFIG_SUBSCRIPTION_ID,
        mode: "snapshot" as const,
        logEpoch: "epoch-cfg",
      },
    })),
    unsubscribeWorkspaceConfigV4: vi.fn(async () => {}),
    resyncWorkspaceConfigV4: vi.fn(async (params) => ({
      ack: {
        subscriptionId: params.subscriptionId,
        mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
        logEpoch: "epoch-cfg",
      },
    })),
    onDynamicWorkspaceConfigFrame: vi.fn(() => configEmitter.event),
    resumeSession: vi.fn(async (target: ZCodeAgentSessionTarget) =>
      snapshotWith(target.sessionId, target.workspacePath),
    ),
    listSessions: vi.fn(async () => []),
    readSession: vi.fn(async (target: ZCodeAgentSessionTarget) =>
      snapshotWith(target.sessionId, target.workspacePath),
    ),
    hasActiveCuaOperationTurn: vi.fn(() => false),
    ...(options.runtimeLifecycle ? { onAgentRuntimeLifecycle: lifecycleEmitter.event } : {}),
  } as unknown as IZCodeAgentService;
  const env = {
    agent,
    indexEmitter,
    configEmitter,
    lifecycleEmitter,
    repo: new TaskIndexRepo(),
  };
  currentEnv = env;
  return env;
}

/** 等待 workspace v4 订阅建立完成（subscribe promise resolve + 初始帧静默入基线）。 */
async function subscribed(env: TestEnv): Promise<void> {
  await vi.waitFor(() => {
    expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalled();
  });
  // establishWorkspaceSubscriptions 里 Promise.all 之后才写 subscriptionId；多让一拍。
  await new Promise((resolve) => setImmediate(resolve));
}

const seedTarget: ZCodeAgentSessionTarget = {
  workspacePath: "/repo",
  sessionId: "sess_complete",
};

async function seedRunningTask(repo: TaskIndexRepo): Promise<ZCodeTaskMeta> {
  return repo.syncTaskMeta({
    meta: {
      taskId: seedTarget.sessionId,
      traceId: "trace_seed",
      title: "Pending task",
      workspacePath: seedTarget.workspacePath,
      createdAt: 1,
      updatedAt: 2,
      mode: "build",
      status: "running",
    },
  });
}

function snapshotWith(
  sessionId: string,
  workspacePath: string,
  overrides: {
    title?: string;
    createdAt?: number;
    updatedAt?: number;
    userMessageText?: string;
    assistantMessageText?: string;
    assistantCompletedAt?: number;
    sessionStatus?: ZCodeSessionStateSnapshot["session"]["status"];
    settingsModel?: ModelSelection;
    messageModel?: ModelSelection;
    thoughtLevel?: string;
    target?: ZCodeSessionStateSnapshot["projection"]["target"];
    lastError?: { type: string; message: string; attribution?: ErrorAttribution };
  } = {},
): ZCodeSessionStateSnapshot {
  const settingsModel = overrides.settingsModel ?? {
    providerId: "anthropic",
    modelId: "haiku-4.5",
  };
  const messageModel = overrides.messageModel ?? settingsModel;
  const messages = [];
  if (overrides.userMessageText !== undefined) {
    messages.push({
      info: {
        messageId: "msg_u1",
        role: "user" as const,
        time: { created: overrides.updatedAt ?? 1, completed: overrides.updatedAt ?? 1 },
        model: messageModel,
      },
      parts: [
        {
          partId: "p1",
          type: "text" as const,
          text: overrides.userMessageText,
        },
      ],
    });
  }
  if (overrides.assistantMessageText !== undefined) {
    messages.push({
      info: {
        messageId: "msg_a1",
        sessionId,
        parentMessageId: "msg_u1",
        role: "assistant" as const,
        time: {
          created: overrides.updatedAt ?? 1,
          ...(typeof overrides.assistantCompletedAt === "number"
            ? { completed: overrides.assistantCompletedAt }
            : {}),
        },
        agent: "zcode",
        model: messageModel,
        path: { cwd: workspacePath, root: workspacePath },
      },
      parts: [
        {
          partId: "p2",
          type: "text" as const,
          text: overrides.assistantMessageText,
        },
      ],
    });
  }
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId,
      workspace: { workspacePath, workspaceKey: workspacePath },
      sessionKind: "interactive",
      revision: 1,
      status: overrides.sessionStatus ?? "running",
      mode: "build",
      title: overrides.title ?? "",
      createdAt: overrides.createdAt ?? 1,
      updatedAt: overrides.updatedAt ?? 1,
      contextWindow: 100000,
      contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      activeTurnId: undefined,
      lastTurnId: undefined,
      lastInputId: undefined,
      archivedAt: undefined,
    },
    settings: {
      model: {
        current: settingsModel,
        available: [],
      },
      thoughtLevel: {
        enabled: overrides.thoughtLevel !== undefined,
        current: overrides.thoughtLevel,
        available: overrides.thoughtLevel ? [overrides.thoughtLevel] : [],
      },
      mode: { current: "build" },
    },
    projection: {
      target: overrides.target ?? null,
      lastError: overrides.lastError ?? null,
      pendingPermissions: [],
    },
    runtime: { stream: { recovering: false } },
    messages: messages as unknown as ZCodeSessionStateSnapshot["messages"],
  } as unknown as ZCodeSessionStateSnapshot;
}

describe("createZCodeTaskIndexSyncer", () => {
  it("writes status: completed on v4 phase running->completedSuccess, broadcasts and emits terminal/ready", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: seedTarget.workspacePath,
    })((event) => broadcasts.push(event));
    const terminals: Array<{ kind: string; sessionId: string }> = [];
    const readies: Array<{ reason: string; sessionId: string }> = [];
    syncer.onSessionTerminalEvent((event) =>
      terminals.push({ kind: event.kind, sessionId: event.target.sessionId }),
    );
    syncer.onSessionReadyEvent((event) =>
      readies.push({ reason: event.reason, sessionId: event.target.sessionId }),
    );
    syncer.ensureSessionSubscription(seedTarget);
    await subscribed(env);

    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess")));

    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.status).toBe("completed");
    });

    // 终态迁移同时给 host runtime command queue 发终态 + ready（先 terminal 后 ready）。
    expect(terminals).toEqual([{ kind: "turn.completed", sessionId: seedTarget.sessionId }]);
    expect(readies).toEqual([{ reason: "prompt_completed", sessionId: seedTarget.sessionId }]);
    expect(env.agent.readSession).toHaveBeenCalledWith({
      ...seedTarget,
      runtimePolicy: "existing-only",
      contentProfile: "index",
    });
    expect(env.agent.resumeSession).not.toHaveBeenCalled();

    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    const changed = broadcasts.filter((event) => event.type === "workspace_task_list_changed");
    expect(changed.length).toBeGreaterThanOrEqual(1);
    const first = changed[0];
    if (first.type === "workspace_task_list_changed") {
      expect(first.taskId).toBe(seedTarget.sessionId);
      expect(first.taskMeta?.status).toBe("completed");
      expect(first.unreadSignal).toBe("background_terminal");
    }

    subscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it.each([
    ["普通完成", undefined, "completedSuccess", true],
    ["Goal verified", "verified", "completedSuccess", true],
    ["Goal active 中间轮", "active", "completedSuccess", false],
    ["Goal verifying", "verifying", "completedSuccess", false],
    ["Goal notSatisfied", "notSatisfied", "completedSuccess", false],
    ["Goal paused/取消", "paused", "completedInterrupted", false],
    ["Goal failed 非错误终态", "failed", "completedSuccess", false],
    ["真实错误", "failed", "error", true],
  ] as const)(
    "%s 的终态未读信号符合 Goal 边界",
    async (_label, goalStatus, phase, shouldSignal) => {
      const env = setupEnv({
        initialSessions: [summaryOf(seedTarget.sessionId, "running", { goalStatus })],
      });
      await seedRunningTask(env.repo);
      const syncer = createZCodeTaskIndexSyncer({
        agentService: env.agent,
        taskIndexRepo: env.repo,
      });
      const broadcasts: ZCodeWorkspaceEvent[] = [];
      syncer.onDynamicWorkspaceEvent({
        workspacePath: seedTarget.workspacePath,
      })((event) => broadcasts.push(event));
      syncer.ensureSessionSubscription(seedTarget);
      await subscribed(env);

      env.indexEmitter.fire(
        indexUpsertFrame(summaryOf(seedTarget.sessionId, phase, { goalStatus })),
      );

      await vi.waitFor(() => expect(env.agent.readSession).toHaveBeenCalled());
      const unreadSignals = broadcasts.filter(
        (event) =>
          event.type === "workspace_task_list_changed" &&
          event.unreadSignal === "background_terminal",
      );
      expect(unreadSignals).toHaveLength(shouldSignal ? 1 : 0);

      syncer.disposeAll();
      env.indexEmitter.dispose();
      env.configEmitter.dispose();
    },
  );

  it("resyncs full snapshot on terminal transition so searchable_text catches up (v4 command path)", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf("sess_v4_search", "running")],
    });
    vi.mocked(env.agent.readSession).mockResolvedValue(
      snapshotWith("sess_v4_search", "/repo", {
        title: "查询订单接口",
        userMessageText: "帮我查询订单接口的实现",
        assistantMessageText: "订单接口在 orderService 里实现。",
        assistantCompletedAt: 130,
        updatedAt: 120,
      }),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    syncer.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) => broadcasts.push(event));
    syncer.ensureSessionSubscription({
      workspacePath: "/repo",
      sessionId: "sess_v4_search",
    });
    await subscribed(env);

    env.indexEmitter.fire(indexUpsertFrame(summaryOf("sess_v4_search", "completedSuccess")));

    // 行由回源 snapshot 创建（v4 命令路径没有 op 驱动的 snapshot 同步），正文可搜。
    await vi.waitFor(async () => {
      const result = await env.repo.queryTaskList({
        workspaceScopes: [{ workspacePath: "/repo" }],
        search: "orderService",
      });
      expect(result.total).toBe(1);
    });
    expect(
      broadcasts.filter(
        (event) =>
          event.type === "workspace_task_list_changed" &&
          event.unreadSignal === "background_terminal",
      ),
    ).toHaveLength(1);

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("writes status: error on v4 phase running->error and fills lastError from resynced snapshot", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    vi.mocked(env.agent.readSession).mockResolvedValue(
      snapshotWith(seedTarget.sessionId, seedTarget.workspacePath, {
        title: "Pending task",
        userMessageText: "run it",
        lastError: { type: "MODEL_ERROR", message: "boom" },
        updatedAt: 6,
      }),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: seedTarget.workspacePath,
    })((event) => broadcasts.push(event));
    const readies: string[] = [];
    syncer.onSessionReadyEvent((event) => readies.push(event.reason));
    syncer.ensureSessionSubscription(seedTarget);
    await subscribed(env);

    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "error")));

    // sessions-index 摘要没有错误详情：status 先收敛，lastError 由回源 snapshot 补权威值。
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.status).toBe("error");
      expect(meta?.lastError?.message).toBe("boom");
      expect(meta?.lastError?.code).toBe("MODEL_ERROR");
    });
    expect(readies).toEqual(["prompt_failed"]);
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);

    subscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("writes title and broadcasts when v4 summary title changes", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: seedTarget.workspacePath,
    })((event) => broadcasts.push(event));
    syncer.ensureSessionSubscription(seedTarget);
    await subscribed(env);

    env.indexEmitter.fire(
      indexUpsertFrame(summaryOf(seedTarget.sessionId, "running", { title: "hello world" })),
    );

    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.title).toBe("hello world");
    });
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    const last = broadcasts[broadcasts.length - 1];
    if (last.type === "workspace_task_list_changed") {
      expect(last.taskMeta?.title).toBe("hello world");
    }

    subscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("falls back to a full snapshot when title arrives before task index row exists", async () => {
    const env = setupEnv();
    const target: ZCodeAgentSessionTarget = {
      workspacePath: "/repo",
      sessionId: "sess_missing",
    };
    vi.mocked(env.agent.readSession).mockResolvedValue(
      snapshotWith("sess_missing", "/repo", {
        title: "first prompt title",
        updatedAt: 8,
      }),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: "/repo",
    })((event) => broadcasts.push(event));
    syncer.ensureSessionSubscription(target);
    await subscribed(env);

    // v4 命令路径首发：会话以带首标题的 upsert 出现，sqlite 尚无行 → 回源完整 snapshot。
    env.indexEmitter.fire(
      indexUpsertFrame(summaryOf("sess_missing", "running", { title: "first prompt title" })),
    );

    await vi.waitFor(() => {
      expect(env.agent.readSession).toHaveBeenCalledWith({
        ...target,
        runtimePolicy: "existing-only",
        contentProfile: "index",
      });
      expect(env.agent.resumeSession).not.toHaveBeenCalled();
    });
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: "/repo",
        taskId: "sess_missing",
      });
      expect(meta?.title).toBe("first prompt title");
    });
    const groupedStructure = await env.repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    expect(groupedStructure.topLevelOrders[0]).toMatchObject({
      type: "task",
      taskId: "sess_missing",
    });
    expect(broadcasts.length).toBe(1);

    subscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("places a promoted v4 draft at grouped root top before its title arrives", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf("sess-promoted", "draft")],
    });
    const target: ZCodeAgentSessionTarget = {
      workspacePath: "/repo",
      sessionId: "sess-promoted",
    };
    vi.mocked(env.agent.readSession).mockResolvedValue(
      snapshotWith("sess-promoted", "/repo", { title: "", updatedAt: 8 }),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) =>
      broadcasts.push(event),
    );
    syncer.ensureSessionSubscription(target);
    await subscribed(env);

    env.indexEmitter.fire(indexUpsertFrame(summaryOf("sess-promoted", "running")));

    await vi.waitFor(async () => {
      const structure = await env.repo.queryGroupedTaskViewStructure({
        workspaceScopes: [{ workspacePath: "/repo" }],
      });
      expect(structure.topLevelOrders[0]).toMatchObject({
        type: "task",
        taskId: "sess-promoted",
      });
    });
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: "workspace_task_list_changed",
        taskId: "sess-promoted",
        reason: "task_created",
      }),
    );

    subscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("silently seeds missing rows from the first sessions-index snapshot and skips drafts", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf("sess_history", "completedSuccess", { title: "历史会话" })],
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: "/repo",
    })((event) => broadcasts.push(event));
    syncer.ensureSessionSubscription({
      workspacePath: "/repo",
      sessionId: "sess_history",
    });
    await subscribed(env);

    // 冷启动 snapshot 不回放历史终态/广播，但必须补齐缺失索引行，避免远端新库永远为空。
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({ workspacePath: "/repo", taskId: "sess_history" });
      expect(meta).toMatchObject({
        taskId: "sess_history",
        title: "历史会话",
        provider: "glm",
        status: "completed",
      });
    });

    // draft 会话（纯内存态）不进 task index。
    env.indexEmitter.fire(indexUpsertFrame(summaryOf("sess_draft", "draft", { title: "草稿" })));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await env.repo.getTaskMeta({ workspacePath: "/repo", taskId: "sess_draft" })).toBeNull();
    expect(broadcasts.length).toBe(0);

    subscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("keeps dynamic workspace-event consumers passive when no runtime exists", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:dev:/repo",
    })(() => {});

    await new Promise((resolve) => setImmediate(resolve));
    expect(env.agent.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(env.agent.subscribeWorkspaceConfigV4).not.toHaveBeenCalled();

    subscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("installs dormant frame listeners before first available subscribe and reuses them after restart", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
      runtimeLifecycle: true,
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const terminals: string[] = [];
    const readies: string[] = [];
    syncer.onSessionTerminalEvent((event) => terminals.push(event.kind));
    syncer.onSessionReadyEvent((event) => readies.push(event.reason));

    // 生产中 task adapter 会先 notify/ensure session，再由实际命令启动名单外 runtime。
    syncer.ensureSessionSubscription(seedTarget);
    await Promise.resolve();
    expect(env.agent.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(env.agent.onDynamicSessionsIndexFrame).not.toHaveBeenCalled();
    expect(env.agent.onDynamicWorkspaceConfigFrame).not.toHaveBeenCalled();

    env.lifecycleEmitter.fire({
      workspacePath: seedTarget.workspacePath,
      workspaceKey: seedTarget.workspacePath,
      runtimeIdentity: {
        generation: 1,
        identity: `${seedTarget.workspacePath}:1`,
        workspaceKey: seedTarget.workspacePath,
      },
      state: "available",
    });
    await subscribed(env);

    // 回归根因：首次 available 必须先挂 listener，subscribe response resolve 后、await
    // continuation 前同步到达的 initial frame 才能写入 task index；旧实现只重订阅。
    expect(env.agent.onDynamicSessionsIndexFrame).toHaveBeenCalledTimes(1);
    expect(env.agent.onDynamicWorkspaceConfigFrame).toHaveBeenCalledTimes(1);
    expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.status).toBe("running");
    });

    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess")));
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.status).toBe("completed");
    });
    expect(terminals).toEqual(["turn.completed"]);
    expect(readies).toEqual(["prompt_completed"]);

    env.lifecycleEmitter.fire({
      workspacePath: seedTarget.workspacePath,
      workspaceKey: seedTarget.workspacePath,
      runtimeIdentity: {
        generation: 1,
        identity: `${seedTarget.workspacePath}:1`,
        workspaceKey: seedTarget.workspacePath,
      },
      state: "unavailable",
    });
    env.lifecycleEmitter.fire({
      workspacePath: seedTarget.workspacePath,
      workspaceKey: seedTarget.workspacePath,
      runtimeIdentity: {
        generation: 2,
        identity: `${seedTarget.workspacePath}:2`,
        workspaceKey: seedTarget.workspacePath,
      },
      state: "available",
    });
    await vi.waitFor(() => {
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
      expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(2);
    });
    expect(env.agent.onDynamicSessionsIndexFrame).toHaveBeenCalledTimes(1);
    expect(env.agent.onDynamicWorkspaceConfigFrame).toHaveBeenCalledTimes(1);
    expect(terminals).toEqual(["turn.completed"]);
    expect(readies).toEqual(["prompt_completed"]);

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
    env.lifecycleEmitter.dispose();
  });

  it("attaches only to an available runtime and returns to dormant after it exits", async () => {
    vi.useFakeTimers();
    try {
      const env = setupEnv({ runtimeLifecycle: true });
      const syncer = createZCodeTaskIndexSyncer({
        agentService: env.agent,
        taskIndexRepo: env.repo,
      });
      const workspaceIdentity = "remote:ssh:dev:/repo";

      const subscription = syncer.onDynamicWorkspaceEvent({
        workspacePath: "/repo",
        workspaceIdentity,
      })(() => {});
      syncer.ensureWorkspaceSubscription({ workspacePath: "/repo", workspaceIdentity });
      await Promise.resolve();
      expect(env.agent.subscribeSessionsIndexV4).not.toHaveBeenCalled();

      env.lifecycleEmitter.fire({
        workspacePath: "/repo",
        workspaceIdentity,
        workspaceKey: workspaceIdentity,
        runtimeIdentity: {
          generation: 1,
          identity: `${workspaceIdentity}:1`,
          workspaceKey: workspaceIdentity,
        },
        state: "available",
      });
      await vi.waitFor(() => expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspacePath: "/repo",
          workspaceIdentity,
          subscriberScope: "task-index",
          runtimePolicy: "existing-only",
        }),
      );

      env.lifecycleEmitter.fire({
        workspacePath: "/repo",
        workspaceIdentity,
        workspaceKey: workspaceIdentity,
        runtimeIdentity: {
          generation: 1,
          identity: `${workspaceIdentity}:1`,
          workspaceKey: workspaceIdentity,
        },
        state: "unavailable",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);

      env.lifecycleEmitter.fire({
        workspacePath: "/repo",
        workspaceIdentity,
        workspaceKey: workspaceIdentity,
        runtimeIdentity: {
          generation: 2,
          identity: `${workspaceIdentity}:2`,
          workspaceKey: workspaceIdentity,
        },
        state: "available",
      });
      await vi.waitFor(() => expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2));

      subscription.dispose();
      syncer.disposeAll();
      env.indexEmitter.dispose();
      env.configEmitter.dispose();
      env.lifecycleEmitter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("SAT29: 只清理明确属于当前 workspace 的 subagent 索引，保留 fork 与未确认记录", async () => {
    const env = setupEnv();
    for (const taskId of ["child", "fork", "unknown"]) {
      await env.repo.syncTaskMetaAtGroupedTop({
        meta: {
          ...snapshotWith(taskId, "/repo").session,
          taskId,
          traceId: "trace",
          title: taskId,
          workspacePath: "/repo",
          createdAt: 1,
          updatedAt: 2,
          mode: "build",
          provider: "glm",
          status: "completed",
        },
      });
    }
    await env.repo.syncTaskMeta({
      meta: {
        taskId: "child",
        traceId: "trace",
        title: "foreign",
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:foreign:/repo",
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        provider: "glm",
        status: "completed",
      },
    });
    vi.mocked(env.agent.listSessions).mockResolvedValue([
      { ...snapshotWith("child", "/repo").session, sessionKind: "subagent_child" },
      { ...snapshotWith("fork", "/repo").session, sessionKind: "fork", parentSessionId: "parent" },
    ]);
    const syncer = createZCodeTaskIndexSyncer({ agentService: env.agent, taskIndexRepo: env.repo });
    const changed = vi.fn();
    const listener = syncer.onDynamicWorkspaceEvent("/repo")(changed);
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await vi.waitFor(async () =>
      expect(await env.repo.getTaskMeta({ workspacePath: "/repo", taskId: "child" })).toBeNull(),
    );
    expect(await env.repo.getTaskMeta({ workspacePath: "/repo", taskId: "fork" })).not.toBeNull();
    expect(
      await env.repo.getTaskMeta({ workspacePath: "/repo", taskId: "unknown" }),
    ).not.toBeNull();
    expect(
      await env.repo.getTaskMeta({
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:foreign:/repo",
        taskId: "child",
      }),
    ).not.toBeNull();
    expect(env.agent.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/repo",
        sessionIds: expect.arrayContaining(["child", "fork", "unknown"]),
        includeArchived: true,
      }),
    );
    expect(env.agent.resumeSession).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    listener.dispose();
    syncer.disposeAll();
  });

  it.each(["failure", "disposed"] as const)(
    "SAT29: 身份查询 %s 时保留既有索引",
    async (failure) => {
      const env = setupEnv();
      await env.repo.syncTaskMeta({
        meta: { ...(await seedRunningTask(env.repo)), provider: "glm" },
      });
      let finish:
        | ((value: Awaited<ReturnType<IZCodeAgentService["listSessions"]>>) => void)
        | undefined;
      vi.mocked(env.agent.listSessions).mockImplementation(() =>
        failure === "failure"
          ? Promise.reject(new Error("remote unavailable"))
          : new Promise((resolve) => {
              finish = resolve;
            }),
      );
      const syncer = createZCodeTaskIndexSyncer({
        agentService: env.agent,
        taskIndexRepo: env.repo,
      });
      syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
      await vi.waitFor(() => expect(env.agent.listSessions).toHaveBeenCalled());
      syncer.disposeAll();
      finish?.([
        { ...snapshotWith(seedTarget.sessionId, "/repo").session, sessionKind: "subagent_child" },
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        await env.repo.getTaskMeta({ workspacePath: "/repo", taskId: seedTarget.sessionId }),
      ).not.toBeNull();
    },
  );

  it("SAT28: child 完整快照不重新写入主列表", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({ agentService: env.agent, taskIndexRepo: env.repo });
    const snapshot = snapshotWith("child", "/repo", { userMessageText: "child prompt" });
    snapshot.session.sessionKind = "subagent_child";
    await syncer.syncSnapshotAndBroadcast(snapshot, { broadcastReason: "task_status_changed" });
    expect(await env.repo.getTaskMeta({ workspacePath: "/repo", taskId: "child" })).toBeNull();
    syncer.disposeAll();
  });

  it("does not overwrite existing product-shell state during initial snapshot reconciliation", async () => {
    const env = setupEnv({
      initialSessions: [
        summaryOf("sess_existing", "completedSuccess", {
          title: "Agent 标题",
          titleSource: "generated",
          lastActivityAt: 999,
        }),
      ],
    });
    await env.repo.syncTaskMeta({
      meta: {
        taskId: "sess_existing",
        traceId: "trace-existing",
        title: "用户标题",
        titleOverridden: true,
        workspacePath: "/repo",
        createdAt: 1,
        updatedAt: 100,
        mode: "build",
        model: "anthropic/haiku-4.5",
        provider: "glm",
        status: "completed",
      },
      pinned: true,
      titleOverridden: true,
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    const [meta] = await env.repo.listTaskMetas({ workspacePath: "/repo", pinned: true });
    expect(meta).toMatchObject({
      taskId: "sess_existing",
      title: "用户标题",
      titleOverridden: true,
      updatedAt: 100,
      mode: "build",
      model: "anthropic/haiku-4.5",
    });

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("seeds remote rows under workspaceIdentity instead of the shared workspacePath", async () => {
    const workspaceIdentity = "remote:ssh:dev.example:22:codegeex:/repo";
    const env = setupEnv({
      workspaceKey: workspaceIdentity,
      initialSessions: [
        summaryOf("sess_remote", "completedSuccess", {
          workspaceId: workspaceIdentity,
          title: "远端会话",
        }),
      ],
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    syncer.onDynamicWorkspaceEvent({
      workspacePath: "/repo",
      workspaceIdentity,
    })(() => {});
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo", workspaceIdentity });
    await subscribed(env);

    await vi.waitFor(async () => {
      const remoteMeta = await env.repo.getTaskMeta({
        workspacePath: "/repo",
        workspaceIdentity,
        taskId: "sess_remote",
      });
      expect(remoteMeta?.workspaceIdentity).toBe(workspaceIdentity);
    });
    expect(
      await env.repo.getTaskMeta({ workspacePath: "/repo", taskId: "sess_remote" }),
    ).toBeNull();

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("forwards v4 workspace-config frames as workspace_config_options_update and drops empty catalogs", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: "/repo",
    })((event) => broadcasts.push(event));
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    // 空目录（无 live session 的订阅种子）不下发，避免清掉工具栏模型目录。
    env.configEmitter.fire(configFrame({ configOptions: [], slashCommands: [] }));
    expect(broadcasts.length).toBe(0);

    env.configEmitter.fire(
      configFrame(
        {
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "anthropic/haiku-4.5",
              options: [{ value: "anthropic/haiku-4.5", name: "Haiku 4.5" }],
            },
          ],
          slashCommands: [{ name: "compact", description: "Compact" }],
        },
        2,
      ),
    );

    expect(broadcasts.length).toBe(1);
    const event = broadcasts[0];
    expect(event.type).toBe("workspace_config_options_update");
    if (event.type === "workspace_config_options_update") {
      expect(event.workspacePath).toBe("/repo");
      expect(event.configOptions).toHaveLength(1);
      expect(event.configOptions[0]?.id).toBe("model");
    }

    subscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("syncSnapshotAndBroadcast writes meta and fires workspace_task_list_changed", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: "/repo",
    })((event) => broadcasts.push(event));

    const meta = await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_new", "/repo", {
        title: "", // 模拟 runtime 还没写 title，触发 deriveTitleFromSnapshot
        userMessageText: "fix the bug in checkout flow",
        updatedAt: 999,
      }),
      { broadcastReason: "task_meta_changed" },
    );

    // 期望从首条 user message 推断 title
    expect(meta.title).toBe("fix the bug in checkout flow");
    expect(meta.updatedAt).toBe(999);

    const persisted = await env.repo.getTaskMeta({
      workspacePath: "/repo",
      taskId: "sess_new",
    });
    expect(persisted?.title).toBe("fix the bug in checkout flow");

    expect(broadcasts.length).toBe(1);
    const evt = broadcasts[0];
    if (evt.type === "workspace_task_list_changed") {
      expect(evt.taskId).toBe("sess_new");
      expect(evt.taskMeta?.title).toBe("fix the bug in checkout flow");
    } else {
      throw new Error("expected workspace_task_list_changed");
    }

    subscription.dispose();
    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast 对 index profile 裁剪后的 snapshot 产出与 full 完全一致的索引写入", async () => {
    const big = "z".repeat(256 * 1024);
    const full = snapshotWith("sess_profile", "/repo", {
      title: "",
      userMessageText: "排查订单列表慢查询",
      assistantMessageText: "根因是缺少索引",
      assistantCompletedAt: 50,
      sessionStatus: "completed",
      updatedAt: 60,
    });
    // 固定 traceId：缺省时 buildMetaFromSnapshot 会随机生成，与裁剪无关。
    full.session.traceId = "trace_profile";
    const assistant = full.messages.find((message) => message.info.role === "assistant");
    if (!assistant) throw new Error("fixture assistant missing");
    assistant.parts.unshift(
      { partId: "p_reason", type: "reasoning", text: big } as never,
      {
        partId: "p_tool",
        type: "tool",
        callId: "call_profile",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: big },
          output: big,
          title: "bash",
          metadata: { output: big },
          startedAt: 40,
          completedAt: 41,
        },
      } as never,
    );
    const elided = elideSessionSnapshotForIndex(full);
    expect(JSON.stringify(elided).length).toBeLessThan(big.length / 10);

    const capture = async (snapshot: ZCodeSessionStateSnapshot) => {
      const env = setupEnv();
      const writes: unknown[] = [];
      const original = env.repo.syncTaskMeta.bind(env.repo);
      vi.spyOn(env.repo, "syncTaskMeta").mockImplementation(async (input) => {
        writes.push(structuredClone(input));
        return await original(input);
      });
      const syncer = createZCodeTaskIndexSyncer({
        agentService: env.agent,
        taskIndexRepo: env.repo,
      });
      const broadcasts: ZCodeWorkspaceEvent[] = [];
      const subscription = syncer.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) =>
        broadcasts.push(event),
      );
      const meta = await syncer.syncSnapshotAndBroadcast(snapshot, {
        broadcastReason: "task_status_changed",
      });
      subscription.dispose();
      syncer.disposeAll();
      return { meta, writes, broadcasts };
    };

    const fromFull = await capture(full);
    const fromIndex = await capture(elided);
    expect(fromFull.writes).toHaveLength(1);
    expect(fromFull.writes[0]).toMatchObject({
      meta: { title: "排查订单列表慢查询", status: "completed" },
      searchableText: "排查订单列表慢查询\n根因是缺少索引",
    });
    expect(fromIndex.writes).toEqual(fromFull.writes);
    expect(fromIndex.meta).toEqual(fromFull.meta);
    expect(fromIndex.broadcasts).toEqual(fromFull.broadcasts);
  });

  it("syncSnapshotAndBroadcast prefers structured projection error code in task meta", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const restored = snapshotWith("sess_error", "/repo", {
      title: "stale model",
      updatedAt: 999,
    });

    const meta = await syncer.syncSnapshotAndBroadcast(
      {
        ...restored,
        session: {
          ...restored.session,
          status: "error",
        },
        projection: {
          ...restored.projection,
          lastError: {
            type: "MODEL_ERROR",
            code: "provider_not_found",
            message: "Model provider is not configured: stale-provider",
            detail: "stale-provider/gpt-5.5",
            attribution: {
              source: "runtime",
              reason: "provider_not_configured",
              providerId: "account:zai-individual-coding-plan",
            },
          },
        },
      },
      { broadcastReason: "task_status_changed" },
    );

    expect(meta.lastError).toEqual({
      code: "provider_not_found",
      detail: "stale-provider/gpt-5.5",
      message: "Model provider is not configured: stale-provider",
      attribution: {
        source: "runtime",
        reason: "provider_not_configured",
        providerId: "account:zai-individual-coding-plan",
      },
    });

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast stores the latest message model when settings current is polluted", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    const meta = await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_model", "/repo", {
        title: "historical model",
        userMessageText: "fix perf",
        settingsModel: {
          providerId: "36965ea6-734a-46a8-8851-3dfec026589e",
          modelId: "glm-5.1-highspeed",
        },
        messageModel: {
          providerId: "default-deepseek",
          modelId: "deepseek-v4-flash",
        },
      }),
      { broadcastReason: "task_meta_changed" },
    );

    expect(meta.model).toBe("default-deepseek/deepseek-v4-flash");
    await expect(
      env.repo.getTaskMeta({
        workspacePath: "/repo",
        taskId: "sess_model",
      }),
    ).resolves.toMatchObject({
      model: "default-deepseek/deepseek-v4-flash",
    });

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast can override task model for explicit model switches", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    const meta = await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_model_override", "/repo", {
        title: "historical model",
        userMessageText: "continue with visible model",
        settingsModel: {
          providerId: "current-provider",
          modelId: "current-model",
        },
        messageModel: {
          providerId: "removed-provider",
          modelId: "removed-model",
        },
      }),
      { modelOverride: "current-provider/current-model", broadcastReason: "task_meta_changed" },
    );

    expect(meta.model).toBe("current-provider/current-model");
    await expect(
      env.repo.getTaskMeta({
        workspacePath: "/repo",
        taskId: "sess_model_override",
      }),
    ).resolves.toMatchObject({
      model: "current-provider/current-model",
    });

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast can override task thought level for explicit resume", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    const meta = await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_thought_override", "/repo", {
        title: "historical thought level",
        userMessageText: "continue with task-local thought level",
        thoughtLevel: "high",
      }),
      { thoughtLevelOverride: "max", broadcastReason: "task_meta_changed" },
    );

    expect(meta.thoughtLevel).toBe("max");
    await expect(
      env.repo.getTaskMeta({
        workspacePath: "/repo",
        taskId: "sess_thought_override",
      }),
    ).resolves.toMatchObject({
      thoughtLevel: "max",
    });

    syncer.disposeAll();
  });

  it("syncTaskModel updates only the persisted task model", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    await env.repo.syncTaskMeta({
      meta: {
        taskId: "sess_model_patch",
        traceId: "trace_model_patch",
        title: "Existing task",
        workspacePath: "/repo",
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        model: "removed-provider/removed-model",
        status: "completed",
      },
    });

    await expect(
      syncer.syncTaskModel(
        {
          workspacePath: "/repo",
          sessionId: "sess_model_patch",
        },
        "current-provider/current-model",
      ),
    ).resolves.toMatchObject({
      model: "current-provider/current-model",
      status: "completed",
      title: "Existing task",
    });

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast titles /goal sessions without indexing continuation reminders", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const internalGoalPrompt = [
      '<system-reminder source="goal-continuation">',
      "Continue working toward the active session goal.",
      "",
      "<untrusted_objective>",
      "优化性能到 60fps",
      "</untrusted_objective>",
      "</system-reminder>",
    ].join("\n");

    const meta = await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_goal", "/repo", {
        title: internalGoalPrompt,
        userMessageText: internalGoalPrompt,
        target: {
          sessionId: "sess_goal",
          targetId: "goal_1",
          objective: "优化性能到 60fps",
          summaryTitle: "优化性能到 60fps",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      { broadcastReason: "task_meta_changed" },
    );

    // Bugfix: /goal 自动续跑的内部 reminder wrapper 只是模型输入，不是用户可见 query。
    // 标题可以回退到真实 goal objective，但正文搜索索引不能写入内部安全封装文本。
    expect(meta.title).toBe("优化性能到 60fps");
    expect(meta.target).toMatchObject({
      objective: "优化性能到 60fps",
      summaryTitle: "优化性能到 60fps",
      targetID: "goal_1",
    });

    const objectiveResult = await env.repo.queryTaskList({
      workspaceScopes: [{ workspacePath: "/repo" }],
      search: "60fps",
    });
    expect(objectiveResult.total).toBe(1);
    const persisted = await env.repo.getTaskMeta({
      workspacePath: "/repo",
      taskId: "sess_goal",
    });
    expect(persisted?.target).toMatchObject({
      objective: "优化性能到 60fps",
      summaryTitle: "优化性能到 60fps",
      targetID: "goal_1",
    });

    const internalPromptResult = await env.repo.queryTaskList({
      workspaceScopes: [{ workspacePath: "/repo" }],
      search: "system-reminder",
    });
    expect(internalPromptResult.total).toBe(0);

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast preserves indexed goal when snapshot omits target", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_goal_preserve", "/repo", {
        target: {
          sessionId: "sess_goal_preserve",
          targetId: "goal_keep",
          objective: "保留历史目标",
          summaryTitle: null,
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      { broadcastReason: "task_meta_changed" },
    );

    const omittedTargetSnapshot = snapshotWith("sess_goal_preserve", "/repo", {
      title: "继续处理历史任务",
      userMessageText: "继续处理历史任务",
    });
    delete omittedTargetSnapshot.projection.target;
    await syncer.syncSnapshotAndBroadcast(omittedTargetSnapshot, {
      broadcastReason: "task_meta_changed",
    });
    expect(
      (
        await env.repo.getTaskMeta({
          workspacePath: "/repo",
          taskId: "sess_goal_preserve",
        })
      )?.target,
    ).toMatchObject({
      objective: "保留历史目标",
      targetID: "goal_keep",
    });

    await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_goal_preserve", "/repo", {
        title: "明确清空历史目标",
        userMessageText: "明确清空历史目标",
        target: null,
      }),
      { broadcastReason: "task_meta_changed" },
    );
    expect(
      (
        await env.repo.getTaskMeta({
          workspacePath: "/repo",
          taskId: "sess_goal_preserve",
        })
      )?.target,
    ).toBeNull();

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast writes sqlite but skips broadcast when snapshot has no user content", async () => {
    // Bugfix: createSession 刚返回时 snapshot 既没有 title 也没有 user message，
    // 此时不应该广播 workspace_task_list_changed，否则侧边栏会先闪一下 "New session" 占位符。
    // sqlite 行仍然要写，让后续 session.titleUpdated (source="first_input") 的 applyAgentPatch 能找到行。
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const broadcasts: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: "/repo",
    })((event) => broadcasts.push(event));

    await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_empty", "/repo", {
        title: "",
        // 不带 userMessageText → snapshot.messages 为空
        updatedAt: 1,
      }),
      { broadcastReason: "task_meta_changed" },
    );

    expect(broadcasts.length).toBe(0);
    // sqlite 行应该已经写入，等待后续 applyAgentPatch 找得到
    const persisted = await env.repo.getTaskMeta({
      workspacePath: "/repo",
      taskId: "sess_empty",
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.taskId).toBe("sess_empty");

    subscription.dispose();
    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast can place desktop-created sessions at the grouped view top", async () => {
    const env = setupEnv();
    await env.repo.syncTaskMeta({
      meta: {
        taskId: "older-task",
        traceId: "trace_older",
        title: "Older task",
        workspacePath: "/repo",
        createdAt: 10,
        updatedAt: 10,
        mode: "build",
        status: "completed",
      },
    });
    await env.repo.syncTaskMeta({
      meta: {
        taskId: "newer-existing-task",
        traceId: "trace_newer_existing",
        title: "Newer existing task",
        workspacePath: "/repo",
        createdAt: 20,
        updatedAt: 20,
        mode: "build",
        status: "completed",
      },
    });
    await env.repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    await syncer.syncSnapshotAndBroadcast(
      snapshotWith("desktop-created-task", "/repo", {
        title: "Desktop created task",
        userMessageText: "Desktop created task",
        createdAt: 30,
        updatedAt: 30,
      }),
      { moveGroupedTaskToTop: true },
    );

    const view = await env.repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    expect(view.nodes[0]).toMatchObject({
      type: "task",
      task: { taskId: "desktop-created-task" },
    });

    syncer.disposeAll();
  });

  it("does not reorder an existing task when duplicate first-snapshot sync finishes late", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    // 先完成空 workspace 的一次性 grouped bootstrap，后续 task 才按真实新建路径进入 root。
    await env.repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    const firstTask = snapshotWith("first-task", "/repo", {
      title: "First task",
      userMessageText: "First task",
      createdAt: 10,
      updatedAt: 10,
    });
    const secondTask = snapshotWith("second-task", "/repo", {
      title: "Second task",
      userMessageText: "Second task",
      createdAt: 20,
      updatedAt: 20,
    });

    await syncer.syncSnapshotAndBroadcast(firstTask, {
      moveGroupedTaskToTop: true,
      broadcastReason: "task_status_changed",
    });
    await syncer.syncSnapshotAndBroadcast(secondTask, {
      moveGroupedTaskToTop: true,
      broadcastReason: "task_status_changed",
    });
    // Bugfix 回归：可见状态与首标题缺行可能让 first-task 的重复回源晚于 second-task 完成。
    // 重复 snapshot 只能更新 meta，不能再次给 first-task 分配更小的顶层 sort_order。
    await syncer.syncSnapshotAndBroadcast(firstTask, {
      moveGroupedTaskToTop: true,
      broadcastReason: "task_status_changed",
    });

    const view = await env.repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    expect(view.nodes.slice(0, 2)).toMatchObject([
      { type: "task", task: { taskId: "second-task" } },
      { type: "task", task: { taskId: "first-task" } },
    ]);

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast preserves a newer sqlite updated_at (no regression)", async () => {
    // Bugfix: snapshot 的 session.updatedAt 是 runtime sessionStore 里的"结构变更时间"，
    // 不一定包含 session.titleUpdated / turn.completed 这些事件触发的 Date.now() 增量。
    // 如果直接用 snapshot.updatedAt 覆盖会让刚被 applyAgentPatch 写入的更新时间倒退，
    // 表现就是新会话第一次 prompt 后又被压到列表底部。
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    // 先写一条 sqlite 行，updated_at 是较新的时间戳（模拟 applyAgentPatch 已经写过一次 Date.now()）
    await env.repo.syncTaskMeta({
      meta: {
        taskId: "sess_regress",
        traceId: "trace_seed",
        title: "你好",
        workspacePath: "/repo",
        createdAt: 100,
        updatedAt: 99999,
        mode: "build",
      },
    });

    // 用一个较旧的 snapshot.updatedAt 触发 sync
    await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_regress", "/repo", {
        title: "你好",
        userMessageText: "你好",
        createdAt: 100,
        updatedAt: 100, // 远小于 sqlite 已有的 99999
      }),
      { broadcastReason: "task_meta_changed" },
    );

    const persisted = await env.repo.getTaskMeta({
      workspacePath: "/repo",
      taskId: "sess_regress",
    });
    // 期望 updated_at 不会倒退
    expect(persisted?.updatedAt).toBe(99999);

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast does not downgrade newer terminal status with an older running snapshot", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    await env.repo.syncTaskMeta({
      meta: {
        taskId: "sess_terminal_status",
        traceId: "trace_complete",
        title: "阅读这个项目",
        workspacePath: "/repo",
        createdAt: 100,
        updatedAt: 99_999,
        mode: "build",
        status: "completed",
      },
    });

    await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_terminal_status", "/repo", {
        title: "阅读这个项目",
        userMessageText: "阅读这个项目",
        createdAt: 100,
        updatedAt: 100,
      }),
      { broadcastReason: "task_meta_changed" },
    );

    const persisted = await env.repo.getTaskMeta({
      workspacePath: "/repo",
      taskId: "sess_terminal_status",
    });

    expect(persisted?.updatedAt).toBe(99_999);
    expect(persisted?.status).toBe("completed");

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast repairs running status when snapshot has a completed assistant turn", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    await env.repo.syncTaskMeta({
      meta: {
        taskId: "sess_repair_terminal",
        traceId: "trace_running",
        title: "阅读这个项目",
        workspacePath: "/repo",
        createdAt: 100,
        updatedAt: 100,
        mode: "build",
        status: "running",
      },
    });

    await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_repair_terminal", "/repo", {
        title: "阅读这个项目",
        userMessageText: "阅读这个项目",
        assistantMessageText: "以下是该项目的完整概览。",
        assistantCompletedAt: 130,
        createdAt: 100,
        updatedAt: 120,
      }),
      { broadcastReason: "task_meta_changed" },
    );

    const persisted = await env.repo.getTaskMeta({
      workspacePath: "/repo",
      taskId: "sess_repair_terminal",
    });

    expect(persisted?.status).toBe("completed");

    syncer.disposeAll();
  });

  it("syncSnapshotAndBroadcast keeps idle completed snapshots terminal in sqlite", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    await env.repo.syncTaskMeta({
      meta: {
        taskId: "sess_idle_completed",
        traceId: "trace_idle_completed",
        title: "切换项目后继续对话",
        workspacePath: "/repo",
        createdAt: 100,
        updatedAt: 100,
        mode: "build",
        status: "running",
      },
    });

    await syncer.syncSnapshotAndBroadcast(
      snapshotWith("sess_idle_completed", "/repo", {
        title: "切换项目后继续对话",
        userMessageText: "继续",
        assistantMessageText: "已经处理完成。",
        assistantCompletedAt: 130,
        sessionStatus: "idle",
        createdAt: 100,
        updatedAt: 130,
      }),
      { broadcastReason: "task_meta_changed" },
    );

    const persisted = await env.repo.getTaskMeta({
      workspacePath: "/repo",
      taskId: "sess_idle_completed",
    });

    expect(persisted?.status).toBe("completed");

    syncer.disposeAll();
  });

  it("only subscribes the workspace once even across many sessions", async () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureSessionSubscription(seedTarget);
    syncer.ensureSessionSubscription(seedTarget);
    syncer.ensureSessionSubscription({
      workspacePath: seedTarget.workspacePath,
      sessionId: "another_session",
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: seedTarget.workspacePath });
    await subscribed(env);

    expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(1);
    // 与 renderer 侧栏共 topic 不同代际：syncer 必须带独立 subscriberScope。
    expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberScope: "task-index" }),
    );

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("stages same-read index/config initial notifications and releases only the ACK subId", async () => {
    const env = setupEnv();
    await seedRunningTask(env.repo);
    let resolveIndex!: (result: IndexSubscribeResult) => void;
    vi.mocked(env.agent.subscribeSessionsIndexV4).mockImplementationOnce(
      () => new Promise((resolve) => (resolveIndex = resolve)),
    );
    vi.mocked(env.agent.subscribeWorkspaceConfigV4).mockImplementationOnce(async () => {
      env.configEmitter.fire(
        configFrame({
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "anthropic/haiku-4.5",
              options: [{ value: "anthropic/haiku-4.5", name: "Haiku 4.5" }],
            },
          ],
          slashCommands: [],
        }),
      );
      return {
        ack: {
          subscriptionId: CONFIG_SUBSCRIPTION_ID,
          mode: "snapshot" as const,
          logEpoch: "epoch-cfg",
        },
      };
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const workspaceEvents: ZCodeWorkspaceEvent[] = [];
    const terminalEvents: string[] = [];
    const workspaceSubscription = syncer.onDynamicWorkspaceEvent({ workspacePath: "/repo" })(
      (event) => workspaceEvents.push(event),
    );
    const terminalSubscription = syncer.onSessionTerminalEvent((event) =>
      terminalEvents.push(event.target.sessionId),
    );
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await vi.waitFor(() => expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));

    env.indexEmitter.fire({
      ...indexSnapshotFrame([summaryOf(seedTarget.sessionId, "completedSuccess")]),
      subscriptionId: "foreign-sub",
    });
    env.indexEmitter.fire(indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")]));
    resolveIndex({
      ack: {
        subscriptionId: INDEX_SUBSCRIPTION_ID,
        mode: "snapshot",
        logEpoch: "epoch-test",
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess")));
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.status).toBe("completed");
    });
    expect(terminalEvents).toEqual([seedTarget.sessionId]);
    expect(workspaceEvents.some((event) => event.type === "workspace_config_options_update")).toBe(
      true,
    );

    terminalSubscription.dispose();
    workspaceSubscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("physical sessions-index 分片在最后一片前不修改 task index，齐片后只 apply 一次", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const terminalEvents: string[] = [];
    const terminalSubscription = syncer.onSessionTerminalEvent((event) =>
      terminalEvents.push(event.target.sessionId),
    );
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    const logical = indexUpsertFrame(
      summaryOf(seedTarget.sessionId, "completedSuccess", { title: "中文🙂".repeat(300) }),
    );
    const wires = encodeTopicWireFrames(logical, {
      topic: logical.topic,
      subscriptionId: logical.subscriptionId,
      logicalFrameId: "logical-index-fragmented",
      logicalFrameOrdinal: 1_000,
      deliveryKind: "online",
      maxPhysicalFrameBytes: 500,
      measurePhysicalFrameBytes: utf8JsonByteLength,
    }) as SessionsIndexTopicWireFrame[];
    expect(wires.length).toBeGreaterThan(2);
    for (const wire of wires.slice(0, -1)) {
      env.indexEmitter.fireWire(wire);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      (
        await env.repo.getTaskMeta({
          workspacePath: seedTarget.workspacePath,
          taskId: seedTarget.sessionId,
        })
      )?.status,
    ).toBe("running");
    expect(terminalEvents).toEqual([]);

    env.indexEmitter.fireWire(wires.at(-1)!);
    await vi.waitFor(async () => {
      expect(
        (
          await env.repo.getTaskMeta({
            workspacePath: seedTarget.workspacePath,
            taskId: seedTarget.sessionId,
          })
        )?.status,
      ).toBe("completed");
    });
    expect(terminalEvents).toEqual([seedTarget.sessionId]);

    terminalSubscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("physical superseded fault 与 newer complete 同批出现时 task index fail closed", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const terminalEvents: string[] = [];
    const terminalSubscription = syncer.onSessionTerminalEvent((event) =>
      terminalEvents.push(event.target.sessionId),
    );
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    const oldLogical = indexUpsertFrame(
      summaryOf(seedTarget.sessionId, "completedSuccess", { title: "old".repeat(500) }),
    );
    const oldWires = encodeTopicWireFrames(oldLogical, {
      topic: oldLogical.topic,
      subscriptionId: oldLogical.subscriptionId,
      logicalFrameId: "logical-index-old-partial",
      logicalFrameOrdinal: 1_000,
      deliveryKind: "online",
      maxPhysicalFrameBytes: 500,
      measurePhysicalFrameBytes: utf8JsonByteLength,
    }) as SessionsIndexTopicWireFrame[];
    env.indexEmitter.fireWire(oldWires[0]!);

    const newer = indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"));
    env.indexEmitter.fireWire({
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: "logical-index-newer",
      logicalFrameOrdinal: 1_001,
      topic: newer.topic,
      subscriptionId: newer.subscriptionId,
      frame: newer,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      (
        await env.repo.getTaskMeta({
          workspacePath: seedTarget.workspacePath,
          taskId: seedTarget.sessionId,
        })
      )?.status,
    ).toBe("running");
    expect(terminalEvents).toEqual([]);

    terminalSubscription.dispose();
    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("stale subscribe ACK cannot replace the new generation and is unsubscribed", async () => {
    const env = setupEnv();
    await seedRunningTask(env.repo);
    const restartEmitter = new Emitter<{ workspaceKey: string }>();
    (env.agent as { onAgentRuntimeRestarted?: unknown }).onAgentRuntimeRestarted =
      restartEmitter.event;
    const resolvers: Array<(result: IndexSubscribeResult) => void> = [];
    vi.mocked(env.agent.subscribeSessionsIndexV4).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    env.indexEmitter.fire(indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")]));

    restartEmitter.fire({ workspaceKey: "/repo" });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    env.indexEmitter.fire({
      ...indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")]),
      subscriptionId: "six-test-2",
    });
    resolvers[1]!({
      ack: {
        subscriptionId: "six-test-2",
        mode: "snapshot",
        logEpoch: "epoch-test-2",
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    resolvers[0]!({
      ack: {
        subscriptionId: INDEX_SUBSCRIPTION_ID,
        mode: "snapshot",
        logEpoch: "epoch-test",
      },
    });
    await vi.waitFor(() =>
      expect(env.agent.unsubscribeSessionsIndexV4).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: INDEX_SUBSCRIPTION_ID }),
      ),
    );

    env.indexEmitter.fire({
      ...indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess")),
      subscriptionId: "six-test-2",
    });
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.status).toBe("completed");
    });

    syncer.disposeAll();
    restartEmitter.dispose();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("dispose clears staged frames and unsubscribes ACKs that resolve after close", async () => {
    const env = setupEnv();
    let resolveIndex!: (result: IndexSubscribeResult) => void;
    vi.mocked(env.agent.subscribeSessionsIndexV4).mockImplementationOnce(
      () => new Promise((resolve) => (resolveIndex = resolve)),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await vi.waitFor(() => expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    env.indexEmitter.fire(indexSnapshotFrame([summaryOf("staged-after-close", "running")]));

    syncer.disposeAll();
    resolveIndex({
      ack: {
        subscriptionId: INDEX_SUBSCRIPTION_ID,
        mode: "snapshot",
        logEpoch: "epoch-test",
      },
    });
    await vi.waitFor(() => {
      expect(env.agent.unsubscribeSessionsIndexV4).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: INDEX_SUBSCRIPTION_ID }),
      );
      expect(env.agent.unsubscribeWorkspaceConfigV4).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: CONFIG_SUBSCRIPTION_ID }),
      );
    });

    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("staging overflow 自动恢复且不会永久 freeze", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    let resolveIndex!: (result: IndexSubscribeResult) => void;
    vi.mocked(env.agent.subscribeSessionsIndexV4).mockImplementationOnce(
      () => new Promise((resolve) => (resolveIndex = resolve)),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await vi.waitFor(() => expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 1_025; index += 1) {
      env.indexEmitter.fire({
        ...indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")]),
        toSeq: index,
      });
    }
    resolveIndex({
      ack: {
        subscriptionId: INDEX_SUBSCRIPTION_ID,
        mode: "snapshot",
        logEpoch: "epoch-test",
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    // pre-ACK overflow 没有可证明 base，必须仅换代 index topic 的 fresh snapshot。
    await vi.waitFor(() => expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2));
    expect(env.agent.resyncSessionsIndexV4).not.toHaveBeenCalled();
    expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(1);
    expect(env.agent.subscribeSessionsIndexV4).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspacePath: "/repo",
        visibility: "background",
        subscriberScope: "task-index",
        runtimePolicy: "existing-only",
      }),
    );

    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"), 2));
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.status).toBe("completed");
    });

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("sessions-index initial assembly fault 不拿 ACK epoch 伪造 base，强制恢复冷 baseline", async () => {
    const cold = summaryOf(seedTarget.sessionId, "running");
    const env = setupEnv();
    await seedRunningTask(env.repo);
    vi.mocked(env.agent.subscribeSessionsIndexV4).mockImplementationOnce(async () => {
      // ACK 前到达但 logical payload 非法：activation 后 assembler 产 typed fault，
      // 这时客户端尚未原子 apply 任何 snapshot，ACK 本身不能证明 base=(epoch,0)。
      env.indexEmitter.fire(
        {
          topic: "sessions-index//repo",
          subscriptionId: INDEX_SUBSCRIPTION_ID,
          fromSeq: 0,
          toSeq: 0,
          sentAt: 1,
          payload: { kind: "deltas", deltas: [{ op: "invalid" }] },
        } as unknown as SessionsIndexTopicFrame,
        "initial",
      );
      return {
        ack: {
          subscriptionId: INDEX_SUBSCRIPTION_ID,
          mode: "snapshot" as const,
          logEpoch: "epoch-test",
        },
      };
    });
    let releaseRecovery!: () => void;
    vi.mocked(env.agent.resyncSessionsIndexV4).mockImplementationOnce(
      (params) =>
        new Promise<IndexResyncResult>((resolve) => {
          releaseRecovery = () => {
            env.indexEmitter.fire(indexSnapshotFrame([cold], 1), "recovery");
            resolve({
              ack: {
                subscriptionId: params.subscriptionId,
                mode: "snapshot",
                logEpoch: "epoch-test",
              },
            });
          };
        }),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });

    await vi.waitFor(() =>
      expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: "/repo",
          subscriptionId: INDEX_SUBSCRIPTION_ID,
          base: null,
          forceSnapshot: true,
        }),
      ),
    );
    // 整个 initial batch 丢失后，数值上衔接的 online delta 也不能抢先建立 baseline。
    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"), 1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      (
        await env.repo.getTaskMeta({
          workspacePath: seedTarget.workspacePath,
          taskId: seedTarget.sessionId,
        })
      )?.status,
    ).toBe("running");
    releaseRecovery();
    await new Promise((resolve) => setImmediate(resolve));
    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"), 2));
    await vi.waitFor(async () => {
      expect(
        (
          await env.repo.getTaskMeta({
            workspacePath: seedTarget.workspacePath,
            taskId: seedTarget.sessionId,
          })
        )?.status,
      ).toBe("completed");
    });

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("workspace-config initial assembly fault 仅以已 apply 状态为 base", async () => {
    const env = setupEnv();
    const recoveredConfig: WorkspaceConfigState = {
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "anthropic/haiku",
          options: [],
        },
      ],
      slashCommands: [],
    };
    vi.mocked(env.agent.subscribeWorkspaceConfigV4).mockImplementationOnce(async () => {
      env.configEmitter.fire(
        {
          topic: "workspace-config//repo",
          subscriptionId: CONFIG_SUBSCRIPTION_ID,
          fromSeq: 0,
          toSeq: 0,
          sentAt: 1,
          payload: { kind: "deltas", deltas: [{ op: "invalid" }] },
        } as unknown as WorkspaceConfigTopicFrame,
        "initial",
      );
      return {
        ack: {
          subscriptionId: CONFIG_SUBSCRIPTION_ID,
          mode: "snapshot" as const,
          logEpoch: "epoch-cfg",
        },
      };
    });
    vi.mocked(env.agent.resyncWorkspaceConfigV4).mockImplementationOnce(async (params) => {
      if (params.forceSnapshot) {
        env.configEmitter.fire(configFrame(recoveredConfig, 1), "recovery");
      } else {
        env.configEmitter.fire(
          {
            topic: "workspace-config//repo",
            subscriptionId: CONFIG_SUBSCRIPTION_ID,
            fromSeq: 0,
            toSeq: 0,
            sentAt: 2,
            payload: { kind: "deltas", deltas: [] },
          },
          "recovery",
        );
      }
      return {
        ack: {
          subscriptionId: params.subscriptionId,
          mode: params.forceSnapshot ? ("snapshot" as const) : ("resume" as const),
          logEpoch: "epoch-cfg",
        },
      };
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const workspaceEvents: ZCodeWorkspaceEvent[] = [];
    syncer.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) =>
      workspaceEvents.push(event),
    );
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });

    await vi.waitFor(() =>
      expect(env.agent.resyncWorkspaceConfigV4).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: "/repo",
          subscriptionId: CONFIG_SUBSCRIPTION_ID,
          base: null,
          forceSnapshot: true,
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        workspaceEvents.some(
          (event) =>
            event.type === "workspace_config_options_update" &&
            event.configOptions[0]?.currentValue === "anthropic/haiku",
        ),
      ).toBe(true),
    );

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("sessions-index gap 只恢复 index，workspace-config sibling 保持可用", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const workspaceEvents: ZCodeWorkspaceEvent[] = [];
    syncer.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) =>
      workspaceEvents.push(event),
    );
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    env.indexEmitter.fire(
      indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"), 99),
    );
    await vi.waitFor(() => expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(1));
    expect(env.agent.resyncWorkspaceConfigV4).not.toHaveBeenCalled();
    expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(1);

    env.configEmitter.fire(
      configFrame({
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "anthropic/haiku",
            options: [],
          },
        ],
        slashCommands: [],
      }),
    );
    await vi.waitFor(() =>
      expect(
        workspaceEvents.some((event) => event.type === "workspace_config_options_update"),
      ).toBe(true),
    );

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("recovery assembly fault 早于 snapshot ACK 时 fresh-subscribe index 而不悬空 flight", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    let resolveResync!: (result: IndexResyncResult) => void;
    vi.mocked(env.agent.resyncSessionsIndexV4).mockImplementationOnce(
      () => new Promise((resolve) => (resolveResync = resolve)),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    // online gap 启动 same-sub recovery。
    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "running"), 99));
    await vi.waitFor(() => expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(1));

    // 同 ordinal 不同 logical id 产生 typed fault；deliveryKind 在 fault.fault 层。
    const invalidRecoveryFrame = indexUpsertFrame(
      summaryOf(seedTarget.sessionId, "completedSuccess"),
      100,
    );
    env.indexEmitter.fireWire({
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "recovery",
      logicalFrameId: "conflicting-recovery-id",
      logicalFrameOrdinal: 2,
      topic: invalidRecoveryFrame.topic,
      subscriptionId: invalidRecoveryFrame.subscriptionId,
      frame: invalidRecoveryFrame,
    });
    resolveResync({
      ack: {
        subscriptionId: INDEX_SUBSCRIPTION_ID,
        mode: "snapshot",
        logEpoch: "epoch-test",
      },
    });

    await vi.waitFor(() => expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2));
    expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(1);

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("recovery flight 中缺失 deliveryKind 的 owned fault 会升级强制 snapshot", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "running"), 99));
    await vi.waitFor(() => expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(1));
    const invalid = indexUpsertFrame(summaryOf(seedTarget.sessionId, "running"), 100);
    env.indexEmitter.fireWire({
      wireVersion: 3,
      kind: "complete",
      // candidate 允许先进 owned assembler 再产生 typed fault；此处故意伪造非法值。
      deliveryKind: "invalid-kind",
      logicalFrameId: "invalid-delivery-kind",
      logicalFrameOrdinal: 3,
      topic: invalid.topic,
      subscriptionId: invalid.subscriptionId,
      frame: invalid,
    } as unknown as SessionsIndexTopicWireFrame);

    await vi.waitFor(() => expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(2));
    expect(vi.mocked(env.agent.resyncSessionsIndexV4).mock.calls[1]?.[0]).toMatchObject({
      subscriptionId: INDEX_SUBSCRIPTION_ID,
      base: null,
      forceSnapshot: true,
    });

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("workspace-config recovery gap 早于 snapshot ACK 时仅 fresh-subscribe config", async () => {
    const env = setupEnv();
    let resolveResync!: (result: ConfigResyncResult) => void;
    vi.mocked(env.agent.resyncWorkspaceConfigV4).mockImplementationOnce(
      () => new Promise((resolve) => (resolveResync = resolve)),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);
    const config: WorkspaceConfigState = {
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "anthropic/haiku",
          options: [],
        },
      ],
      slashCommands: [],
    };
    env.configEmitter.fire(configFrame(config));
    env.configEmitter.fire(configDeltaFrame(config, 99));
    await vi.waitFor(() => expect(env.agent.resyncWorkspaceConfigV4).toHaveBeenCalledTimes(1));

    env.configEmitter.fire(configDeltaFrame(config, 100), "recovery");
    resolveResync({
      ack: {
        subscriptionId: CONFIG_SUBSCRIPTION_ID,
        mode: "snapshot",
        logEpoch: "epoch-cfg",
      },
    });
    await vi.waitFor(() => expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(2));
    expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("sessions-index duplicate delta 静默丢弃且不重复发射 terminal", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const terminals: string[] = [];
    syncer.onSessionTerminalEvent((event) => terminals.push(event.kind));
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"), 2));
    await vi.waitFor(() => expect(terminals).toEqual(["turn.completed"]));
    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "error"), 2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(terminals).toEqual(["turn.completed"]);
    expect(env.agent.resyncSessionsIndexV4).not.toHaveBeenCalled();

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("sessions-index recovery 后同 read residual online gap 启动 successor", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    let attempt = 0;
    vi.mocked(env.agent.resyncSessionsIndexV4).mockImplementation(async (params) => {
      attempt += 1;
      if (attempt === 1) {
        env.indexEmitter.fire(
          indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"), 2),
          "recovery",
        );
        env.indexEmitter.fire(
          indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"), 4),
          "online",
        );
      } else {
        env.indexEmitter.fire(
          {
            topic: "sessions-index//repo",
            subscriptionId: INDEX_SUBSCRIPTION_ID,
            fromSeq: 2,
            toSeq: 2,
            sentAt: 4,
            payload: { kind: "deltas", deltas: [] },
          },
          "recovery",
        );
      }
      return {
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "resume" as const,
          logEpoch: "epoch-test",
        },
      };
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess"), 3));
    await vi.waitFor(async () => {
      expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(2);
      expect(
        (
          await env.repo.getTaskMeta({
            workspacePath: seedTarget.workspacePath,
            taskId: seedTarget.sessionId,
          })
        )?.status,
      ).toBe("completed");
    });
    expect(vi.mocked(env.agent.resyncSessionsIndexV4).mock.calls[1]?.[0]).toMatchObject({
      subscriptionId: INDEX_SUBSCRIPTION_ID,
      base: { logEpoch: "epoch-test", seq: 2 },
    });
    expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("workspace-config recovery 后 residual online gap 只启动 config successor", async () => {
    const env = setupEnv();
    const config: WorkspaceConfigState = {
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "anthropic/haiku",
          options: [],
        },
      ],
      slashCommands: [],
    };
    let attempt = 0;
    vi.mocked(env.agent.resyncWorkspaceConfigV4).mockImplementation(async (params) => {
      attempt += 1;
      if (attempt === 1) {
        env.configEmitter.fire(configDeltaFrame(config, 2), "recovery");
        env.configEmitter.fire(configDeltaFrame(config, 4), "online");
      } else {
        env.configEmitter.fire(
          {
            topic: "workspace-config//repo",
            subscriptionId: CONFIG_SUBSCRIPTION_ID,
            fromSeq: 2,
            toSeq: 2,
            sentAt: 5,
            payload: { kind: "deltas", deltas: [] },
          },
          "recovery",
        );
      }
      return {
        ack: { subscriptionId: params.subscriptionId, mode: "resume", logEpoch: "epoch-cfg" },
      };
    });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);
    env.configEmitter.fire(configFrame(config, 1));
    env.configEmitter.fire(configDeltaFrame(config, 3));

    await vi.waitFor(() => expect(env.agent.resyncWorkspaceConfigV4).toHaveBeenCalledTimes(2));
    expect(vi.mocked(env.agent.resyncWorkspaceConfigV4).mock.calls[1]?.[0]).toMatchObject({
      subscriptionId: CONFIG_SUBSCRIPTION_ID,
      base: { logEpoch: "epoch-cfg", seq: 2 },
    });
    expect(env.agent.resyncSessionsIndexV4).not.toHaveBeenCalled();

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("online snapshot 覆盖在途 recovery 后，重复 recovery 可正常收口", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    let resolveRecovery!: (result: IndexResyncResult) => void;
    vi.mocked(env.agent.resyncSessionsIndexV4).mockImplementationOnce(
      () => new Promise((resolve) => (resolveRecovery = resolve)),
    );
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);
    env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "running"), 3));
    await vi.waitFor(() => expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(1));

    env.indexEmitter.fire(indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")], 5));
    env.indexEmitter.fire(
      {
        topic: "sessions-index//repo",
        subscriptionId: INDEX_SUBSCRIPTION_ID,
        fromSeq: 1,
        toSeq: 5,
        sentAt: 5,
        payload: {
          kind: "deltas",
          deltas: [{ op: "session.upserted", session: summaryOf(seedTarget.sessionId, "running") }],
        },
      },
      "recovery",
    );
    resolveRecovery({
      ack: { subscriptionId: INDEX_SUBSCRIPTION_ID, mode: "resume", logEpoch: "epoch-test" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(1);

    syncer.disposeAll();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("index/config recovery ACK 后零 wire：30s 强制一次，再超时 topic-local fresh", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    const config: WorkspaceConfigState = {
      configOptions: [
        { id: "model", name: "Model", type: "select", currentValue: "m", options: [] },
      ],
      slashCommands: [],
    };
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);
    env.configEmitter.fire(configFrame(config, 1));

    vi.useFakeTimers();
    try {
      env.indexEmitter.fire(indexUpsertFrame(summaryOf(seedTarget.sessionId, "running"), 99));
      env.configEmitter.fire(configDeltaFrame(config, 99));
      await Promise.resolve();
      await Promise.resolve();
      expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(env.agent.resyncWorkspaceConfigV4).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      expect(env.agent.resyncSessionsIndexV4).toHaveBeenCalledTimes(2);
      expect(env.agent.resyncWorkspaceConfigV4).toHaveBeenCalledTimes(2);
      expect(vi.mocked(env.agent.resyncSessionsIndexV4).mock.calls[1]?.[0]).toMatchObject({
        forceSnapshot: true,
      });
      expect(vi.mocked(env.agent.resyncWorkspaceConfigV4).mock.calls[1]?.[0]).toMatchObject({
        forceSnapshot: true,
      });

      await vi.advanceTimersByTimeAsync(PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
      expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(2);
    } finally {
      syncer.disposeAll();
      vi.useRealTimers();
      env.indexEmitter.dispose();
      env.configEmitter.dispose();
    }
  });

  it("provider/model 未就绪时不写 warn，低频探测后自动恢复两个 topic", async () => {
    const env = setupEnv();
    const providerNotReadyError = Object.assign(
      new Error("当前没有可用的模型供应商和模型，请先登录或配置 API Key。"),
      { code: ZCODE_AGENT_PROVIDER_NOT_READY_CODE },
    );
    vi.mocked(env.agent.subscribeSessionsIndexV4).mockRejectedValueOnce(providerNotReadyError);
    vi.mocked(env.agent.subscribeWorkspaceConfigV4).mockRejectedValueOnce(providerNotReadyError);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    vi.useFakeTimers();
    try {
      syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
      await vi.advanceTimersByTimeAsync(0);
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
      expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
      expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(2);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      syncer.disposeAll();
      vi.useRealTimers();
      warnSpy.mockRestore();
      env.indexEmitter.dispose();
      env.configEmitter.dispose();
    }
  });

  it("持续订阅故障使用固定 retry reason，并将相同 topic 的 warn 限频到每分钟一次", async () => {
    const env = setupEnv();
    const persistentError = new Error("persistent topic failure");
    vi.mocked(env.agent.subscribeSessionsIndexV4).mockRejectedValue(persistentError);
    vi.mocked(env.agent.subscribeWorkspaceConfigV4).mockRejectedValue(persistentError);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });

    vi.useFakeTimers();
    try {
      syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
      await vi.advanceTimersByTimeAsync(0);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(warnSpy).toHaveBeenCalledTimes(4);
      const messages = warnSpy.mock.calls.map((call) => String(call[1]));
      expect(messages.filter((message) => message.includes("reason=initial"))).toHaveLength(2);
      expect(messages.filter((message) => message.includes("reason=retry"))).toHaveLength(2);
      expect(messages.every((message) => !message.includes("retry:retry"))).toBe(true);
    } finally {
      syncer.disposeAll();
      vi.useRealTimers();
      warnSpy.mockRestore();
      env.indexEmitter.dispose();
      env.configEmitter.dispose();
    }
  });

  // M5 ③-2（CLI 重连重订）：进程换代后订阅静默失活，syncer 必须重发 subscribe
  // 并按新 subscriptionId 闸门继续摄入帧。
  it("re-subscribes workspace topics after an agent runtime restart and accepts new-generation frames", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    await seedRunningTask(env.repo);
    const restartEmitter = new Emitter<{ workspaceKey: string }>();
    (env.agent as { onAgentRuntimeRestarted?: unknown }).onAgentRuntimeRestarted =
      restartEmitter.event;
    // 第二代订阅换 id：重启后旧 id 的帧必须被闸门丢弃，新 id 的帧被接受。
    vi.mocked(env.agent.subscribeSessionsIndexV4)
      .mockImplementationOnce(async () => {
        env.indexEmitter.fire(indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")]));
        return {
          ack: {
            subscriptionId: INDEX_SUBSCRIPTION_ID,
            mode: "snapshot" as const,
            logEpoch: "epoch-test",
          },
        };
      })
      .mockImplementationOnce(async () => {
        env.indexEmitter.fire({
          ...indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")]),
          subscriptionId: "six-test-2",
        });
        return {
          ack: {
            subscriptionId: "six-test-2",
            mode: "snapshot" as const,
            logEpoch: "epoch-test-2",
          },
        };
      });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureSessionSubscription(seedTarget);
    await subscribed(env);
    expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);

    restartEmitter.fire({ workspaceKey: seedTarget.workspacePath });
    await vi.waitFor(() => {
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
      expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setImmediate(resolve));

    // 新代际帧（新 subscriptionId）驱动终态写入。
    env.indexEmitter.fire({
      ...indexUpsertFrame(summaryOf(seedTarget.sessionId, "completedSuccess")),
      subscriptionId: "six-test-2",
    });
    await vi.waitFor(async () => {
      const meta = await env.repo.getTaskMeta({
        workspacePath: seedTarget.workspacePath,
        taskId: seedTarget.sessionId,
      });
      expect(meta?.status).toBe("completed");
    });

    syncer.disposeAll();
    restartEmitter.dispose();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("runtime restart 后 sessions-index 暂态失败独立重试，config 不被撤销", async () => {
    const env = setupEnv({
      initialSessions: [summaryOf(seedTarget.sessionId, "running")],
    });
    const restartEmitter = new Emitter<{ workspaceKey: string }>();
    (env.agent as { onAgentRuntimeRestarted?: unknown }).onAgentRuntimeRestarted =
      restartEmitter.event;
    vi.mocked(env.agent.subscribeSessionsIndexV4)
      .mockImplementationOnce(async () => {
        env.indexEmitter.fire(
          indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")]),
          "initial",
        );
        return {
          ack: {
            subscriptionId: INDEX_SUBSCRIPTION_ID,
            mode: "snapshot" as const,
            logEpoch: "epoch-test",
          },
        };
      })
      .mockRejectedValueOnce(new Error("transient restart failure"))
      .mockImplementationOnce(async () => {
        env.indexEmitter.fire(
          {
            ...indexSnapshotFrame([summaryOf(seedTarget.sessionId, "running")]),
            subscriptionId: "six-test-3",
          },
          "initial",
        );
        return {
          ack: {
            subscriptionId: "six-test-3",
            mode: "snapshot" as const,
            logEpoch: "epoch-test-3",
          },
        };
      });
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.ensureWorkspaceSubscription({ workspacePath: "/repo" });
    await subscribed(env);

    restartEmitter.fire({ workspaceKey: "/repo" });
    await vi.waitFor(() => {
      expect(env.agent.subscribeSessionsIndexV4).toHaveBeenCalledTimes(3);
      expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(2);
    });
    // config 一次就成功，不跟随 index retry 重订。
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(env.agent.subscribeWorkspaceConfigV4).toHaveBeenCalledTimes(2);

    syncer.disposeAll();
    restartEmitter.dispose();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("ignores ensureSessionSubscription after disposeAll", () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    syncer.disposeAll();
    syncer.ensureSessionSubscription(seedTarget);
    expect(env.agent.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    env.indexEmitter.dispose();
    env.configEmitter.dispose();
  });

  it("shares the same workspace emitter across getWorkspaceEmitter and onDynamicWorkspaceEvent", () => {
    const env = setupEnv();
    const syncer = createZCodeTaskIndexSyncer({
      agentService: env.agent,
      taskIndexRepo: env.repo,
    });
    const received: ZCodeWorkspaceEvent[] = [];
    const subscription = syncer.onDynamicWorkspaceEvent({
      workspacePath: "/repo",
    })((event) => received.push(event));

    // adapter 通过 getWorkspaceEmitter 直接 fire 其他类型事件时，订阅者也应该能收到
    syncer.getWorkspaceEmitter({ workspacePath: "/repo" }).fire({
      type: "workspace_config_options_update",
      workspacePath: "/repo",
      configOptions: [],
    } as ZCodeWorkspaceEvent);

    expect(received.length).toBe(1);
    expect(received[0].type).toBe("workspace_config_options_update");

    subscription.dispose();
    syncer.disposeAll();
  });
});
