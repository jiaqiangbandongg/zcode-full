import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  SESSION_TASK_TYPES,
  type ClaimLegacySessionWorkspaceInput,
  type CreateSessionInput,
  type FileDiff,
  type ListSessionsInput,
  type RepairLegacyRemoteSessionWorkspaceInput,
  type RepairRemoteSessionPathsInput,
  type SessionId,
  type SessionInfo,
  type SessionRevert,
  type UpdateSessionInput,
  type SessionTaskType,
} from "@zcode/contracts";
import { decodeSessionRow } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { SessionRow } from "../rows.js";

export function createSession(
  db: DatabaseSync,
  input: CreateSessionInput,
): SessionInfo {
  const now = Date.now();
  const timeCreated = input.time?.created ?? now;
  const timeUpdated = input.time?.updated ?? timeCreated;

  db
    .prepare(
      `
      insert into session (
        id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
        title, title_source, title_message_id, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, time_title_updated,
        time_compacting, time_archived
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, ?, ?, ?, ?, null, null)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        parent_id = excluded.parent_id,
        trace_id = coalesce(session.trace_id, excluded.trace_id),
        task_type = excluded.task_type,
        slug = excluded.slug,
        directory = excluded.directory,
        path = excluded.path,
        title = excluded.title,
        title_source = excluded.title_source,
        title_message_id = excluded.title_message_id,
        version = excluded.version,
        share_url = excluded.share_url,
        permission = coalesce(excluded.permission, session.permission),
        time_title_updated = excluded.time_title_updated,
        time_updated = excluded.time_updated
      `,
    )
    .run(
      input.id,
      input.projectID,
      input.workspaceID ?? null,
      input.parentID ?? null,
      input.traceID ?? null,
      input.taskType ?? "interactive",
      input.slug,
      input.directory,
      input.path ?? null,
      input.title,
      input.titleSource ?? "first_input",
      input.titleMessageID ?? null,
      input.version,
      input.shareURL ?? null,
      encodeJson(input.permission),
      timeCreated,
      timeUpdated,
      input.titleSource || input.titleMessageID ? timeUpdated : null,
    );

  return mustGetSession(db, input.id);
}

export async function updateSession(
  db: DatabaseSync,
  input: UpdateSessionInput,
): Promise<SessionInfo> {
  const current = await getSession(db, input.id);
  if (!current) {
    throw new Error(`Session not found: ${input.id}`);
  }

  const summary =
    input.summary === undefined
      ? {
          additions: current.summaryAdditions,
          deletions: current.summaryDeletions,
          files: current.summaryFiles,
          diffs: current.summaryDiffs,
        }
      : input.summary;
  const now = Date.now();
  if (
    input.title !== undefined &&
    input.expectedTitleSources &&
    input.expectedTitleSources.length > 0 &&
    !input.expectedTitleSources.includes(current.titleSource ?? "first_input")
  ) {
    return current;
  }
  const titleChanged = input.title !== undefined && input.title !== current.title;
  const nextTitleSource = input.titleSource ?? current.titleSource ?? "first_input";

  db
    .prepare(
      `
      update session set
        directory = ?,
        path = ?,
        title = ?,
        title_source = ?,
        title_message_id = ?,
        share_url = ?,
        summary_additions = ?,
        summary_deletions = ?,
        summary_files = ?,
        summary_diffs = ?,
        revert = ?,
        permission = ?,
        time_title_updated = ?,
        time_compacting = ?,
        time_archived = ?,
        -- 修复原因：路径自愈可能携带并发读取前的旧时间，不能回退真实活动时间。
        time_updated = max(time_updated, ?)
      where id = ?
      `,
    )
    .run(
      input.directory ?? current.directory,
      input.path === undefined ? (current.path ?? null) : input.path,
      input.title ?? current.title,
      nextTitleSource,
      input.titleMessageID === undefined
        ? (current.titleMessageID ?? null)
        : input.titleMessageID,
      input.shareURL === undefined ? (current.shareURL ?? null) : input.shareURL,
      summary === null ? null : (summary.additions ?? null),
      summary === null ? null : (summary.deletions ?? null),
      summary === null ? null : (summary.files ?? null),
      summary === null ? null : encodeJson(summary.diffs),
      input.revert === undefined ? encodeJson(current.revert) : encodeJson(input.revert),
      input.permission === undefined ? encodeJson(current.permission) : encodeJson(input.permission),
      titleChanged || input.titleSource !== undefined || input.titleMessageID !== undefined
        ? now
        : (current.time.titleUpdated ?? null),
      input.timeCompacting === undefined ? (current.time.compacting ?? null) : input.timeCompacting,
      input.timeArchived === undefined ? (current.time.archived ?? null) : input.timeArchived,
      input.timeUpdated ?? now,
      input.id,
    );

  return mustGetSession(db, input.id);
}

export function getSession(
  db: DatabaseSync,
  sessionID: SessionId,
): SessionInfo | null {
  const row = db.prepare("select * from session where id = ?").get(sessionID) as
    | SessionRow
    | undefined;
  return row ? decodeSessionRow(row) : null;
}

