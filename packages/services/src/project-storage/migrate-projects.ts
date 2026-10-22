import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { buildRemoteWorkspaceIdentity, buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ProjectMigrationContext } from "#src/project-storage/contract.js";
import {
  ensureHost,
  hostForWorkspace,
  initializeLegacyTaskIdentity,
  OWNERSHIP_DECIDED,
  uniqueRootProject,
} from "#src/project-storage/legacy-tasks.js";
import { addProjectSchema, tableExists } from "#src/project-storage/schema.js";

function rootName(path: string): string {
  return (path.includes("\\") ? win32 : posix).basename(path) || path;
}

function createProject(
  db: DatabaseSync,
  hostId: string,
  name: string,
  roots: string[],
  overridden: boolean,
  now: number,
): string {
  let uniqueName = name || "新项目";
  for (
    let suffix = 2;
    db
      .prepare("SELECT 1 FROM projects WHERE host_id=? AND name=? AND deleted=0")
      .get(hostId, uniqueName);
    suffix++
  )
    uniqueName = `${name} (${suffix})`;
  const id = randomUUID();
  db.prepare(`INSERT INTO projects(project_id,host_id,name,name_overridden,position,created_at,updated_at)
    VALUES(?,?,?,?,(SELECT count(*) FROM projects WHERE host_id=?),?,?)`).run(
    id,
    hostId,
    uniqueName,
    overridden ? 1 : 0,
    hostId,
    now,
    now,
  );
  roots.forEach((root, index) =>
    db
      .prepare(
        "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
      )
      .run(id, root, index, index === 0 ? 1 : 0),
  );
  return id;
}

function migrateConnectionHosts(db: DatabaseSync, settings: ProjectMigrationContext["settings"]) {
  const aliases = new Map<string, string>();
  const preferred = new Set(settings?.sourceServers?.map((source) => source.preferredProfileId));
  const profiles = [...(settings?.connectionProfiles ?? [])]
    .filter((profile) => profile.lifecycleState !== "retired")
    .sort((a, b) => Number(preferred.has(b.profileId)) - Number(preferred.has(a.profileId)));
  const written = new Set<string>();
  for (const profile of profiles) {
    const addressIdentity = buildRemoteWorkspaceIdentity("/", profile.target);
    const addressId = hostForWorkspace(addressIdentity).hostId;
    const stableId = profile.sourceServerId
      ? hostForWorkspace(
          buildServerRemoteWorkspaceIdentity({
            serverId: profile.sourceServerId,
            workspacePath: "/",
          }),
        ).hostId
      : addressId;
    aliases.set(addressId, stableId);
    aliases.set(stableId, stableId);
    if (written.has(stableId)) continue;
    written.add(stableId);
    ensureHost(db, addressIdentity, stableId);
    db.prepare(
      "UPDATE hosts SET kind=?,target_json=?,membership_id=?,last_opened_at=? WHERE host_id=?",
    ).run(
      profile.target.kind,
      JSON.stringify(profile.target),
      randomUUID(),
      profile.lastConnectedAt ?? null,
      stableId,
    );
  }
  return aliases;
}

