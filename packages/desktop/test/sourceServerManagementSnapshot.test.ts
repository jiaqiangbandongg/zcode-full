import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { SourceServerConnectionStateSnapshot } from "@zcode/shared";
import type { ManagedSourceServerConnection } from "../src/host/sourceServerConnectionManager.js";
import { createSourceServerManagementService } from "../src/host/sourceServerManagementService.js";

const slowSourceId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const fastSourceId = "4cd4f9da-cd79-426c-9d70-75f36e9f6a87";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const connections = new Map<string, ManagedSourceServerConnection>();
  const changes = new Emitter<void>();
  const states = new Emitter<SourceServerConnectionStateSnapshot>();
  const servers = [slowSourceId, fastSourceId].map((sourceServerId) => ({
    sourceServerId,
    displayName: sourceServerId,
    declaredWorkspaces: [],
  }));
  const service = createSourceServerManagementService({
    directory: {
      snapshot: async () => ({ profiles: [], servers, workspaceHistory: [] }),
      onDidChange: changes.event,
      resolveProfileTarget: vi.fn(),
      renameSource: vi.fn(),
      renameProfile: vi.fn(),
      updateProfile: vi.fn(),
      setPreferredProfile: vi.fn(),
      removeProfile: vi.fn(),
      removeSourceServer: vi.fn(),
    },
    manager: {
      listStates: () =>
        [...connections.keys()].map((sourceServerId) => ({
          sourceServerId,
          profileId: sourceServerId,
          state: "online",
          updatedAt: 1,
        })),
      onDidChangeState: states.event,
      getOnlineConnection: (id) => connections.get(id),
      connect: vi.fn(),
      updateServer: vi.fn(),
      removeProfile: vi.fn(),
      disconnect: (id) => {
        connections.delete(id);
        states.fire({ sourceServerId: id, profileId: id, state: "offline", updatedAt: 2 });
      },
    },
  });
  const add = (id: string, failed: () => Promise<number>, abandoned = async () => 1) => {
    const remote = {
      getFailedPathCount: vi.fn(failed),
      getAbandonedPathCount: vi.fn(abandoned),
      retryWorkspaceMigration: vi.fn(async () => ({ rows: [] })),
      abandonFailedWorkspace: vi.fn(async () => ({ rows: [] })),
    };
    connections.set(id, {
      sourceServerId: id,
      profileId: id,
      serverInfo: {} as never,
      services: { sourceServerWorkspaceService: remote } as never,
    });
    return remote;
  };
  return { service, connections, changes, servers, add };
}

async function localSnapshot(service: ReturnType<typeof createSourceServerManagementService>) {
  let settled = false;
  const result = service.getSnapshot().finally(() => {
    settled = true;
  });
  void result.catch(() => undefined);
  // 微任务内完成的本机读必须独立于永不完成的远端读；短等待仅为失败诊断，不解锁远端 Promise。
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
  return result;
}

