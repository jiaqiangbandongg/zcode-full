import { readTrustedZCodeAgentV4Connection } from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import {
  readBotGroupRuntimeSnapshot,
  waitBotGroupExecutionEnd,
} from "#src/zcode-agent/groupRuntimeSnapshot.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter, setNetworkTelemetrySink } from "@zcode/rpc";
import type {
  SessionSummary,
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireFrame,
  WorkspaceConfigTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { NetworkObservation } from "@zcode/rpc";
import { getLegacyTaskSessionSnapshotPath, setDataBaseDir } from "../src/paths.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { CuaProductMcpServerResolver } from "../src/cua-permission-broker/index.js";
import type {
  IZCodeAgentService,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentServiceEvent,
} from "../src/zcode-agent/zcodeAgent.js";
import type {
  AppSettings,
  TraceId,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodeProvider,
  ZCodeSessionEvent,
  ZCodeSessionStateSnapshot,
  ZCodeStreamEvent,
  ZCodeWorkspaceStateSnapshot,
} from "@zcode/shared";
import {
  resolveWorkspaceKey,
  ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";

vi.mock("#src/zcode-agent/groupRuntimeSnapshot.js", () => ({
  readBotGroupRuntimeSnapshot: vi.fn(async () => ({})),
  waitBotGroupExecutionEnd: vi.fn(async () => ({})),
}));

const tempDirs: string[] = [];
const disposables: Array<{ disposeAll(): void }> = [];
const BACKGROUND_AGENT_PROVIDER_ERROR =
  "Requests are too frequent. Please reduce your request frequency, wait a short moment, and retry your request.";
const BACKGROUND_AGENT_FAILED_SUMMARY = `Agent general-purpose task "Review" failed. ${BACKGROUND_AGENT_PROVIDER_ERROR}`;

afterEach(() => {
  vi.useRealTimers();
  setNetworkTelemetrySink(null);
  while (disposables.length > 0) {
    disposables.pop()?.disposeAll();
  }
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function useTempDataBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-task-index-"));
  tempDirs.push(dir);
  setDataBaseDir(dir);
  return dir;
}

function makeSnapshot(params: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  model?: ModelSelection;
  messages?: ZCodeMessageWithParts[];
  backgroundJobs?: ZCodeSessionStateSnapshot["projection"]["backgroundJobs"];
}): ZCodeSessionStateSnapshot {
  const workspace = {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    workspaceKey: params.workspaceIdentity ?? params.workspacePath,
  };
  const model = params.model ?? { providerId: "glm", modelId: "glm-4.6" };
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: params.sessionId,
      workspace,
      sessionKind: "interactive",
      title: params.title ?? "Indexed session",
      mode: "build",
      status: "idle",
      model,
      createdAt: params.createdAt ?? 10,
      updatedAt: params.updatedAt ?? 20,
    },
    settings: {
      model: {
        current: model,
        available: [
          {
            ref: model,
            label: model.modelId,
            contextWindow: 128000,
          },
        ],
        lastUsed: model,
      },
      thoughtLevel: {
        enabled: true,
        current: "think",
        available: [{ value: "think", label: "Think" }],
      },
      mode: { current: "build" },
    },
    projection: {
      sessionId: params.sessionId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 128000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: params.backgroundJobs ?? [],
    },
    runtime: { eventSeq: 0, stateRevision: 1, pendingRequestIds: [] },
    messages: params.messages ?? [],
  };
}

function makeUserMessage(params: {
  sessionId: string;
  messageId: string;
  parts?: ZCodeMessageWithParts["parts"];
  text: string;
}): ZCodeMessageWithParts {
  return {
    info: {
      messageId: params.messageId,
      sessionId: params.sessionId,
      role: "user",
      time: { created: 30 },
      agent: "glm",
      model: { providerId: "glm", modelId: "glm-4.6" },
    },
    parts: params.parts ?? [
      {
        partId: `${params.messageId}_part_1`,
        sessionId: params.sessionId,
        messageId: params.messageId,
        type: "text",
        text: params.text,
      },
    ],
  };
}

function makeAssistantAgentToolMessage(params: {
  sessionId: string;
  messageId: string;
  toolCallId: string;
}): ZCodeMessageWithParts {
  return {
    info: {
      messageId: params.messageId,
      sessionId: params.sessionId,
      role: "assistant",
      time: { created: 40, completed: 50 },
      agent: "glm",
      model: { providerId: "glm", modelId: "glm-4.6" },
    },
    parts: [
      {
        partId: `${params.messageId}_tool_1`,
        sessionId: params.sessionId,
        messageId: params.messageId,
        type: "tool",
        callId: params.toolCallId,
        tool: "Agent",
        state: {
          status: "completed",
          input: { prompt: "Explore project structure" },
          output: "Explore summary",
          title: "Agent",
          metadata: {},
          startedAt: 41,
          completedAt: 49,
        },
      },
    ],
  };
}

