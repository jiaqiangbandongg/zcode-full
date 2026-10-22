import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectStorage } from "#src/project-storage/index.js";
import {
  createRemoteProjectService,
  projectWorkspaceSettings,
} from "#src/remote-projects/index.js";
import { appSettingsSchema } from "@zcode/shared";
import type { RemoteProjectCache } from "#src/remote-projects/contract.js";
const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const directory = await mkdtemp(join(tmpdir(), "remote-project-test-"));
  directories.push(directory);
  await projectStorage.migrate(db, { backupDirectories: [directory] });
  const afterChange = vi.fn();
  const service = createRemoteProjectService({
    database: async () => db,
    afterChange,
    now: () => 100,
  });
  const target = { kind: "ssh" as const, host: "example.test", username: "user" };
  await service.saveHost({ id: "source", target });
  const project: RemoteProjectCache = {
    projectId: "p",
    name: "Remote",
    roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
  };
  return { db, service, afterChange, target, project };
}
describe("workspace settings projection", () => {
  it("只从本机保留入口派生兼容集合；删除入口不因活动目录或旧快照复活", async () => {
    const { db, service, target, project } = await fixture();
    await service.saveHost({ id: "remote:server:retained", target });
    const saved = await service.addEntry({ hostId: "remote:server:retained", project });
    const repository = projectStorage.repository(db);
    const local = repository.saveProject({ roots: ["/local", "/shared"], name: "local" });
    repository.saveProject({ roots: ["/shared"], name: "other" });
    const settings = appSettingsSchema.parse({
      lastWorkspaceSession: [{ kind: "local", workspacePath: "/old-removed" }],
      recentProjects: ["/old-removed"],
      lastActiveWorkspace: {
        kind: "remote",
        target,
        workspacePath: "/repo",
        workspaceIdentity: "remote:server:retained:/repo",
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
      },
    });
    const result = projectWorkspaceSettings(
      repository.readTree({ includeTasks: false }).projects,
      await service.readDirectory(),
      settings,
    );
    // 修复原因：项目仓库已将新建项目放到最前，兼容投影应按该顺序去重 roots。
    expect(result.recentProjects).toEqual(["/shared", "/local"]);
    expect(result.lastWorkspaceSession).toHaveLength(3);
    expect(result.lastActiveTabIndex).toBe(2);
    expect(result.lastActiveWorkspace).toMatchObject({
      workspaceIdentity: "remote:server:retained:/repo",
    });
    expect(result.lastWorkspaceSession?.at(-1)).toMatchObject({
      workspaceIdentity: "remote:ssh:example.test:22:user:/repo",
      target,
    });
    await service.removeEntry(saved.id);
    repository.deleteProject(local.id);
    const removed = projectWorkspaceSettings(
      repository.readTree({ includeTasks: false }).projects,
      await service.readDirectory(),
      { ...settings, ...result },
    );
    expect(removed.recentProjects).toEqual(["/shared"]);
    expect(removed.lastWorkspaceSession).toEqual([
      { kind: "local", workspacePath: "/shared", workspacePurpose: "project" },
    ]);
    expect(removed.lastActiveWorkspace).toBeNull();
  });

  it("活动 conversation 只保留选择不写兼容项目集合，移除连接后清空且 null 不回读旧值", async () => {
    const { service, target } = await fixture();
    await service.removeHost("source");
    const settings = appSettingsSchema.parse({
      lastActiveWorkspace: {
        kind: "remote",
        workspacePath: "/chat",
        workspacePurpose: "conversation",
        workspaceIdentity: "remote:ssh:example.test:22:user:/chat",
        target,
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
      },
    });
    await service.saveHost({ id: "remote:ssh:example.test:22:user", target });
    const first = projectWorkspaceSettings([], await service.readDirectory(), settings);
    expect(first.lastWorkspaceSession).toEqual([]);
    expect(first.lastActiveWorkspace).toMatchObject({ workspacePath: "/chat" });
    await service.removeHost("remote:ssh:example.test:22:user");
    expect(
      projectWorkspaceSettings([], await service.readDirectory(), settings).lastActiveWorkspace,
    ).toBeNull();
    expect(
      projectWorkspaceSettings([], await service.readDirectory(), {
        ...settings,
        lastActiveWorkspace: null,
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/old" }],
      }).lastActiveWorkspace,
    ).toBeNull();
  });
});