export async function listSessions(
  db: DatabaseSync,
  input: ListSessionsInput = {},
): Promise<SessionInfo[]> {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];

  if (input.projectID) {
    clauses.push("project_id = ?");
    values.push(input.projectID);
  }

  if (input.workspaceID !== undefined) {
    if (input.workspaceID === null) {
      clauses.push("workspace_id is null");
    } else {
      clauses.push("workspace_id = ?");
      values.push(input.workspaceID);
    }
  }

  if (input.directory) {
    clauses.push("directory = ?");
    values.push(input.directory);
  }

  if (input.path !== undefined) {
    if (input.path.length === 0) {
      clauses.push("(path is null or path = '')");
    } else {
      clauses.push("(path = ? or path like ?)");
      values.push(input.path, `${input.path}/%`);
    }
  }

  if (input.roots) {
    clauses.push("parent_id is null");
  }

  const taskTypes = normalizeSessionTaskTypes(input.taskTypes);
  if (taskTypes.length > 0) {
    clauses.push(`task_type in (${taskTypes.map(() => "?").join(", ")})`);
    values.push(...taskTypes);
  }

  if (!input.includeArchived) {
    clauses.push("time_archived is null");
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const limitValue = input.limit && input.limit > 0 ? input.limit : undefined;
  const limit = limitValue === undefined ? "" : " limit ?";
  if (limitValue !== undefined) {
    values.push(limitValue);
  }
  const rows = db
    .prepare(`select * from session ${where} order by time_updated desc, id desc${limit}`)
    .all(...values) as unknown as SessionRow[];
  return rows.map(decodeSessionRow);
}

export function claimLegacySessionWorkspace(
  db: DatabaseSync,
  input: ClaimLegacySessionWorkspaceInput,
): number {
  const sessionIDs = [...new Set(input.sessionIDs)];
  if (sessionIDs.length === 0) return 0;
  // 3.3.6 的 SSH/WSL session 没有 workspace_id，3.4 sessions-index 又按完整
  // identity 严格查询，升级后历史任务全部不可见。这里只认 host tasks-index 给出的精确
  // taskId allowlist，并叠加实际目录和 NULL identity，不能退化成按路径批量认领。
  const result = db
    .prepare(
      `update session
       set workspace_id = ?
       where workspace_id is null
         and directory = ?
         and id in (${sessionIDs.map(() => "?").join(", ")})`,
    )
    .run(input.workspaceID, input.directory, ...sessionIDs);
  return Number(result.changes);
}

export function repairLegacyRemoteSessionWorkspace(
  db: DatabaseSync,
  input: RepairLegacyRemoteSessionWorkspaceInput,
): boolean {
  // 3.4.2 把 WSL identity 当成执行路径，生产路径还可能先被 path.resolve
  // 拼到真实 cwd 后落库。只按单 session 和完整旧目录精确迁移，禁止模糊搜索或批量认领。
  const result = db
    .prepare(
      `update session
       set project_id = ?, workspace_id = ?, directory = ?, path = ?
       where id = ?
         and workspace_id is null
         and directory = ?
         and (path is null or path = ?)`,
    )
    .run(
      input.projectID,
      input.workspaceID,
      input.workspacePath,
      input.workspacePath,
      input.sessionID,
      input.legacyWorkspaceDirectory,
      input.legacyWorkspaceDirectory,
    );
  return Number(result.changes) === 1;
}

export function repairRemoteSessionPaths(
  db: DatabaseSync,
  input: RepairRemoteSessionPathsInput,
): boolean {
  // 路径自愈曾复用全字段 updateSession，把读取快照中的标题、权限、回滚和
  // 归档状态覆盖到并发新值上。维护性迁移只能拥有路径字段，并用旧路径做 CAS。
  const result = db
    .prepare(
      `update session
       set directory = ?, path = ?, time_updated = max(time_updated, ?)
       where id = ?
         and workspace_id = ?
         and directory = ?
         and ((? is null and path is null) or path = ?)`,
    )
    .run(
      input.directory,
      input.path,
      input.timeUpdated,
      input.sessionID,
      input.workspaceID,
      input.expectedDirectory,
      input.expectedPath,
      input.expectedPath,
    );
  return Number(result.changes) === 1;
}

export async function setRevert(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  },
): Promise<void> {
  await updateSession(db, {
    id: input.sessionID,
    revert: input.revert,
    summary: input.summary
      ? {
          additions: input.summary.additions,
          deletions: input.summary.deletions,
          files: input.summary.files,
          diffs: input.summary.diffs,
        }
      : undefined,
  });
}

export async function clearRevert(db: DatabaseSync, sessionID: SessionId): Promise<void> {
  await updateSession(db, {
    id: sessionID,
    revert: null,
    summary: null,
  });
}

export function touchSession(db: DatabaseSync, sessionID: SessionId, timeUpdated: number): void {
  db
    .prepare("update session set time_updated = max(time_updated, ?) where id = ?")
    .run(timeUpdated, sessionID);
}

function normalizeSessionTaskTypes(taskTypes: readonly SessionTaskType[] | undefined): string[] {
  if (!taskTypes || taskTypes.length === 0) return [];
  const valid = new Set<string>(SESSION_TASK_TYPES);
  return [...new Set(taskTypes.filter((taskType) => valid.has(taskType)))];
}

function mustGetSession(db: DatabaseSync, sessionID: SessionId): SessionInfo {
  const session = getSession(db, sessionID);
  if (!session) {
    throw new Error(`Session not found after write: ${sessionID}`);
  }
  return session;
}
