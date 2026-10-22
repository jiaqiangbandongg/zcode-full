import {
  sourceServerManagementSnapshotSchema,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import type { ManagedSourceServerConnection } from "./sourceServerConnectionManager.js";
import type { SourceServerDirectorySnapshot } from "./sourceServerDirectory.js";

/** Host 管理服务持有的统计投影；远端读取不阻塞本机目录，连接换代后旧结果失效。 */
export function createSourceServerMigrationCounts(options: {
  getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined;
  onDidChange(): void;
}) {
  let disposed = false;
  type MigrationCount = SourceServerManagementSnapshot["migrationCounts"][number];
  interface MigrationRead {
    connection: ManagedSourceServerConnection;
    value: MigrationCount;
    refreshRequested: boolean;
  }
  const migrationReads = new Map<string, MigrationRead>();
  function invalidateMigrationCounts(sourceServerId?: string) {
    for (const [id, entry] of migrationReads) {
      if (sourceServerId !== undefined && id !== sourceServerId) continue;
      // 在途只标记一次刷新，避免目录事件在网络停滞时积累远端请求。
      if (entry.value.status === "loading") entry.refreshRequested = true;
      else migrationReads.delete(id);
    }
  }
  function startMigrationRead(sourceServerId: string, entry: MigrationRead) {
    void (async () => {
      let value: MigrationCount;
      try {
        const service = entry.connection.services.sourceServerWorkspaceService;
        const [failed, abandoned] = await Promise.allSettled([
          Promise.resolve().then(() => service.getFailedPathCount()),
          Promise.resolve().then(() => service.getAbandonedPathCount()),
        ]);
        // 一项失败也要等该组另一项收口，避免反复失效时堆积仍在途的请求。
        if (failed.status !== "fulfilled" || abandoned.status !== "fulfilled") {
          throw new Error("Migration counts unavailable");
        }
        value = sourceServerManagementSnapshotSchema.shape.migrationCounts.element.parse({
          sourceServerId,
          status: "available",
          failedPathCount: failed.value,
          abandonedPathCount: abandoned.value,
        });
      } catch {
        value = { sourceServerId, status: "unavailable" };
      }
      // 统计属于当前物理连接；断开、换代、目录移除或释放后的迟到结果不能发布。
      if (
        disposed ||
        migrationReads.get(sourceServerId) !== entry ||
        options.getOnlineConnection(sourceServerId) !== entry.connection
      )
        return;
      if (entry.refreshRequested) {
        entry.refreshRequested = false;
        startMigrationRead(sourceServerId, entry);
        return;
      }
      entry.value = value;
      options.onDidChange();
    })();
  }

  function readMigrationCounts(directory: SourceServerDirectorySnapshot): {
    failedPathCount: number;
    abandonedPathCount: number;
    migrationCounts: SourceServerManagementSnapshot["migrationCounts"];
  } {
    const activeSources = new Set(directory.servers.map((server) => server.sourceServerId));
    for (const id of migrationReads.keys()) {
      if (!activeSources.has(id)) migrationReads.delete(id);
    }
    // 本机设备目录与手动断开不能依赖远端迁移统计完成；统计仅异步补全快照。
    const migrationCounts = directory.servers.map((server): MigrationCount => {
      const connection = options.getOnlineConnection(server.sourceServerId);
      if (!connection) {
        migrationReads.delete(server.sourceServerId);
        return {
          sourceServerId: server.sourceServerId,
          status: "requires-connection" as const,
        };
      }
      let entry = migrationReads.get(server.sourceServerId);
      if (!entry || entry.connection !== connection) {
        entry = {
          connection,
          value: { sourceServerId: server.sourceServerId, status: "loading" },
          refreshRequested: false,
        };
        migrationReads.set(server.sourceServerId, entry);
        startMigrationRead(server.sourceServerId, entry);
      }
      return entry.value;
    });
    const totals = migrationCounts.reduce(
      (total, count) => ({
        failedPathCount:
          total.failedPathCount + (count.status === "available" ? count.failedPathCount : 0),
        abandonedPathCount:
          total.abandonedPathCount + (count.status === "available" ? count.abandonedPathCount : 0),
      }),
      { failedPathCount: 0, abandonedPathCount: 0 },
    );
    return { ...totals, migrationCounts };
  }

  return {
    read: readMigrationCounts,
    invalidate: invalidateMigrationCounts,
    dispose() {
      disposed = true;
      migrationReads.clear();
    },
  };
}