describe("管理快照的远端统计隔离", () => {
  it("一项统计失败但另一项仍挂起时不累积请求；显式刷新后可取得新值", async () => {
    const f = fixture();
    const blocked = deferred<number>();
    const remote = f.add(
      slowSourceId,
      async () => {
        throw new Error("failed");
      },
      () => blocked.promise,
    );
    try {
      await localSnapshot(f.service);
      await f.service.getSnapshot({ refreshMigrationCounts: true });
      await f.service.getSnapshot({ refreshMigrationCounts: true });
      expect(remote.getFailedPathCount).toHaveBeenCalledOnce();
      remote.getFailedPathCount.mockResolvedValue(7);
      remote.getAbandonedPathCount.mockResolvedValue(2);
      blocked.resolve(1);
      await vi.waitFor(async () => expect((await f.service.getSnapshot()).failedPathCount).toBe(7));
      expect(remote.getFailedPathCount).toHaveBeenCalledTimes(2);
      remote.getFailedPathCount.mockResolvedValue(8);
      await f.service.getSnapshot({ refreshMigrationCounts: true });
      await vi.waitFor(async () => expect((await f.service.getSnapshot()).failedPathCount).toBe(8));
    } finally {
      f.service.dispose();
      blocked.resolve(0);
    }
  });

  it("慢 Source 不阻塞本机快照/另一个 Source/手动断开，重复快照不重复启动 RPC", async () => {
    const f = fixture();
    const stalled = deferred<number>();
    const slow = f.add(slowSourceId, () => stalled.promise);
    f.add(fastSourceId, async () => 2);
    const notify = vi.fn();
    f.service.onDidChangeDirectory(notify);
    try {
      const first = await localSnapshot(f.service);
      expect(first.servers).toHaveLength(2);
      expect(first.states).toHaveLength(2);
      expect(first.migrationCounts).toContainEqual({
        sourceServerId: slowSourceId,
        status: "loading",
      });
      await vi.waitFor(async () =>
        expect((await f.service.getSnapshot()).migrationCounts).toContainEqual({
          sourceServerId: fastSourceId,
          status: "available",
          failedPathCount: 2,
          abandonedPathCount: 1,
        }),
      );
      await f.service.getSnapshot();
      await f.service.getSnapshot();
      expect(slow.getFailedPathCount).toHaveBeenCalledOnce();
      const offline = await f.service.disconnectSource(slowSourceId);
      expect(offline.migrationCounts).toContainEqual({
        sourceServerId: slowSourceId,
        status: "requires-connection",
      });
      const calls = notify.mock.calls.length;
      stalled.resolve(99);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(notify).toHaveBeenCalledTimes(calls);
      expect((await f.service.getSnapshot()).failedPathCount).toBe(2);
    } finally {
      f.service.dispose();
      stalled.resolve(0);
    }
  });

  it("统计失败保留设备并明确不可用；读取快照不自动重试，目录变化才重新读取", async () => {
    const f = fixture();
    const remote = f.add(slowSourceId, async () => {
      throw new Error("remote failed");
    });
    try {
      await localSnapshot(f.service);
      await vi.waitFor(async () =>
        expect((await f.service.getSnapshot()).migrationCounts).toContainEqual({
          sourceServerId: slowSourceId,
          status: "unavailable",
        }),
      );
      await f.service.getSnapshot();
      expect(remote.getFailedPathCount).toHaveBeenCalledOnce();
      remote.getFailedPathCount.mockResolvedValue(3);
      f.changes.fire();
      await localSnapshot(f.service);
      await vi.waitFor(async () => expect((await f.service.getSnapshot()).failedPathCount).toBe(3));
      expect(remote.getFailedPathCount).toHaveBeenCalledTimes(2);
    } finally {
      f.service.dispose();
    }
  });

  it("换连接或移除 Source 后，旧请求迟到不能覆盖新统计或重新出现设备", async () => {
    const f = fixture();
    const old = deferred<number>();
    f.add(slowSourceId, () => old.promise);
    try {
      await localSnapshot(f.service);
      f.add(slowSourceId, async () => 4);
      await localSnapshot(f.service);
      await vi.waitFor(async () => expect((await f.service.getSnapshot()).failedPathCount).toBe(4));
      old.resolve(90);
      await Promise.resolve();
      await Promise.resolve();
      expect((await f.service.getSnapshot()).failedPathCount).toBe(4);
      const pending = deferred<number>();
      f.add(slowSourceId, () => pending.promise);
      await localSnapshot(f.service);
      f.servers.splice(0, 1);
      f.changes.fire();
      await localSnapshot(f.service);
      pending.resolve(100);
      await Promise.resolve();
      await Promise.resolve();
      expect((await f.service.getSnapshot()).servers.map((s) => s.sourceServerId)).toEqual([
        fastSourceId,
      ]);
    } finally {
      f.service.dispose();
      old.resolve(0);
    }
  });

  it("在途失效合并刷新，迁移操作后读取新统计，dispose 后不发布结果", async () => {
    const f = fixture();
    const first = deferred<number>();
    const remote = f.add(slowSourceId, () => first.promise);
    const notify = vi.fn();
    f.service.onDidChangeDirectory(notify);
    try {
      await localSnapshot(f.service);
      f.changes.fire();
      f.changes.fire();
      await localSnapshot(f.service);
      expect(remote.getFailedPathCount).toHaveBeenCalledOnce();
      remote.getFailedPathCount.mockResolvedValue(5);
      first.resolve(2);
      await vi.waitFor(async () => expect((await f.service.getSnapshot()).failedPathCount).toBe(5));
      expect(remote.getFailedPathCount).toHaveBeenCalledTimes(2);
      remote.getFailedPathCount.mockResolvedValue(6);
      await f.service.retryWorkspaceMigration(slowSourceId, "/workspace", "migration");
      await localSnapshot(f.service);
      await vi.waitFor(async () => expect((await f.service.getSnapshot()).failedPathCount).toBe(6));
      const pending = deferred<number>();
      f.add(slowSourceId, () => pending.promise);
      await localSnapshot(f.service);
      f.service.dispose();
      const count = notify.mock.calls.length;
      pending.resolve(90);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(notify).toHaveBeenCalledTimes(count);
    } finally {
      f.service.dispose();
      first.resolve(0);
    }
  });
});