function createAgentMock() {
  const eventEmitter = new Emitter<ZCodeAgentServiceEvent>();
  const indexFrameEmitter = new Emitter<SessionsIndexTopicWireFrame>();
  const snapshots = new Map<string, ZCodeSessionStateSnapshot>();
  const workspaceState = (params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeWorkspaceStateSnapshot => {
    const snapshot =
      [...snapshots.values()].find(
        (item) =>
          item.session.workspace.workspacePath === params.workspacePath &&
          item.session.workspace.workspaceIdentity === params.workspaceIdentity,
      ) ??
      makeSnapshot({
        sessionId: "draft",
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    return {
      workspace: snapshot.session.workspace,
      settings: snapshot.settings,
    };
  };
  const agent: IZCodeAgentService = {
    initialize: vi.fn(async (params) => ({
      available: true,
      workspaceKey: params.workspaceIdentity ?? params.workspacePath,
      protocolName: "ZCode Protocol",
      protocolVersion: 1,
      transportKind: "stdio",
    })),
    createSession: vi.fn(async (params: ZCodeAgentCreateSessionParams) => {
      const sessionId = params.sessionId ?? `sess_${snapshots.size + 1}`;
      const snapshot = makeSnapshot({
        sessionId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        model: params.model,
        title: params.importedHistory?.title,
        createdAt: params.importedHistory?.createdAt,
        updatedAt: params.importedHistory?.updatedAt,
        messages: params.importedHistory?.messages.map((message, index) =>
          message.role === "assistant"
            ? ({
                info: {
                  messageId: `msg_import_${index}`,
                  sessionId,
                  role: "assistant",
                  time: {
                    created: message.timestamp ?? 30 + index,
                    completed: message.timestamp ?? 30 + index,
                  },
                  parentMessageId: `msg_import_${Math.max(0, index - 1)}`,
                  agent: "glm",
                  model: { providerId: "glm", modelId: "glm-4.6" },
                  path: {
                    cwd: params.workspacePath,
                    root: params.workspacePath,
                  },
                  cost: 0,
                  tokens: {
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                },
                parts: [
                  {
                    partId: `part_import_${index}`,
                    sessionId,
                    messageId: `msg_import_${index}`,
                    type: "text",
                    text: message.content,
                  },
                ],
              } satisfies ZCodeMessageWithParts)
            : makeUserMessage({
                sessionId,
                messageId: `msg_import_${index}`,
                text: message.content,
              }),
        ),
      });
      snapshots.set(snapshot.session.sessionId, snapshot);
      return snapshot;
    }),
    resumeSession: vi.fn(async (params) => {
      const snapshot = snapshots.get(params.sessionId);
      if (!snapshot) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }
      return snapshot;
    }),
    listSessions: vi.fn(async () => {
      throw new Error("listSessions should not be used for task index lists");
    }),
    getTaskTokenUsage: vi.fn(async (params) => ({
      sessionId: params.sessionId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    })),
    readSession: vi.fn(
      async (params) =>
        snapshots.get(params.sessionId) ??
        makeSnapshot({
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
    ),
    readSessionMessages: vi.fn(async () => []),
    readSessionEvents: vi.fn(async () => []),
    readWorkspacePresentation: vi.fn(async (params) => ({
      workspace: workspaceState(params).workspace,
      mode: "build" as const,
      slashCommands: [],
    })),
    sendPrompt: vi.fn(
      async (params) =>
        snapshots.get(params.sessionId) ??
        makeSnapshot({
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
    ),
    // M5 ③-2：send/stop/交互回执主路径收敛 v4 命令面（旧 sendPrompt 仅剩附件回退分支）。
    sendConversationCommandV4: vi.fn(async (params) => ({
      commandId: params.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
      ...(params.envelope.type === "createSession"
        ? {
            result: {
              type: "createSession" as const,
              sessionId: "sess_v4_created",
            },
          }
        : {}),
    })),
    closeSession: vi.fn(async () => undefined),
    upsertModelProvider: vi.fn(async (params) => workspaceState(params)),
    removeModelProvider: vi.fn(async (params) => workspaceState(params)),
    setModel: vi.fn(
      async (params) =>
        snapshots.get(params.sessionId) ??
        makeSnapshot({
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
    ),
    setThoughtLevel: vi.fn(
      async (params) =>
        snapshots.get(params.sessionId) ??
        makeSnapshot({
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
    ),
    setMode: vi.fn(
      async (params) =>
        snapshots.get(params.sessionId) ??
        makeSnapshot({
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
    ),
    onDynamicSessionEvent: vi.fn(() => eventEmitter.event),
    // M5 删波次 2：syncer 的终态/ready 摄入换到 v4 sessions-index 帧，
    // 真实 syncer 会在首个 session 激活信号时建立 workspace 级订阅。
    subscribeSessionsIndexV4: vi.fn(async () => {
      // fresh subscribe 必须先给 syncer 一份完整 initial snapshot；后续 ready deltas
      // 才能在同一 log epoch/seq 链上作为权威状态迁移被消费。
      fireIndexSnapshot(indexFrameEmitter);
      return {
        ack: {
          subscriptionId: "six-compat-1",
          mode: "snapshot" as const,
          logEpoch: "epoch-compat",
        },
      };
    }),
    unsubscribeSessionsIndexV4: vi.fn(async () => undefined),
    onDynamicSessionsIndexFrame: vi.fn(() => indexFrameEmitter.event),
    subscribeWorkspaceConfigV4: vi.fn(async () => ({
      ack: {
        subscriptionId: "wcs-compat-1",
        mode: "snapshot" as const,
        logEpoch: "epoch-compat-cfg",
      },
    })),
    unsubscribeWorkspaceConfigV4: vi.fn(async () => undefined),
    onDynamicWorkspaceConfigFrame: vi.fn(() => new Emitter<WorkspaceConfigTopicWireFrame>().event),
    hasActiveCuaOperationTurn: vi.fn(() => false),
    disposeWorkspace: vi.fn(async () => undefined),
    disposeAll: vi.fn(),
  };
  return { agent, eventEmitter, indexFrameEmitter };
}

function createService(options?: {
  settings?: Partial<AppSettings>;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}) {
  useTempDataBaseDir();
  const { agent, eventEmitter, indexFrameEmitter } = createAgentMock();
  const settingService = options?.settings
    ? {
        get: vi.fn(
          async () =>
            ({
              recentProjects: [],
              locale: "zh-CN",
              ...options.settings,
            }) as AppSettings,
        ),
      }
    : undefined;
  // adapter 现在要求注入 syncer；测试里给一个真实的 syncer（agent 上面已经 mock 了 onDynamicSessionEvent）。
  const taskIndexRepo = new TaskIndexRepo();
  const taskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: agent,
    taskIndexRepo,
  });

  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: agent,
    taskIndexRepo,
    taskIndexSyncer,
    ...(settingService ? { settingService } : {}),
    ...(options?.cuaProductMcpServerResolver
      ? { cuaProductMcpServerResolver: options.cuaProductMcpServerResolver }
      : {}),
  }) as ReturnType<typeof createZCodeTaskServiceAdapter> & {
    disposeAll(): void;
  };
  disposables.push(service);
  return { agent, eventEmitter, indexFrameEmitter, service, taskIndexRepo };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

const compatIndexFrameSeqByEmitter = new WeakMap<Emitter<SessionsIndexTopicWireFrame>, number>();

function fireIndexSnapshot(indexFrameEmitter: Emitter<SessionsIndexTopicWireFrame>): void {
  const seq = 100;
  compatIndexFrameSeqByEmitter.set(indexFrameEmitter, seq);
  const frame: SessionsIndexTopicFrame = {
    topic: "sessions-index//repo",
    subscriptionId: "six-compat-1",
    fromSeq: 0,
    toSeq: seq,
    sentAt: 100,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "/repo",
        logEpoch: "epoch-compat",
        sessions: [],
      },
    },
  };
  indexFrameEmitter.fire({
    wireVersion: 3,
    deliveryKind: "online",
    kind: "complete",
    logicalFrameId: `logical-compat-${seq}`,
    logicalFrameOrdinal: seq,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  });
}

function compatSummary(
  sessionId: string,
  phase: "running" | "completedSuccess" | "error",
): SessionSummary {
  return {
    sessionId,
    workspaceId: "/repo",
    title: "",
    phase,
    sessionEnded: phase !== "running",
    hasBackgroundWork: false,
    lastActivityAt: 100,
    createdAt: 1,
  };
}

function fireIndexUpsert(
  indexFrameEmitter: Emitter<SessionsIndexTopicWireFrame>,
  session: SessionSummary,
): void {
  const compatIndexFrameSeq = (compatIndexFrameSeqByEmitter.get(indexFrameEmitter) ?? 0) + 1;
  compatIndexFrameSeqByEmitter.set(indexFrameEmitter, compatIndexFrameSeq);
  const frame: SessionsIndexTopicFrame = {
    topic: "sessions-index//repo",
    subscriptionId: "six-compat-1",
    fromSeq: compatIndexFrameSeq - 1,
    toSeq: compatIndexFrameSeq,
    sentAt: 100,
    payload: { kind: "deltas", deltas: [{ op: "session.upserted", session }] },
  };
  indexFrameEmitter.fire({
    wireVersion: 3,
    deliveryKind: "online",
    kind: "complete",
    logicalFrameId: `logical-compat-${compatIndexFrameSeq}`,
    logicalFrameOrdinal: compatIndexFrameSeq,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  });
}

/**
 * M5 删波次 2：prompt ready 边界改由 v4 sessions-index 的 phase 终态迁移驱动
 * （running → completedSuccess），替代旧 state.updated prompt_completed 通知。
 */
async function firePromptCompletedState(
  indexFrameEmitter: Emitter<SessionsIndexTopicWireFrame>,
  params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  },
): Promise<void> {
  // 等 syncer 的 workspace v4 订阅建立完（subscriptionId 闸门就位）。
  await flushMicrotasks();
  fireIndexUpsert(indexFrameEmitter, compatSummary(params.sessionId, "running"));
  fireIndexUpsert(indexFrameEmitter, compatSummary(params.sessionId, "completedSuccess"));
}

async function seedIndexedTask(
  repo: TaskIndexRepo,
  params: {
    taskId: string;
    provider: ZCodeProvider;
    model?: string;
    workspacePath?: string;
    createdAt?: number;
    updatedAt?: number;
    pinned?: boolean;
    archived?: boolean;
    migrationSource?: "claudeCode";
    thoughtLevel?: string;
  },
) {
  await repo.syncTaskMeta({
    meta: {
      taskId: params.taskId,
      traceId: `trace_${params.taskId}`,
      title: params.taskId,
      workspacePath: params.workspacePath ?? "/repo",
      createdAt: params.createdAt ?? 10,
      updatedAt: params.updatedAt ?? 20,
      mode: "build",
      status: "completed",
      provider: params.provider,
      ...(params.model ? { model: params.model } : {}),
      ...(params.thoughtLevel ? { thoughtLevel: params.thoughtLevel } : {}),
      ...(params.migrationSource ? { migrationSource: params.migrationSource } : {}),
    },
    pinned: params.pinned,
    archived: params.archived,
  });
}

async function seedLegacyAcpSessionId(
  repo: TaskIndexRepo,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    acpSessionId: string;
  },
) {
  await repo.ensureReady();
  const db = (
    repo as unknown as {
      getDatabase(): {
        exec(sql: string): unknown;
        prepare(sql: string): {
          run(...args: unknown[]): unknown;
        };
      };
    }
  ).getDatabase();
  db.exec("ALTER TABLE tasks ADD COLUMN acp_session_id TEXT");
  db.prepare(`UPDATE tasks SET acp_session_id = ? WHERE workspace_key = ? AND task_id = ?`).run(
    params.acpSessionId,
    resolveWorkspaceKey(params),
    params.taskId,
  );
  // Bugfix: 老库的 acp_session_id 只在初始化迁移阶段读取。
  // 测试里手工补列后重开 repo，验证迁移不是运行时 facade 兜底。
  repo.close();
  await repo.ensureReady();
}

describe("ZCode legacy task compat task index", () => {
  it.each([undefined, "ssh://host/repo"])(
    "waits for an in-flight topic admission before confirming cancellation (%s)",
    async (workspaceIdentity) => {
      const { service, agent } = createService();
      const task = await service.createTask({
        workspacePath: "/repo",
        workspaceIdentity,
        provider: "glm",
      });
      const target = { taskId: task.taskId, workspacePath: "/repo", workspaceIdentity };
      let release!: () => void;
      agent.sendConversationCommandV4 = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { commandId: "topic-inflight", status: "accepted", revisionAtDecision: 1 };
      });
      const sending = service.submitBotGroupInput!({
        ...target,
        commandId: "topic-inflight",
        content: "read",
        source: {
          provider: "feishu",
          botId: "bot",
          chatId: "chat",
          threadId: "topic",
          messageId: "message",
          senderId: "owner",
          senderName: "Owner",
        },
      });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      let cancelled = false;
      const cancellation = service.invalidateBotTopicInputs!(target).then(() => {
        cancelled = true;
      });
      await flushMicrotasks();
      const completedBeforeAdmission = cancelled;
      // 总是释放挂起请求，失败断言也不能遗留正在写入临时任务的异步工作。
      release();
      await Promise.all([sending, cancellation]);
      expect(completedBeforeAdmission).toBe(false);
      expect(cancelled).toBe(true);
    },
  );

  it("does not admit an uploaded topic input after cancellation", async () => {
    const { service, agent } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    let finish!: () => void;
    agent.attachmentBeginV4 = vi.fn(async (p) => ({
      uploadId: p.uploadId,
      state: "staging" as const,
      nextChunkIndex: 0,
    }));
    agent.attachmentChunkV4 = vi.fn(async (p) => ({ uploadId: p.uploadId, nextChunkIndex: 1 }));
    agent.attachmentCommitV4 = vi.fn(async (p) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { uploadId: p.uploadId, ref: "artifact://prepared" };
    });
    const sending = service.submitBotGroupInput!({
      taskId: task.taskId,
      workspacePath: "/repo",
      commandId: "topic-upload",
      content: "read",
      attachments: [
        { kind: "file", filename: "input.txt", textContent: "material", mimeType: "text/plain" },
      ],
      source: {
        provider: "feishu",
        botId: "bot",
        chatId: "chat",
        threadId: "topic",
        messageId: "message",
        senderId: "owner",
        senderName: "Owner",
      },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await service.invalidateBotTopicInputs!({ taskId: task.taskId, workspacePath: "/repo" });
    finish();
    await expect(sending).rejects.toThrow(/cancelled/);
    expect(agent.sendConversationCommandV4).not.toHaveBeenCalled();
  });

  it("uploads Bot attachments and admits input on the same trusted connection", async () => {
    const { service, agent } = createService();
    const task = await service.createTask({
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      provider: "glm",
    });
    const connections: string[] = [];
    const check = (params: unknown) => {
      const connection = readTrustedZCodeAgentV4Connection(params);
      if (!connection) throw new Error("fault.attachment.connectionUntrusted");
      expect(connection.clientMode).toBe("desktop-continuous");
      expect(params).toEqual(
        expect.objectContaining({
          workspaceIdentity: "ssh://host/repo",
          remoteSessionId: "current-remote",
        }),
      );
      connections.push(connection.connectionId);
    };
    agent.attachmentBeginV4 = vi.fn(async (params) => {
      check(params);
      return { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex: 0 };
    });
    agent.attachmentChunkV4 = vi.fn(async (params) => {
      check(params);
      return { uploadId: params.uploadId, nextChunkIndex: 1 };
    });
    agent.attachmentCommitV4 = vi.fn(async (params) => {
      check(params);
      return { uploadId: params.uploadId, ref: "artifact://bot-file" };
    });
    agent.attachmentAbortV4 = vi.fn(async () => undefined);
    agent.sendConversationCommandV4 = vi.fn(async (params) => {
      check(params);
      expect(params.envelope.payload).toEqual(
        expect.objectContaining({
          attachments: [expect.objectContaining({ ref: "artifact://bot-file" })],
        }),
      );
      return {
        commandId: params.envelope.commandId,
        status: "accepted" as const,
        revisionAtDecision: 1,
        result: {
          type: "inputAccepted" as const,
          inputId: params.envelope.commandId,
          delivery: "queue" as const,
        },
      };
    });
    await service.submitBotGroupInput!({
      taskId: task.taskId,
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      remoteSessionId: "current-remote",
      commandId: "group-with-file",
      content: "Read this file",
      attachments: [
        { kind: "file", filename: "example.txt", mimeType: "text/plain", textContent: "hello" },
      ],
      source: {
        provider: "feishu",
        botId: "bot",
        chatId: "chat",
        senderId: "member",
        messageId: "message",
      },
    });
    expect(connections).toHaveLength(4);
    expect(new Set(connections).size).toBe(1);
  });

  it("keeps trusted remote session routing on group admission and rejects a foreign workspace before IO", async () => {
    const { service, agent } = createService();
    const task = await service.createTask({
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      provider: "glm",
    });
    agent.sendConversationCommandV4 = vi.fn(async (params) => ({
      commandId: params.envelope.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
      result: {
        type: "inputAccepted" as const,
        inputId: params.envelope.commandId,
        delivery: "queue" as const,
      },
    }));
    const input = {
      taskId: task.taskId,
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      remoteSessionId: "current-remote",
      commandId: "group-command",
      content: "hello",
      source: {
        provider: "feishu" as const,
        botId: "bot",
        chatId: "group",
        senderId: "member",
        senderName: "Member",
        messageId: "message",
        threadId: "omt_source",
        rootMessageId: "om_root",
      },
    };
    vi.mocked(readBotGroupRuntimeSnapshot).mockClear();
    vi.mocked(agent.sendConversationCommandV4).mockImplementation(async (params) => {
      // 冷启动时先恢复同一任务，不能依赖 Desktop 曾经打开过它。
      expect(readBotGroupRuntimeSnapshot).toHaveBeenCalledWith(expect.any(Object), {
        workspacePath: "/repo",
        workspaceIdentity: "ssh://host/repo",
        remoteSessionId: "current-remote",
        sessionId: task.taskId,
      });
      return {
        commandId: params.envelope.commandId,
        status: "accepted",
        revisionAtDecision: 1,
        result: { type: "inputAccepted", inputId: params.envelope.commandId, delivery: "queue" },
      };
    });
    await service.submitBotGroupInput!(input);
    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceIdentity: "ssh://host/repo",
        remoteSessionId: "current-remote",
        envelope: expect.objectContaining({
          payload: expect.objectContaining({
            requestedDelivery: "startNow",
            botDeliveryTarget: expect.objectContaining({
              threadId: "omt_source",
              rootMessageId: "om_root",
            }),
          }),
        }),
      }),
    );
    await expect(
      service.submitBotGroupInput!({ ...input, workspaceIdentity: "ssh://other/repo" }),
    ).rejects.toThrow("workspace mismatch");
    await expect(
      service.getBotGroupTaskBlockReason!({
        taskId: task.taskId,
        workspacePath: "/repo",
        workspaceIdentity: "ssh://other/repo",
      }),
    ).rejects.toThrow("workspace mismatch");
    expect(agent.sendConversationCommandV4).toHaveBeenCalledOnce();
    vi.mocked(readBotGroupRuntimeSnapshot).mockRejectedValueOnce(new Error("restore failed"));
    await expect(
      service.submitBotGroupInput!({ ...input, commandId: "cold-failure" }),
    ).rejects.toThrow("restore failed");
    expect(agent.sendConversationCommandV4).toHaveBeenCalledOnce();
    await service.readBotTopicSummaries!({
      taskId: task.taskId,
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      remoteSessionId: "current-remote",
    });
    expect(agent.readSessionMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: task.taskId,
        workspaceIdentity: "ssh://host/repo",
        remoteSessionId: "current-remote",
      }),
    );
    await expect(
      service.readBotTopicSummaries!({
        taskId: task.taskId,
        workspacePath: "/repo",
        workspaceIdentity: "ssh://other/repo",
      }),
    ).rejects.toThrow("workspace mismatch");
  });

  it("exposes task ready only after the indexed session returns to an input-ready phase", async () => {
    const { indexFrameEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const readyReasons: string[] = [];
    const disposable = service.onDynamicTaskReady(task.taskId)((event) => {
      readyReasons.push(event.reason);
    });

    try {
      await flushMicrotasks();
      fireIndexUpsert(indexFrameEmitter, compatSummary("another-task", "running"));
      fireIndexUpsert(indexFrameEmitter, compatSummary("another-task", "completedSuccess"));
      fireIndexUpsert(indexFrameEmitter, compatSummary(task.taskId, "running"));
      fireIndexUpsert(indexFrameEmitter, compatSummary(task.taskId, "completedSuccess"));
      fireIndexUpsert(indexFrameEmitter, compatSummary(task.taskId, "running"));
      fireIndexUpsert(indexFrameEmitter, compatSummary(task.taskId, "error"));
      await flushMicrotasks();

      expect(readyReasons).toEqual(["prompt_completed", "prompt_failed"]);
    } finally {
      disposable.dispose();
    }
  });

  it("reports the manual automation runId on terminal outcome", async () => {
    const { indexFrameEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const outcomes: Array<{ inputId?: string; outcome: string }> = [];
    const disposable = service.onDynamicTaskTerminalOutcome(task.taskId)((event) => {
      outcomes.push(event);
    });
    const runId = "automation-1:manual:1700000000000";

    try {
      await service.sendPrompt({
        taskId: task.taskId,
        traceId: runId,
        content: "run scheduled report",
        automationId: "automation-1",
      });
      await flushMicrotasks();
      fireIndexUpsert(indexFrameEmitter, compatSummary(task.taskId, "running"));
      fireIndexUpsert(indexFrameEmitter, compatSummary(task.taskId, "completedSuccess"));
      await flushMicrotasks();

      expect(outcomes).toEqual([expect.objectContaining({ inputId: runId, outcome: "succeeded" })]);
    } finally {
      disposable.dispose();
    }
  });

  it("keeps automation mutation isolation turn-scoped when creating an execution task", async () => {
    const { agent, service, taskIndexRepo } = createService();

    const task = await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      automationId: "automation-1",
    });

    const createParams = vi.mocked(agent.createSession).mock.calls[0]?.[0];
    expect(createParams).toEqual(
      expect.objectContaining({
        workspacePath: "/repo",
        persistence: "deferred",
        titleGenerationEnabled: false,
      }),
    );
    expect(createParams).not.toHaveProperty("toolDenylist");
    await expect(
      taskIndexRepo.getTaskMeta({
        workspacePath: "/repo",
        taskId: task.taskId,
      }),
    ).resolves.toEqual(expect.objectContaining({ cronAutomationId: "automation-1" }));
  });

  it("SAT28: 显式恢复 child 只返回详情，不创建主列表索引", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const snapshot = makeSnapshot({ sessionId: "hidden-child", workspacePath: "/repo" });
    snapshot.session.sessionKind = "subagent_child";
    vi.mocked(agent.resumeSession).mockResolvedValue(snapshot);
    await service.resumeTask({ workspacePath: "/repo", taskId: "hidden-child" });
    expect(
      await taskIndexRepo.getTaskMeta({ workspacePath: "/repo", taskId: "hidden-child" }),
    ).toBeNull();
  });

  it("keeps automation mutation isolation turn-scoped when resuming an execution task", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.resumeSession).mockClear();

    await service.resumeTask({
      workspacePath: "/repo",
      taskId: task.taskId,
      automationId: "automation-2",
    });

    const resumeParams = vi.mocked(agent.resumeSession).mock.calls[0]?.[0];
    expect(resumeParams).toEqual(
      expect.objectContaining({
        workspacePath: "/repo",
        sessionId: task.taskId,
      }),
    );
    expect(resumeParams).not.toHaveProperty("toolDenylist");
    await expect(
      taskIndexRepo.getTaskMeta({
        workspacePath: "/repo",
        taskId: task.taskId,
      }),
    ).resolves.toEqual(expect.objectContaining({ cronAutomationId: "automation-2" }));
  });

  it("marks automation execution prompts on v4 sendText commands", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.sendConversationCommandV4).mockClear();

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "trace-automation-run",
      content: "run scheduled prompt",
      automationId: "automation-1",
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          type: "sendText",
          commandId: "trace-automation-run",
          payload: {
            text: "run scheduled prompt",
            heldQueueDisposition: "keepQueueAndSend",
            automationId: "automation-1",
            toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
          },
        }),
      }),
    );
  });

  it("applies a caller-scoped CronCreate denylist to a first-run prompt", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.sendConversationCommandV4).mockClear();

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "trace-off-peak-first-run",
      content: "run off-peak prompt",
      offPeakTaskId: "offpeak-stable-1",
      offPeakRunType: "init",
      toolDenylist: ["CronCreate"],
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          type: "sendText",
          commandId: "trace-off-peak-first-run",
          payload: {
            text: "run off-peak prompt",
            heldQueueDisposition: "keepQueueAndSend",
            offPeakTaskId: "offpeak-stable-1",
            offPeakRunType: "init",
            // D49-2：闲时派发轮在调用方 CronCreate 之外，纵深补 OffPeakCreate
            // （免费池自我放大）；OffPeakList 只读保留。
            toolDisallowlist: ["CronCreate", "OffPeakCreate"],
          },
        }),
      }),
    );
    await expect(
      taskIndexRepo.getTaskMeta({
        workspacePath: "/repo",
        taskId: task.taskId,
      }),
    ).resolves.toEqual(expect.objectContaining({ cronAutomationId: undefined }));
  });

  it("applies a caller-scoped CronCreate denylist after resuming a normal session", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    await service.resumeTask({ workspacePath: "/repo", taskId: task.taskId });
    vi.mocked(agent.sendConversationCommandV4).mockClear();

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "trace-off-peak-resume",
      content: "continue off-peak prompt",
      offPeakTaskId: "offpeak-stable-1",
      offPeakRunType: "resume",
      toolDenylist: ["CronCreate"],
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          type: "sendText",
          commandId: "trace-off-peak-resume",
          payload: {
            text: "continue off-peak prompt",
            heldQueueDisposition: "keepQueueAndSend",
            offPeakTaskId: "offpeak-stable-1",
            offPeakRunType: "resume",
            // D49-2：续跑段与首跑同语义。
            toolDisallowlist: ["CronCreate", "OffPeakCreate"],
          },
        }),
      }),
    );
  });

  it("restores automation mutation tools for a user turn in a cron-owned session", async () => {
    const { agent, service } = createService();
    // 会话因用户在其中创建过定时任务而归属 automation：DB meta 带 cronAutomationId。
    const task = await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      automationId: "automation-owned",
    });
    // 复刻打开已有定时任务会话：归属仍保存在 DB，但普通用户轮不携带 automationId。
    await service.resumeTask({ workspacePath: "/repo", taskId: task.taskId });
    service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })(() => undefined);
    vi.mocked(agent.sendConversationCommandV4).mockClear();

    // 普通用户后续输入：不带 automationId。
    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "trace-followup",
      content: "再帮我建一个每5分钟的提醒",
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          type: "sendText",
          commandId: "trace-followup",
          payload: {
            text: "再帮我建一个每5分钟的提醒",
            heldQueueDisposition: "keepQueueAndSend",
          },
        }),
      }),
    );
  });

  it("does not hide CronCreate for plain user turns in a normal (non cron-owned) session", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    await service.resumeTask({ workspacePath: "/repo", taskId: task.taskId });
    service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })(() => undefined);
    vi.mocked(agent.sendConversationCommandV4).mockClear();

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "trace-normal",
      content: "帮我看看这段代码",
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          type: "sendText",
          commandId: "trace-normal",
          payload: {
            text: "帮我看看这段代码",
            heldQueueDisposition: "keepQueueAndSend",
          },
        }),
      }),
    );
  });

  it("injects product CUA helper broker config before legacy createTask session creation", async () => {
    // services 只负责建会话前把 MCP 配置交给 producer 的 resolver；改写细节由 producer 自己的测试覆盖。
    // 这里用测试自己的 resolver，不依赖私有 producer 的注入实现（开源占位包不改写配置）。
    const resolver = {
      resolveMcpServers: vi.fn(async (servers) =>
        servers?.map((server) =>
          "command" in server
            ? {
                ...server,
                args: [
                  ...(server.args ?? []),
                  "--permission-broker-socket",
                  "/tmp/zcode-cua/helper.sock",
                ],
              }
            : server,
        ),
      ),
    } satisfies CuaProductMcpServerResolver;
    const { agent, service } = createService({ cuaProductMcpServerResolver: resolver });

    await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      mcpServers: [
        {
          name: ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
          command: "uvx",
          args: ["zcode-cua"],
          env: [
            { name: ZCODE_PLUGIN_ID_ENV_KEY, value: ZCODE_CUA_OFFICIAL_PLUGIN_ID },
            { name: ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY, value: "test-authority" },
          ],
        },
      ],
    });

    const createParams = vi.mocked(agent.createSession).mock.calls[0]?.[0];
    const server = createParams?.mcpServers?.[0];
    expect(resolver.resolveMcpServers).toHaveBeenCalledTimes(1);
    expect(server && "command" in server ? server.args : []).toEqual([
      "zcode-cua",
      "--permission-broker-socket",
      "/tmp/zcode-cua/helper.sock",
    ]);
  });

  it("restarts only the current workspace agent process", async () => {
    const { agent, service } = createService();

    await service.restartWorkspaceProcess({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:dev:/repo",
      provider: "glm",
    });

    // Bugfix: restartWorkspaceProcess 是切模型/配置后的 workspace 级重启，
    // 不能调用 disposeAll 把整个 agent manager 永久关闭。
    expect(agent.disposeWorkspace).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:dev:/repo",
    });
    expect(agent.disposeAll).not.toHaveBeenCalled();
  });

  it("releases workspace preparation through the workspace-scoped agent lifecycle", async () => {
    const { agent, service } = createService();

    await service.releaseWorkspacePreparation({
      workspacePath: "/repo",
      workspaceIdentity: "remote:wsl:ubuntu:/repo",
      provider: "glm",
    });

    expect(agent.disposeWorkspace).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "remote:wsl:ubuntu:/repo",
    });
    expect(agent.disposeAll).not.toHaveBeenCalled();
  });

  it("uses structured ModelSelection for a custom model", async () => {
    const { agent, service } = createService();
    const workspacePath = "/repo-custom-model-ref";
    const task = await service.createTask({ workspacePath, provider: "glm" });

    await service.setModel({
      taskId: task.taskId,
      traceId: "trace_custom_model_ref",
      modelSelection: { providerId: "provider-b", modelId: "gpt-5.5" },
    });

    expect(agent.setModel).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity: undefined,
      sessionId: task.taskId,
      model: { providerId: "provider-b", modelId: "gpt-5.5" },
    });
  });

  it("records agent model network status events as HTTP network telemetry", async () => {
    const observations: NetworkObservation[] = [];
    setNetworkTelemetrySink((observation) => observations.push(observation));
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })(() => undefined);

    try {
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt-model-completed",
          sessionId: task.taskId,
          seq: 1,
          timestamp: 1_700_000_000_000,
          type: "session.updated",
          payload: {
            type: "model_request_completed",
            timestamp: "2026-06-05T00:00:00.000Z",
            traceId: "trace-model-network",
            requestId: "request-model-network",
            model: { providerId: "glm", modelId: "glm-4.6" },
            baseURL: "https://api.example.com/v1?token=secret",
            providerKind: "openai-compatible",
            transport: "sse",
            attempt: 2,
            maxAttempts: 3,
            durationMs: 456,
          },
        },
      });
    } finally {
      disposable.dispose();
    }

    expect(observations).toEqual([
      {
        transport: "http",
        interface: "zcode_agent.model.openai-compatible.sse.api.example.com/v1",
        durationMs: 456,
        ok: true,
        attempt: 2,
      },
    ]);
  });

  it("projects user input response to elicitation response in dynamic task fallback subscriptions", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      streamEvents.push(event);
    });

    try {
      eventEmitter.fire({
        type: "userInput.response",
        requestId: "input-1",
        response: {
          action: "accept",
          content: { answers: { answer_0: "a" } },
        },
      });
    } finally {
      disposable.dispose();
    }

    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "elicitation_response",
        taskId: task.taskId,
        requestId: "input-1",
        action: "accept",
        content: { answers: { answer_0: "a" } },
      }),
    );
  });

  it("projects structured turn failure codes into dynamic task errors", async () => {
    const { eventEmitter, service, taskIndexRepo } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      streamEvents.push(event);
    });

    try {
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_turn_failed",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 1,
          timestamp: 10,
          traceId: "protocol_trace_1",
          type: "turn.failed",
          payload: {
            turnPhase: "model",
            inputId: "input_failed_1",
            error: {
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
      });
    } finally {
      disposable.dispose();
    }

    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "task_error",
        taskId: task.taskId,
        traceId: "input_failed_1",
        inputId: "input_failed_1",
        error: "Model provider is not configured: stale-provider",
        code: "provider_not_found",
        detail: "stale-provider/gpt-5.5",
        attribution: {
          source: "runtime",
          reason: "provider_not_configured",
          providerId: "account:zai-individual-coding-plan",
        },
      }),
    );
    await vi.waitFor(async () => {
      await expect(
        taskIndexRepo.getTaskMeta({
          workspacePath: "/repo",
          taskId: task.taskId,
        }),
      ).resolves.toMatchObject({
        lastError: {
          code: "provider_not_found",
          detail: "stale-provider/gpt-5.5",
          message: "Model provider is not configured: stale-provider",
          attribution: {
            source: "runtime",
            reason: "provider_not_configured",
            providerId: "account:zai-individual-coding-plan",
          },
        },
      });
    });
  });

  it("projects streaming Write input in dynamic task fallback subscriptions", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      streamEvents.push(event);
    });

    try {
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_turn_started",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 1,
          timestamp: 10,
          traceId: "protocol_trace_1",
          type: "turn.started",
          payload: {
            input: "write file",
            inputId: "input_write_1",
            turnNumber: 1,
          },
        },
      });
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_tool_input_delta_1",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 2,
          timestamp: 11,
          traceId: "protocol_trace_1",
          type: "model.streaming",
          payload: {
            kind: "tool_input_delta",
            toolCallId: "call_write",
            delta: '{"file_path":"src/app.ts","content":"line 1',
          },
        },
      });
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_tool_input_delta_2",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 3,
          timestamp: 12,
          traceId: "protocol_trace_1",
          type: "model.streaming",
          payload: {
            kind: "tool_input_delta",
            toolCallId: "call_write",
            delta: "\\nline 2",
          },
        },
      });
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_tool_call_final",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 4,
          timestamp: 13,
          traceId: "protocol_trace_1",
          type: "model.streaming",
          payload: {
            kind: "tool_call",
            toolCallId: "call_write",
            toolName: "Write",
            input: {
              file_path: "src/app.ts",
              content: "line 1\nline 2",
            },
          },
        },
      });
    } finally {
      disposable.dispose();
    }

    const runStarted = streamEvents.find((event) => event.type === "task_run_started");
    const toolUpdates = streamEvents.filter(
      (event): event is Extract<ZCodeStreamEvent, { type: "tool_call_update" }> =>
        event.type === "tool_call_update",
    );

    expect(runStarted).toMatchObject({
      type: "task_run_started",
      traceId: "input_write_1",
      inputId: "input_write_1",
    });
    expect(toolUpdates.at(-1)).toMatchObject({
      type: "tool_call_update",
      traceId: "input_write_1",
      inputId: "input_write_1",
      toolId: "call_write",
      toolName: "Write",
      kind: "Write",
      title: "Write",
      input: {
        file_path: "src/app.ts",
        content: "line 1\nline 2",
      },
    });
  });

  it("keeps background Agent launch acknowledgements in progress in dynamic task streams", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      streamEvents.push(event);
    });

    try {
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_parent_agent",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 1,
          timestamp: 10,
          traceId: "trace_session",
          type: "tool.updated",
          payload: {
            kind: "scheduled",
            toolCallId: "call_parent_agent",
            toolName: "Agent",
            input: {
              description: "Inspect workspace",
              prompt: "Find the project shape",
              run_in_background: true,
            },
          },
        },
      });
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_parent_agent_result",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 2,
          timestamp: 11,
          traceId: "trace_session",
          type: "tool.updated",
          payload: {
            kind: "result",
            toolCallId: "call_parent_agent",
            duration: 4,
            result: {
              success: true,
              content: [
                'Agent Explore task "Inspect workspace" started in background.',
                "agentId: agent_1",
                "backgroundTaskId: agent_1",
                "Runtime will wait for this background Agent before completing the current turn.",
              ].join("\n"),
            },
          },
        },
      });
    } finally {
      disposable.dispose();
    }

    expect(streamEvents).toContainEqual(
      expect.objectContaining({
        type: "tool_call_update",
        toolId: "call_parent_agent",
        toolName: "Agent",
        status: "in_progress",
      }),
    );
  });

  it("keeps previous and current async Task launch acknowledgements in progress in dynamic task streams", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      streamEvents.push(event);
    });

    try {
      const acknowledgementContents = [
        [
          'Agent general-purpose task "Inspect workspace" started in background.',
          "agentId: agent_1",
          "outputFile: /tmp/agent_1/output.txt",
          "You will be notified when the Agent completes.",
        ].join("\n"),
        [
          "Async agent launched successfully.",
          "agentId: agent_1 (internal ID - do not mention to user. Use SendMessage with to: 'agent_1' to continue this agent.)",
          "The agent is working in the background. You will be notified automatically when it completes.",
          "output_file: /tmp/agent_1/output.txt",
          "Do NOT Read or tail this file via the shell tool.",
        ].join("\n"),
      ];

      for (const [index, content] of acknowledgementContents.entries()) {
        const toolCallId = `call_parent_task_${index}`;
        eventEmitter.fire({
          type: "session.event",
          event: {
            eventId: `evt_parent_task_${index}`,
            sessionId: task.taskId,
            turnId: "turn_1",
            seq: index * 2 + 1,
            timestamp: 10 + index * 2,
            traceId: "trace_session",
            type: "tool.updated",
            payload: {
              kind: "scheduled",
              toolCallId,
              toolName: "Task",
              input: {
                description: "Inspect workspace",
                prompt: "Find the project shape",
              },
            },
          },
        });
        eventEmitter.fire({
          type: "session.event",
          event: {
            eventId: `evt_parent_task_result_${index}`,
            sessionId: task.taskId,
            turnId: "turn_1",
            seq: index * 2 + 2,
            timestamp: 11 + index * 2,
            traceId: "trace_session",
            type: "tool.updated",
            payload: {
              kind: "result",
              toolCallId,
              duration: 4,
              result: {
                success: true,
                content,
              },
            },
          },
        });
      }
    } finally {
      disposable.dispose();
    }

    for (let index = 0; index < 2; index++) {
      expect(streamEvents).toContainEqual(
        expect.objectContaining({
          type: "tool_call_update",
          toolId: `call_parent_task_${index}`,
          toolName: "Task",
          status: "in_progress",
        }),
      );
    }
  });

  // M5 ③ 删除：listWorkspaceTaskLists（workspace 行分组查询）——列表面（本机 + remote shard）
  // 已切 sessions-index，分组结果在客户端由 sessions + tasks-index 归属 join 构建。

  it("broadcasts task_created when createTask inserts a new indexed task", async () => {
    const { service } = createService();
    const events: Array<{ reason?: string; taskId?: string }> = [];
    const disposable = service.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) => {
      if (event.type === "workspace_task_list_changed") {
        events.push({ reason: event.reason, taskId: event.taskMeta?.taskId });
      }
    });

    await service.createTask({ workspacePath: "/repo", provider: "glm" });
    disposable.dispose();

    expect(events).toEqual([
      {
        reason: "task_created",
        taskId: "sess_1",
      },
    ]);
  });

  it("broadcasts explicit task list membership reasons for pin and archive actions", async () => {
    const { service } = createService();
    const events: Array<{ reason?: string; taskId?: string }> = [];
    const disposable = service.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) => {
      if (event.type === "workspace_task_list_changed") {
        events.push({ reason: event.reason, taskId: event.taskMeta?.taskId });
      }
    });

    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    await service.setTaskPinned({
      workspacePath: "/repo",
      taskId: task.taskId,
      pinned: true,
    });
    await service.setTaskPinned({
      workspacePath: "/repo",
      taskId: task.taskId,
      pinned: false,
    });
    await service.archiveTask({
      workspacePath: "/repo",
      taskId: task.taskId,
    });
    await service.unarchiveTask({
      workspacePath: "/repo",
      taskId: task.taskId,
    });
    disposable.dispose();

    expect(events).toEqual([
      { reason: "task_created", taskId: task.taskId },
      { reason: "task_pinned", taskId: task.taskId },
      { reason: "task_unpinned", taskId: task.taskId },
      { reason: "task_archived", taskId: task.taskId },
      { reason: "task_unarchived", taskId: task.taskId },
    ]);
  });

  it("does not clear a newer unread marker when the system clock does not advance", async () => {
    vi.useFakeTimers();
    const { service, taskIndexRepo } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    vi.setSystemTime(100);
    const [openedUnread, terminalUnread] = await Promise.all([
      service.setTaskUnread({
        workspacePath: "/repo",
        taskId: task.taskId,
        unread: true,
      }),
      service.setTaskUnread({
        workspacePath: "/repo",
        taskId: task.taskId,
        unread: true,
      }),
    ]);
    expect(openedUnread.unreadAt).toBe(100);
    expect(terminalUnread.unreadAt).toBe(101);
    await expect(
      service.getTaskSnapshot({
        workspacePath: "/repo",
        taskId: task.taskId,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ meta: expect.objectContaining({ unreadAt: 101 }) }),
    );

    const events: string[] = [];
    const disposable = service.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) => {
      if (event.type === "workspace_task_list_changed") {
        events.push(event.reason);
      }
    });

    const result = await service.setTaskUnread({
      workspacePath: "/repo",
      taskId: task.taskId,
      unread: false,
      expectedUnreadAt: openedUnread.unreadAt,
    });

    expect(result.unreadAt).toBe(terminalUnread.unreadAt);
    await expect(
      taskIndexRepo.getTaskMeta({
        workspacePath: "/repo",
        taskId: task.taskId,
      }),
    ).resolves.toEqual(expect.objectContaining({ unreadAt: terminalUnread.unreadAt }));
    expect(events).toEqual([]);

    await service.setTaskUnread({
      workspacePath: "/repo",
      taskId: task.taskId,
      unread: false,
      expectedUnreadAt: terminalUnread.unreadAt,
    });
    events.length = 0;
    const unreadAfterClear = await service.setTaskUnread({
      workspacePath: "/repo",
      taskId: task.taskId,
      unread: true,
    });
    expect(unreadAfterClear.unreadAt).toBe(102);
    events.length = 0;

    const staleClearAfterNewUnread = await service.setTaskUnread({
      workspacePath: "/repo",
      taskId: task.taskId,
      unread: false,
      expectedUnreadAt: terminalUnread.unreadAt,
    });
    disposable.dispose();

    expect(staleClearAfterNewUnread.unreadAt).toBe(unreadAfterClear.unreadAt);
    expect(events).toEqual([]);
  });

  it("clears the unread marker when expectedUnreadAt still matches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const { service, taskIndexRepo } = createService();
    await seedIndexedTask(taskIndexRepo, {
      taskId: "matching-read-clear",
      provider: "glm",
    });
    const openedUnread = await service.setTaskUnread({
      workspacePath: "/repo",
      taskId: "matching-read-clear",
      unread: true,
    });
    const events: string[] = [];
    const disposable = service.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) => {
      if (event.type === "workspace_task_list_changed") {
        events.push(event.reason);
      }
    });

    const result = await service.setTaskUnread({
      workspacePath: "/repo",
      taskId: "matching-read-clear",
      unread: false,
      expectedUnreadAt: openedUnread.unreadAt,
    });
    disposable.dispose();

    expect(result.unreadAt).toBeUndefined();
    const persisted = await taskIndexRepo.getTaskMeta({
      workspacePath: "/repo",
      taskId: "matching-read-clear",
    });
    expect(persisted?.unreadAt).toBeUndefined();
    expect(events).toEqual(["task_meta_changed"]);
  });

  it("persists deleted tombstone and broadcasts task_deleted without deleting the CLI session", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const events: Array<{ reason?: string; taskId?: string }> = [];
    const disposable = service.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) => {
      if (event.type === "workspace_task_list_changed") {
        events.push({ reason: event.reason, taskId: event.taskId ?? event.taskMeta?.taskId });
      }
    });
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    await service.archiveTask({ workspacePath: "/repo", taskId: task.taskId });
    vi.mocked(agent.sendConversationCommandV4).mockClear();

    await service.deleteTask({ workspacePath: "/repo", taskId: task.taskId });
    disposable.dispose();

    await expect(service.listDeletedTaskIds({ workspacePath: "/repo" })).resolves.toEqual([
      task.taskId,
    ]);
    await expect(service.listArchivedTasks({ workspacePath: "/repo" })).resolves.toEqual([]);
    await expect(
      taskIndexRepo.listTaskMetas({
        workspacePath: "/repo",
        provider: "glm",
        archived: true,
        includeDeleted: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ taskId: task.taskId })]);
    expect(events.at(-1)).toEqual({ reason: "task_deleted", taskId: task.taskId });
    expect(agent.sendConversationCommandV4).not.toHaveBeenCalled();
  });

  it("deletes only still-archived targets, skips restored/missing targets, and retains CLI sessions", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const target = { workspacePath: "/repo", taskId: task.taskId };
    await service.archiveTask(target);
    await service.unarchiveTask(target);
    expect(await service.deleteArchivedTask(target)).toBe(false);
    await service.archiveTask(target);
    vi.mocked(agent.sendConversationCommandV4).mockClear();
    expect(await service.deleteArchivedTask(target)).toBe(true);
    expect(await service.deleteArchivedTask(target)).toBe(false);
    expect(await service.deleteArchivedTask({ ...target, taskId: "missing" })).toBe(false);
    expect(await service.listDeletedTaskIds({ workspacePath: "/repo" })).toEqual([task.taskId]);
    expect(agent.sendConversationCommandV4).not.toHaveBeenCalled();
  });

  it("does not publish deletion or hide the archived target when guarded persistence fails", async () => {
    const { service, taskIndexRepo } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const target = { workspacePath: "/repo", taskId: task.taskId };
    await service.archiveTask(target);
    const events: string[] = [];
    const listener = service.onDynamicWorkspaceEvent({ workspacePath: "/repo" })((event) => {
      if (event.type === "workspace_task_list_changed") events.push(event.reason);
    });
    const write = vi
      .spyOn(taskIndexRepo, "deleteArchivedTask")
      .mockRejectedValueOnce(new Error("write failed"));
    await expect(service.deleteArchivedTask(target)).rejects.toThrow("write failed");
    expect(
      (await service.listArchivedTasks({ workspacePath: "/repo" })).map((meta) => meta.taskId),
    ).toContain(task.taskId);
    expect(events).toEqual([]);
    write.mockRestore();
    listener.dispose();
  });

  it("批量条件删除逐项提交，重复 ID 去重，混合失败只发布一次 workspace 删除事件", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const tasks = [];
    for (let i = 0; i < 4; i += 1) {
      const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
      await service.archiveTask({ workspacePath: "/repo", taskId: task.taskId });
      tasks.push(task);
    }
    const [first, restored, failed, last] = tasks;
    await service.unarchiveTask({ workspacePath: "/repo", taskId: restored!.taskId });
    const onEvent = vi.fn();
    const listener = service.onDynamicWorkspaceEvent({ workspacePath: "/repo" })(onEvent);
    const originalDelete = taskIndexRepo.deleteArchivedTask.bind(taskIndexRepo);
    const write = vi
      .spyOn(taskIndexRepo, "deleteArchivedTask")
      .mockImplementation(async (target) => {
        if (target.taskId === failed!.taskId) throw new Error("write failed");
        return originalDelete(target);
      });
    vi.mocked(agent.sendConversationCommandV4).mockClear();
    const result = await service.deleteArchivedTasks({
      workspacePath: "/repo",
      taskIds: [
        first!.taskId,
        restored!.taskId,
        failed!.taskId,
        last!.taskId,
        first!.taskId,
        "missing",
      ],
    });
    expect(result).toEqual({
      deletedTaskIds: [first!.taskId, last!.taskId],
      skippedTaskIds: [restored!.taskId, "missing"],
      failedTaskIds: [failed!.taskId],
    });
    expect(write).toHaveBeenCalledTimes(5);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "workspace_task_list_changed",
        workspacePath: "/repo",
        reason: "task_deleted",
      }),
    );
    expect(onEvent.mock.calls[0]![0].taskId).toBeUndefined();
    expect(onEvent.mock.calls[0]![0].taskMeta).toBeUndefined();
    expect(
      (await service.listArchivedTasks({ workspacePath: "/repo" })).map((task) => task.taskId),
    ).toEqual([failed!.taskId]);
    expect(agent.sendConversationCommandV4).not.toHaveBeenCalled();
    onEvent.mockClear();
    expect(await service.deleteArchivedTasks({ workspacePath: "/repo", taskIds: [] })).toEqual({
      deletedTaskIds: [],
      skippedTaskIds: [],
      failedTaskIds: [],
    });
    expect(
      await service.deleteArchivedTasks({ workspacePath: "/repo", taskIds: [failed!.taskId] }),
    ).toEqual({ deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [failed!.taskId] });
    expect(
      await service.deleteArchivedTasks({ workspacePath: "/repo", taskIds: [first!.taskId] }),
    ).toEqual({ deletedTaskIds: [], skippedTaskIds: [first!.taskId], failedTaskIds: [] });
    expect(onEvent).not.toHaveBeenCalled();
    write.mockRestore();
    listener.dispose();
  });

  it("批次按 workspaceIdentity 隔离，同路径同 taskId 不会误删其它 source", async () => {
    const { service, taskIndexRepo } = createService();
    const identities = ["remote:ssh:first:/repo", "remote:ssh:second:/repo"];
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    for (const workspaceIdentity of identities) {
      await taskIndexRepo.syncTaskMeta({ meta: { ...task, workspaceIdentity } });
      await taskIndexRepo.updateTaskState({
        workspacePath: "/repo",
        workspaceIdentity,
        taskId: task.taskId,
        patch: { archived: true },
      });
    }
    expect(
      await service.deleteArchivedTasks({
        workspacePath: "/repo",
        workspaceIdentity: identities[0],
        taskIds: [task.taskId],
      }),
    ).toEqual({ deletedTaskIds: [task.taskId], skippedTaskIds: [], failedTaskIds: [] });
    expect(
      await taskIndexRepo.getTaskMeta({
        workspacePath: "/repo",
        workspaceIdentity: identities[1],
        taskId: task.taskId,
      }),
    ).toEqual(expect.objectContaining({ taskId: task.taskId, workspaceIdentity: identities[1] }));
  });

  it("并发批次仍由 Repo 条件写入裁决，每个目标只能成功删除一次", async () => {
    const { service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    await service.archiveTask({ workspacePath: "/repo", taskId: task.taskId });
    const results = await Promise.all(
      [1, 2].map(() =>
        service.deleteArchivedTasks({
          workspacePath: "/repo",
          taskIds: [task.taskId],
        }),
      ),
    );
    expect(results.flatMap((result) => result.deletedTaskIds)).toEqual([task.taskId]);
    expect(results.flatMap((result) => result.skippedTaskIds)).toEqual([task.taskId]);
    expect(results.flatMap((result) => result.failedTaskIds)).toEqual([]);
  });

  it("bumps updatedAt when renaming a task so running UI title refreshes immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T14:45:00.000Z"));
    const { agent, service, taskIndexRepo } = createService();
    await seedIndexedTask(taskIndexRepo, {
      taskId: "running-rename",
      provider: "glm",
      workspacePath: "/repo",
      updatedAt: 100,
    });
    vi.mocked(agent.sendConversationCommandV4).mockClear();

    const renamed = await service.renameTask({
      taskId: "running-rename",
      workspacePath: "/repo",
      title: "短名",
    });

    expect(renamed.title).toBe("短名");
    expect(renamed.titleOverridden).toBe(true);
    expect(renamed.updatedAt).toBe(Date.parse("2026-06-13T14:45:00.000Z"));
    await expect(
      taskIndexRepo.getTaskMeta({
        taskId: "running-rename",
        workspacePath: "/repo",
      }),
    ).resolves.toMatchObject({
      title: "短名",
      titleOverridden: true,
    });
    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "renameSession",
        sessionId: "running-rename",
        payload: { title: "短名" },
      }),
    });
  });

  it("reuses a mobile replayable draft session when createTask receives draftSessionId", async () => {
    const { agent, service } = createService();
    await agent.createSession({
      workspacePath: "/repo",
      sessionId: "draft_mobile",
      persistence: "deferred",
      model: { providerId: "glm", modelId: "deepseek-v4-pro" },
    });
    vi.mocked(agent.createSession).mockClear();
    vi.mocked(agent.readSession).mockClear();

    const task = await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      draftSessionId: "draft_mobile",
    });
    const list = await service.listTasks({ workspacePath: "/repo" });

    expect(agent.readSession).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      sessionId: "draft_mobile",
    });
    expect(agent.createSession).not.toHaveBeenCalled();
    expect(task.taskId).toBe("draft_mobile");
    expect(list.map((item) => item.taskId)).toEqual(["draft_mobile"]);
  });

  it("reads the bound Session original selection without filtering unavailable model options", async () => {
    const { agent, service } = createService();
    const workspaceIdentity = "remote:ssh:dev:/repo";
    const task = await service.createTask({
      workspacePath: "/repo",
      workspaceIdentity,
      provider: "glm",
    });
    const original = {
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "removed-model",
      options: { reasoningLevel: "removed-level" },
    };
    const snapshot = makeSnapshot({
      sessionId: task.taskId,
      workspacePath: "/repo",
      workspaceIdentity,
      model: original,
    });
    snapshot.settings.model.available = [];
    snapshot.settings.thoughtLevel.current = undefined;
    vi.mocked(agent.readSession).mockResolvedValueOnce(snapshot);
    vi.mocked(agent.setModel).mockClear();

    expect(await service.getTaskModelSelection({ taskId: task.taskId })).toEqual(original);
    expect(agent.readSession).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity,
      sessionId: task.taskId,
    });
    expect(agent.setModel).not.toHaveBeenCalled();
  });

  it("creates a Bot draft with the native v4 createSession command", async () => {
    const { agent, service } = createService();
    const mcpServers = [{ name: "docs", command: "node", args: ["server.js"], env: [] }];

    const task = await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      model: "glm/deepseek-v4-flash",
      mcpServers,
      v4Create: true,
    });

    expect(agent.createSession).not.toHaveBeenCalled();
    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        sessionId: null,
        type: "createSession",
        payload: expect.objectContaining({
          workspaceId: "/repo",
          config: expect.objectContaining({
            provider: "glm",
            model: "deepseek-v4-flash",
          }),
          mcpServers,
        }),
      }),
    });
    expect(task.taskId).toBe("sess_v4_created");
  });

  it("desktop-attached remote Bot draft 只发送 ModelSelection", async () => {
    const { agent, service } = createService();

    await service.createTask({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:dev:/repo",
      provider: "glm",
      model: "alternate-provider/deepseek-v4-pro",
      v4Create: true,
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceIdentity: "remote:ssh:dev:/repo",
        envelope: expect.objectContaining({
          type: "createSession",
          payload: expect.objectContaining({
            config: expect.objectContaining({
              provider: "alternate-provider",
              model: "deepseek-v4-pro",
            }),
          }),
        }),
      }),
    );
    const command = vi.mocked(agent.sendConversationCommandV4).mock.calls.at(-1)?.[0];
    expect(command?.envelope.payload).not.toHaveProperty("runtimeModel");
  });

  it("uses deferred persistence and disables generated titles only for automation sessions", async () => {
    const { agent, service } = createService();

    await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      automationId: "automation_1",
    });
    expect(agent.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        persistence: "deferred",
        titleGenerationEnabled: false,
      }),
    );

    await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const regularCreate = vi.mocked(agent.createSession).mock.calls.at(-1)?.[0];
    expect(regularCreate).not.toHaveProperty("titleGenerationEnabled");
    expect(regularCreate).not.toHaveProperty("persistence");
  });

  it("uses deferred persistence without cron metadata for headless first-prompt sessions", async () => {
    const { agent, service } = createService();

    const task = await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      deferPersistenceUntilFirstPrompt: true,
    });

    expect(agent.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        persistence: "deferred",
      }),
    );
    expect(vi.mocked(agent.createSession).mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "titleGenerationEnabled",
    );
    expect(task.cronAutomationId).toBeUndefined();
  });

  it("syncs a structured model selection before reusing a mobile replayable draft session", async () => {
    const { agent, service } = createService();
    await agent.createSession({
      workspacePath: "/repo",
      sessionId: "draft_mobile",
      persistence: "deferred",
      model: { providerId: "glm", modelId: "glm-0606[1m]" },
    });
    vi.mocked(agent.setModel).mockClear();

    const task = await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      draftSessionId: "draft_mobile",
      modelSelection: {
        providerId: "glm",
        modelId: "glm-0606[1m]",
        options: { reasoningLevel: "max" },
      },
    });

    expect(agent.setModel).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      sessionId: "draft_mobile",
      model: {
        providerId: "glm",
        modelId: "glm-0606[1m]",
        options: { reasoningLevel: "max" },
      },
    });
    expect(task.taskId).toBe("draft_mobile");
  });

  it("syncs model and thoughtLevel before reusing a mobile replayable draft session", async () => {
    const { agent, service } = createService();
    await agent.createSession({
      workspacePath: "/repo",
      sessionId: "draft_mobile",
      persistence: "deferred",
      model: { providerId: "custom-deepseek", modelId: "deepseek-v4-flash" },
    });
    vi.mocked(agent.createSession).mockClear();
    vi.mocked(agent.setModel).mockClear();
    vi.mocked(agent.setThoughtLevel).mockClear();

    const task = await service.createTask({
      workspacePath: "/repo",
      provider: "glm",
      draftSessionId: "draft_mobile",
      modelSelection: {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM-5-Turbo",
        options: { reasoningLevel: "enabled" },
      },
    });

    expect(agent.setModel).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      sessionId: "draft_mobile",
      model: {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM-5-Turbo",
        options: { reasoningLevel: "enabled" },
      },
    });
    expect(agent.setThoughtLevel).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      sessionId: "draft_mobile",
      thoughtLevel: "enabled",
    });
    expect(agent.createSession).not.toHaveBeenCalled();
    expect(task.taskId).toBe("draft_mobile");
  });

  it("drains an accepted mobile task command after the current turn completes", async () => {
    const { agent, eventEmitter, indexFrameEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "replayable",
    })(() => undefined);

    try {
      await service.sendPrompt({
        taskId: task.taskId,
        traceId: "input_first",
        queryId: "query_first",
        content: "first",
      });
      await service.enqueueTaskCommand({
        workspacePath: "/repo",
        taskId: task.taskId,
        commandId: "queued_second",
        traceId: "input_second",
        queryId: "query_second",
        type: "send_prompt",
        content: "second",
      });

      expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);

      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_turn_completed",
          sessionId: task.taskId,
          turnId: "turn_first",
          seq: 2,
          timestamp: 100,
          traceId: "protocol_trace_first",
          type: "turn.completed",
          payload: {
            inputId: "input_first",
            response: "done",
          },
        },
      });
      await flushMicrotasks();

      expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);

      await firePromptCompletedState(indexFrameEmitter, {
        sessionId: task.taskId,
        workspacePath: "/repo",
      });
      await flushMicrotasks();

      expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(2);
      // 幂等键 inputId→commandId：drain 落 v4 sendText，终态收口仍按 traceId 对账。
      expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
        workspacePath: "/repo",
        workspaceIdentity: undefined,
        envelope: expect.objectContaining({
          type: "sendText",
          sessionId: task.taskId,
          commandId: "input_second",
          payload: { text: "second", heldQueueDisposition: "keepQueueAndSend" },
        }),
      });
    } finally {
      disposable.dispose();
    }
  });

  it("drains automation host command with CronCreate denied", async () => {
    const { agent, eventEmitter, indexFrameEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_first",
      queryId: "query_first",
      content: "first",
    });
    const result = await service.enqueueTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_automation",
      traceId: "automation-parent:manual:run-1",
      queryId: "automation-parent:manual:run-1",
      type: "send_prompt",
      content: "每 5 分钟给我讲个冷笑话",
      automationId: "automation-parent",
    });

    expect(result.command).toEqual(
      expect.objectContaining({
        automationId: "automation-parent",
        status: "accepted",
      }),
    );
    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_turn_completed",
        sessionId: task.taskId,
        turnId: "turn_first",
        seq: 2,
        timestamp: 100,
        traceId: "protocol_trace_first",
        type: "turn.completed",
        payload: {
          inputId: "input_first",
          response: "done",
        },
      },
    });
    await flushMicrotasks();
    await firePromptCompletedState(indexFrameEmitter, {
      sessionId: task.taskId,
      workspacePath: "/repo",
    });
    await flushMicrotasks();

    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(2);
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "sendText",
        sessionId: task.taskId,
        commandId: "automation-parent:manual:run-1",
        payload: {
          text: "每 5 分钟给我讲个冷笑话",
          heldQueueDisposition: "keepQueueAndSend",
          automationId: "automation-parent",
          toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
        },
      }),
    });
  });

  it("drains a mobile task command when the session syncer observes the ready event", async () => {
    const { agent, eventEmitter, indexFrameEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_first",
      queryId: "query_first",
      content: "first",
    });
    await service.enqueueTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_second",
      traceId: "input_second",
      queryId: "query_second",
      type: "send_prompt",
      content: "second",
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_turn_completed",
        sessionId: task.taskId,
        turnId: "turn_first",
        seq: 2,
        timestamp: 100,
        traceId: "protocol_trace_first",
        type: "turn.completed",
        payload: {
          inputId: "input_first",
          response: "done",
        },
      },
    });
    await flushMicrotasks();

    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);

    await firePromptCompletedState(indexFrameEmitter, {
      sessionId: task.taskId,
      workspacePath: "/repo",
    });
    await flushMicrotasks();

    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(2);
    // 幂等键 inputId→commandId：drain 落 v4 sendText，终态收口仍按 traceId 对账。
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "sendText",
        sessionId: task.taskId,
        commandId: "input_second",
        payload: { text: "second", heldQueueDisposition: "keepQueueAndSend" },
      }),
    });
  });

  it("waits for the prompt completed ready state before draining a mobile task command", async () => {
    const { agent, eventEmitter, indexFrameEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_first",
      queryId: "query_first",
      content: "first",
    });
    await service.enqueueTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_second",
      traceId: "input_second",
      queryId: "query_second",
      type: "send_prompt",
      content: "second",
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_turn_completed",
        sessionId: task.taskId,
        turnId: "turn_first",
        seq: 2,
        timestamp: 100,
        traceId: "protocol_trace_first",
        type: "turn.completed",
        payload: {
          inputId: "input_first",
          response: "done",
        },
      },
    });
    await flushMicrotasks();

    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);

    await firePromptCompletedState(indexFrameEmitter, {
      sessionId: task.taskId,
      workspacePath: "/repo",
    });
    await flushMicrotasks();

    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(2);
    // 幂等键 inputId→commandId：drain 落 v4 sendText，终态收口仍按 traceId 对账。
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "sendText",
        sessionId: task.taskId,
        commandId: "input_second",
        payload: { text: "second", heldQueueDisposition: "keepQueueAndSend" },
      }),
    });
  });

  it("rejects a stale mobile enqueue command for an older owner run", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_current",
      queryId: "query_current",
      content: "current",
    });

    await expect(
      service.enqueueTaskCommand({
        workspacePath: "/repo",
        taskId: task.taskId,
        commandId: "queued_stale",
        traceId: "input_stale_queued",
        queryId: "query_stale_queued",
        type: "send_prompt",
        content: "stale queued",
        ownerRunId: "input_old",
      }),
    ).rejects.toMatchObject({
      code: "STALE_TASK_OWNER_COMMAND",
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);
    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
      clientMode: "web-remote-replayable",
    });
    expect(snapshot?.runtime?.pendingCommands).toEqual([]);
  });

  it("rejects a stale mobile promote command for an older owner run", async () => {
    const { service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_current",
      queryId: "query_current",
      content: "current",
    });
    await service.enqueueTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_second",
      traceId: "input_second",
      queryId: "query_second",
      type: "send_prompt",
      content: "second",
      ownerRunId: "input_current",
    });

    await expect(
      service.promoteTaskCommand({
        workspacePath: "/repo",
        taskId: task.taskId,
        commandId: "queued_second",
        ownerRunId: "input_old",
        clientMode: "web-remote-replayable",
      }),
    ).rejects.toMatchObject({
      code: "STALE_TASK_OWNER_COMMAND",
    });

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
      clientMode: "web-remote-replayable",
    });
    expect(snapshot?.runtime?.pendingCommands).toEqual([
      expect.objectContaining({
        commandId: "queued_second",
        status: "accepted",
        traceId: "input_second",
      }),
    ]);
  });

  it("cancels an accepted mobile task command before it drains", async () => {
    const { agent, indexFrameEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_current",
      queryId: "query_current",
      content: "current",
    });
    await service.enqueueTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_second",
      traceId: "input_second",
      queryId: "query_second",
      type: "send_prompt",
      content: "second",
      ownerRunId: "input_current",
    });

    const result = await service.cancelTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_second",
      ownerRunId: "input_current",
      clientMode: "web-remote-replayable",
    });

    expect(result).toEqual(
      expect.objectContaining({
        canceled: true,
        commandId: "queued_second",
        status: "accepted",
      }),
    );
    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
      clientMode: "web-remote-replayable",
    });
    expect(snapshot?.runtime?.pendingCommands).toEqual([]);

    await firePromptCompletedState(indexFrameEmitter, {
      sessionId: task.taskId,
      workspacePath: "/repo",
    });
    await flushMicrotasks();

    expect(agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);
  });

  it("keeps a running mobile task command when cancel races with drain", async () => {
    const { service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.enqueueTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_running",
      traceId: "input_running",
      queryId: "query_running",
      type: "send_prompt",
      content: "already running",
    });
    await flushMicrotasks();

    const result = await service.cancelTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_running",
      clientMode: "web-remote-replayable",
    });

    expect(result).toEqual(
      expect.objectContaining({
        canceled: false,
        commandId: "queued_running",
        reason: "already_running",
        status: "running",
      }),
    );
    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
      clientMode: "web-remote-replayable",
    });
    expect(snapshot?.runtime?.pendingCommands).toEqual([
      expect.objectContaining({
        commandId: "queued_running",
        status: "running",
        traceId: "input_running",
      }),
    ]);
  });

  it("keeps mobile clientId on the v4 sendText envelope when draining a host command", async () => {
    const { agent, indexFrameEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_first",
      content: "first",
    });
    await service.enqueueTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_second",
      traceId: "input_second",
      type: "send_prompt",
      content: "second",
      clientId: "mobile-client-7",
    });
    await firePromptCompletedState(indexFrameEmitter, {
      sessionId: task.taskId,
      workspacePath: "/repo",
    });
    await flushMicrotasks();

    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          commandId: "input_second",
          clientId: "mobile-client-7",
        }),
      }),
    );
  });

  it("marks a drained mobile command failed when the v4 sendText ACK is rejected", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.sendConversationCommandV4).mockResolvedValueOnce({
      commandId: "input_failed",
      status: "failed",
      reasonCode: "fault.command.executionFailed",
      message: "boom",
      revisionAtDecision: 3,
    });

    await service.enqueueTaskCommand({
      workspacePath: "/repo",
      taskId: task.taskId,
      commandId: "queued_failed",
      traceId: "input_failed",
      type: "send_prompt",
      content: "will fail",
    });
    await flushMicrotasks();

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
      clientMode: "web-remote-replayable",
    });
    expect(snapshot?.runtime?.pendingCommands).toEqual([
      expect.objectContaining({
        commandId: "queued_failed",
        status: "failed",
        error: expect.stringContaining("fault.command.executionFailed"),
      }),
    ]);
  });

  it("keeps attachment prompts on the legacy session/send fallback", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.sendConversationCommandV4).mockClear();

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_attach",
      content: "see image",
      modelSelection: {
        providerId: "test-provider",
        modelId: "test-model",
        options: { reasoningLevel: "high" },
      },
      modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
      attachments: [
        { kind: "image", filename: "a.png", mimeType: "image/png", dataBase64: "aGk=" },
      ],
    });

    // 附件命令面未建模（v4 attachmentRef 引用模型缺上传面）：带附件输入仍走旧 session/send。
    expect(agent.sendConversationCommandV4).not.toHaveBeenCalled();
    expect(agent.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        inputId: "input_attach",
        modelSelection: {
          providerId: "test-provider",
          modelId: "test-model",
          options: { reasoningLevel: "high" },
        },
        modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
        attachments: [expect.objectContaining({ filename: "a.png" })],
      }),
    );
  });

  it("requires authoritative identity before stopping a running topic", async () => {
    const { service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const target = { taskId: task.taskId, workspacePath: "/repo" };
    vi.mocked(readBotGroupRuntimeSnapshot).mockResolvedValueOnce({
      control: { stopState: "idle", activeWorks: [] },
    } as never);
    await expect(service.readBotTopicExecution!(target)).resolves.toBeUndefined();
    vi.mocked(readBotGroupRuntimeSnapshot).mockResolvedValueOnce({
      control: {
        stopState: "stoppable",
        activeWorks: [
          {
            kind: "primaryTurn",
            foregroundExecutionId: "execution",
            sourceCommandId: "input-current",
          },
        ],
      },
    } as never);
    await expect(service.readBotTopicExecution!(target)).resolves.toEqual({
      executionId: "execution",
      sourceCommandId: "input-current",
    });
    vi.mocked(readBotGroupRuntimeSnapshot).mockResolvedValueOnce({
      control: { stopState: "stoppable", activeWorks: [] },
    } as never);
    await expect(service.readBotTopicExecution!(target)).rejects.toThrow("identity is unavailable");
  });

  it("routes topic stop through the same workspace and waits for its execution to end", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    let finish!: () => void;
    vi.mocked(waitBotGroupExecutionEnd).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({} as never);
        }),
    );
    let completed = false;
    const stopping = service.stopBotTopicExecution!({
      taskId: task.taskId,
      workspacePath: "/repo",
      remoteSessionId: "remote-a",
      executionId: "old",
    }).then(() => {
      completed = true;
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith(
      expect.objectContaining({
        remoteSessionId: "remote-a",
        envelope: expect.objectContaining({
          type: "stop",
          payload: { expectedForegroundExecutionId: "old" },
        }),
      }),
    );
    expect(completed).toBe(false);
    finish();
    await stopping;
    expect(completed).toBe(true);
  });

  it("preserves the observed execution identity in a topic stop", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    await service.stopGeneration({
      taskId: task.taskId,
      expectedForegroundExecutionId: "old-execution",
    });
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          type: "stop",
          payload: { expectedForegroundExecutionId: "old-execution" },
        }),
      }),
    );
  });

  it("routes stopGeneration through the v4 stop command", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.stopGeneration({ taskId: task.taskId });

    // M5 ③-4：agentService.stopSession 已删除（v4 stop 命令唯一路径），断言收敛为 v4 面。
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "stop",
        sessionId: task.taskId,
        payload: {},
      }),
    });
  });

  // M5 ③-3：模式切换（手机远控语义入口 setMode/setConfigOption）收敛 v4 switchCollaborationMode。
  it("routes setMode through the v4 switchCollaborationMode command", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.setMode({ taskId: task.taskId, mode: "plan" });

    expect(agent.setMode).not.toHaveBeenCalled();
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "switchCollaborationMode",
        sessionId: task.taskId,
        payload: { mode: "plan" },
      }),
    });
  });

  // M5 ③-3：host 无本地 v4 投影，CAS 首发 baseRevision=0 探测，stale 用 revisionAtDecision 收敛。
  it("retries a stale switchCollaborationMode ACK with the server revision", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.sendConversationCommandV4).mockResolvedValueOnce({
      commandId: "probe",
      status: "stale",
      reasonCode: "proto.staleRevision",
      revisionAtDecision: 7,
    });

    await service.setMode({ taskId: task.taskId, mode: "yolo" });

    const envelopes = vi
      .mocked(agent.sendConversationCommandV4)
      .mock.calls.filter(([params]) => params.envelope.type === "switchCollaborationMode")
      .map(([params]) => params.envelope);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({ baseRevision: 0 });
    expect(envelopes[1]).toMatchObject({ baseRevision: 7, payload: { mode: "yolo" } });
  });

  // M5 ③-3 残留保真：v4 switchCollaborationMode 值域刻意排除 auto，auto 继续走旧 op。
  it("keeps mode=auto on the legacy session/setMode fallback", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.setMode({ taskId: task.taskId, mode: "auto" });

    expect(agent.setMode).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: task.taskId, mode: "auto" }),
    );
    expect(
      vi
        .mocked(agent.sendConversationCommandV4)
        .mock.calls.some(([params]) => params.envelope.type === "switchCollaborationMode"),
    ).toBe(false);
  });

  // M5 ③-3：思考深度收敛 v4 switchModelConfig（thought 字段承载，provider/model 取当前选型）。
  it("routes thought level config through v4 switchModelConfig with the current model", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    const configOptions = await service.setConfigOption({
      taskId: task.taskId,
      configId: "thought_level",
      value: "max",
    });

    expect(agent.setThoughtLevel).not.toHaveBeenCalled();
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "switchModelConfig",
        sessionId: task.taskId,
        payload: { provider: "glm", model: "glm-4.6", thought: "max" },
      }),
    });
    expect(configOptions.some((option) => option.id === "thought_level")).toBe(true);
  });

  // M5 ③-3 评估标注保真：setModel 仍走旧 op（v4 switchModelConfig 无 runtimeModel 解析，
  // 迁移会让手机远控的 custom provider 跨切失效）。
  it("keeps setModel on the legacy session/setModel op", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.setModel({
      taskId: task.taskId,
      modelSelection: { providerId: "glm", modelId: "glm-4.7" },
    });

    expect(agent.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: task.taskId }),
    );
    expect(
      vi
        .mocked(agent.sendConversationCommandV4)
        .mock.calls.some(([params]) => params.envelope.type === "switchModelConfig"),
    ).toBe(false);
  });

  it("routes local automation selection through V4 commands without Host runtimeModel", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    await service.setAutomationSessionConfig({
      taskId: task.taskId,
      traceId: "automation-run" as TraceId,
      modelSelection: { providerId: "provider-deepseek", modelId: "deepseek-v4-pro" },
      thoughtLevel: "high",
      mode: "edit",
    });

    expect(agent.setModel).not.toHaveBeenCalled();
    expect(agent.setThoughtLevel).not.toHaveBeenCalled();
    const automationCommands = vi
      .mocked(agent.sendConversationCommandV4)
      .mock.calls.map(([params]) => params.envelope)
      .slice(-3);
    expect(automationCommands).toEqual([
      expect.objectContaining({
        type: "switchModelConfig",
        payload: expect.objectContaining({
          provider: "provider-deepseek",
          model: "deepseek-v4-pro",
          thought: "high",
        }),
      }),
      expect.objectContaining({
        type: "switchModelConfig",
        payload: {
          provider: "provider-deepseek",
          model: "deepseek-v4-pro",
          thought: "high",
        },
      }),
      expect.objectContaining({
        type: "switchCollaborationMode",
        payload: { mode: "edit" },
      }),
    ]);
  });

  it("routes desktop-attached remote automation with ModelSelection only", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:dev:/repo",
      provider: "glm",
    });
    await service.setAutomationSessionConfig({
      taskId: task.taskId,
      traceId: "remote-automation-run" as TraceId,
      modelSelection: { providerId: "provider-deepseek", modelId: "deepseek-v4-pro" },
      thoughtLevel: "high",
      mode: "edit",
    });

    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceIdentity: "remote:ssh:dev:/repo",
        envelope: expect.objectContaining({
          type: "switchModelConfig",
          payload: expect.objectContaining({
            provider: "provider-deepseek",
            model: "deepseek-v4-pro",
            thought: "high",
          }),
        }),
      }),
    );
    const modelCommand = vi
      .mocked(agent.sendConversationCommandV4)
      .mock.calls.map(([params]) => params.envelope)
      .find((envelope) => envelope.type === "switchModelConfig");
    expect(modelCommand?.payload).not.toHaveProperty("runtimeModel");
  });

  it("routes respondPermission through v4 resolveInteraction keyed by requestId", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    const submitted = await service.respondPermission({
      taskId: task.taskId,
      requestId: "perm_req_1",
      optionId: "allow_project",
      response: { decision: "allow", reason: "Approved" },
    });

    expect(submitted).toBe(true);
    // M5 ③-4：agentService.respondPermission 已删除（v4 resolveInteraction 唯一路径）。
    expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "resolveInteraction",
        sessionId: task.taskId,
        payload: {
          interactionId: "perm_req_1",
          answer: { optionId: "allow_project" },
        },
      }),
    });
  });

  it("routes respondElicitation through v4 resolveInteraction with action/content", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "replayable",
    })((event) => {
      received.push(event);
    });

    try {
      const submitted = await service.respondElicitation({
        taskId: task.taskId,
        requestId: "elicit_req_1",
        action: "accept",
        content: { answers: { "Pick one": "B" } },
        clientMode: "web-remote-replayable",
      });

      expect(submitted).toBe(true);
      expect(agent.sendConversationCommandV4).toHaveBeenLastCalledWith({
        workspacePath: "/repo",
        workspaceIdentity: undefined,
        envelope: expect.objectContaining({
          type: "resolveInteraction",
          sessionId: task.taskId,
          payload: {
            interactionId: "elicit_req_1",
            answer: {
              action: "accept",
              content: { answers: { "Pick one": "B" } },
            },
          },
        }),
      });
      // 语义保真：replayable 应答后 observer 弹窗按 elicitation_response 清理（原
      // respondUserInput 的 web-remote-replayable 分支，现由 adapter 本地补投）。
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "elicitation_response",
          requestId: "elicit_req_1",
          action: "accept",
        }),
      );
    } finally {
      disposable.dispose();
    }
  });

  it("treats a noop resolveInteraction ACK as an idempotent success", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.sendConversationCommandV4).mockResolvedValueOnce({
      commandId: "any",
      status: "noop",
      reasonCode: "proto.alreadyResolved",
      revisionAtDecision: 9,
    });

    await expect(
      service.respondPermission({
        taskId: task.taskId,
        requestId: "perm_req_late",
        optionId: "deny",
        response: { decision: "deny", reason: "Denied" },
      }),
    ).resolves.toBe(true);
  });

  it("merges live subagent tool projection into terminal ZCode snapshots", async () => {
    const { agent, eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const terminalSnapshot = makeSnapshot({
      sessionId: task.taskId,
      workspacePath: "/repo",
      messages: [
        makeUserMessage({
          sessionId: task.taskId,
          messageId: "msg_user_1",
          text: "加一个地址系统，可以加，可以选",
        }),
        makeAssistantAgentToolMessage({
          sessionId: task.taskId,
          messageId: "msg_assistant_1",
          toolCallId: "call_00_agent",
        }),
      ],
    });
    vi.mocked(agent.resumeSession).mockResolvedValue({
      ...terminalSnapshot,
      session: {
        ...terminalSnapshot.session,
        status: "completed",
      },
      projection: {
        ...terminalSnapshot.projection,
        status: "completed",
      },
    });

    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
    })((event) => {
      streamEvents.push(event);
    });

    try {
      const scheduledEvent: ZCodeSessionEvent = {
        eventId: "evt_subagent_tool_scheduled",
        sessionId: task.taskId,
        turnId: "turn_1",
        seq: 1,
        traceId: "trace_subagent_tool",
        timestamp: 60,
        type: "tool.updated",
        payload: {
          kind: "scheduled",
          toolCallId: "tool_subagent_read",
          toolName: "Read",
          input: { file_path: "package.json" },
          parentToolCallId: "call_00_agent",
          source: "subagent",
          agentId: "agent_1",
          agentType: "Explore",
          childSessionId: "sess_subagent_agent_1",
          childToolCallId: "call_child_read",
        },
      };
      const resultEvent: ZCodeSessionEvent = {
        eventId: "evt_subagent_tool_result",
        sessionId: task.taskId,
        turnId: "turn_1",
        seq: 4,
        traceId: "trace_subagent_tool",
        timestamp: 63,
        type: "tool.updated",
        payload: {
          kind: "result",
          toolCallId: "tool_subagent_read",
          parentToolCallId: "call_00_agent",
          source: "subagent",
          agentId: "agent_1",
          agentType: "Explore",
          childSessionId: "sess_subagent_agent_1",
          childToolCallId: "call_child_read",
          result: { content: "read output" },
          duration: 10,
        },
      };

      eventEmitter.fire({ type: "session.event", event: scheduledEvent });
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_subagent_tool_progress",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 2,
          traceId: "trace_subagent_tool",
          timestamp: 61,
          type: "tool.updated",
          payload: {
            kind: "started",
            toolCallId: "tool_subagent_read",
            toolName: "Read",
            parentToolCallId: "call_00_agent",
            source: "subagent",
            agentId: "agent_1",
          },
        },
      });
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_parent_turn_completed",
          sessionId: task.taskId,
          turnId: "turn_1",
          seq: 3,
          traceId: "trace_subagent_tool",
          timestamp: 62,
          type: "turn.completed",
          payload: {
            inputId: "input_parent",
            resultType: "success",
          },
        },
      });
      eventEmitter.fire({ type: "session.event", event: resultEvent });

      expect(streamEvents.some((event) => event.type === "tool_call_update")).toBe(true);
      expect(streamEvents).toContainEqual(
        expect.objectContaining({
          type: "tool_call_update",
          toolId: "tool_subagent_read",
          toolName: "Read",
          status: "in_progress",
          input: { file_path: "package.json" },
        }),
      );
      expect(streamEvents).toContainEqual(
        expect.objectContaining({
          type: "tool_call_update",
          toolId: "tool_subagent_read",
          parentToolUseId: "call_00_agent",
          toolName: "Read",
          status: "completed",
          input: { file_path: "package.json" },
        }),
      );

      const snapshot = await service.getTaskSnapshot({
        workspacePath: "/repo",
        taskId: task.taskId,
      });
      const tools = snapshot?.messages[1]?.tools ?? [];
      const childTool = tools.find(
        (tool) =>
          (tool.raw as { toolCallId?: string } | undefined)?.toolCallId === "tool_subagent_read",
      );

      expect(tools).toHaveLength(2);
      expect(childTool?.output).toBe("read output");
      expect((childTool?.raw as { parentToolCallId?: string } | undefined)?.parentToolCallId).toBe(
        "call_00_agent",
      );
    } finally {
      disposable.dispose();
    }
  });

  it("attaches hidden task notification metadata to background Agent tools in restored snapshots", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const restored = makeSnapshot({
      sessionId: task.taskId,
      workspacePath: "/repo",
      messages: [
        makeUserMessage({
          sessionId: task.taskId,
          messageId: "msg_user_1",
          text: "启动后台 Agent",
        }),
        {
          info: {
            messageId: "msg_assistant_agent",
            sessionId: task.taskId,
            role: "assistant",
            time: { created: 40, completed: 50 },
            agent: "glm",
            model: { providerId: "glm", modelId: "glm-4.6" },
          },
          parts: [
            {
              partId: "part_agent_tool",
              sessionId: task.taskId,
              messageId: "msg_assistant_agent",
              type: "tool",
              callId: "toolu_background_agent",
              tool: "Agent",
              state: {
                status: "completed",
                input: {
                  prompt: "Explore project structure",
                  run_in_background: true,
                },
                output:
                  "Async agent launched successfully.\noutput_file: /tmp/background-agent.output",
                title: "Agent",
                metadata: {},
                startedAt: 41,
                completedAt: 49,
              },
            },
          ],
        } satisfies ZCodeMessageWithParts,
        makeUserMessage({
          sessionId: task.taskId,
          messageId: "msg_task_notification",
          text: [
            "<task-notification>",
            "<task-id>agent_1</task-id>",
            "<tool-use-id>toolu_background_agent</tool-use-id>",
            "<output-file>/tmp/background-agent.output</output-file>",
            "<status>completed</status>",
            "<result>Background Agent restored result</result>",
            "</task-notification>",
          ].join("\n"),
          parts: [
            {
              partId: "part_task_notification",
              sessionId: task.taskId,
              messageId: "msg_task_notification",
              type: "text",
              synthetic: true,
              metadata: { source: "background_task" },
              text: [
                "<task-notification>",
                "<task-id>agent_1</task-id>",
                "<tool-use-id>toolu_background_agent</tool-use-id>",
                "<output-file>/tmp/background-agent.output</output-file>",
                "<status>completed</status>",
                "<result>Background Agent restored result</result>",
                "</task-notification>",
              ].join("\n"),
            },
          ],
        }),
      ],
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(restored);

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
    });

    expect(snapshot?.messages).toHaveLength(2);
    expect(snapshot?.messages[1]?.tools?.[0]?.raw).toMatchObject({
      _meta: {
        zcode: {
          taskNotification: {
            outputFile: "/tmp/background-agent.output",
            result: "Background Agent restored result",
            status: "completed",
            taskId: "agent_1",
          },
        },
      },
    });
  });

  it.each([
    {
      expectedError: BACKGROUND_AGENT_PROVIDER_ERROR,
      expectedStatus: "failed" as const,
      notificationStatus: "failed",
    },
    {
      expectedError: undefined,
      expectedStatus: "completed" as const,
      notificationStatus: "stopped",
    },
  ])(
    "restores a $notificationStatus background Agent notification without changing unrelated launch semantics",
    async ({ expectedError, expectedStatus, notificationStatus }) => {
      const { agent, service } = createService();
      const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
      const notificationSummary = `Agent general-purpose task "Review" ${notificationStatus}.`;
      const notificationText = [
        "<task-notification>",
        "<task-id>agent_failed</task-id>",
        "<tool-use-id>toolu_background_agent_failed</tool-use-id>",
        "<output-file>/tmp/background-agent-failed.output</output-file>",
        `<status>${notificationStatus}</status>`,
        `<summary>${notificationSummary.replaceAll('"', "&quot;")}</summary>`,
        ...(expectedError ? [`<error>${expectedError}</error>`] : []),
        "</task-notification>",
      ].join("\n");
      const restored = makeSnapshot({
        sessionId: task.taskId,
        workspacePath: "/repo",
        messages: [
          makeUserMessage({
            sessionId: task.taskId,
            messageId: "msg_user_failed",
            text: "启动会失败的后台 Agent",
          }),
          {
            info: {
              messageId: "msg_assistant_failed_agent",
              sessionId: task.taskId,
              role: "assistant",
              time: { created: 40, completed: 50 },
              agent: "glm",
              model: { providerId: "glm", modelId: "glm-4.6" },
            },
            parts: [
              {
                partId: "part_failed_agent_tool",
                sessionId: task.taskId,
                messageId: "msg_assistant_failed_agent",
                type: "tool",
                callId: "toolu_background_agent_failed",
                tool: "Agent",
                state: {
                  status: "completed",
                  input: {
                    prompt: "Review the workspace",
                    run_in_background: true,
                  },
                  output:
                    "Async agent launched successfully.\noutput_file: /tmp/background-agent-failed.output",
                  title: "Agent",
                  metadata: {},
                  startedAt: 41,
                  completedAt: 49,
                },
              },
            ],
          } satisfies ZCodeMessageWithParts,
          makeUserMessage({
            sessionId: task.taskId,
            messageId: "msg_failed_task_notification",
            text: notificationText,
            parts: [
              {
                partId: "part_failed_task_notification",
                sessionId: task.taskId,
                messageId: "msg_failed_task_notification",
                type: "text",
                synthetic: true,
                metadata: { source: "background_task" },
                text: notificationText,
              },
            ],
          }),
        ],
      });
      vi.mocked(agent.resumeSession).mockResolvedValueOnce(restored);

      const snapshot = await service.getTaskSnapshot({
        workspacePath: "/repo",
        taskId: task.taskId,
      });
      const restoredTool = snapshot?.messages[1]?.tools?.[0];

      expect(restoredTool).toMatchObject({
        status: expectedStatus,
        raw: {
          _meta: {
            zcode: {
              taskNotification: {
                status: notificationStatus,
                summary: notificationSummary,
                taskId: "agent_failed",
              },
            },
          },
        },
      });
      expect(restoredTool?.error).toBe(expectedError);
    },
  );

  it("projects live task notification turns back onto matching background Agent tools", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
    })((event) => {
      streamEvents.push(event);
    });

    try {
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_task_notification_started",
          sessionId: task.taskId,
          turnId: "turn_task_notification",
          seq: 1,
          traceId: "trace_task_notification",
          timestamp: 70,
          type: "turn.started",
          payload: {
            input: [
              "<task-notification>",
              "<task-id>agent_1</task-id>",
              "<tool-use-id>toolu_background_agent</tool-use-id>",
              "<output-file>/tmp/background-agent.output</output-file>",
              "<status>completed</status>",
              "<summary>Agent general-purpose task &quot;Review&quot; completed.</summary>",
              "<result>Background Agent live result</result>",
              "</task-notification>",
            ].join("\n"),
            inputSource: "task-notification",
            inputVisibility: "model-only",
          },
        },
      });

      expect(streamEvents).toContainEqual(
        expect.objectContaining({
          type: "tool_call_update",
          taskId: task.taskId,
          toolId: "toolu_background_agent",
          status: "completed",
          content: "Background Agent live result",
          raw: expect.objectContaining({
            _meta: expect.objectContaining({
              zcode: expect.objectContaining({
                taskNotification: {
                  outputFile: "/tmp/background-agent.output",
                  result: "Background Agent live result",
                  status: "completed",
                  summary: 'Agent general-purpose task "Review" completed.',
                  taskId: "agent_1",
                },
              }),
            }),
            toolCallId: "toolu_background_agent",
          }),
        }),
      );
    } finally {
      disposable.dispose();
    }
  });

  it("projects failed live task notifications with the provider error on matching Agent tools", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
    })((event) => {
      streamEvents.push(event);
    });

    try {
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_failed_task_notification_started",
          sessionId: task.taskId,
          turnId: "turn_failed_task_notification",
          seq: 1,
          traceId: "trace_failed_task_notification",
          timestamp: 80,
          type: "turn.started",
          payload: {
            input: [
              "<task-notification>",
              "<task-id>agent_failed</task-id>",
              "<tool-use-id>toolu_background_agent_failed</tool-use-id>",
              "<output-file>/tmp/background-agent-failed.output</output-file>",
              "<status>failed</status>",
              `<summary>${BACKGROUND_AGENT_FAILED_SUMMARY.replaceAll('"', "&quot;")}</summary>`,
              `<error>${BACKGROUND_AGENT_PROVIDER_ERROR}</error>`,
              "</task-notification>",
            ].join("\n"),
            inputSource: "task-notification",
            inputVisibility: "model-only",
          },
        },
      });
    } finally {
      disposable.dispose();
    }

    const failedUpdate = streamEvents.find(
      (event): event is Extract<ZCodeStreamEvent, { type: "tool_call_update" }> =>
        event.type === "tool_call_update" && event.toolId === "toolu_background_agent_failed",
    );
    expect(failedUpdate).toMatchObject({
      type: "tool_call_update",
      taskId: task.taskId,
      toolId: "toolu_background_agent_failed",
      status: "failed",
      error: BACKGROUND_AGENT_PROVIDER_ERROR,
      raw: {
        _meta: {
          zcode: {
            taskNotification: {
              error: BACKGROUND_AGENT_PROVIDER_ERROR,
              status: "failed",
              summary: BACKGROUND_AGENT_FAILED_SUMMARY,
              taskId: "agent_failed",
            },
          },
        },
      },
    });
  });

  it("merges live background job updates with restored replayable snapshot jobs", async () => {
    const { agent, eventEmitter, service } = createService();
    const workspacePath = "/repo";
    const workspaceIdentity = "remote:ssh:dev:/repo";
    const task = await service.createTask({
      workspacePath,
      workspaceIdentity,
      provider: "glm",
    });
    const restored = makeSnapshot({
      sessionId: task.taskId,
      workspacePath,
      workspaceIdentity,
      backgroundJobs: [
        {
          type: "background_bash",
          taskId: "bash_a",
          command: "sleep 1",
          status: "running",
          background: true,
        },
        {
          type: "background_bash",
          taskId: "bash_b",
          command: "sleep 2",
          status: "running",
          background: true,
        },
      ],
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(restored);

    const snapshot = await service.getTaskSnapshot({
      workspacePath,
      workspaceIdentity,
      taskId: task.taskId,
    });
    expect(snapshot?.runtime?.backgroundBashJobs?.map((job) => job.jobId)).toEqual([
      "bash_a",
      "bash_b",
    ]);

    const streamEvents: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath,
      workspaceIdentity,
      taskId: task.taskId,
      deliveryKind: "replayable",
    })((event) => {
      streamEvents.push(event);
    });

    try {
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: "evt_background_job_update",
          sessionId: task.taskId,
          seq: 1,
          timestamp: 70,
          type: "session.updated",
          payload: {
            type: "background_bash",
            taskId: "bash_a",
            command: "sleep 1",
            status: "completed",
            background: true,
          },
        },
      });

      const backgroundUpdate = streamEvents.findLast(
        (event): event is Extract<ZCodeStreamEvent, { type: "background_bash_jobs_update" }> =>
          event.type === "background_bash_jobs_update",
      );
      expect(backgroundUpdate?.jobs.map((job) => [job.jobId, job.status])).toEqual([
        ["bash_a", "completed"],
        ["bash_b", "running"],
      ]);
    } finally {
      disposable.dispose();
    }
  });

  it("filters non-glm legacy task rows in sqlite-backed lists", async () => {
    const { service, taskIndexRepo } = createService();
    await seedIndexedTask(taskIndexRepo, { taskId: "glm_active", provider: "glm" });
    await seedIndexedTask(taskIndexRepo, { taskId: "claude_active", provider: "claude" });
    await seedIndexedTask(taskIndexRepo, {
      taskId: "claude_imported",
      provider: "claude",
      migrationSource: "claudeCode",
    });
    await seedIndexedTask(taskIndexRepo, {
      taskId: "glm_pinned",
      provider: "glm",
      pinned: true,
    });
    await seedIndexedTask(taskIndexRepo, {
      taskId: "claude_pinned",
      provider: "claude",
      pinned: true,
    });
    await seedIndexedTask(taskIndexRepo, {
      taskId: "claude_imported_pinned",
      provider: "claude",
      pinned: true,
      migrationSource: "claudeCode",
    });

    const active = await service.listTasks({ workspacePath: "/repo" });
    const pinned = await service.listPinnedTasks({ workspacePath: "/repo" });
    const pinnedIds = await service.listPinnedTaskIds();
    const taskList = await service.listTaskList({
      kind: "active",
      workspaceScopes: [{ workspacePath: "/repo" }],
      sortBy: "updated",
    });
    // M5 ②：listGroupedTaskView（tasks 表 join 的 grouped 查询）已删除；grouped 任务内容
    // 改由 sessions-index 提供，provider 过滤断言只保留仍存在的 sqlite 列表面。
    expect(active.map((task) => task.taskId)).toEqual(["glm_active"]);
    expect(pinned.map((task) => task.taskId)).toEqual(["glm_pinned"]);
    expect(pinnedIds).toEqual(["glm_pinned"]);
    expect(taskList.items.map((task) => task.taskId)).toEqual(["glm_active"]);
    expect(taskList.total).toBe(1);
  });

  it("filters non-glm task rows from grouped order save results", async () => {
    const { service, taskIndexRepo } = createService();
    await seedIndexedTask(taskIndexRepo, { taskId: "glm_active", provider: "glm" });
    await seedIndexedTask(taskIndexRepo, { taskId: "glm_grouped", provider: "glm" });
    await seedIndexedTask(taskIndexRepo, { taskId: "gemini_active", provider: "gemini" });
    const group = await service.createTaskGroup({ title: "Group" });

    const savedGroupedView = await service.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/repo" }],
      topLevelNodes: [
        { type: "group", groupId: group.id },
        {
          type: "task",
          task: { workspacePath: "/repo", taskId: "glm_active" },
        },
        {
          type: "task",
          task: { workspacePath: "/repo", taskId: "gemini_active" },
        },
      ],
      groups: [
        {
          groupId: group.id,
          taskRefs: [
            { workspacePath: "/repo", taskId: "glm_grouped" },
            { workspacePath: "/repo", taskId: "gemini_active" },
          ],
        },
      ],
    });
    const groupedTaskIds = savedGroupedView.nodes.flatMap((node) =>
      node.type === "group" ? node.tasks.map((task) => task.taskId) : [node.task.taskId],
    );
    const rawOrders = (
      taskIndexRepo as unknown as {
        getDatabase(): {
          prepare(sql: string): {
            all(): Array<{ node_key: string }>;
          };
        };
      }
    )
      .getDatabase()
      .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
      .all()
      .map((row) => row.node_key);
    const rawMembers = (
      taskIndexRepo as unknown as {
        getDatabase(): {
          prepare(sql: string): {
            all(): Array<{ task_id: string }>;
          };
        };
      }
    )
      .getDatabase()
      .prepare("SELECT task_id FROM task_group_members")
      .all()
      .map((row) => row.task_id);

    expect(groupedTaskIds).toEqual(["glm_grouped", "glm_active"]);
    expect(rawOrders.some((nodeKey) => nodeKey.includes("gemini_active"))).toBe(false);
    expect(rawMembers).toEqual(["glm_grouped"]);
  });

  it("keeps stale grouped tasks visible when auto archive is disabled", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-09T00:00:00.000Z").getTime();
    vi.setSystemTime(now);
    const { service, taskIndexRepo } = createService({
      settings: {
        taskAutoArchiveEnabled: false,
        taskAutoArchiveOlderThanDays: 7,
      },
    });
    await seedIndexedTask(taskIndexRepo, {
      taskId: "stale_glm",
      provider: "glm",
      updatedAt: now - 8 * 24 * 60 * 60 * 1000,
    });
    await seedIndexedTask(taskIndexRepo, {
      taskId: "stale_gemini",
      provider: "gemini",
      updatedAt: now - 8 * 24 * 60 * 60 * 1000,
    });

    // M5 ②：grouped 入口改为结构读取（listGroupedTaskViewStructure），auto-archive 触发口径不变。
    await service.listGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    const archived = await taskIndexRepo.listTaskMetas({
      workspacePath: "/repo",
      archived: true,
    });

    expect(archived.map((task) => task.taskId)).toEqual([]);
  });

  it("auto archives stale grouped tasks across providers when the setting is enabled", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-09T00:00:00.000Z").getTime();
    vi.setSystemTime(now);
    const { service, taskIndexRepo } = createService({
      settings: {
        taskAutoArchiveEnabled: true,
        taskAutoArchiveOlderThanDays: 7,
      },
    });
    await seedIndexedTask(taskIndexRepo, {
      taskId: "stale_glm",
      provider: "glm",
      updatedAt: now - 8 * 24 * 60 * 60 * 1000,
    });
    await seedIndexedTask(taskIndexRepo, {
      taskId: "stale_gemini",
      provider: "gemini",
      updatedAt: now - 8 * 24 * 60 * 60 * 1000,
    });

    // M5 ②：grouped 入口改为结构读取（listGroupedTaskViewStructure），auto-archive 触发口径不变。
    await service.listGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/repo" }],
    });
    const archived = await taskIndexRepo.listTaskMetas({
      workspacePath: "/repo",
      archived: true,
    });
    const visibleArchived = await service.listArchivedTasks({ workspacePath: "/repo" });

    expect(archived.map((task) => task.taskId)).toEqual(["stale_glm", "stale_gemini"]);
    expect(visibleArchived.map((task) => task.taskId)).toEqual(["stale_glm"]);
  });

  it("does not include zero ZCode Protocol context usage in task snapshots", async () => {
    const { service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
    });

    expect(snapshot?.runtime?.contextUsage).toBeUndefined();
  });

  it("uses runtime context usage when restored projection has no usage yet", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const restored = makeSnapshot({
      sessionId: task.taskId,
      workspacePath: "/repo",
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce({
      ...restored,
      projection: {
        ...restored.projection,
        contextUsed: 0,
      },
      runtime: {
        ...restored.runtime,
        contextUsage: {
          used: 12345,
          size: 128000,
          cost: null,
        },
      },
    });

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
    });

    expect(snapshot?.runtime?.contextUsage).toEqual({
      used: 12345,
      size: 128000,
      cost: null,
    });
  });

  it("prefers structured projection error code in restored task snapshots", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const restored = makeSnapshot({
      sessionId: task.taskId,
      workspacePath: "/repo",
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce({
      ...restored,
      session: {
        ...restored.session,
        status: "error",
      },
      projection: {
        ...restored.projection,
        status: "error",
        lastError: {
          type: "MODEL_ERROR",
          code: "provider_not_found",
          message: "Model provider is not configured: stale-provider",
          detail: "stale-provider/gpt-5.5",
        },
      },
    });

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
    });

    expect(snapshot?.meta.lastError).toEqual({
      code: "provider_not_found",
      detail: "stale-provider/gpt-5.5",
      message: "Model provider is not configured: stale-provider",
    });
  });

  it("restores protocol user file parts as task message attachments", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const imageBase64 = "QUJD";
    const videoBase64 = "REVG";
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: task.taskId,
        workspacePath: "/repo",
        messages: [
          makeUserMessage({
            sessionId: task.taskId,
            messageId: "msg_with_attachments",
            text: "inspect attachments",
            parts: [
              {
                partId: "msg_with_attachments_text",
                sessionId: task.taskId,
                messageId: "msg_with_attachments",
                type: "text",
                text: "inspect attachments",
              },
              {
                partId: "msg_with_attachments_file",
                sessionId: task.taskId,
                messageId: "msg_with_attachments",
                type: "file",
                mime: "text/plain",
                filename: "notes.txt",
                url: "/repo/notes.txt",
                metadata: {
                  originalUrl: "/repo/notes.txt",
                  preview: {
                    text: "hello world",
                    truncated: false,
                  },
                  sizeBytes: 11,
                  storageKind: "inline",
                },
              },
              {
                partId: "msg_with_attachments_image",
                sessionId: task.taskId,
                messageId: "msg_with_attachments",
                type: "file",
                mime: "image/png",
                filename: "diagram.png",
                url: `data:image/png;base64,${imageBase64}`,
                metadata: {
                  originalUrl: "/repo/diagram.png",
                  sizeBytes: 3,
                  storageKind: "inline",
                },
              },
              {
                partId: "msg_with_attachments_video",
                sessionId: task.taskId,
                messageId: "msg_with_attachments",
                type: "file",
                mime: "video/mp4",
                filename: "demo.mp4",
                url: `data:video/mp4;base64,${videoBase64}`,
                metadata: {
                  originalUrl: "/repo/demo.mp4",
                  sizeBytes: 3,
                  storageKind: "inline",
                },
              },
            ],
          }),
        ],
      }),
    );

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
    });

    expect(snapshot?.messages[0]).toMatchObject({
      role: "user",
      content: "inspect attachments",
      attachments: [
        {
          kind: "file",
          filename: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 11,
          localPath: "/repo/notes.txt",
        },
        {
          kind: "image",
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataBase64: imageBase64,
          localPath: "/repo/diagram.png",
        },
        {
          kind: "video",
          filename: "demo.mp4",
          mimeType: "video/mp4",
          sizeBytes: 3,
          dataBase64: videoBase64,
          localPath: "/repo/demo.mp4",
        },
      ],
    });
  });

  it("backfills indexed model hint for web remote replayable snapshot resume", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const taskId = "remote_deepseek_task";
    const workspacePath = "/repo";
    await seedIndexedTask(taskIndexRepo, {
      taskId,
      workspacePath,
      provider: "glm",
      model: "default-deepseek/deepseek-v4-flash",
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: taskId,
        workspacePath,
      }),
    );

    await service.getTaskSnapshot({
      workspacePath,
      taskId,
      clientMode: "web-remote-replayable",
    });

    expect(agent.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        workspaceIdentity: undefined,
        sessionId: taskId,
        model: {
          providerId: "default-deepseek",
          modelId: "deepseek-v4-flash",
        },
      }),
    );
  });

  it("does not backfill indexed model hint for desktop continuous snapshot resume", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const taskId = "desktop_deepseek_task";
    const workspacePath = "/repo";
    await seedIndexedTask(taskIndexRepo, {
      taskId,
      workspacePath,
      provider: "glm",
      model: "default-deepseek/deepseek-v4-flash",
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: taskId,
        workspacePath,
      }),
    );

    await service.getTaskSnapshot({
      workspacePath,
      taskId,
      clientMode: "desktop-continuous",
    });

    expect(vi.mocked(agent.resumeSession).mock.calls.at(-1)?.[0]?.model).toBeUndefined();
  });

  it("backfills indexed model hint when resumeTask omits model", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const taskId = "resume_deepseek_task";
    const workspacePath = "/repo";
    await seedIndexedTask(taskIndexRepo, {
      taskId,
      workspacePath,
      provider: "glm",
      model: "default-deepseek/deepseek-v4-flash",
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: taskId,
        workspacePath,
      }),
    );

    await service.resumeTask({
      workspacePath,
      taskId,
    });

    expect(agent.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        workspaceIdentity: undefined,
        sessionId: taskId,
        model: {
          providerId: "default-deepseek",
          modelId: "deepseek-v4-flash",
        },
      }),
    );
  });

  it("stamps offPeakTaskId on normal snapshot resume (D48)", async () => {
    // SG-01：legacy 分支已补写闲时标记，正常 snapshot 续跑路径必须同语义，
    // 否则 pre-D48 会话被闲时续跑后月亮标识与系统分组归属不会出现。
    const { agent, service, taskIndexRepo } = createService();
    const taskId = "resume_offpeak_stamp_task";
    const workspacePath = "/repo";
    await seedIndexedTask(taskIndexRepo, { taskId, workspacePath, provider: "glm" });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: taskId,
        workspacePath,
      }),
    );

    const meta = await service.resumeTask({
      workspacePath,
      taskId,
      offPeakTaskId: "offpeak-resume-stamp",
    });

    expect(meta.offPeakTaskId).toBe("offpeak-resume-stamp");
    const indexed = await taskIndexRepo.getTaskMeta({ workspacePath, taskId });
    expect(indexed?.offPeakTaskId).toBe("offpeak-resume-stamp");
  });

  it("backfills indexed thought level when resumeTask omits thought level", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const taskId = "resume_glm52_task";
    const workspacePath = "/repo";
    await seedIndexedTask(taskIndexRepo, {
      taskId,
      workspacePath,
      provider: "glm",
      model: "bigmodel-api/GLM-5.2",
      thoughtLevel: "high",
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: taskId,
        workspacePath,
      }),
    );

    await service.resumeTask({
      workspacePath,
      taskId,
    });

    expect(agent.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        workspaceIdentity: undefined,
        sessionId: taskId,
        model: {
          providerId: "bigmodel-api",
          modelId: "GLM-5.2",
        },
        thoughtLevel: "high",
      }),
    );
  });

  it("backfills indexed thought level for web replayable snapshot resume", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const taskId = "replayable_glm52_task";
    const workspacePath = "/repo";
    await seedIndexedTask(taskIndexRepo, {
      taskId,
      workspacePath,
      provider: "glm",
      model: "bigmodel-api/GLM-5.2",
      thoughtLevel: "high",
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: taskId,
        workspacePath,
      }),
    );

    await service.getTaskSnapshot({
      workspacePath,
      taskId,
      clientMode: "web-remote-replayable",
    });

    expect(agent.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        workspaceIdentity: undefined,
        sessionId: taskId,
        model: {
          providerId: "bigmodel-api",
          modelId: "GLM-5.2",
        },
        thoughtLevel: "high",
      }),
    );
  });

  it("skips indexed model backfill for web replayable ui-resolved snapshot restore", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const taskId = "replayable_readonly_unavailable_model";
    const workspacePath = "/repo";
    await seedIndexedTask(taskIndexRepo, {
      taskId,
      workspacePath,
      provider: "glm",
      model: "account:bigmodel-individual-coding-plan/GLM-5.2",
      thoughtLevel: "max",
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: taskId,
        workspacePath,
      }),
    );

    await service.getTaskSnapshot({
      workspacePath,
      taskId,
      clientMode: "web-remote-replayable",
      resumeModelPolicy: "ui-resolved-only",
    } as Parameters<typeof service.getTaskSnapshot>[0]);

    const resumeParams = vi.mocked(agent.resumeSession).mock.calls[0]?.[0];
    expect(resumeParams).toMatchObject({
      workspacePath,
      workspaceIdentity: undefined,
      sessionId: taskId,
      model: undefined,
    });
    expect(resumeParams?.thoughtLevel).toBeUndefined();
  });

  it("marks idle protocol snapshots with completed assistant turns as completed tasks", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const restored = makeSnapshot({
      sessionId: task.taskId,
      workspacePath: "/repo",
      messages: [
        makeUserMessage({
          sessionId: task.taskId,
          messageId: "msg_user_done",
          text: "继续执行",
        }),
        makeAssistantAgentToolMessage({
          sessionId: task.taskId,
          messageId: "msg_assistant_done",
          toolCallId: "tool_done",
        }),
      ],
    });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce({
      ...restored,
      session: {
        ...restored.session,
        status: "idle",
      },
      projection: {
        ...restored.projection,
        status: "idle",
        pendingPermissions: [],
        activeToolCalls: [],
      },
      runtime: {
        ...restored.runtime,
        pendingRequestIds: [],
      },
    });

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
    });

    expect(snapshot?.meta.status).toBe("completed");
  });

  it("marks protocol task snapshots when messageLimit trims older history", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.resumeSession).mockResolvedValueOnce(
      makeSnapshot({
        sessionId: task.taskId,
        workspacePath: "/repo",
        messages: [
          makeUserMessage({
            sessionId: task.taskId,
            messageId: "message_1",
            text: "message 1",
          }),
          makeUserMessage({
            sessionId: task.taskId,
            messageId: "message_2",
            text: "message 2",
          }),
          makeUserMessage({
            sessionId: task.taskId,
            messageId: "message_3",
            text: "message 3",
          }),
        ],
      }),
    );

    const snapshot = await service.getTaskSnapshot({
      workspacePath: "/repo",
      taskId: task.taskId,
      messageLimit: 2,
    });

    expect(snapshot?.messages.map((message) => message.content)).toEqual([
      "message 2",
      "message 3",
    ]);
    expect(snapshot?.history?.truncatedBefore).toBe(true);
    expect(snapshot?.history?.totalMessages).toBe(3);
  });

  it("restores legacy v2 task snapshots when the protocol session is missing", async () => {
    const { agent, service } = createService();
    const workspacePath = "/repo";
    const taskId = "legacy_task";
    const snapshotPath = getLegacyTaskSessionSnapshotPath(workspacePath, taskId);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        meta: {
          taskId,
          traceId: "trace_legacy",
          title: "Legacy ACP task",
          workspacePath,
          createdAt: 10,
          updatedAt: 20,
          mode: "yolo",
          provider: "glm",
        },
        messages: [
          {
            role: "user",
            content: "old prompt",
            timestamp: 10,
          },
        ],
      }),
      "utf-8",
    );
    vi.mocked(agent.resumeSession).mockRejectedValue(new Error(`Session not found: ${taskId}`));

    const snapshot = await service.getTaskSnapshot({ workspacePath, taskId });

    expect(snapshot?.meta).toMatchObject({
      taskId,
      title: "Legacy ACP task",
      workspacePath,
      status: "completed",
    });
    expect(snapshot?.messages.map((message) => message.content)).toEqual(["old prompt"]);

    vi.mocked(agent.onDynamicSessionEvent).mockClear();
    const disposable = service.onDynamicTaskEvent({
      workspacePath,
      taskId,
      deliveryKind: "continuous",
    })(() => undefined);
    disposable.dispose();

    expect(agent.onDynamicSessionEvent).not.toHaveBeenCalled();
  });

  it("upgrades legacy imported Claude snapshots to protocol sessions before model switching", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const workspacePath = "/repo";
    const taskId = "claude-import-590ccc622ab6db6bd9f1d7bf";
    const snapshotPath = getLegacyTaskSessionSnapshotPath(workspacePath, taskId);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        meta: {
          taskId,
          traceId: "trace_claude_import",
          title: "Claude imported task",
          workspacePath,
          createdAt: 10,
          updatedAt: 20,
          provider: "glm",
          migrationSource: "claudeCode",
        },
        messages: [
          {
            role: "user",
            content: "旧 Claude 提问",
            timestamp: 10,
          },
          {
            role: "assistant",
            content: "旧 Claude 回答",
            timestamp: 20,
          },
        ],
      }),
      "utf-8",
    );
    vi.mocked(agent.resumeSession).mockImplementation(async (params) => {
      throw new Error(`Session not found: ${params.sessionId}`);
    });

    const snapshot = await service.getTaskSnapshot({ workspacePath, taskId });

    expect(agent.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        workspaceIdentity: undefined,
        sessionId: taskId,
        persistence: "immediate",
        importedHistory: expect.objectContaining({
          source: "claudeCode",
          title: "Claude imported task",
          messages: [
            { role: "user", content: "旧 Claude 提问", timestamp: 10 },
            { role: "assistant", content: "旧 Claude 回答", timestamp: 20 },
          ],
        }),
      }),
    );
    expect(snapshot?.meta).toMatchObject({
      taskId,
      title: "Claude imported task",
      workspacePath,
      migrationSource: "claudeCode",
      model: "glm/glm-4.6",
    });
    expect(snapshot?.messages.map((message) => message.content)).toEqual([
      "旧 Claude 提问",
      "旧 Claude 回答",
    ]);
    await expect(taskIndexRepo.getTaskMeta({ workspacePath, taskId })).resolves.toMatchObject({
      taskId,
      migrationSource: "claudeCode",
      model: "glm/glm-4.6",
    });

    vi.mocked(agent.resumeSession).mockRestore();
    await service.setModel({
      taskId,
      traceId: "trace_set_model",
      modelSelection: { providerId: "glm", modelId: "glm-4.6" },
    });

    expect(agent.setModel).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity: undefined,
      sessionId: taskId,
      model: { providerId: "glm", modelId: "glm-4.6" },
    });
  });

  it("repairs empty protocol snapshots for imported Claude tasks from legacy backups", async () => {
    const { agent, service } = createService();
    const workspacePath = "/repo";
    const taskId = "claude-import-empty-protocol";
    const snapshotPath = getLegacyTaskSessionSnapshotPath(workspacePath, taskId);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        meta: {
          taskId,
          traceId: "trace_empty_protocol",
          title: "Claude empty protocol",
          workspacePath,
          createdAt: 10,
          updatedAt: 20,
          migrationSource: "claudeCode",
        },
        messages: [
          { role: "user", content: "旧问题", timestamp: 10 },
          { role: "assistant", content: "旧回答", timestamp: 20 },
        ],
      }),
      "utf-8",
    );
    vi.mocked(agent.resumeSession).mockResolvedValue(
      makeSnapshot({
        sessionId: taskId,
        workspacePath,
        title: "Claude empty protocol",
        messages: [],
      }),
    );

    const snapshot = await service.getTaskSnapshot({ workspacePath, taskId });

    expect(agent.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        sessionId: taskId,
        persistence: "immediate",
        importedHistory: expect.objectContaining({
          source: "claudeCode",
          messages: [
            { role: "user", content: "旧问题", timestamp: 10 },
            { role: "assistant", content: "旧回答", timestamp: 20 },
          ],
        }),
      }),
    );
    expect(snapshot?.messages.map((message) => message.content)).toEqual(["旧问题", "旧回答"]);
    expect(snapshot?.meta).toMatchObject({
      taskId,
      migrationSource: "claudeCode",
    });
  });

  it("migrates legacy wrapper task ids to acp_session_id backed protocol sessions", async () => {
    const { agent, service, taskIndexRepo } = createService();
    const workspacePath = "/repo";
    const taskId = "legacy_wrapper_task";
    const acpSessionId = "sess_legacy_real";
    await seedIndexedTask(taskIndexRepo, {
      taskId,
      provider: "glm",
      workspacePath,
    });
    await seedLegacyAcpSessionId(taskIndexRepo, {
      workspacePath,
      taskId,
      acpSessionId,
    });

    await expect(taskIndexRepo.getTaskMeta({ workspacePath, taskId })).resolves.toBeNull();
    await expect(
      taskIndexRepo.getTaskMeta({ workspacePath, taskId: acpSessionId }),
    ).resolves.toMatchObject({
      taskId: acpSessionId,
      workspacePath,
      provider: "glm",
    });

    const dbSnapshot = makeSnapshot({
      sessionId: acpSessionId,
      workspacePath,
      title: "DB session",
      messages: [
        makeUserMessage({
          sessionId: acpSessionId,
          messageId: "msg_db_user",
          text: "db prompt",
        }),
      ],
    });
    vi.mocked(agent.resumeSession).mockImplementation(async (params) => {
      if (params.sessionId === acpSessionId) {
        return dbSnapshot;
      }
      throw new Error(`Session not found: ${params.sessionId}`);
    });

    const snapshot = await service.getTaskSnapshot({
      workspacePath,
      taskId: acpSessionId,
    });

    expect(snapshot?.meta).toMatchObject({
      taskId: acpSessionId,
      title: "DB session",
      workspacePath,
      model: "glm/glm-4.6",
      thoughtLevel: "think",
    });
    expect(snapshot?.messages.map((message) => message.content)).toEqual(["db prompt"]);
    expect(agent.resumeSession).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity: undefined,
      sessionId: acpSessionId,
    });

    const disposable = service.onDynamicTaskEvent({
      workspacePath,
      taskId: acpSessionId,
      deliveryKind: "continuous",
    })(() => undefined);
    disposable.dispose();
    expect(agent.onDynamicSessionEvent).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity: undefined,
      sessionId: acpSessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
    });

    await service.sendPrompt({
      taskId: acpSessionId,
      traceId: "input_1",
      content: "continue",
    });
    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity: undefined,
      envelope: expect.objectContaining({
        type: "sendText",
        sessionId: acpSessionId,
        commandId: "input_1",
        payload: { text: "continue", heldQueueDisposition: "keepQueueAndSend" },
      }),
    });
  });

  it("maps ZCode Protocol context projection events to legacy usage_update", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      received.push(event);
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_usage",
        sessionId: task.taskId,
        seq: 1,
        timestamp: 2,
        traceId: "trace_usage",
        type: "session.updated",
        payload: {
          contextUsed: 24000,
          contextWindow: 128000,
        },
      },
    });
    disposable.dispose();

    expect(received).toContainEqual({
      type: "usage_update",
      taskId: task.taskId,
      traceId: "trace_usage",
      used: 24000,
      size: 128000,
      cost: null,
    });
  });

  it.each([
    { streamed: "", expected: "完整项目说明" },
    { streamed: "完整项目", expected: "说明" },
    { streamed: "完整项目说明", expected: "" },
  ])(
    "补齐工具调用后缺失的终态正文且不重复已收到的部分：$streamed",
    async ({ streamed, expected }) => {
      const { eventEmitter, service } = createService();
      const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
      const received: ZCodeStreamEvent[] = [];
      const subscription = service.onDynamicTaskEvent({
        workspacePath: "/repo",
        taskId: task.taskId,
        deliveryKind: "bot-channel-continuous",
      })((event) => {
        received.push(event);
      });
      let seq = 0;
      const emit = (
        type: ZCodeSessionEvent["type"],
        payload: Record<string, unknown>,
        turnId = "turn_repair",
      ) => {
        eventEmitter.fire({
          type: "session.event",
          event: {
            eventId: `repair_${++seq}`,
            sessionId: task.taskId,
            turnId,
            seq,
            timestamp: seq,
            traceId: turnId,
            type,
            payload,
          },
        });
      };
      emit("turn.started", { inputId: "input_repair" });
      emit("session.updated", {
        kind: "text_delta",
        delta: "我来看一下项目目录的内容。",
        assistantMessageId: "preface",
      });
      emit("tool.updated", {
        kind: "scheduled",
        toolCallId: "read_project",
        toolName: "Read",
        input: {},
      });
      if (streamed)
        emit("session.updated", {
          kind: "text_delta",
          delta: streamed,
          assistantMessageId: "answer",
        });
      const before = received.length;
      emit("turn.completed", {
        inputId: "input_repair",
        response: "完整项目说明",
        resultType: "success",
      });
      const terminal = received.slice(before);
      expect(
        terminal
          .filter((event) => event.type === "agent_message_chunk")
          .map((event) => event.content)
          .join(""),
      ).toBe(expected);
      expect(terminal.at(-1)?.type).toBe("task_complete");
      emit("turn.started", { inputId: "input_next" }, "turn_next");
      const next = received.length;
      emit(
        "turn.completed",
        { inputId: "input_next", response: "完整项目说明", resultType: "success" },
        "turn_next",
      );
      expect(received.slice(next)).toContainEqual(
        expect.objectContaining({
          type: "agent_message_chunk",
          content: "完整项目说明",
          inputId: "input_next",
        }),
      );
      subscription.dispose();
    },
  );

  it("不同 assistant message 的正文独立核对，不受前言或子代理文字影响", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const subscription = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "bot-channel-continuous",
    })((event) => {
      received.push(event);
    });
    let seq = 0;
    const emit = (
      payload: Record<string, unknown>,
      type: "session.updated" | "turn.completed" = "session.updated",
    ) =>
      eventEmitter.fire({
        type: "session.event",
        event: {
          eventId: `message_${++seq}`,
          sessionId: task.taskId,
          turnId: "message_turn",
          seq,
          timestamp: seq,
          traceId: "message_turn",
          type,
          payload,
        },
      });
    emit({ kind: "text_delta", assistantMessageId: "preface", delta: "先检查。" });
    emit({ kind: "text_delta", assistantMessageId: "answer", delta: "最终" });
    emit({
      kind: "text_delta",
      assistantMessageId: "child",
      parentToolUseId: "agent_tool",
      delta: "子代理内容",
    });
    const before = received.length;
    emit({ response: "最终回答", resultType: "success" }, "turn.completed");
    expect(received.slice(before)).toEqual([
      expect.objectContaining({ type: "agent_message_chunk", content: "回答" }),
      expect.objectContaining({ type: "task_complete" }),
    ]);
    subscription.dispose();
  });

  it("uses prompt inputId as per-turn traceId for session stream events", async () => {
    const { agent, eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      received.push(event);
    });

    await service.sendPrompt({
      taskId: task.taskId,
      traceId: "input_turn_1",
      content: "continue",
    });
    expect(agent.sendConversationCommandV4).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({ commandId: "input_turn_1" }),
      }),
    );

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_stream",
        sessionId: task.taskId,
        turnId: "turn_1",
        seq: 1,
        timestamp: 2,
        traceId: "runtime_trace_1",
        type: "session.updated",
        payload: { kind: "text_delta", delta: "hello" },
      },
    });
    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_tool",
        sessionId: task.taskId,
        turnId: "turn_1",
        seq: 2,
        timestamp: 3,
        traceId: "runtime_trace_1",
        type: "tool.updated",
        payload: {
          kind: "scheduled",
          toolCallId: "call_1",
          toolName: "Read",
          input: { filePath: "/repo/app.ts" },
        },
      },
    });
    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_done",
        sessionId: task.taskId,
        turnId: "turn_1",
        seq: 3,
        timestamp: 4,
        traceId: "runtime_trace_1",
        type: "turn.completed",
        payload: { inputId: "input_turn_1", resultType: "success" },
      },
    });
    disposable.dispose();

    expect(received).toContainEqual(
      expect.objectContaining({
        type: "agent_message_chunk",
        traceId: "input_turn_1",
        inputId: "input_turn_1",
      }),
    );
    expect(received).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        traceId: "input_turn_1",
        inputId: "input_turn_1",
        toolId: "call_1",
      }),
    );
    expect(received).toContainEqual(
      expect.objectContaining({
        type: "task_complete",
        traceId: "input_turn_1",
        inputId: "input_turn_1",
      }),
    );
  });

  it("maps main turn model usage with context window to legacy usage_update", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      received.push(event);
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_model_usage",
        sessionId: task.taskId,
        seq: 1,
        timestamp: 2,
        traceId: "trace_model_usage",
        type: "session.updated",
        payload: {
          contextWindow: 1_000_000,
          querySource: "main_turn",
          usage: {
            inputTokens: 279454,
            outputTokens: 177,
            totalTokens: 279631,
            cacheReadTokens: 1000,
            cacheWriteTokens: 200,
            cacheHitRate: 0.25,
          },
          contextUsageBreakdown: [
            { source: "messages", chars: 1200 },
            { source: "system_tool_schemas", chars: 300 },
          ],
        },
      },
    });
    disposable.dispose();

    expect(received).toContainEqual({
      type: "usage_update",
      taskId: task.taskId,
      traceId: "trace_model_usage",
      used: 279631,
      size: 1_000_000,
      cost: null,
      cache: {
        inputTokens: 279454,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        latestHitRate: 0.25,
        hitRate: 0.25,
      },
      breakdown: [
        { source: "messages", chars: 1200 },
        { source: "system_tool_schemas", chars: 300 },
      ],
    });
    expect(received).toContainEqual({
      type: "task_token_usage_delta",
      taskId: task.taskId,
      traceId: "trace_model_usage",
      eventKey: "evt_model_usage",
      eventId: "evt_model_usage",
      querySource: "main_turn",
      usage: {
        inputTokens: 279454,
        outputTokens: 177,
        totalTokens: 279631,
        reasoningTokens: undefined,
        cachedInputTokens: 1000,
        cachedWriteInputTokens: 200,
      },
    });
  });

  it("maps aggregate main turn cache hit usage to legacy usage_update", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      received.push(event);
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_model_usage_average",
        sessionId: task.taskId,
        seq: 1,
        timestamp: 2,
        traceId: "trace_model_usage_average",
        type: "session.updated",
        payload: {
          contextWindow: 1_000_000,
          querySource: "main_turn",
          cacheHit: {
            inputTokens: 200,
            cacheReadTokens: 80,
            cacheWriteTokens: 10,
            latestHitRate: 0.4,
            hitRate: 0.3,
            hitRateRequestCount: 2,
            totalInputTokens: 500,
            totalCacheReadTokens: 150,
            totalCacheWriteTokens: 25,
          },
          usage: {
            inputTokens: 200,
            outputTokens: 20,
            totalTokens: 220,
            cacheReadTokens: 80,
            cacheWriteTokens: 10,
          },
        },
      },
    });
    disposable.dispose();

    expect(received).toContainEqual({
      type: "usage_update",
      taskId: task.taskId,
      traceId: "trace_model_usage_average",
      used: 220,
      size: 1_000_000,
      cost: null,
      cache: {
        inputTokens: 200,
        cacheReadTokens: 80,
        cacheWriteTokens: 10,
        latestHitRate: 0.4,
        hitRate: 0.3,
        hitRateRequestCount: 2,
        totalInputTokens: 500,
        totalCacheReadTokens: 150,
        totalCacheWriteTokens: 25,
      },
    });
  });

  it("prefers real main turn model usage over projected context used", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      received.push(event);
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_model_usage_projection",
        sessionId: task.taskId,
        seq: 1,
        timestamp: 2,
        traceId: "trace_model_usage_projection",
        type: "session.updated",
        payload: {
          contextUsed: 64000,
          contextWindow: 1_000_000,
          querySource: "main_turn",
          usage: {
            inputTokens: 12345,
            outputTokens: 77,
            totalTokens: 12422,
          },
        },
      },
    });
    disposable.dispose();

    expect(received).toContainEqual({
      type: "usage_update",
      taskId: task.taskId,
      traceId: "trace_model_usage_projection",
      used: 12422,
      size: 1_000_000,
      cost: null,
    });
    expect(received).toContainEqual({
      type: "task_token_usage_delta",
      taskId: task.taskId,
      traceId: "trace_model_usage_projection",
      eventKey: "evt_model_usage_projection",
      eventId: "evt_model_usage_projection",
      querySource: "main_turn",
      usage: {
        inputTokens: 12345,
        outputTokens: 77,
        totalTokens: 12422,
        reasoningTokens: undefined,
        cachedInputTokens: undefined,
        cachedWriteInputTokens: undefined,
      },
    });
  });

  it("does not map sidecar model usage to legacy usage_update", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      received.push(event);
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_title_usage",
        sessionId: task.taskId,
        seq: 1,
        timestamp: 2,
        traceId: "trace_title_usage",
        type: "session.updated",
        payload: {
          contextWindow: 1_000_000,
          querySource: "session_title",
          usage: {
            inputTokens: 89,
            outputTokens: 84,
            totalTokens: 173,
          },
        },
      },
    });
    disposable.dispose();

    expect(received).not.toContainEqual(
      expect.objectContaining({
        type: "usage_update",
        traceId: "trace_title_usage",
      }),
    );
    expect(received).toContainEqual({
      type: "task_token_usage_delta",
      taskId: task.taskId,
      traceId: "trace_title_usage",
      eventKey: "evt_title_usage",
      eventId: "evt_title_usage",
      querySource: "session_title",
      usage: {
        inputTokens: 89,
        outputTokens: 84,
        totalTokens: 173,
        reasoningTokens: undefined,
        cachedInputTokens: undefined,
        cachedWriteInputTokens: undefined,
      },
    });
  });

  it("maps ZCode model retry status to apiRetry stream events and runtime snapshots", async () => {
    const { eventEmitter, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    const received: ZCodeStreamEvent[] = [];
    const disposable = service.onDynamicTaskEvent({
      workspacePath: "/repo",
      taskId: task.taskId,
      deliveryKind: "continuous",
    })((event) => {
      received.push(event);
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_retry",
        sessionId: task.taskId,
        seq: 1,
        timestamp: 2,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          type: "model_retry_scheduled",
          attempt: 1,
          maxAttempts: 4,
          delayMs: 2_000,
          statusCode: 429,
          message: "rate limited",
        },
      },
    });

    expect(received).toContainEqual({
      type: "session_info_update",
      taskId: task.taskId,
      traceId: "trace_retry",
      apiRetry: {
        kind: "api_retry",
        attempt: 1,
        maxRetries: 3,
        retryDelayMs: 2_000,
        errorStatus: 429,
        error: "rate limited",
      },
    });
    await expect(
      service.getTaskSnapshot({ workspacePath: "/repo", taskId: task.taskId }),
    ).resolves.toMatchObject({
      runtime: {
        apiRetry: {
          kind: "api_retry",
          attempt: 1,
          maxRetries: 3,
          retryDelayMs: 2_000,
          errorStatus: 429,
          error: "rate limited",
        },
      },
    });

    const retryStartedReceivedIndex = received.length;
    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_retry_started",
        sessionId: task.taskId,
        seq: 2,
        timestamp: 3,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          type: "model_request_started",
          attempt: 2,
          maxAttempts: 4,
          requestId: "request_retry",
        },
      },
    });
    const retryStartedEvents = received.slice(retryStartedReceivedIndex);
    expect(retryStartedEvents).toContainEqual(
      expect.objectContaining({
        type: "task_network_debug_status",
        taskId: task.taskId,
        traceId: "trace_retry",
        eventKey: "evt_retry_started",
        statusType: "model_request_started",
        attempt: 2,
        maxAttempts: 4,
      }),
    );
    expect(retryStartedEvents).not.toContainEqual({
      type: "session_info_update",
      taskId: task.taskId,
      traceId: "trace_retry",
      apiRetry: null,
    });
    await expect(
      service.getTaskSnapshot({ workspacePath: "/repo", taskId: task.taskId }),
    ).resolves.toMatchObject({
      runtime: {
        apiRetry: {
          kind: "api_retry",
          attempt: 1,
          maxRetries: 3,
          retryDelayMs: 2_000,
          errorStatus: 429,
          error: "rate limited",
        },
      },
    });

    const retryProgressReceivedIndex = received.length;
    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_retry_progress",
        sessionId: task.taskId,
        seq: 3,
        timestamp: 4,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          kind: "text_delta",
          delta: "recovered",
          assistantMessageId: "msg_retry",
        },
      },
    });
    const retryProgressEvents = received.slice(retryProgressReceivedIndex);
    expect(retryProgressEvents).toContainEqual({
      type: "session_info_update",
      taskId: task.taskId,
      traceId: "trace_retry",
      apiRetry: null,
    });
    expect(retryProgressEvents).toContainEqual({
      type: "agent_message_chunk",
      taskId: task.taskId,
      traceId: "trace_retry",
      messageId: "msg_retry",
      content: "recovered",
    });
    await expect(
      service.getTaskSnapshot({ workspacePath: "/repo", taskId: task.taskId }),
    ).resolves.toMatchObject({
      runtime: {
        apiRetry: null,
      },
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_stream_recovery_retry",
        sessionId: task.taskId,
        seq: 4,
        timestamp: 5,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          type: "model_request_started",
          attempt: 1,
          maxAttempts: 11,
          requestId: "request_recovery",
          streamRecovery: {
            attemptId: "stream_attempt_1",
            anchorId: "anchor_1",
            maxRetries: 10,
            recoveredFromRequestId: "request_failed",
            retryNumber: 3,
          },
        },
      },
    });

    expect(received).toContainEqual({
      type: "session_info_update",
      taskId: task.taskId,
      traceId: "trace_retry",
      apiRetry: {
        kind: "api_retry",
        attempt: 3,
        maxRetries: 10,
        retryDelayMs: 0,
        errorStatus: null,
        error: "Model stream recovery retry started",
      },
    });
    await expect(
      service.getTaskSnapshot({ workspacePath: "/repo", taskId: task.taskId }),
    ).resolves.toMatchObject({
      runtime: {
        apiRetry: {
          kind: "api_retry",
          attempt: 3,
          maxRetries: 10,
          retryDelayMs: 0,
          errorStatus: null,
          error: "Model stream recovery retry started",
        },
      },
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_stream_recovery_progress",
        sessionId: task.taskId,
        seq: 5,
        timestamp: 6,
        traceId: "trace_retry",
        type: "streamRecovery.updated",
        payload: {
          attemptId: "stream_attempt_2",
          failedRequestId: "request_failed",
          maxRetries: 10,
          recoveredFromRequestId: "request_failed",
          retryNumber: 4,
          streamMode: "sse",
        },
      },
    });

    expect(received).toContainEqual({
      type: "session_info_update",
      taskId: task.taskId,
      traceId: "trace_retry",
      apiRetry: {
        kind: "api_retry",
        attempt: 4,
        maxRetries: 10,
        retryDelayMs: 0,
        errorStatus: null,
        error: "Model stream recovery retry started",
      },
    });
    await expect(
      service.getTaskSnapshot({ workspacePath: "/repo", taskId: task.taskId }),
    ).resolves.toMatchObject({
      runtime: {
        apiRetry: {
          kind: "api_retry",
          attempt: 4,
          maxRetries: 10,
          retryDelayMs: 0,
          errorStatus: null,
          error: "Model stream recovery retry started",
        },
      },
    });

    eventEmitter.fire({
      type: "session.event",
      event: {
        eventId: "evt_retry_clear",
        sessionId: task.taskId,
        seq: 6,
        timestamp: 7,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          type: "model_request_completed",
          attempt: 2,
          maxAttempts: 4,
        },
      },
    });
    disposable.dispose();

    expect(received).toContainEqual({
      type: "session_info_update",
      taskId: task.taskId,
      traceId: "trace_retry",
      apiRetry: null,
    });
    await expect(
      service.getTaskSnapshot({ workspacePath: "/repo", taskId: task.taskId }),
    ).resolves.toMatchObject({
      runtime: {
        apiRetry: null,
      },
    });
  });

  it("keeps pinned state in sqlite without resuming the agent session", async () => {
    const { agent, service } = createService();
    const task = await service.createTask({ workspacePath: "/repo", provider: "glm" });
    vi.mocked(agent.resumeSession).mockClear();

    await service.setTaskPinned({
      workspacePath: "/repo",
      taskId: task.taskId,
      pinned: true,
    });
    const pinned = await service.listPinnedTasks({ workspacePath: "/repo" });
    const active = await service.listTasks({ workspacePath: "/repo" });

    expect(agent.resumeSession).not.toHaveBeenCalled();
    expect(pinned.map((item) => item.taskId)).toEqual([task.taskId]);
    expect(active).toEqual([]);
  });
});
