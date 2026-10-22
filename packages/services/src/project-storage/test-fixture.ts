import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import type { ProjectStorageContract } from "#src/project-storage/contract.js";
import { projectStorage } from "#src/project-storage/index.js";
export const port: ProjectStorageContract = projectStorage;
const resources: Array<{ db: DatabaseSync; directory: string }> = [];
afterEach(async () => {
  for (const { db, directory } of resources.splice(0)) {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
export async function fixture(savedWorkspaces: readonly string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-project-migration-"));
  const db = new DatabaseSync(":memory:");
  resources.push({ db, directory });
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, task_id TEXT,
    title TEXT DEFAULT '', provider TEXT DEFAULT 'glm', title_overridden INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, unread_at INTEGER,
    task_status TEXT DEFAULT 'completed', created_at INTEGER DEFAULT 1, updated_at INTEGER DEFAULT 2,
    PRIMARY KEY(workspace_key,task_id));
    CREATE TABLE task_groups(group_id TEXT PRIMARY KEY,title TEXT,color TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE task_group_members(group_id TEXT,workspace_key TEXT,workspace_path TEXT,workspace_identity TEXT,task_id TEXT,sort_order INTEGER);
    CREATE TABLE task_group_workspace_bootstraps(workspace_key TEXT PRIMARY KEY,group_id TEXT);
    CREATE TABLE task_group_view_node_orders(node_type TEXT,node_key TEXT,sort_order INTEGER);
    CREATE TABLE automations(automation_id TEXT PRIMARY KEY,workspace_key TEXT,workspace_path TEXT);
    CREATE TABLE off_peak_tasks(off_peak_task_id TEXT PRIMARY KEY,workspace_key TEXT,workspace_path TEXT);
    CREATE TABLE untouched(id TEXT PRIMARY KEY,value TEXT);
    INSERT INTO untouched VALUES ('keep','unchanged');`);
  const add = (id: string, path: string, identity?: string) =>
    db
      .prepare(
        "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title) VALUES(?,?,?,?,?)",
      )
      .run(identity ?? path, path, identity ?? null, id, `title ${id}`);
  return {
    db,
    add,
    context: {
      backupDirectories: [directory],
      now: () => 10,
      settings: {
        recentProjects: [],
        lastWorkspaceSession: savedWorkspaces.map((workspacePath) => ({
          kind: "local" as const,
          workspacePath,
        })),
      },
    },
  };
}
