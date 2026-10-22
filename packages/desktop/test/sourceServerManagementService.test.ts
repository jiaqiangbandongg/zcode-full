import { SourceServerConnectionManager } from "../src/host/sourceServerConnectionManager.js";
import type { SourceServerTransportAdapter } from "@zcode/server/source-server";
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { SourceServerConnectionStateSnapshot } from "@zcode/shared";
import { createSourceServerManagementService } from "../src/host/sourceServerManagementService.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";

describe("SourceServerManagementService", () => {
  it("routes a retained-member reconnect without saving a new membership", async () => {
    const emitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const target = { kind: "docker" as const, container: "dev" };
    const profile = {
      profileId,
      sourceServerId,
      transport: "docker" as const,
      target,
      createdAt: 1,
    };
    const onConnectionLog = vi.fn();
    const connect = vi.fn(async (input) => {
      input.context?.onLog?.({ phase: "probe", message: "connected transport" });
      return {};
    });
    const service = createSourceServerManagementService({
      directory: {
        snapshot: async () => ({
          profiles: [profile],
          servers: [{ sourceServerId, displayName: "dev" }],
          workspaceHistory: [],
        }),
        resolveProfileTarget: async () => target,
      } as never,
      manager: {
        listStates: () => [],
        onDidChangeState: emitter.event,
        connect,
        getOnlineConnection: () => undefined,
      } as never,
      onConnectionLog,
    });
    await service.connectProfile(profileId, { retainedOnly: true });
    expect(connect).toHaveBeenCalledWith({
      profile,
      target,
      membershipIntent: "retain",
      context: { onLog: onConnectionLog },
    });
    expect(onConnectionLog).toHaveBeenCalledWith({
      phase: "probe",
      message: "connected transport",
    });
    service.dispose();
  });
  it("管理服务查询并转发更新阶段、真实进度和失败日志", async () => {
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () =>
        ({
          kind: "docker",
          probe: async () => ({ platform: "linux", arch: "x64", installed: false }),
          installOrUpdate: async (_target, _release, context) => {
            context.onLog?.({
              phase: "upload",
              message: "archive /Users/private/file token=hidden",
              progress: 0.5,
            });
            throw new Error("upload failed");
          },
        }) as SourceServerTransportAdapter,
      now: () => 10,
    });
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [
            {
              profileId,
              transport: "docker" as const,
              target: { kind: "docker" as const, container: "dev" },
              sourceServerId,
              createdAt: 1,
            },
          ],
          servers: [{ sourceServerId, displayName: "dev", declaredWorkspaces: [] }],
          workspaceHistory: [],
        })),
        resolveProfileTarget: vi.fn(async () => ({
          kind: "docker" as const,
          container: "dev",
        })),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
      },
      manager,
      resolveRelease: async () => ({
        target: "linux-x64",
        version: "3.8.0",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        urls: [],
      }),
      now: () => 10,
    });
    const logs: unknown[] = [];
    service.onDidAppendOperationLog?.((entry) => logs.push(entry));

    await expect(service.updateSource({ profileId, force: false })).rejects.toThrow(
      "upload failed",
    );

    expect(logs).toEqual([
      expect.objectContaining({ phase: "probe", timestamp: 10 }),
      expect.objectContaining({
        phase: "upload",
        progress: 0.5,
        timestamp: 10,
      }),
      expect.objectContaining({
        phase: "upload",
        level: "error",
        timestamp: 10,
      }),
    ]);
    expect(await service.getRecentOperationLogs(profileId)).toEqual(logs);
    expect(JSON.stringify(logs)).not.toContain("hidden");
    expect(JSON.stringify(logs)).not.toContain("/Users/");
    service.dispose();
    manager.dispose();
  });

  it("prepares distinct unclassified conversation directories on the existing online Host", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const recordConversationWorkspace = vi.fn(async () => undefined);
    let nextDirectory = 0;
    const prepareSession = vi.fn(async () => ({
      workspacePath: `/home/dev/.zcode/workspace/task-${++nextDirectory}`,
      projectId: null,
      additionalDirectories: [],
    }));
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [],
          servers: [],
          workspaceHistory: [],
        })),
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
        recordConversationWorkspace,
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => ({
          sourceServerId,
          profileId,
          serverInfo: {} as never,
          services: { projectService: { prepareSession } } as never,
        }),
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect: vi.fn(),
      },
    });

    await expect(service.ensureConversationWorkspace(sourceServerId)).resolves.toEqual({
      path: "/home/dev/.zcode/workspace/task-1",
      created: true,
      workspacePurpose: "conversation",
    });
    expect(recordConversationWorkspace).toHaveBeenCalledWith(
      sourceServerId,
      "/home/dev/.zcode/workspace/task-1",
    );
    await expect(service.ensureConversationWorkspace(sourceServerId)).resolves.toMatchObject({
      path: "/home/dev/.zcode/workspace/task-2",
    });
    expect(prepareSession).toHaveBeenCalledWith();
    service.dispose();
  });

  it("returns an initial snapshot and monotonic Host state deltas", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const state: SourceServerConnectionStateSnapshot = {
      profileId,
      sourceServerId,
      state: "online",
      updateAvailability: "none",
      currentVersion: "3.8.0",
      availableVersion: "3.8.0",
      minimumVersion: "3.8.0",
      updatedAt: 10,
    };
    const sourceServerWorkspaceService = {
      getFailedPathCount: vi.fn(async () => 2),
      getAbandonedPathCount: vi.fn(async () => 1),
    };
    const connection = {
      sourceServerId,
      profileId,
      serverInfo: {} as never,
      services: { sourceServerWorkspaceService } as never,
    };
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [
            {
              profileId,
              transport: "docker" as const,
              target: { kind: "docker" as const, container: "dev" },
              sourceServerId,
              createdAt: 1,
            },
          ],
          servers: [{ sourceServerId, displayName: "devbox", declaredWorkspaces: [] }],
          workspaceHistory: [],
        })),
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
      },
      manager: {
        listStates: () => [state],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => connection,
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect: vi.fn(),
      },
    });
    const deltas: unknown[] = [];
    const subscription = service.onDidChangeState((delta) => deltas.push(delta));

    await expect(service.getSnapshot()).resolves.toEqual({
      generation: 0,
      profiles: expect.arrayContaining([expect.objectContaining({ profileId })]),
      servers: [
        {
          sourceServerId,
          displayName: "devbox",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      workspaceHistory: [],
      states: [state],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [{ sourceServerId, status: "loading" }],
    });
    await vi.waitFor(async () => {
      expect(await service.getSnapshot()).toMatchObject({
        generation: 1,
        failedPathCount: 2,
        abandonedPathCount: 1,
        migrationCounts: [
          { sourceServerId, status: "available", failedPathCount: 2, abandonedPathCount: 1 },
        ],
      });
    });
    const retrying = { ...state, state: "retrying" as const, updatedAt: 11 };
    stateEmitter.fire(retrying);

    expect(deltas).toEqual([{ generation: 2, state: retrying }]);
    subscription.dispose();
    service.dispose();
  });

  it("reports offline migration counts as requiring a connection instead of zero", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [],
          servers: [{ sourceServerId, displayName: "offline", declaredWorkspaces: [] }],
          workspaceHistory: [],
        })),
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect: vi.fn(),
      },
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [{ sourceServerId, status: "requires-connection" }],
    });
    service.dispose();
  });

  it("renames a connection profile through the directory authority", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const renameProfile = vi.fn(async () => undefined);
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [],
          servers: [{ sourceServerId, displayName: "server", declaredWorkspaces: [] }],
          workspaceHistory: [],
        })),
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile,
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect: vi.fn(),
      },
    });

    await service.renameProfile(profileId, "backup line");
    expect(renameProfile).toHaveBeenCalledWith(profileId, "backup line");
    service.dispose();
  });

  it("updates a connection profile through the directory authority", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const updateProfile = vi.fn(async () => undefined);
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [],
          servers: [],
          workspaceHistory: [],
        })),
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        updateProfile,
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
        removeSourceServer: vi.fn(),
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        removeProfile: vi.fn(),
        disconnect: vi.fn(),
      },
      onBeforeSourceServerRemoved: vi.fn(),
    });
    const input = {
      profileId,
      profileDisplayName: "primary",
      sourceDisplayName: "Build server",
      sshAuthMethod: "password" as const,
      target: {
        kind: "ssh" as const,
        host: "example.com",
        port: 2222,
        username: "dev",
        password: "secret",
      },
    };

    await service.updateProfile(input);

    expect(updateProfile).toHaveBeenCalledWith(input);
    service.dispose();
  });

  it("removes the persisted Profile before terminalizing its Manager lifecycle", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const removeDirectoryProfile = vi.fn(async () => undefined);
    const removeManagerProfile = vi.fn();
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [],
          servers: [],
          workspaceHistory: [],
        })),
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        updateProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: removeDirectoryProfile,
        removeSourceServer: vi.fn(),
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect: vi.fn(),
        removeProfile: removeManagerProfile,
      },
      onBeforeSourceServerRemoved: vi.fn(),
    });

    await service.removeProfile(profileId);

    expect(removeDirectoryProfile).toHaveBeenCalledWith(profileId);
    expect(removeManagerProfile).toHaveBeenCalledWith(profileId);
    expect(removeDirectoryProfile.mock.invocationCallOrder[0]).toBeLessThan(
      removeManagerProfile.mock.invocationCallOrder[0]!,
    );
    service.dispose();
  });

  it("keeps the Manager lifecycle unchanged when Profile persistence fails", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const removeManagerProfile = vi.fn();
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [],
          servers: [],
          workspaceHistory: [],
        })),
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        updateProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(async () => {
          throw new Error("settings write failed");
        }),
        removeSourceServer: vi.fn(),
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect: vi.fn(),
        removeProfile: removeManagerProfile,
      },
      onBeforeSourceServerRemoved: vi.fn(),
    });

    await expect(service.removeProfile(profileId)).rejects.toThrow("settings write failed");
    expect(removeManagerProfile).not.toHaveBeenCalled();
    service.dispose();
  });

  it("publishes directory deltas with the same monotonic generation as state deltas", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const directoryEmitter = new Emitter<void>();
    const directory = {
      snapshot: vi.fn(async () => ({
        profiles: [],
        servers: [],
        workspaceHistory: [],
      })),
      onDidChange: directoryEmitter.event,
      resolveProfileTarget: vi.fn(),
      renameSource: vi.fn(),
      renameProfile: vi.fn(),
      setPreferredProfile: vi.fn(),
      removeProfile: vi.fn(),
      removeSourceServer: vi.fn(),
    };
    const service = createSourceServerManagementService({
      directory,
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        removeProfile: vi.fn(),
        disconnect: vi.fn(),
      },
      onBeforeSourceServerRemoved: vi.fn(),
    });
    const directoryDeltas: unknown[] = [];
    const stateDeltas: unknown[] = [];
    service.onDidChangeDirectory((delta) => directoryDeltas.push(delta));
    service.onDidChangeState((delta) => stateDeltas.push(delta));

    directoryEmitter.fire();
    stateEmitter.fire({ profileId, state: "online", updatedAt: 1 });

    expect(directoryDeltas).toEqual([{ generation: 1 }]);
    expect(stateDeltas).toEqual([
      { generation: 2, state: { profileId, state: "online", updatedAt: 1 } },
    ]);
    service.dispose();
  });

  it("removes a complete device through the Host callback before persistence", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const removeSourceServer = vi.fn(async () => undefined);
    const disconnect = vi.fn();
    const onBeforeSourceServerRemoved = vi.fn(async () => undefined);
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [],
          servers: [{ sourceServerId, displayName: "server", declaredWorkspaces: [] }],
          workspaceHistory: [],
        })),
        onDidChange: new Emitter<void>().event,
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
        removeSourceServer,
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        removeProfile: vi.fn(),
        disconnect,
      },
      onBeforeSourceServerRemoved,
    });

    await service.removeSourceServer(sourceServerId);
    expect(disconnect).toHaveBeenCalledWith(sourceServerId);
    expect(onBeforeSourceServerRemoved).toHaveBeenCalledWith(sourceServerId);
    expect(removeSourceServer).toHaveBeenCalledWith(sourceServerId);
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      onBeforeSourceServerRemoved.mock.invocationCallOrder[0]!,
    );
    expect(onBeforeSourceServerRemoved.mock.invocationCallOrder[0]).toBeLessThan(
      removeSourceServer.mock.invocationCallOrder[0]!,
    );
    service.dispose();
  });

  it("rejects removal without attachment cleanup and preserves callback failures as codes", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const snapshot = {
      profiles: [],
      servers: [{ sourceServerId, displayName: "server", declaredWorkspaces: [] }],
      workspaceHistory: [],
    };
    const directoryRemove = vi.fn(async () => undefined);
    const makeService = (onBeforeSourceServerRemoved?: () => Promise<void>) =>
      createSourceServerManagementService({
        directory: {
          snapshot: vi.fn(async () => snapshot),
          onDidChange: new Emitter<void>().event,
          resolveProfileTarget: vi.fn(),
          renameSource: vi.fn(),
          renameProfile: vi.fn(),
          setPreferredProfile: vi.fn(),
          removeProfile: vi.fn(),
          removeSourceServer: directoryRemove,
        },
        manager: {
          listStates: () => [],
          onDidChangeState: stateEmitter.event,
          getOnlineConnection: () => undefined,
          connect: vi.fn(),
          updateServer: vi.fn(),
          disconnect: vi.fn(),
          removeProfile: vi.fn(),
        },
        ...(onBeforeSourceServerRemoved ? { onBeforeSourceServerRemoved } : {}),
      });

    const missing = makeService();
    await expect(missing.removeSourceServer(sourceServerId)).rejects.toMatchObject({
      code: "source-server-remove-callback-missing",
    });
    missing.dispose();

    const callbackFailed = makeService(async () => {
      throw new Error("attachment failure");
    });
    await expect(callbackFailed.removeSourceServer(sourceServerId)).rejects.toMatchObject({
      code: "source-server-remove-callback-failed",
    });
    callbackFailed.dispose();
    // 合同 §8.1.3：缺回调拒绝与回调失败中止都不得触碰持久化记录。
    expect(directoryRemove).not.toHaveBeenCalled();
  });

  it("maps persistence failures to the persist-failed code and keeps the device in the snapshot", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const snapshot = {
      profiles: [],
      servers: [{ sourceServerId, displayName: "server", declaredWorkspaces: [] }],
      workspaceHistory: [],
    };
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => snapshot),
        onDidChange: new Emitter<void>().event,
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
        removeSourceServer: vi.fn(async () => {
          throw new Error("disk full");
        }),
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect: vi.fn(),
        removeProfile: vi.fn(),
      },
      onBeforeSourceServerRemoved: vi.fn(async () => undefined),
    });

    await expect(service.removeSourceServer(sourceServerId)).rejects.toMatchObject({
      code: "source-server-remove-persist-failed",
    });
    // 恢复态：设备记录保留在权威快照中，且无任何在线状态（连接已在删除流程前断开）。
    const recovered = await service.getSnapshot();
    expect(recovered.servers).toEqual([expect.objectContaining({ sourceServerId })]);
    expect(recovered.states).toEqual([]);
    service.dispose();
  });

  it("returns a successful snapshot without side effects when removing an unknown device", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const directoryRemove = vi.fn(async () => undefined);
    const onBeforeSourceServerRemoved = vi.fn(async () => undefined);
    const disconnect = vi.fn();
    const service = createSourceServerManagementService({
      directory: {
        snapshot: vi.fn(async () => ({
          profiles: [],
          servers: [],
          workspaceHistory: [],
        })),
        onDidChange: new Emitter<void>().event,
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
        removeSourceServer: directoryRemove,
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect,
        removeProfile: vi.fn(),
      },
      onBeforeSourceServerRemoved,
    });

    // 幂等：设备不存在返回成功空操作，不走断连/回调/持久化，也不占用错误码。
    await expect(service.removeSourceServer(sourceServerId)).resolves.toMatchObject({
      servers: [],
    });
    expect(disconnect).not.toHaveBeenCalled();
    expect(onBeforeSourceServerRemoved).not.toHaveBeenCalled();
    expect(directoryRemove).not.toHaveBeenCalled();
    service.dispose();
  });

  it("retries the snapshot read when a concurrent write bumps the generation", async () => {
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const directoryChange = new Emitter<void>();
    const staleServers = [{ sourceServerId, displayName: "stale-name", declaredWorkspaces: [] }];
    const freshServers = [{ sourceServerId, displayName: "fresh-name", declaredWorkspaces: [] }];
    const snapshot = vi.fn(async () => {
      if (snapshot.mock.calls.length === 1) {
        // 读取进行中注入并发目录写入：generation 递增，本轮读到的是旧内容。
        directoryChange.fire();
        return { profiles: [], servers: staleServers, workspaceHistory: [] };
      }
      return { profiles: [], servers: freshServers, workspaceHistory: [] };
    });
    const service = createSourceServerManagementService({
      directory: {
        snapshot,
        onDidChange: directoryChange.event,
        resolveProfileTarget: vi.fn(),
        renameSource: vi.fn(),
        renameProfile: vi.fn(),
        setPreferredProfile: vi.fn(),
        removeProfile: vi.fn(),
        removeSourceServer: vi.fn(),
      },
      manager: {
        listStates: () => [],
        onDidChangeState: stateEmitter.event,
        getOnlineConnection: () => undefined,
        connect: vi.fn(),
        updateServer: vi.fn(),
        disconnect: vi.fn(),
        removeProfile: vi.fn(),
      },
    });

    // 合同 §8.1.4 稳定读取：start/end generation 双检查，不一致必须整体重读，
    // 不得产出「旧内容 + 新版本号」。
    const result = await service.getSnapshot();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(result.generation).toBe(1);
    expect(result.servers).toEqual([expect.objectContaining({ displayName: "fresh-name" })]);
    service.dispose();
  });
});
