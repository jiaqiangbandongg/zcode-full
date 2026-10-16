import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IZCodeAgentService } from "@zcode/services";
import type { ZCodeAgentMcpServer, ZCodeSessionStateSnapshot } from "@zcode/shared";
import { createZCodeSessionService } from "@zcode/services/node";
import type { ZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { getLegacyTaskSessionSnapshotPath, setDataBaseDir } from "../src/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function useTempDataBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-session-service-"));
  tempDirs.push(dir);
  setDataBaseDir(dir);
  return dir;
}

describe("createZCodeSessionService", () => {
  it("injects product CUA helper broker config before desktop-continuous session creation", async () => {
    const snapshot = {
      session: {
        sessionId: "session-cua",
        workspace: {
          workspacePath: "/workspace/app",
          workspaceIdentity: undefined,
        },
      },
      runtime: { eventSeq: 1, stateRevision: 1, pendingRequestIds: [] },
      settings: {},
      messages: [],
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      createSession: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    // services 只负责建会话前把 MCP 配置交给 producer 的 resolver；改写细节由 producer 自己的测试覆盖。
    // 这里用测试自己的 resolver，不依赖私有 producer 的注入实现（开源占位包不改写配置）。
    const resolver = {
      resolveMcpServers: vi.fn(async (servers: ZCodeAgentMcpServer[] | undefined) =>
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
    };
    const service = createZCodeSessionService({
      agentService,
      cuaProductMcpServerResolver: resolver,
    });

    await service.createSession({
      workspacePath: "/workspace/app",
      mcpServers: [
        {
          name: "plugin:computer-use:computer-use",
          command: "uvx",
          args: ["zcode-cua"],
          env: [
            { name: "ZCODE_PLUGIN_ID", value: "computer-use@zcode-plugins-official" },
            {
              name: "ZCODE_CUA_PLUGIN_AUTHORITY",
              value: "dev.zcode.cua-helper/dev",
            },
          ],
        },
      ],
    });

    const createParams = vi.mocked(agentService.createSession).mock.calls[0]?.[0];
    const server = createParams?.mcpServers?.[0];
    expect(resolver.resolveMcpServers).toHaveBeenCalledTimes(1);
    expect(server && "command" in server ? server.args : []).toEqual([
      "zcode-cua",
      "--permission-broker-socket",
      "/tmp/zcode-cua/helper.sock",
    ]);
  });

  it("does not sync deferred draft sessions into the task index", async () => {
    const snapshot = {
      session: {
        sessionId: "draft-1",
        workspace: {
          workspacePath: "/workspace/app",
          workspaceIdentity: "remote:ssh:dev:/workspace/app",
        },
      },
    };
    const agentService = {
      createSession: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    };
    const service = createZCodeSessionService({
      agentService,
      taskIndexSyncer: taskIndexSyncer as never,
    });

    await expect(
      service.createSession({
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        persistence: "deferred",
      }),
    ).resolves.toBe(snapshot);

    // Bugfix: zcodeSessionService 会为 createSession 补 sessionTraceId 贯穿日志链路。
    // 这个 deferred draft 用例只验证草稿不进入 task index，因此需要显式接受并校验 trace 字段。
    expect(agentService.createSession).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      persistence: "deferred",
      sessionTraceId: expect.any(String),
    });
    expect(taskIndexSyncer.ensureSessionSubscription).not.toHaveBeenCalled();
    expect(taskIndexSyncer.syncSnapshotAndBroadcast).not.toHaveBeenCalled();
  });

  it("does not sync deferred draft session model changes into the task index", async () => {
    const snapshot = {
      session: {
        sessionId: "draft-1",
        workspace: {
          workspacePath: "/workspace/app",
          workspaceIdentity: "remote:ssh:dev:/workspace/app",
        },
      },
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      createSession: vi.fn(async () => snapshot),
      setModel: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await service.createSession({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      persistence: "deferred",
    });

    await expect(
      service.setModel({
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        sessionId: "draft-1",
        model: { providerId: "current-provider", modelId: "current-model" },
      }),
    ).resolves.toBe(snapshot);

    expect(agentService.setModel).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "draft-1",
      model: { providerId: "current-provider", modelId: "current-model" },
    });
    expect(taskIndexSyncer.ensureSessionSubscription).not.toHaveBeenCalled();
    expect(taskIndexSyncer.syncSnapshotAndBroadcast).not.toHaveBeenCalled();
  });

  it("promotes deferred draft sessions before replayable task facade owns them", async () => {
    const snapshot = {
      session: {
        sessionId: "draft-1",
        workspace: {
          workspacePath: "/workspace/app",
          workspaceIdentity: "remote:ssh:dev:/workspace/app",
        },
      },
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      createSession: vi.fn(async () => snapshot),
      setModel: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await service.createSession({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      persistence: "deferred",
    });
    await service.promoteDeferredDraftSession({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "draft-1",
    });
    vi.mocked(taskIndexSyncer.ensureSessionSubscription).mockClear();
    vi.mocked(taskIndexSyncer.syncSnapshotAndBroadcast).mockClear();

    await expect(
      service.setModel({
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        sessionId: "draft-1",
        model: { providerId: "current-provider", modelId: "current-model" },
      }),
    ).resolves.toBe(snapshot);

    expect(taskIndexSyncer.ensureSessionSubscription).toHaveBeenCalledWith(
      {
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        sessionId: "draft-1",
      },
      undefined,
    );
    expect(taskIndexSyncer.syncSnapshotAndBroadcast).toHaveBeenCalledWith(snapshot, {
      modelOverride: "current-provider/current-model",
      broadcastReason: "task_model_changed",
    });
  });

  it("uses a conditional stale-draft close after a remote session is promoted", async () => {
    const snapshot = {
      session: {
        sessionId: "remote-task-1",
        workspace: {
          workspacePath: "/workspace/app",
          workspaceIdentity: "remote:ssh:dev:/workspace/app",
        },
      },
    } as unknown as ZCodeSessionStateSnapshot;
    let persistence: "deferred" | "immediate" = "deferred";
    const closeSession: IZCodeAgentService["closeSession"] = vi.fn(async (params) => {
      if (params.expectedPersistence && params.expectedPersistence !== persistence) {
        return false;
      }
      return true;
    });
    const agentService = {
      closeSession,
      createSession: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });
    const target = {
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "remote-task-1",
    };

    await service.createSession({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      persistence: "deferred",
    });
    // 远程端首发会把同一个 session 原地提升；设置页异步闭包仍可能持有旧 draftSessionId。
    persistence = "immediate";
    await service.promoteDeferredDraftSession(target);

    await expect(service.closeDeferredDraftSession(target)).resolves.toBe(false);
    expect(closeSession).toHaveBeenCalledWith({
      ...target,
      expectedPersistence: "deferred",
    });
    expect(taskIndexSyncer.ensureSessionSubscription).toHaveBeenCalledWith(target, undefined);
  });

  it("only closes a draft when the Agent confirms it is still deferred", async () => {
    const closeSession = vi.fn(async () => false);
    const agentService = { closeSession } as unknown as IZCodeAgentService;
    const service = createZCodeSessionService({ agentService });

    await expect(
      service.closeDeferredDraftSession({
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        sessionId: "draft-promoted-elsewhere",
      }),
    ).resolves.toBe(false);

    expect(closeSession).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "draft-promoted-elsewhere",
      expectedPersistence: "deferred",
    });
  });

  it("does not fall back to unconditional close when an older Agent rejects conditional close", async () => {
    const closeSession = vi.fn(async () => {
      throw new Error("Invalid params: expectedPersistence");
    });
    const agentService = { closeSession } as unknown as IZCodeAgentService;
    const service = createZCodeSessionService({ agentService });

    await expect(
      service.closeDeferredDraftSession({
        workspacePath: "/workspace/app",
        sessionId: "draft-on-old-agent",
      }),
    ).resolves.toBe(false);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("delegates workspace initialization and read paths to the agent service", async () => {
    const agentService = {
      initialize: vi.fn(async () => ({
        available: true,
        workspaceKey: "remote:ssh:dev:/workspace/app",
        protocolName: "ZCode Protocol",
        protocolVersion: 1,
        transportKind: "stdio",
      })),
      readSessionMessages: vi.fn(async () => []),
      readSessionEvents: vi.fn(async () => []),
    } as unknown as IZCodeAgentService;
    const service = createZCodeSessionService({ agentService });

    await expect(
      service.initializeWorkspace({
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
      }),
    ).resolves.toMatchObject({
      available: true,
      workspaceKey: "remote:ssh:dev:/workspace/app",
    });

    await service.readSessionMessages({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "session-1",
      limit: 20,
    });
    await service.readSessionEvents({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "session-1",
      afterSeq: 4,
    });
    expect(agentService.initialize).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
    });
    expect(agentService.readSessionMessages).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "session-1",
      limit: 20,
    });
    expect(agentService.readSessionEvents).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "session-1",
      afterSeq: 4,
    });
  });

  it("repairs empty imported Claude protocol sessions from legacy snapshots", async () => {
    useTempDataBaseDir();
    const workspacePath = "/workspace/imported";
    const sessionId = "claude-import-empty";
    const legacyPath = getLegacyTaskSessionSnapshotPath(workspacePath, sessionId);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        meta: {
          taskId: sessionId,
          traceId: "trace_imported",
          title: "Imported Claude",
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
    const emptySnapshot = {
      session: {
        sessionId,
        mode: "build",
        status: "idle",
        workspace: {
          workspacePath,
          workspaceKey: workspacePath,
        },
      },
      settings: {
        model: {
          current: { providerId: "glm", modelId: "glm-4.6" },
          available: [],
        },
        thoughtLevel: { enabled: true, current: "think", available: [] },
        mode: { current: "build" },
      },
      runtime: {
        eventSeq: 1,
        stateRevision: 2,
        pendingRequestIds: [],
      },
      messages: [],
    } as unknown as ZCodeSessionStateSnapshot;
    const repairedSnapshot = {
      ...emptySnapshot,
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "旧问题" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "旧回答" }] },
      ],
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      resumeSession: vi.fn(async () => emptySnapshot),
      createSession: vi.fn(async () => repairedSnapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await expect(service.resumeSession({ workspacePath, sessionId })).resolves.toBe(
      repairedSnapshot,
    );

    expect(agentService.createSession).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity: undefined,
      sessionId,
      mode: "build",
      model: { providerId: "glm", modelId: "glm-4.6" },
      thoughtLevel: "think",
      persistence: "immediate",
      importedHistory: {
        source: "claudeCode",
        title: "Imported Claude",
        createdAt: 10,
        updatedAt: 20,
        messages: [
          { role: "user", content: "旧问题", timestamp: 10 },
          { role: "assistant", content: "旧回答", timestamp: 20 },
        ],
      },
    });
    expect(taskIndexSyncer.syncSnapshotAndBroadcast).toHaveBeenCalledWith(
      repairedSnapshot,
      // Bugfix: resume 收敛是状态同步，广播 reason 改为 task_status_changed，避免全局 membership 重拉。
      { broadcastReason: "task_status_changed" },
    );
  });

  it("repairs imported Claude protocol sessions with legacy fixed message ids", async () => {
    useTempDataBaseDir();
    const workspacePath = "/workspace/imported";
    const sessionId = "claude-import-corrupted-order";
    const legacyPath = getLegacyTaskSessionSnapshotPath(workspacePath, sessionId);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        meta: {
          taskId: sessionId,
          traceId: "trace_imported_corrupted",
          title: "Imported Claude Corrupted",
          workspacePath,
          createdAt: 10,
          updatedAt: 20,
          migrationSource: "claudeCode",
        },
        messages: [
          { role: "user", content: "正确问题", timestamp: 10 },
          { role: "assistant", content: "正确回答", timestamp: 20 },
        ],
      }),
      "utf-8",
    );
    const corruptedSnapshot = {
      session: {
        sessionId,
        mode: "build",
        status: "idle",
        workspace: {
          workspacePath,
          workspaceKey: workspacePath,
        },
      },
      settings: {
        model: {
          current: { providerId: "glm", modelId: "glm-4.6" },
          available: [],
        },
        thoughtLevel: { enabled: true, current: "think", available: [] },
        mode: { current: "build" },
      },
      runtime: {
        eventSeq: 1,
        stateRevision: 2,
        pendingRequestIds: [],
      },
      messages: [
        { info: { messageId: "msg_import_1", role: "assistant" }, parts: [] },
        { info: { messageId: "msg_import_0", role: "user" }, parts: [] },
      ],
    } as unknown as ZCodeSessionStateSnapshot;
    const repairedSnapshot = {
      ...corruptedSnapshot,
      messages: [
        {
          info: { messageId: "msg_repaired_0", role: "user" },
          parts: [{ type: "text", text: "正确问题" }],
        },
        {
          info: { messageId: "msg_repaired_1", role: "assistant" },
          parts: [{ type: "text", text: "正确回答" }],
        },
      ],
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      resumeSession: vi.fn(async () => corruptedSnapshot),
      createSession: vi.fn(async () => repairedSnapshot),
    } as unknown as IZCodeAgentService;
    const service = createZCodeSessionService({ agentService });

    await expect(service.resumeSession({ workspacePath, sessionId })).resolves.toBe(
      repairedSnapshot,
    );

    expect(agentService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        sessionId,
        importedHistory: expect.objectContaining({
          messages: [
            { role: "user", content: "正确问题", timestamp: 10 },
            { role: "assistant", content: "正确回答", timestamp: 20 },
          ],
        }),
      }),
    );
  });

  it("does not repair ordinary user-only sessions from accidental Claude legacy files", async () => {
    useTempDataBaseDir();
    const workspacePath = "/workspace/ordinary";
    const sessionId = "ordinary-user-only-session";
    const legacyPath = getLegacyTaskSessionSnapshotPath(workspacePath, sessionId);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        meta: {
          taskId: sessionId,
          traceId: "trace_accidental_legacy",
          title: "Accidental Claude backup",
          workspacePath,
          createdAt: 10,
          updatedAt: 20,
          migrationSource: "claudeCode",
        },
        messages: [
          { role: "user", content: "不应该回填的问题", timestamp: 10 },
          { role: "assistant", content: "不应该回填的回答", timestamp: 20 },
        ],
      }),
      "utf-8",
    );
    const ordinarySnapshot = {
      session: {
        sessionId,
        mode: "build",
        status: "idle",
        workspace: {
          workspacePath,
          workspaceKey: workspacePath,
        },
      },
      settings: {
        model: {
          current: { providerId: "glm", modelId: "glm-4.6" },
          available: [],
        },
        thoughtLevel: { enabled: true, current: "think", available: [] },
        mode: { current: "build" },
      },
      runtime: {
        eventSeq: 1,
        stateRevision: 2,
        pendingRequestIds: [],
      },
      messages: [{ info: { messageId: "msg_ordinary_0", role: "user" }, parts: [] }],
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      resumeSession: vi.fn(async () => ordinarySnapshot),
      createSession: vi.fn(),
    } as unknown as IZCodeAgentService;
    const service = createZCodeSessionService({ agentService });

    await expect(service.resumeSession({ workspacePath, sessionId })).resolves.toBe(
      ordinarySnapshot,
    );

    expect(agentService.createSession).not.toHaveBeenCalled();
  });

  it("asks the task index syncer to place desktop-created sessions at the grouped top", async () => {
    const snapshot = {
      session: {
        sessionId: "session-1",
        workspace: {
          workspacePath: "/workspace/app",
          workspaceKey: "/workspace/app",
        },
      },
    };
    const agentService = {
      createSession: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(async () => ({
        taskId: "session-1",
        traceId: "trace-session-1",
        title: "New session",
        workspacePath: "/workspace/app",
        createdAt: 1,
        updatedAt: 1,
        mode: "build",
        status: "running",
      })),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await service.createSession({ workspacePath: "/workspace/app" });

    expect(taskIndexSyncer.ensureSessionSubscription).toHaveBeenCalledWith(
      {
        workspacePath: "/workspace/app",
        workspaceIdentity: undefined,
        sessionId: "session-1",
      },
      undefined,
    );
    expect(taskIndexSyncer.syncSnapshotAndBroadcast).toHaveBeenCalledWith(snapshot, {
      moveGroupedTaskToTop: true,
      broadcastReason: "task_meta_changed",
    });
  });

  it("syncs resume model override into the task index", async () => {
    const snapshot = {
      protocol: { name: "ZCode Protocol", version: 1 },
      session: {
        sessionId: "session-1",
        mode: "build",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        workspace: {
          workspacePath: "/workspace/app",
          workspaceKey: "/workspace/app",
        },
      },
      settings: {
        model: {
          current: { providerId: "current-provider", modelId: "current-model" },
          available: [],
        },
        thoughtLevel: { enabled: false, available: [] },
        mode: { current: "build" },
      },
      runtime: { eventSeq: 1, stateRevision: 1, pendingRequestIds: [] },
      projection: {},
      messages: [],
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      resumeSession: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await service.resumeSession({
      workspacePath: "/workspace/app",
      sessionId: "session-1",
      model: { providerId: "current-provider", modelId: "current-model" },
    });

    expect(taskIndexSyncer.syncSnapshotAndBroadcast).toHaveBeenCalledWith(snapshot, {
      modelOverride: "current-provider/current-model",
      broadcastReason: "task_status_changed",
    });
  });

  it("replays requested thought level before broadcasting resume snapshot", async () => {
    const makeSnapshot = (thoughtLevel: string) =>
      ({
        protocol: { name: "ZCode Protocol", version: 1 },
        session: {
          sessionId: "session-1",
          mode: "build",
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
          workspace: {
            workspacePath: "/workspace/app",
            workspaceKey: "/workspace/app",
          },
        },
        settings: {
          model: {
            current: { providerId: "bigmodel-api", modelId: "GLM-5.2" },
            available: [],
          },
          thoughtLevel: { enabled: true, current: thoughtLevel, available: ["high", "max"] },
          mode: { current: "build" },
        },
        runtime: {
          activeTurnId: undefined,
          eventSeq: 1,
          stateRevision: 1,
          pendingRequestIds: [],
        },
        projection: { target: null, lastError: null, pendingPermissions: [] },
        messages: [],
      }) as unknown as ZCodeSessionStateSnapshot;
    const pollutedSnapshot = makeSnapshot("high");
    const correctedSnapshot = makeSnapshot("max");
    const agentService = {
      resumeSession: vi.fn(async () => pollutedSnapshot),
      setThoughtLevel: vi.fn(async () => correctedSnapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await expect(
      service.resumeSession({
        workspacePath: "/workspace/app",
        sessionId: "session-1",
        model: { providerId: "bigmodel-api", modelId: "GLM-5.2" },
        thoughtLevel: "max",
      }),
    ).resolves.toBe(correctedSnapshot);

    expect(agentService.setThoughtLevel).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: undefined,
      sessionId: "session-1",
      thoughtLevel: "max",
    });
    expect(taskIndexSyncer.syncSnapshotAndBroadcast).toHaveBeenCalledWith(correctedSnapshot, {
      modelOverride: "bigmodel-api/GLM-5.2",
      thoughtLevelOverride: "max",
      broadcastReason: "task_status_changed",
    });
  });

  it("skips resume thought replay when the restored model does not support the requested level", async () => {
    const snapshot = {
      protocol: { name: "ZCode Protocol", version: 1 },
      session: {
        sessionId: "session-1",
        mode: "build",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        workspace: {
          workspacePath: "/workspace/app",
          workspaceKey: "/workspace/app",
        },
      },
      settings: {
        model: {
          current: {
            providerId: "account:bigmodel-individual-coding-plan",
            modelId: "GLM-5-Turbo",
          },
          available: [],
        },
        thoughtLevel: {
          enabled: true,
          current: "enabled",
          available: [
            { value: "enabled", label: "Enabled" },
            { value: "off", label: "Off" },
          ],
        },
        mode: { current: "build" },
      },
      runtime: {
        activeTurnId: undefined,
        eventSeq: 1,
        stateRevision: 1,
        pendingRequestIds: [],
      },
      projection: { target: null, lastError: null, pendingPermissions: [] },
      messages: [],
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      resumeSession: vi.fn(async () => snapshot),
      setThoughtLevel: vi.fn(async () => {
        throw new Error("setThoughtLevel should not be called");
      }),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await expect(
      service.resumeSession({
        workspacePath: "/workspace/app",
        sessionId: "session-1",
        model: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5-Turbo" },
        thoughtLevel: "max",
      }),
    ).resolves.toBe(snapshot);

    expect(agentService.setThoughtLevel).not.toHaveBeenCalled();
    expect(taskIndexSyncer.syncSnapshotAndBroadcast).toHaveBeenCalledWith(snapshot, {
      modelOverride: "account:bigmodel-individual-coding-plan/GLM-5-Turbo",
      broadcastReason: "task_status_changed",
    });
  });

  it("updates only task model when resume snapshot broadcast is disabled", async () => {
    const snapshot = {
      protocol: { name: "ZCode Protocol", version: 1 },
      session: {
        sessionId: "session-1",
        mode: "build",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        workspace: {
          workspacePath: "/workspace/app",
          workspaceKey: "/workspace/app",
        },
      },
      settings: {
        model: {
          current: { providerId: "current-provider", modelId: "current-model" },
          available: [],
        },
        thoughtLevel: { enabled: false, available: [] },
        mode: { current: "build" },
      },
      runtime: { eventSeq: 1, stateRevision: 1, pendingRequestIds: [] },
      projection: {},
      messages: [],
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      resumeSession: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
      syncTaskModel: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await service.resumeSession({
      workspacePath: "/workspace/app",
      sessionId: "session-1",
      model: { providerId: "current-provider", modelId: "current-model" },
      broadcastSnapshot: false,
    });

    expect(taskIndexSyncer.syncSnapshotAndBroadcast).not.toHaveBeenCalled();
    expect(taskIndexSyncer.syncTaskModel).toHaveBeenCalledWith(
      {
        workspacePath: "/workspace/app",
        workspaceIdentity: undefined,
        sessionId: "session-1",
      },
      "current-provider/current-model",
    );
  });

  it("syncs explicit setModel snapshots into the task index", async () => {
    const snapshot = {
      session: {
        sessionId: "session-1",
        workspace: {
          workspacePath: "/workspace/app",
          workspaceKey: "/workspace/app",
        },
      },
    } as unknown as ZCodeSessionStateSnapshot;
    const agentService = {
      setModel: vi.fn(async () => snapshot),
    } as unknown as IZCodeAgentService;
    const taskIndexSyncer = {
      ensureSessionSubscription: vi.fn(),
      syncSnapshotAndBroadcast: vi.fn(),
    } as unknown as ZCodeTaskIndexSyncer;
    const service = createZCodeSessionService({ agentService, taskIndexSyncer });

    await expect(
      service.setModel({
        workspacePath: "/workspace/app",
        sessionId: "session-1",
        model: { providerId: "current-provider", modelId: "current-model" },
      }),
    ).resolves.toBe(snapshot);

    expect(taskIndexSyncer.ensureSessionSubscription).toHaveBeenCalledWith(
      {
        workspacePath: "/workspace/app",
        workspaceIdentity: undefined,
        sessionId: "session-1",
      },
      undefined,
    );
    expect(taskIndexSyncer.syncSnapshotAndBroadcast).toHaveBeenCalledWith(snapshot, {
      modelOverride: "current-provider/current-model",
      broadcastReason: "task_model_changed",
    });
  });
});