export function migrateProjects(db: DatabaseSync, context: ProjectMigrationContext): void {
  const now = (context.now ?? Date.now)();
  addProjectSchema(db);
  ensureHost(db, "local", context.hostId);
  initializeLegacyTaskIdentity(db, false, context.hostId);
  const settings = context.settings;
  const remoteOwner = (context.hostId ?? "local") !== "local";
  const hostAliases = remoteOwner
    ? new Map<string, string>()
    : migrateConnectionHosts(db, settings);
  const workspaces = new Map<string, { path: string; hostId: string }>();
  // Bug 原因：历史任务目录不代表用户仍保留该工作区，扫描 tasks 会复活已移除的项目入口。
  // 首次项目集合与顺序只取旧 settings；其他历史任务保留原目录，按现有规则保持未归类。
  for (const entry of settings?.lastWorkspaceSession ?? []) {
    if (entry.kind === "local" && entry.workspacePurpose !== "conversation")
      workspaces.set(entry.workspacePath, {
        path: entry.workspacePath,
        hostId: context.hostId ?? "local",
      });
    if (entry.kind !== "remote" || (context.hostId ?? "local") !== "local") continue;
    const identity =
      entry.workspaceIdentity ?? buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target);
    const knownHostId = hostAliases.get(hostForWorkspace(identity).hostId);
    const hostId = ensureHost(db, identity, knownHostId);
    db.prepare(
      "UPDATE hosts SET target_json=coalesce(target_json,?),last_connection_status=?,last_connection_error=?,last_opened_at=? WHERE host_id=?",
    ).run(
      JSON.stringify(entry.target),
      entry.lastConnectionStatus,
      entry.lastConnectionError ?? null,
      entry.lastOpenedAt,
      hostId,
    );
    db.prepare(`INSERT INTO remote_project_entries(entry_id,host_id,cached_name,cached_roots_json,legacy_workspace_json)
      VALUES(?,?,?,?,?)`).run(
      randomUUID(),
      hostId,
      rootName(entry.workspacePath),
      JSON.stringify([{ rootPath: entry.workspacePath, position: 0, isPrimary: true }]),
      JSON.stringify(entry),
    );
  }
  // Bug 原因：桌面控制的旧版远程工作区清单只存在控制端 setting.json（kind=remote），
  // 远端 Source Server 自己的 lastWorkspaceSession 为空；只按 settings 建项目会让远端建出 0 个项目，
  // 旧会话全部定为未归类，而远端未归类会话不进侧栏，升级后选原目录只能新建空项目。
  // 远端项目只经本机入口进入桌面侧栏，按历史任务目录建项目不会复活已移除入口；
  // 系统对话目录（含 settings 标为 conversation 的目录）与仅剩已删任务的目录除外。
  if (remoteOwner && tableExists(db, "tasks")) {
    const conversations = new Set(
      (settings?.lastWorkspaceSession ?? []).flatMap((entry) =>
        entry.workspacePurpose === "conversation" ? [entry.workspacePath] : [],
      ),
    );
    for (const row of db
      .prepare(
        `SELECT root_path FROM tasks WHERE host_id=? AND project_id IS NULL AND deleted=0
          AND replace(root_path, char(92), '/') NOT GLOB '*/.zcode/workspace/*'
          GROUP BY root_path ORDER BY max(updated_at) DESC, root_path`,
      )
      .all(context.hostId!) as { root_path: string }[]) {
      if (!workspaces.has(row.root_path) && !conversations.has(row.root_path))
        workspaces.set(row.root_path, { path: row.root_path, hostId: context.hostId! });
    }
  }
  for (const row of db
    .prepare("SELECT host_id FROM hosts WHERE target_json IS NOT NULL AND membership_id IS NULL")
    .all()) {
    db.prepare("UPDATE hosts SET membership_id=? WHERE host_id=?").run(
      randomUUID(),
      String(row.host_id),
    );
  }
  for (const [key, workspace] of workspaces) {
    const projectId = createProject(
      db,
      workspace.hostId,
      rootName(workspace.path),
      [workspace.path],
      false,
      now,
    );
    if (tableExists(db, "tasks"))
      db.prepare("UPDATE tasks SET project_id=? WHERE workspace_key=?").run(projectId, key);
  }
  // 分组与项目独立；升级只按 workspace 建项目，不能再改写分组成员的项目归属。
  if (tableExists(db, "tasks")) {
    for (const row of db
      .prepare("SELECT workspace_key,task_id,host_id,root_path FROM tasks WHERE project_id IS NULL")
      .all() as { workspace_key: string; task_id: string; host_id: string; root_path: string }[]) {
      db.prepare("UPDATE tasks SET project_id=? WHERE workspace_key=? AND task_id=?").run(
        uniqueRootProject(db, row.host_id, row.root_path),
        row.workspace_key,
        row.task_id,
      );
    }
    db.exec(`UPDATE tasks SET handoff_pending=handoff_pending | ${OWNERSHIP_DECIDED}`);
    const duplicate = db
      .prepare(
        "SELECT host_id,task_id,count(*) AS count FROM tasks GROUP BY host_id,task_id HAVING count(*)>1 LIMIT 1",
      )
      .get();
    db.exec(
      `CREATE ${duplicate ? "" : "UNIQUE "}INDEX IF NOT EXISTS idx_tasks_host_task ON tasks(host_id,task_id)`,
    );
    if (duplicate) context.warn?.("历史 task ID 存在冲突，host/task 索引暂用非唯一索引", duplicate);
  }
  for (const table of ["automations", "off_peak_tasks"]) {
    if (!tableExists(db, table)) continue;
    for (const row of db
      .prepare(`SELECT DISTINCT workspace_key,workspace_path FROM ${table}`)
      .all() as {
      workspace_key: string;
      workspace_path: string;
    }[]) {
      const hostId = context.hostId ?? hostForWorkspace(row.workspace_key).hostId;
      // 远端身份 key 与 settings 的真实目录不同；调度定义也按同 Host 的 root 归入已保存项目。
      db.prepare(
        `UPDATE ${table} SET host_id=?,project_id=?,additional_directories='[]' WHERE workspace_key=?`,
      ).run(hostId, uniqueRootProject(db, hostId, row.workspace_path), row.workspace_key);
    }
  }
}
