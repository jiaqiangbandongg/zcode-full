import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { cancelConflictingOffPeakBindings } from "#src/session/offPeakWorkspaceIdentityMigration.js";
import { runSessionDatabaseIdentityMigration } from "@zcode/shared/sqlite-migrations";
/* eslint-disable max-lines -- R3 canonical alias、双库备份、ledger 与幂等合并属于同一迁移事务边界。 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE,
  WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE,
  WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
  WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE,
  type SourceServerMigrationReport,
  type SourceServerMigrationReportRow,
} from "@zcode/shared";
import { getDataBaseDir, getTasksIndexDatabasePath, getWorkspaceHash } from "#src/paths.js";

type Database = InstanceType<typeof DatabaseSync>;
const require = createRequire(import.meta.url);
const { backup, DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface SourceServerWorkspaceAliasRepoOptions {
  taskDbPath?: string;
  sessionDbPath?: string;
  backupRoot?: string;
  now?: () => number;
  migrationId?: () => string;
  afterPhaseCommitted?: (phase: WorkspaceMigrationPhase) => Promise<void> | void;
}

export const WORKSPACE_MIGRATION_PHASES = [
  "preflight",
  "backups-created",
  "task-db-merged",
  "session-db-merged",
  "config-dirs-merged",
  "alias-published",
  "completed",
] as const;

export type WorkspaceMigrationPhase = (typeof WORKSPACE_MIGRATION_PHASES)[number];

function hasReachedMigrationPhase(
  current: WorkspaceMigrationPhase,
  target: WorkspaceMigrationPhase,
): boolean {
  return WORKSPACE_MIGRATION_PHASES.indexOf(current) >= WORKSPACE_MIGRATION_PHASES.indexOf(target);
}

function parseMigrationPhase(value: string): WorkspaceMigrationPhase | null {
  return WORKSPACE_MIGRATION_PHASES.includes(value as WorkspaceMigrationPhase)
    ? (value as WorkspaceMigrationPhase)
    : null;
}

export interface ResolveCanonicalWorkspaceKeyInput {
  workspacePath: string;
  legacyRouteHint?: string;
}

export interface ResolveCanonicalWorkspaceKeyResult {
  canonicalKey: string;
  mergedKeys: string[];
  migrationId?: string;
}

export class SourceServerWorkspaceIdentityConflictError extends Error {
  public readonly code = WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly conflicts: WorkspaceTaskIdentityConflict[] = [],
  ) {
    super(`Source Server workspace task identity conflict: ${workspacePath}`);
    this.name = "SourceServerWorkspaceIdentityConflictError";
  }
}

export class SourceServerWorkspaceConfigConflictError extends Error {
  public readonly code = WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly relativePath: string,
    public readonly sourceKey: string,
  ) {
    super(`Source Server workspace config conflict: ${workspacePath} (${relativePath})`);
    this.name = "SourceServerWorkspaceConfigConflictError";
  }
}

export class SourceServerWorkspaceMigrationPlanDivergedError extends Error {
  public readonly code = WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly newVariants: string[],
  ) {
    super(`Source Server workspace migration plan diverged: ${workspacePath}`);
    this.name = "SourceServerWorkspaceMigrationPlanDivergedError";
  }
}

export class SourceServerWorkspaceSessionGenerationChangedError extends Error {
  public readonly code = WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE;
  public readonly retryable = false;

  public constructor(workspacePath: string) {
    super(`Source Server workspace session database generation changed: ${workspacePath}`);
    this.name = "SourceServerWorkspaceSessionGenerationChangedError";
  }
}

interface WorkspaceActivityRow {
  workspace_key: string;
  last_active_at: number;
}

interface WorkspaceTaskIdentityConflict {
  taskId: string;
  sourceKey: string;
}

type WorkspaceActivityDigestVersion = 1 | 2;

interface WorkspaceActivityDigestBaseline {
  version: WorkspaceActivityDigestVersion;
  digests: Record<string, string>;
}

type SessionConfigEntries = Map<string, { kind: "directory" } | { kind: "file"; content: Buffer }>;

const WORKSPACE_PATH_TABLES = [
  "tasks",
  "task_group_members",
  "automations",
  "off_peak_tasks",
] as const;
const MAX_FOLLOW_UP_MIGRATIONS = 3;

interface ActiveWorkspaceMigration {
  migrationId: string;
  canonicalKey: string;
  variants: string[];
  phase: WorkspaceMigrationPhase;
  taskBackupPath: string;
  sessionBackupPath: string | null;
  sessionDatabaseGeneration: string | null;
}

function isLegacyRemoteKey(value: string): boolean {
  return (
    isRemoteWorkspaceIdentity(value) &&
    (value.startsWith("remote:ssh:") ||
      value.startsWith("remote:wsl:") ||
      value.startsWith("remote:docker:"))
  );
}

function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  ).some((row) => row.name === column);
}

function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return db;
}

function rollbackQuietly(db: Database): void {
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch {
    // SQLite 可能已自动回滚，或清理也遇到 IO 故障；不能用二次错误覆盖原始迁移错误。
  }
}

const TASK_IDENTITY_META_FIELDS = [
  ["cronAutomationId", "cron_automation_id"],
  ["offPeakTaskId", "off_peak_task_id"],
  ["forkedFromTaskId", "forked_from_task_id"],
] as const;

interface TaskCliFactsRow {
  cli_title: string | null;
  cli_title_source: string | null;
  cli_created_at: number | null;
  cli_updated_at: number | null;
  cli_last_outcome: string | null;
  cli_deleted: number | null;
  handoff_pending: number;
}

/**
 * Bug 原因：项目化索引从 cli_* 列投影标题、时间与状态；只合并旧列会在删除 source 后丢失
 * 其中较新的 CLI 事实。沿用 TaskIndexRepo.applyCliFacts 的规则：时间取最早/最晚，
 * 较新 outcome 为空时保留旧值，custom 标题不被非 custom 覆盖，待交接标记取并集。
 */
function mergeTaskCliFacts(newer: TaskCliFactsRow, older: TaskCliFactsRow): TaskCliFactsRow {
  const title =
    older.cli_title_source === "custom" && newer.cli_title_source !== "custom" ? older : newer;
  const times = (key: "cli_created_at" | "cli_updated_at") =>
    [newer[key], older[key]].filter((value): value is number => value !== null);
  const created = times("cli_created_at");
  const updated = times("cli_updated_at");
  return {
    cli_title: title.cli_title,
    cli_title_source: title.cli_title_source,
    cli_created_at: created.length ? Math.min(...created) : null,
    cli_updated_at: updated.length ? Math.max(...updated) : null,
    cli_last_outcome: newer.cli_last_outcome ?? older.cli_last_outcome,
    cli_deleted:
      newer.cli_deleted === null && older.cli_deleted === null
        ? null
        : Math.max(newer.cli_deleted ?? 0, older.cli_deleted ?? 0),
    handoff_pending: newer.handoff_pending | older.handoff_pending,
  };
}

interface WorkspaceTaskMetaRow {
  meta_json: string;
  updated_at: number;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  forked_from_task_id: string | null;
}

function parseMetaRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mergeTaskMetaJson(
  canonical: WorkspaceTaskMetaRow,
  source: WorkspaceTaskMetaRow,
  canonicalKey: string,
): { status: "merged"; metaJson: string } | { status: "identity-conflict" } {
  const canonicalMeta = parseMetaRecord(canonical.meta_json);
  const sourceMeta = parseMetaRecord(source.meta_json);
  // Bug 原因：历史身份可能只回填索引列，相同 JSON 也可能对应不同身份。
  // 与 TaskIndexRepo 读取一致，先补齐有效身份，再由预检和写事务共用同一冲突规则。
  for (const [key, column] of TASK_IDENTITY_META_FIELDS) {
    const canonicalValue = canonicalMeta?.[key] ?? canonical[column] ?? undefined;
    const sourceValue = sourceMeta?.[key] ?? source[column] ?? undefined;
    if (
      canonicalValue !== undefined &&
      sourceValue !== undefined &&
      canonicalValue !== sourceValue
    ) {
      return { status: "identity-conflict" };
    }
    if (canonicalMeta && canonicalValue !== undefined) canonicalMeta[key] = canonicalValue;
    if (sourceMeta && sourceValue !== undefined) sourceMeta[key] = sourceValue;
  }
  if (!canonicalMeta || !sourceMeta) {
    return canonical.meta_json === source.meta_json
      ? { status: "merged", metaJson: canonical.meta_json }
      : { status: "identity-conflict" };
  }
  const [older, newer] =
    canonical.updated_at <= source.updated_at
      ? [canonicalMeta, sourceMeta]
      : [sourceMeta, canonicalMeta];
  const merged = { ...older, ...newer };
  if ("workspaceIdentity" in merged) merged.workspaceIdentity = canonicalKey;
  return { status: "merged", metaJson: JSON.stringify(merged) };
}

export class SourceServerWorkspaceAliasRepo {
  private readonly taskDbPath: string;
  private readonly sessionDbPath: string;
  private readonly backupRoot: string;
  private readonly now: () => number;
  private readonly createMigrationId: () => string;
  private readonly afterPhaseCommitted?: SourceServerWorkspaceAliasRepoOptions["afterPhaseCommitted"];
  private readonly workspaceOperations = new Map<string, Promise<void>>();

  public constructor(options: SourceServerWorkspaceAliasRepoOptions = {}) {
    this.taskDbPath = options.taskDbPath ?? getTasksIndexDatabasePath();
    this.sessionDbPath =
      options.sessionDbPath ?? join(getDataBaseDir(), ".zcode", "cli", "db", "db.sqlite");
    this.backupRoot =
      options.backupRoot ?? join(getDataBaseDir(), ".zcode", "server", "migration-backups");
    this.now = options.now ?? Date.now;
    this.createMigrationId = options.migrationId ?? randomUUID;
    this.afterPhaseCommitted = options.afterPhaseCommitted;
  }

  public async resolveCanonicalWorkspaceKey(
    input: ResolveCanonicalWorkspaceKeyInput,
    options: { ignoreAbandoned?: boolean } = {},
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    return await this.runWorkspaceOperation(input.workspacePath, (workspacePath) =>
      this.resolveCanonicalWorkspaceKeyInternal({ ...input, workspacePath }, options),
    );
  }

