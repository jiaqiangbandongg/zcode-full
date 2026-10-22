import { z } from "zod";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  generateTraceId,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type {
  AutoArchiveInput,
  ProjectDirectories,
  ProjectRepositoryContract,
  ProjectTask,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "#src/project-storage/contract.js";
import { ensureHost, OWNERSHIP_DECIDED } from "#src/project-storage/legacy-tasks.js";
import {
  assertRemoteProjectRoots,
  assertRemoteTaskDirectories,
} from "#src/project-storage/remote-policy.js";

const executionDirectoriesSchema = z.array(z.string().min(1)).max(256);

function transaction<T>(db: DatabaseSync, body: () => T, write = true): T {
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function readProjects(db: DatabaseSync, includeDeleted = true): VirtualProject[] {
  const roots = db
    .prepare(
      "SELECT project_id,root_path,position,is_primary FROM project_roots ORDER BY position,root_path",
    )
    .all();
  return db
    .prepare(
      `SELECT * FROM projects ${includeDeleted ? "" : "WHERE deleted=0"} ORDER BY position,project_id`,
    )
    .all()
    .map((row) => ({
      id: String(row.project_id),
      hostId: String(row.host_id),
      name: String(row.name),
      nameOverridden: row.name_overridden === 1,
      position: Number(row.position),
      pinned: row.pinned === 1,
      deleted: row.deleted === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      roots: roots
        .filter((root) => root.project_id === row.project_id)
        .map((root) => ({
          rootPath: String(root.root_path),
          position: Number(root.position),
          isPrimary: root.is_primary === 1,
        })),
    }));
}

function requireProject(db: DatabaseSync, id: string): VirtualProject {
  const project = readProjects(db).find((entry) => entry.id === id);
  if (!project) throw new Error("project.not-found");
  return project;
}

function readTask(db: DatabaseSync, task: ProjectTaskRef) {
  return db
    .prepare("SELECT * FROM tasks WHERE workspace_key=? AND task_id=?")
    .get(resolveWorkspaceKey(task), task.taskId);
}

function resolveDirectories(
  db: DatabaseSync,
  task: ProjectTaskRef,
  ownerHostId = "local",
): ProjectDirectories {
  const row = readTask(db, task);
  // 旧远端影子行仍可能保留；行与项目一致不代表当前 Host 有权加载其目录。
  if (row && row.host_id !== ownerHostId) throw new Error("project.host-mismatch");
  const workspacePath = row ? String(row.root_path) : task.workspacePath;
  const project = row?.project_id ? requireProject(db, String(row.project_id)) : null;
  if (project && row?.host_id !== project.hostId) throw new Error("project.host-mismatch");
  assertRemoteTaskDirectories(
    ownerHostId,
    project,
    workspacePath,
    typeof row?.execution_directories === "string"
      ? executionDirectoriesSchema.parse(JSON.parse(row.execution_directories))
      : [],
  );
  return {
    workspacePath,
    projectId: project?.id ?? null,
    additionalDirectories:
      typeof row?.execution_directories === "string"
        ? executionDirectoriesSchema.parse(JSON.parse(row.execution_directories))
        : (project?.roots.map((root) => root.rootPath).filter((path) => path !== workspacePath) ??
          []),
  };
}

function readTasks(db: DatabaseSync): ProjectTask[] {
  // 迁移后的旧后端行也有 CLI 时间；沿用列表的 provider 边界，避免展示 Controller 无法操作的会话。
  return db
    .prepare(
      "SELECT * FROM tasks WHERE provider=? AND deleted=0 AND coalesce(cli_deleted,0)=0 AND cli_created_at IS NOT NULL ORDER BY cli_updated_at DESC,task_id",
    )
    .all(ZCODE_AGENT_PROVIDER)
    .map((row) => {
      const meta = typeof row.meta_json === "string" ? JSON.parse(row.meta_json) : {};
      return {
        ...meta,
        taskId: String(row.task_id),
        traceId: meta.traceId ?? generateTraceId(String(row.task_id)),
        workspacePath: String(row.root_path),
        workspaceIdentity:
          row.workspace_identity === row.workspace_key
            ? String(row.workspace_identity)
            : isRemoteWorkspaceIdentity(String(row.workspace_key))
              ? String(row.workspace_key)
              : undefined,
        title: String(row.title_overridden === 1 ? row.title : (row.cli_title ?? "")),
        titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
        createdAt: Number(row.cli_created_at),
        updatedAt: Number(row.cli_updated_at),
        status:
          row.cli_last_outcome === "error"
            ? "error"
            : row.cli_last_outcome
              ? "completed"
              : undefined,
        mode: meta.mode ?? "default",
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        unreadAt: row.unread_at == null ? undefined : Number(row.unread_at),
        projectId: row.project_id == null ? null : String(row.project_id),
        hostId: String(row.host_id),
      };
    });
}

export class ProjectRepository implements ProjectRepositoryContract {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerHostId?: string,
  ) {}

  archiveInactive(input: AutoArchiveInput): ProjectTaskRef[] {
    return transaction(this.db, () => {
      const active = new Set(
        input.activeTasks.map((task) => JSON.stringify([resolveWorkspaceKey(task), task.taskId])),
      );
      // 2026-09-15 裁决：纯按 CLI 最后活动时间归档，不再看 last_outcome 与未读；
      // 只有置顶和 syncer 观察到的运行中会话除外。旧判据把 error / 无结果的老会话永远留在列表里。
      const candidates = this.db
        .prepare(`SELECT workspace_key,workspace_path,workspace_identity,task_id FROM tasks
        WHERE archived=0 AND pinned=0 AND deleted=0 AND coalesce(cli_deleted,0)=0
        AND cli_updated_at < ? AND host_id=?`)
        .all(input.cutoff, this.ownerHostId ?? "local");
      const result: ProjectTaskRef[] = [];
      for (const row of candidates) {
        if (active.has(JSON.stringify([row.workspace_key, row.task_id]))) continue;
        this.db
          .prepare("UPDATE tasks SET archived=1 WHERE workspace_key=? AND task_id=?")
          .run(row.workspace_key!, row.task_id!);
        result.push({
          workspacePath: String(row.workspace_path),
          taskId: String(row.task_id),
          workspaceIdentity:
            row.workspace_identity === row.workspace_key
              ? String(row.workspace_identity)
              : isRemoteWorkspaceIdentity(String(row.workspace_key))
                ? String(row.workspace_key)
                : undefined,
        });
      }
      return result;
    });
  }

  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    includeTasks?: boolean;
  }): ProjectTree {
    const read = () => ({
      projects: readProjects(this.db, options?.includeDeleted ?? false).filter(
        (project) => project.hostId === (this.ownerHostId ?? "local"),
      ),
      ...(options?.includeDeletedTasks
        ? {
            deletedTasks: this.db
              .prepare(`
        SELECT task_id AS taskId,workspace_path AS workspacePath,workspace_identity AS workspaceIdentity,host_id AS hostId
        FROM tasks WHERE host_id=? AND (deleted=1 OR coalesce(cli_deleted,0)=1)`)
              .all(this.ownerHostId ?? "local")
              .map((row) => ({
                taskId: String(row.taskId),
                workspacePath: String(row.workspacePath),
                hostId: String(row.hostId),
                ...(typeof row.workspaceIdentity === "string"
                  ? { workspaceIdentity: row.workspaceIdentity }
                  : {}),
              })),
          }
        : {}),
      tasks:
        options?.includeTasks === false
          ? []
          : readTasks(this.db).filter((task) => task.hostId === (this.ownerHostId ?? "local")),
    });
    return this.db.isTransaction ? read() : transaction(this.db, read, false);
  }

  saveProject(input: SaveProjectInput): VirtualProject {
    return transaction(this.db, () => {
      const old =
        input.id || input.restoreProjectId
          ? requireProject(this.db, input.id ?? input.restoreProjectId!)
          : undefined;
      if (input.id && old?.deleted) throw new Error("project.deleted");
      const hostId = this.ownerHostId ?? "local";
      if (old && old.hostId !== hostId) throw new Error("project.cross-host-move");
      if (input.hostId && input.hostId !== hostId) throw new Error("project.host-immutable");
      const roots = [...new Set(input.roots ?? old?.roots.map((root) => root.rootPath) ?? [])];
      assertRemoteProjectRoots(this.ownerHostId, roots, old);
      if (
        input.restoreProjectId &&
        (!old?.deleted ||
          roots.length !== old.roots.length ||
          roots.some((root) => !old.roots.some((entry) => entry.rootPath === root)))
      )
        throw new Error("project.restore-roots-mismatch");
      const primary =
        input.primaryRoot ??
        old?.roots.find((root) => root.isPrimary && roots.includes(root.rootPath))?.rootPath ??
        roots[0];
      if (primary !== undefined && !roots.includes(primary))
        throw new Error("project.invalid-primary-root");
      const id = old?.id ?? randomUUID();
      const overridden =
        input.name !== undefined ? input.name.trim().length > 0 : (old?.nameOverridden ?? false);
      const baseName =
        input.name?.trim() ||
        (overridden ? old?.name : undefined) ||
        (roots[0] ? basename(roots[0]) : input.defaultName?.trim() || old?.name || "New project");
      let name = baseName;
      for (
        let suffix = 2;
        this.db
          .prepare(
            "SELECT 1 FROM projects WHERE host_id=? AND name=? AND deleted=0 AND project_id<>?",
          )
          .get(hostId, name, id);
        suffix++
      )
        name = `${baseName} (${suffix})`;
      const now = Date.now();
      // 原先用 max(position)+1 导致新建项目落在末尾；同一 Host 写事务内取最小值减一，保留已有顺序。
      this.db
        .prepare(`INSERT INTO projects(project_id,host_id,name,name_overridden,position,pinned,pinned_at,created_at,updated_at)
        VALUES(?,?,?,?,(SELECT coalesce(min(position),1)-1 FROM projects WHERE host_id=?),?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,name_overridden=excluded.name_overridden,
        pinned=excluded.pinned,pinned_at=excluded.pinned_at,deleted=0,deleted_at=NULL,updated_at=excluded.updated_at`)
        .run(
          id,
          hostId,
          name,
          overridden ? 1 : 0,
          hostId,
          (input.pinned ?? old?.pinned) ? 1 : 0,
          (input.pinned ?? old?.pinned) ? now : null,
          now,
          now,
        );
      this.db.prepare("DELETE FROM project_roots WHERE project_id=?").run(id);
      roots.forEach((root, position) =>
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
          )
          .run(id, root, position, root === primary ? 1 : 0),
      );
      return requireProject(this.db, id);
    });
  }

  initializeProjectRoot(id: string, path: string): VirtualProject {
    return transaction(this.db, () => {
      const project = requireProject(this.db, id);
      if (project.hostId !== (this.ownerHostId ?? "local"))
        throw new Error("project.cross-host-move");
      if (project.deleted) throw new Error("project.deleted");
      assertRemoteProjectRoots(this.ownerHostId, [path], project);
      if (!project.roots.length) {
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
          )
          .run(id, path);
        this.db.prepare("UPDATE projects SET updated_at=? WHERE project_id=?").run(Date.now(), id);
      }
      return requireProject(this.db, id);
    });
  }

  deleteProject(id: string): void {
    this.db
      .prepare(
        "UPDATE projects SET deleted=1,deleted_at=?,updated_at=? WHERE project_id=? AND deleted=0 AND host_id=?",
      )
      .run(Date.now(), Date.now(), id, this.ownerHostId ?? "local");
  }

  moveTask(input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }): void {
    transaction(this.db, () => {
      const project = requireProject(this.db, input.projectId);
      if (project.deleted) throw new Error("project.deleted");
      const task = readTask(this.db, input.task);
      if (!task) throw new Error("project.task-not-found");
      if (project.hostId !== (this.ownerHostId ?? "local") || task.host_id !== project.hostId)
        throw new Error("project.cross-host-move");
      assertRemoteTaskDirectories(this.ownerHostId, project, String(task.root_path));
      if (!project.roots.some((root) => root.rootPath === task.root_path)) {
        if (!input.addMissingRoot) throw new Error("project.root-confirmation-required");
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
          )
          .run(
            project.id,
            String(task.root_path),
            project.roots.length,
            project.roots.length === 0 ? 1 : 0,
          );
      }
      this.db
        .prepare(
          "UPDATE tasks SET project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=?",
        )
        .run(project.id, OWNERSHIP_DECIDED, resolveWorkspaceKey(input.task), input.task.taskId);
    });
  }

  reorderProjects(ids: string[]): void {
    transaction(this.db, () => {
      if (new Set(ids).size !== ids.length) throw new Error("project.duplicate-order");
      ids.forEach((id, position) => {
        if (requireProject(this.db, id).hostId !== (this.ownerHostId ?? "local"))
          throw new Error("project.cross-host-move");
        this.db.prepare("UPDATE projects SET position=? WHERE project_id=?").run(position, id);
      });
    });
  }

  resolveSessionDirectories(task: ProjectTaskRef): ProjectDirectories {
    return transaction(this.db, () => resolveDirectories(this.db, task, this.ownerHostId), false);
  }

  reserveCreatedTask(input: {
    task: ProjectTaskRef;
    projectId: string | null;
    additionalDirectories?: string[];
  }): ProjectDirectories {
    return transaction(this.db, () => {
      const key = resolveWorkspaceKey(input.task);
      const host = ensureHost(this.db, key, this.ownerHostId);
      if (host !== (this.ownerHostId ?? "local")) throw new Error("project.cross-host-move");
      if (!readTask(this.db, input.task)) {
        assertRemoteTaskDirectories(
          this.ownerHostId,
          input.projectId ? requireProject(this.db, input.projectId) : null,
          input.task.workspacePath,
          input.additionalDirectories,
        );
        if (input.projectId) {
          const project = requireProject(this.db, input.projectId);
          if (project.deleted && input.additionalDirectories === undefined)
            throw new Error("project.deleted");
          if (project.hostId !== host) throw new Error("project.cross-host-move");
          if (
            input.additionalDirectories === undefined &&
            !project.roots.some((root) => root.rootPath === input.task.workspacePath)
          )
            throw new Error("project.cwd-not-in-roots");
        }
        // 创建归属必须先于 CLI 首发；空事实不是假会话，列表只读取已有 CLI 事实的行。
        this.db
          .prepare(`INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,project_id,handoff_pending,execution_directories)
          VALUES(?,?,?,?,0,0,?,?,?,?,?)`)
          .run(
            key,
            input.task.workspacePath,
            input.task.workspaceIdentity ?? null,
            input.task.taskId,
            host,
            input.task.workspacePath,
            input.projectId,
            OWNERSHIP_DECIDED,
            input.additionalDirectories === undefined
              ? null
              : JSON.stringify(executionDirectoriesSchema.parse(input.additionalDirectories)),
          );
      }
      return resolveDirectories(this.db, input.task, this.ownerHostId);
    });
  }
}