  private async runWorkspaceOperation<T>(
    rawWorkspacePath: string,
    operation: (workspacePath: string) => Promise<T>,
  ): Promise<T> {
    const workspacePath = rawWorkspacePath.trim();
    if (!workspacePath) throw new Error("workspacePath is required");
    // Bug 原因：alias/ledger 读取后的异步 IO 会让同路径解析交错，返回不同 canonical，
    // 甚至重复搬运配置目录。三个修改入口按规范化路径串行，覆盖读取、提交和连接关闭。
    const previous = this.workspaceOperations.get(workspacePath) ?? Promise.resolve();
    const result = previous.then(() => operation(workspacePath));
    // 失败仍返回给当前调用方；队列继续消费下一项，让其从已提交的 ledger 恢复。
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceOperations.set(workspacePath, settled);
    try {
      return await result;
    } finally {
      if (this.workspaceOperations.get(workspacePath) === settled) {
        this.workspaceOperations.delete(workspacePath);
      }
    }
  }

  private async resolveCanonicalWorkspaceKeyInternal(
    input: ResolveCanonicalWorkspaceKeyInput,
    options: { ignoreAbandoned?: boolean } = {},
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    const { workspacePath } = input;
    await mkdir(join(this.taskDbPath, ".."), { recursive: true }).catch(() => undefined);
    const taskDb = openDatabase(this.taskDbPath);
    let sessionDb: Database | null = null;
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
      const activeMigration = this.readActiveMigration(taskDb, workspacePath);
      const sessionDatabaseExists = await stat(this.sessionDbPath).then(
        (value) => value.isFile(),
        () => false,
      );
      if (activeMigration?.sessionBackupPath && !sessionDatabaseExists) {
        this.failActiveMigration(
          taskDb,
          activeMigration.migrationId,
          WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
        );
        throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
      }
      if (sessionDatabaseExists) {
        sessionDb = openDatabase(this.sessionDbPath);
      }
      if (activeMigration?.sessionBackupPath && sessionDb) {
        let currentGeneration = this.readSessionDatabaseGeneration(sessionDb);
        if (
          activeMigration.sessionDatabaseGeneration &&
          !currentGeneration &&
          activeMigration.phase === "preflight"
        ) {
          currentGeneration = this.ensureSessionDatabaseGeneration(
            sessionDb,
            activeMigration.sessionDatabaseGeneration,
          );
        }
        if (!activeMigration.sessionDatabaseGeneration) {
          if (activeMigration.phase === "preflight") {
            currentGeneration = this.ensureSessionDatabaseGeneration(sessionDb);
          } else {
            currentGeneration = await this.adoptLegacySessionDatabaseGeneration(
              sessionDb,
              workspacePath,
              activeMigration,
            );
          }
          if (currentGeneration) {
            activeMigration.sessionDatabaseGeneration = currentGeneration;
            taskDb
              .prepare(
                "UPDATE workspace_migration_ledger SET session_db_generation = ?, updated_at = ? WHERE migration_id = ?",
              )
              .run(currentGeneration, this.now(), activeMigration.migrationId);
          }
        }
        if (
          !activeMigration.sessionDatabaseGeneration ||
          currentGeneration !== activeMigration.sessionDatabaseGeneration
        ) {
          this.failActiveMigration(
            taskDb,
            activeMigration.migrationId,
            WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
          );
          throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
        }
      }
      if (activeMigration && sessionDb && !activeMigration.sessionBackupPath) {
        if (this.hasSessionDatabaseOwnedState(sessionDb, workspacePath, activeMigration.variants)) {
          // Bug 原因：plan 冻结时没有 session DB，恢复期间新出现的空库不应被误杀；
          // 只有新代际已经承载本 workspace/variant 数据时，才无法证明可安全并入。
          this.failActiveMigration(
            taskDb,
            activeMigration.migrationId,
            WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
          );
          throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
        }
        // frozen plan 没有 session backup 且新库不含 owned state：显式排除该 generation，
        // 后续阶段不得依赖“UPDATE 恰好匹配不到行”来维持无副作用。
        sessionDb.close();
        sessionDb = null;
      }
      // frozen plan 明确排除的晚到空库保持不变；只接管本次实际参与解析/合并的库。
      if (sessionDb) runSessionDatabaseIdentityMigration(sessionDb);
      if (activeMigration) {
        // Bug 原因：task DB 已提交、session DB 尚未提交时重新扫描活跃度会反向选主，
        // 甚至创建第二条 migration。活动 ledger 是恢复 owner，计划必须原样续跑。
        return await this.runMigrationPlan({
          taskDb,
          sessionDb,
          workspacePath,
          migration: activeMigration,
        });
      }
      const abandonedMigration = options.ignoreAbandoned
        ? null
        : this.readLatestAbandonedMigration(taskDb, workspacePath);
      if (abandonedMigration) {
        // Bug 原因：放弃合并只写 alias，但旧入口仍因遗留 variant 再次进入 mergeVariants，
        // 于是同一冲突会立刻阻塞重开并创建第二条 ledger。abandoned 是用户明确选择的
        // 冻结 canonical；只有 retryFailedWorkspace 显式清除 abandoned 后才允许重新合并。
        return { canonicalKey: abandonedMigration.canonicalKey, mergedKeys: [] };
      }
      const existing = taskDb
        .prepare("SELECT canonical_key FROM workspace_alias WHERE path = ?")
        .get(workspacePath) as { canonical_key: string } | undefined;
      const variants = this.findVariants(taskDb, sessionDb, workspacePath);
      const legacyRouteHint = input.legacyRouteHint?.trim();
      if (
        legacyRouteHint &&
        isLegacyRemoteKey(legacyRouteHint) &&
        !variants.includes(legacyRouteHint) &&
        (await this.hasWorkspaceOwnedStateForHint(taskDb, workspacePath, legacyRouteHint))
      ) {
        variants.push(legacyRouteHint);
        variants.sort();
      }
      if (existing) {
        const mergedKeys = variants.filter((key) => key !== existing.canonical_key);
        if (mergedKeys.length === 0) {
          this.markFailedPathResolved(taskDb, workspacePath);
          return { canonicalKey: existing.canonical_key, mergedKeys: [] };
        }
        return await this.mergeVariants({
          taskDb,
          sessionDb,
          workspacePath,
          canonicalKey: existing.canonical_key,
          variants: [existing.canonical_key, ...mergedKeys],
          mergedKeys,
        });
      }
      if (variants.length === 0) {
        const hint = input.legacyRouteHint?.trim();
        // 新 URL Server 没有旧 SSH 路由；仅初次无历史绑定可使用稳定 server identity。
        // 已有 alias 与历史 variants 的裁决顺序保持不变，避免改变 CLI 配置目录。
        if (!hint || !isRemoteWorkspaceIdentity(hint)) {
          throw new Error("A legacyRouteHint is required for a new Source Server workspace");
        }
        this.writeAlias(taskDb, workspacePath, hint);
        this.markFailedPathResolved(taskDb, workspacePath);
        return { canonicalKey: hint, mergedKeys: [] };
      }
      if (variants.length === 1) {
        const canonicalKey = variants[0]!;
        this.writeAlias(taskDb, workspacePath, canonicalKey);
        this.markFailedPathResolved(taskDb, workspacePath);
        return { canonicalKey, mergedKeys: [] };
      }

      const canonicalKey = this.chooseCanonicalKey(taskDb, sessionDb, workspacePath, variants);
      const mergedKeys = variants.filter((key) => key !== canonicalKey);
      return await this.mergeVariants({
        taskDb,
        sessionDb,
        workspacePath,
        canonicalKey,
        variants,
        mergedKeys,
      });
    } finally {
      sessionDb?.close();
      taskDb.close();
    }
  }

  private async mergeVariants(input: {
    taskDb: Database;
    sessionDb: Database | null;
    workspacePath: string;
    canonicalKey: string;
    variants: string[];
    mergedKeys: string[];
    followUpDepth?: number;
  }): Promise<ResolveCanonicalWorkspaceKeyResult> {
    const {
      taskDb,
      sessionDb,
      workspacePath,
      canonicalKey,
      variants,
      mergedKeys,
      followUpDepth = 0,
    } = input;
    const identityConflicts = this.findTaskIdentityConflicts(
      taskDb,
      workspacePath,
      canonicalKey,
      mergedKeys,
    );
    if (identityConflicts.length > 0) {
      this.recordTaskIdentityConflicts(taskDb, {
        workspacePath,
        canonicalKey,
        variants,
        conflicts: identityConflicts,
      });
      throw new SourceServerWorkspaceIdentityConflictError(workspacePath);
    }
    try {
      await this.assertSessionConfigDirectoriesMergeable(workspacePath, canonicalKey, mergedKeys);
    } catch (error) {
      if (error instanceof SourceServerWorkspaceConfigConflictError) {
        this.recordConfigConflict(taskDb, {
          workspacePath,
          canonicalKey,
          variants,
          conflict: error,
        });
      }
      throw error;
    }
    const migrationId = this.createMigrationId();
    const migrationDir = join(this.backupRoot, migrationId);
    const taskBackupPath = join(migrationDir, "tasks-index.sqlite");
    const sessionBackupPath = sessionDb ? join(migrationDir, "db.sqlite") : null;
    const sessionDatabaseGeneration = sessionDb
      ? (this.readSessionDatabaseGeneration(sessionDb) ?? randomUUID())
      : null;
    this.writeLedger(taskDb, {
      migrationId,
      workspacePath,
      canonicalKey,
      variants,
      status: "running",
      taskBackupPath,
      sessionBackupPath,
      sessionDatabaseGeneration,
    });
    try {
      if (sessionDb && sessionDatabaseGeneration) {
        // 先持久化 frozen ledger，再给 session DB 写 identity；中途崩溃时 preflight
        // resume 可按 ledger 中的期望 generation 幂等补写，不留下无 owner 的数据库变更。
        this.ensureSessionDatabaseGeneration(sessionDb, sessionDatabaseGeneration);
      }
      await this.afterPhaseCommitted?.("preflight");
    } catch (error) {
      taskDb
        .prepare(
          "UPDATE workspace_migration_ledger SET status = 'failed', error = ?, updated_at = ? WHERE migration_id = ?",
        )
        .run(
          error instanceof Error ? error.message.slice(0, 1_000) : String(error),
          this.now(),
          migrationId,
        );
      throw error;
    }
    return await this.runMigrationPlan({
      taskDb,
      sessionDb,
      workspacePath,
      migration: {
        migrationId,
        canonicalKey,
        variants,
        phase: "preflight",
        taskBackupPath,
        sessionBackupPath,
        sessionDatabaseGeneration,
      },
      followUpDepth,
    });
  }

  private readActiveMigration(
    db: Database,
    workspacePath: string,
  ): ActiveWorkspaceMigration | null {
    const row = db
      .prepare(`
        SELECT migration_id, canonical_key, variant_keys_json, phase,
               task_backup_path, session_backup_path, session_db_generation
        FROM workspace_migration_ledger
        WHERE path = ? AND status IN ('running', 'failed') AND phase IS NOT NULL
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(workspacePath) as
      | {
          migration_id: string;
          canonical_key: string;
          variant_keys_json: string;
          phase: string;
          task_backup_path: string;
          session_backup_path: string | null;
          session_db_generation: string | null;
        }
      | undefined;
    if (!row) return null;
    const phase = parseMigrationPhase(row.phase);
    let variants: unknown;
    try {
      variants = JSON.parse(row.variant_keys_json);
    } catch {
      variants = null;
    }
    if (
      !phase ||
      !Array.isArray(variants) ||
      variants.some((value) => typeof value !== "string") ||
      !variants.includes(row.canonical_key)
    ) {
      throw new Error(`Invalid active Source Server migration ledger: ${row.migration_id}`);
    }
    return {
      migrationId: row.migration_id,
      canonicalKey: row.canonical_key,
      variants,
      phase,
      taskBackupPath: row.task_backup_path,
      sessionBackupPath: row.session_backup_path,
      sessionDatabaseGeneration: row.session_db_generation,
    };
  }

  private readLatestAbandonedMigration(
    db: Database,
    workspacePath: string,
  ): { canonicalKey: string } | null {
    const row = db
      .prepare(`
        SELECT canonical_key, status
        FROM workspace_migration_ledger
        WHERE path = ?
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(workspacePath) as
      | { canonical_key: string; status: "running" | "completed" | "failed" | "abandoned" }
      | undefined;
    return row?.status === "abandoned" ? { canonicalKey: row.canonical_key } : null;
  }

  private failActiveMigration(db: Database, migrationId: string, errorCode: string): void {
    // Bug 原因：session generation 异常过去无条件保留 phase，连尚未搬运数据的计划也无法
    // abandon。仅 preflight/backups-created 可安全释放 resume owner；post-merge 继续保留。
    db.prepare(`
      UPDATE workspace_migration_ledger
      SET status = 'failed',
          phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
          error = ?, updated_at = ?
      WHERE migration_id = ?
    `).run(errorCode, this.now(), migrationId);
  }

  private async runMigrationPlan(input: {
    taskDb: Database;
    sessionDb: Database | null;
    workspacePath: string;
    migration: ActiveWorkspaceMigration;
    followUpDepth?: number;
  }): Promise<ResolveCanonicalWorkspaceKeyResult> {
    const { taskDb, sessionDb, workspacePath, migration } = input;
    const { migrationId, canonicalKey, variants, taskBackupPath, sessionBackupPath } = migration;
    const followUpDepth = input.followUpDepth ?? 0;
    const mergedKeys = variants.filter((key) => key !== canonicalKey);
    let phase = migration.phase;
    let followUpMergedKeys: string[] = [];
    if (phase !== "completed") {
      const newVariants = this.findVariants(taskDb, sessionDb, workspacePath).filter(
        (variant) => !variants.includes(variant),
      );
      if (newVariants.length > 0 && !hasReachedMigrationPhase(phase, "task-db-merged")) {
        // Bug 原因：resume 只消费 frozen variants，新出现的身份线会被当次迁移遗漏；
        // 继续发布 alias 会返回“已完成”但结果不完整，因此必须保留原计划并显式失败。
        taskDb
          .prepare(
            `UPDATE workspace_migration_ledger
             SET status = 'failed',
                 phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
                 error = ?, updated_at = ?
             WHERE migration_id = ?`,
          )
          .run(WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE, this.now(), migrationId);
        throw new SourceServerWorkspaceMigrationPlanDivergedError(workspacePath, newVariants);
      }
      const identityConflicts = this.findTaskIdentityConflicts(
        taskDb,
        workspacePath,
        canonicalKey,
        mergedKeys,
      );
      if (identityConflicts.length > 0) {
        // Bug 原因：首次 preflight 后到恢复前仍可能出现同 taskId 的另一条身份线；旧恢复
        // 直接跳过 preflight，mergeTaskDatabase 只保留冲突 task，却继续 rekey 其余关联表并
        // 最终标 completed，形成不可解释的部分搬运第三态。恢复必须复检并复用原 ledger。
        this.recordTaskIdentityConflicts(taskDb, {
          migrationId,
          workspacePath,
          canonicalKey,
          variants,
          conflicts: identityConflicts,
        });
        throw new SourceServerWorkspaceIdentityConflictError(workspacePath);
      }
      try {
        // Bug 原因：frozen plan 首次 preflight 后仍可能新增配置；恢复若只执行旧计划，
        // DB 已搬完后才在文件移动阶段发现冲突，会留下跨介质的部分迁移。
        await this.assertSessionConfigDirectoriesMergeable(workspacePath, canonicalKey, mergedKeys);
      } catch (error) {
        if (error instanceof SourceServerWorkspaceConfigConflictError) {
          this.recordConfigConflict(taskDb, {
            migrationId,
            workspacePath,
            canonicalKey,
            variants,
            conflict: error,
          });
        }
        throw error;
      }
    }
    taskDb
      .prepare(
        "UPDATE workspace_migration_ledger SET status = 'running', error = NULL, updated_at = ? WHERE migration_id = ?",
      )
      .run(this.now(), migrationId);
    if (phase === "completed") {
      // Bug 原因：completed phase 写入成功后进程可能在返回前退出；恢复入口不能把它降回 running。
      taskDb
        .prepare(
          "UPDATE workspace_migration_ledger SET status = 'completed', error = NULL, updated_at = ? WHERE migration_id = ?",
        )
        .run(this.now(), migrationId);
    }
    try {
      if (!hasReachedMigrationPhase(phase, "backups-created")) {
        await mkdir(dirname(taskBackupPath), { recursive: true, mode: 0o700 });
        await this.ensureDatabaseBackup(taskDb, taskBackupPath);
        if (sessionBackupPath) {
          if (!sessionDb) {
            throw new Error(`Source Server session database is missing: ${this.sessionDbPath}`);
          }
          await this.ensureDatabaseBackup(sessionDb, sessionBackupPath);
        }
        phase = await this.commitMigrationPhase(taskDb, migrationId, "backups-created");
      }
      if (!hasReachedMigrationPhase(phase, "task-db-merged")) {
        this.mergeTaskDatabase(taskDb, workspacePath, canonicalKey, mergedKeys);
        phase = await this.commitMigrationPhase(taskDb, migrationId, "task-db-merged");
      }
      if (!hasReachedMigrationPhase(phase, "session-db-merged")) {
        this.mergeSessionDatabase(sessionDb, workspacePath, canonicalKey, mergedKeys);
        phase = await this.commitMigrationPhase(taskDb, migrationId, "session-db-merged");
      }
      if (!hasReachedMigrationPhase(phase, "config-dirs-merged")) {
        await this.mergeSessionConfigDirectories(workspacePath, canonicalKey, mergedKeys);
        phase = await this.commitMigrationPhase(taskDb, migrationId, "config-dirs-merged");
      }
      if (!hasReachedMigrationPhase(phase, "alias-published")) {
        this.writeAlias(taskDb, workspacePath, canonicalKey);
        phase = await this.commitMigrationPhase(taskDb, migrationId, "alias-published");
      }
      if (!hasReachedMigrationPhase(phase, "completed")) {
        phase = await this.commitMigrationPhase(taskDb, migrationId, "completed", "completed");
      }
      this.markFailedPathResolved(taskDb, workspacePath);
      followUpMergedKeys = this.findVariants(taskDb, sessionDb, workspacePath).filter(
        (variant) => variant !== canonicalKey,
      );
    } catch (error) {
      if (
        error instanceof SourceServerWorkspaceIdentityConflictError &&
        error.conflicts.length > 0
      ) {
        this.recordTaskIdentityConflicts(taskDb, {
          migrationId,
          workspacePath,
          canonicalKey,
          variants,
          conflicts: error.conflicts,
        });
        throw error;
      }
      if (error instanceof SourceServerWorkspaceConfigConflictError) {
        this.recordConfigConflict(taskDb, {
          migrationId,
          workspacePath,
          canonicalKey,
          variants,
          conflict: error,
        });
        throw error;
      }
      taskDb
        .prepare(
          "UPDATE workspace_migration_ledger SET status = 'failed', error = ?, updated_at = ? WHERE migration_id = ?",
        )
        .run(
          error instanceof Error ? error.message.slice(0, 1_000) : String(error),
          this.now(),
          migrationId,
        );
      throw error;
    }
    if (followUpMergedKeys.length > 0) {
      if (followUpDepth >= MAX_FOLLOW_UP_MIGRATIONS) {
        throw new SourceServerWorkspaceMigrationPlanDivergedError(
          workspacePath,
          followUpMergedKeys,
        );
      }
      // Bug 原因：task DB 已提交后出现的新 variant 不能清 phase/abandon，也不能让 frozen
      // plan 永久重抛。先完成原计划，再用独立 ledger/备份做增量合并，保持两次事务可审计。
      const followUp = await this.mergeVariants({
        taskDb,
        sessionDb,
        workspacePath,
        canonicalKey,
        variants: [canonicalKey, ...followUpMergedKeys],
        mergedKeys: followUpMergedKeys,
        followUpDepth: followUpDepth + 1,
      });
      return {
        ...followUp,
        mergedKeys: [...new Set([...mergedKeys, ...followUp.mergedKeys])],
      };
    }
    return { canonicalKey, mergedKeys, migrationId };
  }

  private mergeSessionDatabase(
    sessionDb: Database | null,
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): void {
    if (!sessionDb || !hasTable(sessionDb, "session") || mergedKeys.length === 0) return;
    const placeholders = mergedKeys.map(() => "?").join(", ");
    sessionDb.exec("BEGIN IMMEDIATE");
    try {
      sessionDb
        .prepare(
          `UPDATE session SET workspace_id = ?
             WHERE workspace_id IN (${placeholders})
               AND (directory = ? OR path = ?)`,
        )
        .run(canonicalKey, ...mergedKeys, workspacePath, workspacePath);
      sessionDb.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(sessionDb);
      throw error;
    }
  }

  private hasSessionDatabaseOwnedState(
    db: Database,
    workspacePath: string,
    variants: string[],
  ): boolean {
    for (const table of ["session", "sessions"]) {
      if (!hasTable(db, table)) continue;
      const workspaceColumn = ["workspace_id", "workspace_key", "workspace_identity"].find(
        (column) => hasColumn(db, table, column),
      );
      const pathColumns = ["directory", "path", "workspace_path"].filter((column) =>
        hasColumn(db, table, column),
      );
      const predicates: string[] = [];
      const values: string[] = [];
      if (workspaceColumn && variants.length > 0) {
        predicates.push(`${workspaceColumn} IN (${variants.map(() => "?").join(", ")})`);
        values.push(...variants);
      }
      for (const column of pathColumns) {
        predicates.push(`${column} = ?`);
        values.push(workspacePath);
      }
      if (
        predicates.length > 0 &&
        db.prepare(`SELECT 1 FROM ${table} WHERE ${predicates.join(" OR ")} LIMIT 1`).get(...values)
      ) {
        return true;
      }
    }
    return false;
  }

  private readSessionDatabaseGeneration(db: Database): string | null {
    if (!hasTable(db, "zcode_database_identity")) return null;
    const row = db
      .prepare("SELECT identity FROM zcode_database_identity WHERE scope = 'session' LIMIT 1")
      .get() as { identity: string } | undefined;
    return row?.identity?.trim() || null;
  }

  private async adoptLegacySessionDatabaseGeneration(
    currentDb: Database,
    workspacePath: string,
    migration: ActiveWorkspaceMigration,
  ): Promise<string | null> {
    if (!migration.sessionBackupPath || !(await this.pathExists(migration.sessionBackupPath))) {
      return null;
    }
    const backupDb = openDatabase(migration.sessionBackupPath);
    try {
      if (!hasTable(backupDb, "session") || !hasTable(currentDb, "session")) {
        return !hasTable(backupDb, "session") && !hasTable(currentDb, "session")
          ? this.persistAdoptedSessionGeneration(currentDb, backupDb)
          : null;
      }
      const backupRows = backupDb
        .prepare("SELECT id, workspace_id, directory, path, time_updated FROM session")
        .all() as unknown as Array<{
        id: string;
        workspace_id: string | null;
        directory: string;
        path: string | null;
        time_updated: number;
      }>;
      if (backupRows.length === 0) {
        return this.hasSessionDatabaseOwnedState(currentDb, workspacePath, migration.variants)
          ? null
          : this.persistAdoptedSessionGeneration(currentDb, backupDb);
      }
      const findCurrent = currentDb.prepare(
        "SELECT workspace_id, directory, path, time_updated FROM session WHERE id = ?",
      );
      const mergedKeys = new Set(
        migration.variants.filter((variant) => variant !== migration.canonicalKey),
      );
      for (const row of backupRows) {
        const current = findCurrent.get(row.id) as
          | {
              workspace_id: string | null;
              directory: string;
              path: string | null;
              time_updated: number;
            }
          | undefined;
        const belongsToWorkspace = row.directory === workspacePath || row.path === workspacePath;
        const expectedWorkspaceId =
          belongsToWorkspace &&
          hasReachedMigrationPhase(migration.phase, "session-db-merged") &&
          row.workspace_id &&
          mergedKeys.has(row.workspace_id)
            ? migration.canonicalKey
            : row.workspace_id;
        if (
          !current ||
          current.workspace_id !== expectedWorkspaceId ||
          current.directory !== row.directory ||
          current.path !== row.path ||
          current.time_updated < row.time_updated
        ) {
          return null;
        }
      }
      return this.persistAdoptedSessionGeneration(currentDb, backupDb);
    } finally {
      backupDb.close();
    }
  }

  private persistAdoptedSessionGeneration(currentDb: Database, backupDb: Database): string {
    const identity = randomUUID();
    this.ensureSessionDatabaseGeneration(backupDb, identity);
    return this.ensureSessionDatabaseGeneration(currentDb, identity);
  }

  private ensureSessionDatabaseGeneration(db: Database, identity: string = randomUUID()): string {
    // 修复原因：Repo 曾直接建表，绕过 Agent 的正式账本；复用同一 migration 接管存量表。
    runSessionDatabaseIdentityMigration(db);
    const existing = this.readSessionDatabaseGeneration(db);
    if (existing) return existing;
    db.prepare("INSERT INTO zcode_database_identity (scope, identity) VALUES ('session', ?)").run(
      identity,
    );
    return identity;
  }

  private async commitMigrationPhase(
    db: Database,
    migrationId: string,
    phase: WorkspaceMigrationPhase,
    status: "running" | "completed" = "running",
  ): Promise<WorkspaceMigrationPhase> {
    db.prepare(
      "UPDATE workspace_migration_ledger SET phase = ?, status = ?, error = NULL, updated_at = ? WHERE migration_id = ?",
    ).run(phase, status, this.now(), migrationId);
    await this.afterPhaseCommitted?.(phase);
    return phase;
  }

  private getSessionConfigDirectory(workspacePath: string, workspaceKey: string): string {
    return join(
      dirname(this.taskDbPath),
      "sessions",
      getWorkspaceHash(workspacePath, workspaceKey),
    );
  }

  private async assertSessionConfigDirectoriesMergeable(
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): Promise<void> {
    const seen = new Map<
      string,
      ({ kind: "directory" } | { kind: "file"; content: Buffer }) & { workspaceKey: string }
    >();
    for (const workspaceKey of [canonicalKey, ...mergedKeys]) {
      const entries = await this.readSessionConfigEntries(
        this.getSessionConfigDirectory(workspacePath, workspaceKey),
      );
      for (const [relativePath, entry] of entries) {
        const existing = seen.get(relativePath);
        if (!existing) {
          seen.set(relativePath, { ...entry, workspaceKey });
          continue;
        }
        const matches =
          existing.kind === entry.kind &&
          (existing.kind === "directory" ||
            (entry.kind === "file" && existing.content.equals(entry.content)));
        if (!matches) {
          throw new SourceServerWorkspaceConfigConflictError(
            workspacePath,
            relativePath,
            workspaceKey,
          );
        }
      }
    }
  }

  private async readSessionConfigEntries(
    root: string,
    relativeRoot = "",
  ): Promise<SessionConfigEntries> {
    const result: SessionConfigEntries = new Map();
    if (!(await this.pathExists(root))) return result;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const absolutePath = join(root, entry.name);
      if (entry.isDirectory()) {
        result.set(relativePath, { kind: "directory" });
        const nested = await this.readSessionConfigEntries(absolutePath, relativePath);
        for (const item of nested) result.set(...item);
        continue;
      }
      if (entry.isFile()) {
        result.set(relativePath, { kind: "file", content: await readFile(absolutePath) });
        continue;
      }
      throw new SourceServerWorkspaceConfigConflictError(root, relativePath, root);
    }
    return result;
  }

  private async readVariantConfigSnapshots(
    workspacePath: string,
    variants: string[],
  ): Promise<Map<string, SessionConfigEntries>> {
    return new Map(
      await Promise.all(
        variants.map(
          async (variant) =>
            [
              variant,
              await this.readSessionConfigEntries(
                this.getSessionConfigDirectory(workspacePath, variant),
              ),
            ] as const,
        ),
      ),
    );
  }

  private async mergeSessionConfigDirectories(
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): Promise<void> {
    const canonicalDir = this.getSessionConfigDirectory(workspacePath, canonicalKey);
    for (const sourceKey of mergedKeys) {
      const sourceDir = this.getSessionConfigDirectory(workspacePath, sourceKey);
      if (sourceDir === canonicalDir || !(await this.pathExists(sourceDir))) continue;
      if (!(await this.pathExists(canonicalDir))) {
        await mkdir(dirname(canonicalDir), { recursive: true });
        await rename(sourceDir, canonicalDir);
        continue;
      }
      await this.mergeSessionConfigDirectoryContents({
        sourceDir,
        canonicalDir,
        workspacePath,
        sourceKey,
      });
      await rm(sourceDir, { recursive: true, force: true });
    }
  }

  private async mergeSessionConfigDirectoryContents(input: {
    sourceDir: string;
    canonicalDir: string;
    workspacePath: string;
    sourceKey: string;
    relativeRoot?: string;
  }): Promise<void> {
    const { sourceDir, canonicalDir, workspacePath, sourceKey, relativeRoot = "" } = input;
    await mkdir(canonicalDir, { recursive: true });
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name);
      const canonicalPath = join(canonicalDir, entry.name);
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const canonicalStat = await stat(canonicalPath).catch(() => null);
      if (!canonicalStat) {
        await rename(sourcePath, canonicalPath);
        continue;
      }
      if (entry.isDirectory() && canonicalStat.isDirectory()) {
        await this.mergeSessionConfigDirectoryContents({
          sourceDir: sourcePath,
          canonicalDir: canonicalPath,
          workspacePath,
          sourceKey,
          relativeRoot: relativePath,
        });
        await rm(sourcePath, { recursive: true, force: true });
        continue;
      }
      if (entry.isFile() && canonicalStat.isFile()) {
        const [sourceContent, canonicalContent] = await Promise.all([
          readFile(sourcePath),
          readFile(canonicalPath),
        ]);
        if (!sourceContent.equals(canonicalContent)) {
          throw new SourceServerWorkspaceConfigConflictError(
            workspacePath,
            relativePath,
            sourceKey,
          );
        }
        await rm(sourcePath, { force: true });
        continue;
      }
      throw new SourceServerWorkspaceConfigConflictError(workspacePath, relativePath, sourceKey);
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    return await stat(path).then(
      () => true,
      () => false,
    );
  }

  private async ensureDatabaseBackup(db: Database, backupPath: string): Promise<void> {
    if (await this.pathExists(backupPath)) return;
    const temporaryPath = `${backupPath}.tmp`;
    await rm(temporaryPath, { force: true });
    await backup(db, temporaryPath);
    await rename(temporaryPath, backupPath);
  }

  public async getFailedPathCount(): Promise<number> {
    const taskDb = openDatabase(this.taskDbPath);
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
      const row = taskDb
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_migration_ledger current
           WHERE current.status = 'failed'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_migration_ledger newer
               WHERE newer.path = current.path
                 AND (newer.updated_at > current.updated_at
                   OR (newer.updated_at = current.updated_at
                     AND (newer.created_at > current.created_at
                       OR (newer.created_at = current.created_at
                         AND newer.rowid > current.rowid))))
             )`,
        )
        .get() as { count: number };
      return row.count;
    } finally {
      taskDb.close();
    }
  }

  public async getAbandonedPathCount(): Promise<number> {
    const taskDb = openDatabase(this.taskDbPath);
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
      const row = taskDb
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_migration_ledger current
           WHERE current.status = 'abandoned'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_migration_ledger newer
               WHERE newer.path = current.path
                 AND (newer.updated_at > current.updated_at
                   OR (newer.updated_at = current.updated_at
                     AND (newer.created_at > current.created_at
                       OR (newer.created_at = current.created_at
                         AND newer.rowid > current.rowid))))
             )`,
        )
        .get() as { count: number };
      return row.count;
    } finally {
      taskDb.close();
    }
  }

  public async listMigrationReports(): Promise<SourceServerMigrationReport> {
    const taskDb = openDatabase(this.taskDbPath);
    const sessionDb = await stat(this.sessionDbPath).then(
      (value) => (value.isFile() ? openDatabase(this.sessionDbPath) : null),
      () => null,
    );
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
      const ledgerRows = taskDb
        .prepare(`
          SELECT migration_id, path, canonical_key, variant_keys_json, status, phase,
                 task_backup_path, session_backup_path, error, updated_at,
                 abandoned_at, abandoned_trigger, abandoned_activity_json
          FROM workspace_migration_ledger
          ORDER BY updated_at DESC, created_at DESC, rowid DESC
        `)
        .all() as unknown as Array<{
        migration_id: string;
        path: string;
        canonical_key: string;
        variant_keys_json: string;
        status: "running" | "completed" | "failed" | "abandoned";
        phase: string | null;
        task_backup_path: string;
        session_backup_path: string | null;
        error: string | null;
        updated_at: number;
        abandoned_at: number | null;
        abandoned_trigger: string | null;
        abandoned_activity_json: string | null;
      }>;
      const readConflicts = taskDb.prepare(`
        SELECT conflict_kind, conflict_key, task_id, relative_path, source_key,
               canonical_key, reason
        FROM workspace_migration_conflicts
        WHERE migration_id = ?
        ORDER BY conflict_kind, conflict_key, source_key
      `);
      const rows: SourceServerMigrationReportRow[] = [];
      for (const ledger of ledgerRows) {
        const variantKeys = this.parseVariantKeys(ledger.variant_keys_json);
        let status: SourceServerMigrationReportRow["status"] = ledger.status;
        if (ledger.status === "abandoned" && ledger.abandoned_activity_json) {
          const baseline = this.parseAbandonedActivity(ledger.abandoned_activity_json);
          const current = await this.computeVariantActivityDigests(
            taskDb,
            sessionDb,
            ledger.path,
            variantKeys.filter((key) => key !== ledger.canonical_key),
            baseline.version,
          );
          if (JSON.stringify(current) !== JSON.stringify(baseline.digests)) {
            status = "abandoned-diverged";
          }
        }
        const conflicts = readConflicts.all(ledger.migration_id) as unknown as Array<{
          conflict_kind: "task-identity" | "config-file";
          conflict_key: string;
          task_id: string | null;
          relative_path: string | null;
          source_key: string;
          canonical_key: string;
          reason: string;
        }>;
        rows.push({
          migrationId: ledger.migration_id,
          workspacePath: ledger.path,
          canonicalKey: ledger.canonical_key,
          variantKeys,
          status,
          ...(ledger.phase ? { phase: ledger.phase } : {}),
          ...(ledger.error ? { errorCode: ledger.error } : {}),
          ...(ledger.task_backup_path ? { taskBackupPath: ledger.task_backup_path } : {}),
          ...(ledger.session_backup_path ? { sessionBackupPath: ledger.session_backup_path } : {}),
          updatedAt: ledger.updated_at,
          ...(ledger.abandoned_at !== null ? { abandonedAt: ledger.abandoned_at } : {}),
          ...(ledger.abandoned_trigger ? { abandonedTrigger: ledger.abandoned_trigger } : {}),
          conflicts: conflicts.map((conflict) => ({
            kind: conflict.conflict_kind,
            key: conflict.conflict_key,
            ...(conflict.task_id ? { taskId: conflict.task_id } : {}),
            ...(conflict.relative_path ? { relativePath: conflict.relative_path } : {}),
            sourceKey: conflict.source_key,
            canonicalKey: conflict.canonical_key,
            reason: conflict.reason,
          })),
        });
      }
      return { rows };
    } finally {
      sessionDb?.close();
      taskDb.close();
    }
  }

  public async abandonFailedWorkspace(workspacePath: string, migrationId?: string): Promise<void> {
    return await this.runWorkspaceOperation(workspacePath, (normalizedPath) =>
      this.abandonFailedWorkspaceInternal(normalizedPath, migrationId),
    );
  }

  private async abandonFailedWorkspaceInternal(
    workspacePath: string,
    migrationId?: string,
  ): Promise<void> {
    const taskDb = openDatabase(this.taskDbPath);
    const sessionDb = await stat(this.sessionDbPath).then(
      (value) => (value.isFile() ? openDatabase(this.sessionDbPath) : null),
      () => null,
    );
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
      const ledger = taskDb
        .prepare(`
          SELECT migration_id, canonical_key, variant_keys_json, phase
          FROM workspace_migration_ledger
          WHERE path = ? AND status = 'failed'
            ${migrationId ? "AND migration_id = ?" : ""}
          ORDER BY updated_at DESC, created_at DESC, rowid DESC
          LIMIT 1
        `)
        .get(workspacePath, ...(migrationId ? [migrationId] : [])) as
        | {
            migration_id: string;
            canonical_key: string;
            variant_keys_json: string;
            phase: string | null;
          }
        | undefined;
      if (!ledger) throw new Error(`No failed Source Server migration for path: ${workspacePath}`);
      if (ledger.phase !== null) {
        // phase 非空的 failed ledger 仍是 crash resume owner，不能被 abandon 销毁。
        throw new Error(`Source Server resumable migration cannot be abandoned: ${workspacePath}`);
      }
      const variantKeys = this.parseVariantKeys(ledger.variant_keys_json);
      const abandonedVariants = variantKeys.filter((key) => key !== ledger.canonical_key);
      const configSnapshots = await this.readVariantConfigSnapshots(
        workspacePath,
        abandonedVariants,
      );
      const now = this.now();
      taskDb.exec("BEGIN IMMEDIATE");
      try {
        // 配置 IO 期间其他进程可能已完成或换了计划；取得写锁后复查，避免旧 abandon
        // 覆盖新 ledger/alias。updated_at 可在同一毫秒内重复，必须比较状态与冻结计划本身。
        const current = taskDb
          .prepare(`
          SELECT canonical_key, variant_keys_json
          FROM workspace_migration_ledger
          WHERE migration_id = ? AND path = ? AND status = 'failed' AND phase IS NULL
        `)
          .get(ledger.migration_id, workspacePath) as
          | { canonical_key: string; variant_keys_json: string }
          | undefined;
        if (
          !current ||
          current.canonical_key !== ledger.canonical_key ||
          current.variant_keys_json !== ledger.variant_keys_json
        ) {
          throw Object.assign(
            new Error(`Source Server migration changed during abandon: ${workspacePath}`),
            { retryable: true },
          );
        }
        sessionDb?.exec("BEGIN");
        taskDb
          .prepare(`
          UPDATE workspace_migration_ledger
          SET status = 'abandoned', phase = NULL, abandoned_at = ?,
              abandoned_trigger = 'user', abandoned_activity_json = NULL, updated_at = ?
          WHERE migration_id = ?
        `)
          .run(now, now, ledger.migration_id);
        this.writeAlias(taskDb, workspacePath, ledger.canonical_key);
        // Bug 原因：旧实现先算 digest 再开启 ledger 事务，事务触发器/并发 task 写入会在
        // abandoned 提交前落盘，却被误判成“放弃后的 divergence”。先提交逻辑状态，再在
        // 同一未提交事务的最终视图上取 DB 基线；session DB 用读事务固定同一轮快照。
        // config 文件已在加写锁前并行读取，避免目录大小直接延长 task DB 写锁。
        const activity = await this.computeVariantActivityDigests(
          taskDb,
          sessionDb,
          workspacePath,
          abandonedVariants,
          2,
          configSnapshots,
        );
        taskDb
          .prepare(
            "UPDATE workspace_migration_ledger SET abandoned_activity_json = ? WHERE migration_id = ?",
          )
          .run(JSON.stringify({ schemaVersion: 2, digests: activity }), ledger.migration_id);
        sessionDb?.exec("COMMIT");
        taskDb.exec("COMMIT");
      } catch (error) {
        if (sessionDb) rollbackQuietly(sessionDb);
        rollbackQuietly(taskDb);
        throw error;
      }
    } finally {
      sessionDb?.close();
      taskDb.close();
    }
  }

  public async retryFailedWorkspace(
    workspacePath: string,
    migrationId?: string,
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    return await this.runWorkspaceOperation(workspacePath, (normalizedPath) =>
      this.retryFailedWorkspaceInternal(normalizedPath, migrationId),
    );
  }

  private async retryFailedWorkspaceInternal(
    workspacePath: string,
    migrationId?: string,
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    const taskDb = openDatabase(this.taskDbPath);
    let canonicalKey: string | undefined;
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
      const failed = taskDb
        .prepare(`
        SELECT canonical_key
        FROM workspace_migration_ledger
        WHERE path = ? AND status IN ('failed', 'abandoned')
          ${migrationId ? "AND migration_id = ?" : ""}
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
        .get(workspacePath, ...(migrationId ? [migrationId] : [])) as
        | { canonical_key: string }
        | undefined;
      canonicalKey = failed?.canonical_key;
    } finally {
      taskDb.close();
    }
    if (!canonicalKey)
      throw new Error(`No retryable Source Server migration for path: ${workspacePath}`);
    // retry 只绕过本次 abandoned 短路；若仍冲突会创建新的 failed attempt，原审计保留。
    // 当前操作已占有同路径队列，直接复用内部入口，避免重新排队后等待自身。
    return await this.resolveCanonicalWorkspaceKeyInternal(
      {
        workspacePath,
        legacyRouteHint: canonicalKey,
      },
      { ignoreAbandoned: true },
    );
  }

  private parseVariantKeys(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  }

  private parseAbandonedActivity(raw: string): WorkspaceActivityDigestBaseline {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (
          record.schemaVersion === 2 &&
          record.digests &&
          typeof record.digests === "object" &&
          !Array.isArray(record.digests)
        ) {
          return {
            version: 2,
            digests: this.parseDigestMap(record.digests as Record<string, unknown>),
          };
        }
        // Bug 原因：旧 abandoned 行没有算法版本；若直接用新增 bootstrap/过滤 node-order
        // 后的算法比较，升级本身就会制造 divergence。无 envelope 的行必须固定按 v1 回放。
        return { version: 1, digests: this.parseDigestMap(record) };
      }
      return { version: 1, digests: {} };
    } catch {
      return { version: 1, digests: {} };
    }
  }

  private parseDigestMap(input: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(input).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  private async computeVariantActivityDigests(
    taskDb: Database,
    sessionDb: Database | null,
    workspacePath: string,
    variants: string[],
    version: WorkspaceActivityDigestVersion = 2,
    configSnapshots?: ReadonlyMap<string, SessionConfigEntries>,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const variant of [...variants].sort()) {
      const hash = createHash("sha256");
      this.updateDatabaseActivityHash(
        hash,
        taskDb,
        workspacePath,
        variant,
        version === 1
          ? [
              "tasks",
              "task_group_members",
              "task_group_view_node_orders",
              "automations",
              "automation_runs",
              "off_peak_tasks",
            ]
          : [
              "tasks",
              "task_group_members",
              "task_group_workspace_bootstraps",
              "task_group_view_node_orders",
              "automations",
              "automation_runs",
              "off_peak_tasks",
            ],
        version,
      );
      if (sessionDb) {
        this.updateDatabaseActivityHash(
          hash,
          sessionDb,
          workspacePath,
          variant,
          ["session", "sessions"],
          version,
        );
      }
      const configEntries =
        configSnapshots?.get(variant) ??
        (await this.readSessionConfigEntries(
          this.getSessionConfigDirectory(workspacePath, variant),
        ));
      for (const [relativePath, entry] of [...configEntries.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        hash.update(relativePath);
        hash.update(entry.kind);
        if (entry.kind === "file") hash.update(entry.content);
      }
      result[variant] = hash.digest("hex");
    }
    return result;
  }

  private updateDatabaseActivityHash(
    hash: ReturnType<typeof createHash>,
    db: Database,
    workspacePath: string,
    workspaceKey: string,
    tables: string[],
    version: WorkspaceActivityDigestVersion,
  ): void {
    for (const table of tables) {
      if (!hasTable(db, table)) continue;
      const column = [
        "workspace_key",
        "workspace_identity",
        "workspace_id",
        "workspace_path",
        "path",
      ].find((candidate) => hasColumn(db, table, candidate));
      let rows = (
        column
          ? db
              .prepare(`SELECT * FROM ${table} WHERE ${column} = ?`)
              .all(column === "workspace_path" || column === "path" ? workspacePath : workspaceKey)
          : db.prepare(`SELECT * FROM ${table}`).all()
      ) as unknown[];
      if (version === 2 && !column && table === "task_group_view_node_orders") {
        rows = rows.filter((row) => {
          const nodeKey = (row as { node_key?: unknown }).node_key;
          if (typeof nodeKey !== "string") return false;
          try {
            const parsed = JSON.parse(nodeKey) as unknown;
            return Array.isArray(parsed) && parsed[0] === workspaceKey;
          } catch {
            return false;
          }
        });
      }
      const normalized = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [
              key,
              typeof item === "bigint"
                ? item.toString()
                : Buffer.isBuffer(item)
                  ? item.toString("base64")
                  : item,
            ]),
        ),
      );
      normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      hash.update(table);
      hash.update(JSON.stringify(normalized));
    }
  }

  private findVariants(
    taskDb: Database,
    sessionDb: Database | null,
    workspacePath: string,
  ): string[] {
    const variants = new Set<string>();
    for (const table of WORKSPACE_PATH_TABLES) {
      if (
        !hasTable(taskDb, table) ||
        !hasColumn(taskDb, table, "workspace_key") ||
        !hasColumn(taskDb, table, "workspace_path")
      ) {
        continue;
      }
      const rows = taskDb
        .prepare(
          `SELECT DISTINCT workspace_key FROM ${table}
           WHERE workspace_path = ? AND workspace_key LIKE 'remote:%'`,
        )
        .all(workspacePath) as unknown as Array<{ workspace_key: string }>;
      for (const row of rows)
        if (isLegacyRemoteKey(row.workspace_key)) variants.add(row.workspace_key);
    }
    for (const table of ["task_group_workspace_bootstraps", "automation_runs"] as const) {
      if (!hasTable(taskDb, table) || !hasColumn(taskDb, table, "workspace_key")) continue;
      const rows = taskDb
        .prepare(`SELECT DISTINCT workspace_key FROM ${table} WHERE workspace_key LIKE 'remote:%'`)
        .all() as unknown as Array<{ workspace_key: string }>;
      for (const row of rows) {
        if (
          isLegacyRemoteKey(row.workspace_key) &&
          parseRemoteWorkspaceIdentity(row.workspace_key)?.workspacePath === workspacePath
        ) {
          variants.add(row.workspace_key);
        }
      }
    }
    if (hasTable(taskDb, "task_group_view_node_orders")) {
      const rows = taskDb
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .all() as unknown as Array<{ node_key: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.node_key) as unknown;
          const workspaceKey = Array.isArray(parsed) ? parsed[0] : null;
          if (
            typeof workspaceKey === "string" &&
            isLegacyRemoteKey(workspaceKey) &&
            parseRemoteWorkspaceIdentity(workspaceKey)?.workspacePath === workspacePath
          ) {
            variants.add(workspaceKey);
          }
        } catch {
          // 非结构化 node key 不属于 workspace task 排序记录。
        }
      }
    }
    if (sessionDb && hasTable(sessionDb, "session")) {
      const rows = sessionDb
        .prepare(
          "SELECT DISTINCT workspace_id FROM session WHERE (directory = ? OR path = ?) AND workspace_id LIKE 'remote:%'",
        )
        .all(workspacePath, workspacePath) as unknown as Array<{ workspace_id: string }>;
      for (const row of rows)
        if (isLegacyRemoteKey(row.workspace_id)) variants.add(row.workspace_id);
    }
    return [...variants].sort();
  }

  private async hasWorkspaceOwnedStateForHint(
    taskDb: Database,
    workspacePath: string,
    workspaceKey: string,
  ): Promise<boolean> {
    for (const table of [
      "tasks",
      "task_group_members",
      "task_group_workspace_bootstraps",
      "automations",
      "automation_runs",
      "off_peak_tasks",
    ] as const) {
      if (
        hasTable(taskDb, table) &&
        hasColumn(taskDb, table, "workspace_key") &&
        taskDb.prepare(`SELECT 1 FROM ${table} WHERE workspace_key = ? LIMIT 1`).get(workspaceKey)
      ) {
        return true;
      }
    }
    if (hasTable(taskDb, "task_group_view_node_orders")) {
      const rows = taskDb
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .all() as unknown as Array<{ node_key: string }>;
      if (
        rows.some((row) => {
          try {
            const parsed = JSON.parse(row.node_key) as unknown;
            return Array.isArray(parsed) && parsed[0] === workspaceKey;
          } catch {
            return false;
          }
        })
      ) {
        return true;
      }
    }
    const configDir = this.getSessionConfigDirectory(workspacePath, workspaceKey);
    if (!(await this.pathExists(configDir))) return false;
    return (await readdir(configDir)).length > 0;
  }

  private chooseCanonicalKey(
    taskDb: Database,
    sessionDb: Database | null,
    workspacePath: string,
    variants: string[],
  ): string {
    const activity = new Map(variants.map((key) => [key, 0]));
    for (const table of WORKSPACE_PATH_TABLES) {
      if (
        !hasTable(taskDb, table) ||
        !hasColumn(taskDb, table, "workspace_key") ||
        !hasColumn(taskDb, table, "workspace_path") ||
        !hasColumn(taskDb, table, "updated_at")
      ) {
        continue;
      }
      const rows = taskDb
        .prepare(
          `SELECT workspace_key, MAX(updated_at) AS last_active_at FROM ${table}
           WHERE workspace_path = ? GROUP BY workspace_key`,
        )
        .all(workspacePath) as unknown as WorkspaceActivityRow[];
      for (const row of rows) {
        if (activity.has(row.workspace_key)) {
          activity.set(
            row.workspace_key,
            Math.max(activity.get(row.workspace_key) ?? 0, row.last_active_at),
          );
        }
      }
    }
    if (sessionDb && hasTable(sessionDb, "session")) {
      const rows = sessionDb
        .prepare(
          "SELECT workspace_id AS workspace_key, MAX(time_updated) AS last_active_at FROM session WHERE directory = ? OR path = ? GROUP BY workspace_id",
        )
        .all(workspacePath, workspacePath) as unknown as WorkspaceActivityRow[];
      for (const row of rows) {
        if (activity.has(row.workspace_key)) {
          activity.set(
            row.workspace_key,
            Math.max(activity.get(row.workspace_key) ?? 0, row.last_active_at),
          );
        }
      }
    }
    return [...variants].sort((left, right) => {
      const activityOrder = (activity.get(right) ?? 0) - (activity.get(left) ?? 0);
      return activityOrder || left.localeCompare(right);
    })[0]!;
  }

  private mergeTaskDatabase(
    db: Database,
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): void {
    if (!hasTable(db, "tasks")) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const conflicts = this.findTaskIdentityConflicts(db, workspacePath, canonicalKey, mergedKeys);
      if (conflicts.length > 0) {
        // Bug 原因：独立 preflight 与真正写事务之间仍有竞态窗口。冲突复检必须在
        // BEGIN IMMEDIATE 取得写锁后完成，失败时由本事务整体回滚，再写审计报告。
        throw new SourceServerWorkspaceIdentityConflictError(workspacePath, conflicts);
      }
      const listTasks = db.prepare(
        "SELECT task_id, title, created_at, updated_at, pinned, archived, deleted, title_overridden, searchable_text, unread_at, last_unread_at, task_status, provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id, meta_json FROM tasks WHERE workspace_key = ? AND workspace_path = ?",
      );
      const findCanonical = db.prepare(
        "SELECT task_id, title, created_at, updated_at, pinned, archived, deleted, title_overridden, searchable_text, unread_at, last_unread_at, task_status, provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id, meta_json FROM tasks WHERE workspace_key = ? AND task_id = ?",
      );
      const moveTask = db.prepare(
        "UPDATE tasks SET workspace_key = ?, workspace_identity = ?, meta_json = ? WHERE workspace_key = ? AND task_id = ?",
      );
      const mergeTask = db.prepare(`
        UPDATE tasks SET
          created_at = MIN(created_at, ?),
          updated_at = MAX(updated_at, ?),
          pinned = MAX(pinned, ?),
          archived = MAX(archived, ?),
          deleted = MAX(deleted, ?),
          title = CASE WHEN title_overridden = 1 THEN title WHEN ? = 1 THEN ? ELSE title END,
          title_overridden = MAX(title_overridden, ?),
          searchable_text = CASE WHEN searchable_text <> '' THEN searchable_text ELSE ? END,
          unread_at = ?,
          last_unread_at = ?,
          task_status = ?,
          provider = ?,
          mode = ?,
          model = ?,
          migration_source = ?,
          forked_from_task_id = ?,
          cron_automation_id = ?,
          off_peak_task_id = ?,
          meta_json = ?
        WHERE workspace_key = ? AND task_id = ?
      `);
      const deleteTask = db.prepare("DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?");
      // 只跑过 tasks schema 迁移的库没有项目化列，此时旧列已是全部事实。
      const hasCliFacts = hasColumn(db, "tasks", "cli_updated_at");
      const readCliFacts = db.prepare(
        hasCliFacts
          ? "SELECT cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending FROM tasks WHERE workspace_key = ? AND task_id = ?"
          : "SELECT NULL WHERE 0",
      );
      const writeCliFacts = db.prepare(
        hasCliFacts
          ? "UPDATE tasks SET cli_title = ?, cli_title_source = ?, cli_created_at = ?, cli_updated_at = ?, cli_last_outcome = ?, cli_deleted = ?, handoff_pending = ? WHERE workspace_key = ? AND task_id = ?"
          : "SELECT NULL WHERE 0",
      );
      for (const sourceKey of mergedKeys) {
        const rows = listTasks.all(sourceKey, workspacePath) as unknown as Array<{
          task_id: string;
          title: string;
          created_at: number;
          updated_at: number;
          pinned: number;
          archived: number;
          deleted: number;
          title_overridden: number;
          searchable_text: string;
          unread_at: number | null;
          last_unread_at: number;
          task_status: string | null;
          provider: string | null;
          mode: string;
          model: string | null;
          migration_source: string | null;
          forked_from_task_id: string | null;
          cron_automation_id: string | null;
          off_peak_task_id: string | null;
          meta_json: string;
        }>;
        for (const row of rows) {
          const existing = findCanonical.get(canonicalKey, row.task_id) as typeof row | undefined;
          if (!existing) {
            const meta = parseMetaRecord(row.meta_json);
            const movedMetaJson =
              meta && "workspaceIdentity" in meta
                ? JSON.stringify({ ...meta, workspaceIdentity: canonicalKey })
                : row.meta_json;
            moveTask.run(canonicalKey, canonicalKey, movedMetaJson, sourceKey, row.task_id);
            continue;
          }
          const metaMerge = mergeTaskMetaJson(existing, row, canonicalKey);
          if (metaMerge.status === "identity-conflict") {
            throw new SourceServerWorkspaceIdentityConflictError(workspacePath, [
              { taskId: row.task_id, sourceKey },
            ]);
          }
          // Bug 原因：只合并壳字段后删除 source 会永久丢失正文索引和未读状态。
          // 在删除前保留可搜索正文，并延续索引已有的未读 marker 合并规则。
          const unreadAt =
            existing.unread_at !== null && row.unread_at !== null
              ? Math.max(existing.unread_at, row.unread_at)
              : (existing.unread_at ?? row.unread_at);
          // Bug 原因：meta 已按新旧合并，查询投影却保留 canonical 旧值，导致状态过滤和身份反查失真。
          // 从合并后的 meta 重建投影；旧 meta 未携带的字段沿用索引列，保留历史回填的身份。
          const mergedMeta = parseMetaRecord(metaMerge.metaJson);
          const [newer, older] =
            existing.updated_at <= row.updated_at ? [row, existing] : [existing, row];
          const project = (key: string, legacyValue: string | null): string | null => {
            const value = mergedMeta?.[key];
            return typeof value === "string" ? value : legacyValue;
          };
          mergeTask.run(
            row.created_at,
            row.updated_at,
            row.pinned,
            row.archived,
            row.deleted,
            row.title_overridden,
            row.title,
            row.title_overridden,
            row.searchable_text,
            unreadAt,
            Math.max(existing.last_unread_at, row.last_unread_at, unreadAt ?? 0),
            project("status", newer.task_status ?? older.task_status),
            project("provider", newer.provider ?? older.provider),
            project("mode", newer.mode),
            project("model", newer.model ?? older.model),
            project("migrationSource", newer.migration_source ?? older.migration_source),
            project("forkedFromTaskId", newer.forked_from_task_id ?? older.forked_from_task_id),
            project("cronAutomationId", newer.cron_automation_id ?? older.cron_automation_id),
            project("offPeakTaskId", newer.off_peak_task_id ?? older.off_peak_task_id),
            metaMerge.metaJson,
            canonicalKey,
            row.task_id,
          );
          if (hasCliFacts) {
            const canonicalFacts = readCliFacts.get(
              canonicalKey,
              row.task_id,
            ) as unknown as TaskCliFactsRow;
            const sourceFacts = readCliFacts.get(
              sourceKey,
              row.task_id,
            ) as unknown as TaskCliFactsRow;
            // Bug 原因：旧 ACP ID 合并只抬高 updated_at、不改 cli_*，两列在存量库中会分叉；按
            // updated_at 选胜者会把较旧的状态/标题配上较新的 cli_updated_at。CLI 事实只按自身
            // 时间裁决，无事实的一方不胜出，同时间沿用 source 优先。
            const cliTime = (facts: TaskCliFactsRow) =>
              facts.cli_updated_at ?? Number.NEGATIVE_INFINITY;
            const facts =
              cliTime(canonicalFacts) <= cliTime(sourceFacts)
                ? mergeTaskCliFacts(sourceFacts, canonicalFacts)
                : mergeTaskCliFacts(canonicalFacts, sourceFacts);
            writeCliFacts.run(
              facts.cli_title,
              facts.cli_title_source,
              facts.cli_created_at,
              facts.cli_updated_at,
              facts.cli_last_outcome,
              facts.cli_deleted,
              facts.handoff_pending,
              canonicalKey,
              row.task_id,
            );
          }
          deleteTask.run(sourceKey, row.task_id);
        }
        if (hasTable(db, "task_group_members")) {
          db.prepare(`DELETE FROM task_group_members
            WHERE workspace_key = ? AND EXISTS (
              SELECT 1 FROM task_group_members target
              WHERE target.workspace_key = ? AND target.task_id = task_group_members.task_id
            )`).run(sourceKey, canonicalKey);
          db.prepare(
            "UPDATE task_group_members SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ?",
          ).run(canonicalKey, canonicalKey, sourceKey);
        }
        if (hasTable(db, "task_group_workspace_bootstraps")) {
          const canonicalBootstrap = db
            .prepare("SELECT 1 FROM task_group_workspace_bootstraps WHERE workspace_key = ?")
            .get(canonicalKey);
          if (canonicalBootstrap) {
            db.prepare("DELETE FROM task_group_workspace_bootstraps WHERE workspace_key = ?").run(
              sourceKey,
            );
          } else {
            db.prepare(
              "UPDATE task_group_workspace_bootstraps SET workspace_key = ? WHERE workspace_key = ?",
            ).run(canonicalKey, sourceKey);
          }
        }
        this.migrateTaskNodeOrders(db, sourceKey, canonicalKey);
        this.updateWorkspaceIdentityColumns(db, "automations", sourceKey, canonicalKey);
        this.updateWorkspaceIdentityColumns(db, "automation_runs", sourceKey, canonicalKey);
        cancelConflictingOffPeakBindings(db, sourceKey, canonicalKey, this.now());
        this.updateWorkspaceIdentityColumns(db, "off_peak_tasks", sourceKey, canonicalKey);
      }
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

  private migrateTaskNodeOrders(db: Database, sourceKey: string, canonicalKey: string): void {
    if (!hasTable(db, "task_group_view_node_orders")) return;
    const rows = db
      .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
      .all() as unknown as Array<{ node_key: string }>;
    const deleteRow = db.prepare(
      "DELETE FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
    );
    const updateRow = db.prepare(
      "UPDATE task_group_view_node_orders SET node_key = ? WHERE node_type = 'task' AND node_key = ?",
    );
    const targetExists = db.prepare(
      "SELECT 1 FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
    );
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.node_key);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== sourceKey) continue;
      const canonicalNodeKey = JSON.stringify([canonicalKey, parsed[1]]);
      if (targetExists.get(canonicalNodeKey)) {
        deleteRow.run(row.node_key);
      } else {
        updateRow.run(canonicalNodeKey, row.node_key);
      }
    }
  }

  private updateWorkspaceIdentityColumns(
    db: Database,
    table: "automations" | "automation_runs" | "off_peak_tasks",
    sourceKey: string,
    canonicalKey: string,
  ): void {
    if (!hasTable(db, table) || !hasColumn(db, table, "workspace_key")) return;
    if (hasColumn(db, table, "workspace_identity")) {
      db.prepare(
        `UPDATE ${table} SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ?`,
      ).run(canonicalKey, canonicalKey, sourceKey);
      return;
    }
    db.prepare(`UPDATE ${table} SET workspace_key = ? WHERE workspace_key = ?`).run(
      canonicalKey,
      sourceKey,
    );
  }

  private findTaskIdentityConflicts(
    db: Database,
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): WorkspaceTaskIdentityConflict[] {
    if (!hasTable(db, "tasks")) return [];
    const listTasks = db.prepare(
      "SELECT task_id, meta_json, updated_at, cron_automation_id, off_peak_task_id, forked_from_task_id FROM tasks WHERE workspace_key = ? AND workspace_path = ?",
    );
    const findCanonical = db.prepare(
      "SELECT task_id, meta_json, updated_at, cron_automation_id, off_peak_task_id, forked_from_task_id FROM tasks WHERE workspace_key = ? AND task_id = ?",
    );
    // Bug 原因：写事务按 mergedKeys 顺序把 source 逐个并入 canonical，后一个 source 比较的是
    // 已累积的合并结果；预检只比 canonical 快照，canonical 缺该 task 或缺身份字段时会漏掉
    // source 之间的冲突，备份后才在写事务里失败，每次打开都重新建账、备份两库。
    // 预检按同一顺序累积每个 taskId 的合并结果，和写事务用同一条冲突规则。
    const merged = new Map<string, WorkspaceTaskMetaRow>();
    const conflicts: WorkspaceTaskIdentityConflict[] = [];
    for (const sourceKey of mergedKeys) {
      const rows = listTasks.all(sourceKey, workspacePath) as unknown as Array<
        WorkspaceTaskMetaRow & { task_id: string }
      >;
      for (const row of rows) {
        const target =
          merged.get(row.task_id) ??
          (findCanonical.get(canonicalKey, row.task_id) as WorkspaceTaskMetaRow | undefined);
        if (!target) {
          merged.set(row.task_id, row);
          continue;
        }
        const result = mergeTaskMetaJson(target, row, canonicalKey);
        if (result.status === "identity-conflict") {
          conflicts.push({ taskId: row.task_id, sourceKey });
          continue;
        }
        // 无冲突时每个身份字段至多一个取值，取并集即写事务投影后的有效身份。
        merged.set(row.task_id, {
          meta_json: result.metaJson,
          updated_at: Math.max(target.updated_at, row.updated_at),
          cron_automation_id: target.cron_automation_id ?? row.cron_automation_id,
          off_peak_task_id: target.off_peak_task_id ?? row.off_peak_task_id,
          forked_from_task_id: target.forked_from_task_id ?? row.forked_from_task_id,
        });
      }
    }
    return conflicts;
  }

  private recordTaskIdentityConflicts(
    db: Database,
    input: {
      migrationId?: string;
      workspacePath: string;
      canonicalKey: string;
      variants: string[];
      conflicts: WorkspaceTaskIdentityConflict[];
    },
  ): void {
    const existing = input.migrationId
      ? (db
          .prepare("SELECT migration_id FROM workspace_migration_ledger WHERE migration_id = ?")
          .get(input.migrationId) as { migration_id: string } | undefined)
      : (db
          .prepare(`
            SELECT migration_id
            FROM workspace_migration_ledger
            WHERE path = ? AND status = 'failed'
              AND error = 'workspace-task-identity-conflict'
            ORDER BY updated_at DESC, created_at DESC, rowid DESC
            LIMIT 1
          `)
          .get(input.workspacePath) as { migration_id: string } | undefined);
    const migrationId = existing?.migration_id ?? this.createMigrationId();
    const now = this.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        // Bug 原因：冲突 ledger 幂等去重后直接 return，后续新增/消失的冲突不会更新报告。
        // 复用同一 migrationId，但事务性替换当前冲突集，仍不重复备份或新建 ledger。
        // preflight/backups-created 尚未搬运数据，可清 phase 让用户 abandon；之后的 phase
        // 保留 resume owner，禁止把部分迁移伪装成普通冲突。
        db.prepare(`
          UPDATE workspace_migration_ledger
          SET canonical_key = ?, variant_keys_json = ?, status = 'failed',
              phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
              error = 'workspace-task-identity-conflict', updated_at = ?
          WHERE migration_id = ?
        `).run(input.canonicalKey, JSON.stringify(input.variants), now, migrationId);
        db.prepare("DELETE FROM workspace_migration_conflicts WHERE migration_id = ?").run(
          migrationId,
        );
      } else {
        db.prepare(`
          INSERT INTO workspace_migration_ledger (
            migration_id, path, canonical_key, variant_keys_json, status,
            task_backup_path, session_backup_path, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'failed', '', NULL, 'workspace-task-identity-conflict', ?, ?)
        `).run(
          migrationId,
          input.workspacePath,
          input.canonicalKey,
          JSON.stringify(input.variants),
          now,
          now,
        );
      }
      const insertConflict = db.prepare(`
        INSERT INTO workspace_migration_conflicts (
          migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
          source_key, canonical_key, reason, created_at
        ) VALUES (?, ?, 'task-identity', ?, ?, NULL, ?, ?,
          'task-identity-metadata-conflict', ?)
      `);
      for (const conflict of input.conflicts) {
        insertConflict.run(
          migrationId,
          input.workspacePath,
          conflict.taskId,
          conflict.taskId,
          conflict.sourceKey,
          input.canonicalKey,
          now,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

  private recordConfigConflict(
    db: Database,
    input: {
      migrationId?: string;
      workspacePath: string;
      canonicalKey: string;
      variants: string[];
      conflict: SourceServerWorkspaceConfigConflictError;
    },
  ): void {
    const existing = input.migrationId
      ? (db
          .prepare("SELECT migration_id FROM workspace_migration_ledger WHERE migration_id = ?")
          .get(input.migrationId) as { migration_id: string } | undefined)
      : (db
          .prepare(`
        SELECT migration_id
        FROM workspace_migration_ledger
        WHERE path = ? AND status = 'failed'
          AND error = 'workspace-config-file-conflict'
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
          .get(input.workspacePath) as { migration_id: string } | undefined);
    const migrationId = existing?.migration_id ?? this.createMigrationId();
    const now = this.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        // 仅 pre-merge phase 能安全转成可 abandon 冲突；DB 已提交后的冲突必须保留 resume owner。
        db.prepare(`
          UPDATE workspace_migration_ledger
          SET canonical_key = ?, variant_keys_json = ?, status = 'failed',
              phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
              error = 'workspace-config-file-conflict', updated_at = ?
          WHERE migration_id = ?
        `).run(input.canonicalKey, JSON.stringify(input.variants), now, migrationId);
        db.prepare("DELETE FROM workspace_migration_conflicts WHERE migration_id = ?").run(
          migrationId,
        );
      } else {
        db.prepare(`
          INSERT INTO workspace_migration_ledger (
            migration_id, path, canonical_key, variant_keys_json, status, phase,
            task_backup_path, session_backup_path, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'failed', NULL, '', NULL,
            'workspace-config-file-conflict', ?, ?)
        `).run(
          migrationId,
          input.workspacePath,
          input.canonicalKey,
          JSON.stringify(input.variants),
          now,
          now,
        );
      }
      db.prepare(`
        INSERT INTO workspace_migration_conflicts (
          migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
          source_key, canonical_key, reason, created_at
        ) VALUES (?, ?, 'config-file', ?, NULL, ?, ?, ?,
          'workspace-config-file-conflict', ?)
      `).run(
        migrationId,
        input.workspacePath,
        input.conflict.relativePath,
        input.conflict.relativePath,
        input.conflict.sourceKey,
        input.canonicalKey,
        now,
      );
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

  private writeAlias(db: Database, workspacePath: string, canonicalKey: string): void {
    const now = this.now();
    db.prepare(`
      INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET canonical_key = excluded.canonical_key, updated_at = excluded.updated_at
    `).run(workspacePath, canonicalKey, now, now);
  }

  private markFailedPathResolved(db: Database, workspacePath: string): void {
    db.prepare(`
      UPDATE workspace_migration_ledger
      SET status = 'completed', error = NULL, updated_at = ?
      WHERE path = ? AND status = 'failed'
    `).run(this.now(), workspacePath);
  }

  private writeLedger(
    db: Database,
    input: {
      migrationId: string;
      workspacePath: string;
      canonicalKey: string;
      variants: string[];
      status: "running" | "completed" | "failed";
      taskBackupPath: string;
      sessionBackupPath: string | null;
      sessionDatabaseGeneration: string | null;
    },
  ): void {
    const now = this.now();
    db.prepare(`
      INSERT INTO workspace_migration_ledger (
        migration_id, path, canonical_key, variant_keys_json, status, phase,
        task_backup_path, session_backup_path, created_at, updated_at,
        session_db_generation
      ) VALUES (?, ?, ?, ?, ?, 'preflight', ?, ?, ?, ?, ?)
    `).run(
      input.migrationId,
      input.workspacePath,
      input.canonicalKey,
      JSON.stringify(input.variants),
      input.status,
      input.taskBackupPath,
      input.sessionBackupPath,
      now,
      now,
      input.sessionDatabaseGeneration,
    );
  }
}
