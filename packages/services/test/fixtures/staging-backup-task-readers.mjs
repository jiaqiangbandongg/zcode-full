// 冻结来源 staging_backup@790884b1ce4b990583ab40625b5f283e2169eb36；原读取函数仅擦除类型，不引用当前 Reader。
import { z } from "zod";
// 该 schema 同时被 validation 聚合入口和 legacy protocol 使用，必须放在无反向依赖的叶子模块。
// 根因：protocol 从 validation 导入它，而 validation 又导入 protocol 的资源采样 schema，
// ESM/Jiti 在 clean Docker 中会先读到尚未初始化的 binding，导致 `.optional()` 启动即崩溃。
export const zcodeTaskModeSchema = z.enum([
  "default",
  "yolo",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);
function rowToAutomation(row) {
  return {
    automationId: row.automation_id,
    title: row.title,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    // Bug 根因：历史版本曾把空字符串写进 mode，旧读取逻辑又直接强转为枚举，导致
    // automation/list 在协议层校验整个数组时被单条脏数据拖垮。历史非法值按未设置兼容。
    mode: normalizeAutomationMode(row.mode),
    thoughtLevel: row.thought_level ?? undefined,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    targetTaskId: row.target_task_id ?? undefined,
    locationKind: row.location_kind === "remote" ? "remote" : "local",
    recurring: row.recurring === 1,
    maxRuns: row.max_runs ?? undefined,
    endAt: row.end_at ?? undefined,
    scheduleRule: row.schedule_rule ? JSON.parse(row.schedule_rule) : undefined,
    ...(row.schedule_edited_by_user === 1 ? { scheduleEditedByUser: true } : {}),
    runCount: row.run_count,
    enabled: row.enabled === 1,
    lifecycleStatus: row.lifecycle_status,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    dispatchStatus: row.dispatch_status,
    dispatchAttempts: row.dispatch_attempts,
    retryAt: row.retry_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function normalizeAutomationMode(mode) {
  const parsed = zcodeTaskModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : undefined;
}
function rowToRun(row) {
  return {
    runId: row.run_id,
    automationId: row.automation_id,
    workspaceKey: row.workspace_key,
    scheduledAt: row.scheduled_at ?? undefined,
    trigger: row.trigger,
    dispatchStatus: row.dispatch_status,
    outcome: row.outcome ?? undefined,
    sessionId: row.session_id ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function rowToTask(row) {
  return {
    offPeakTaskId: row.off_peak_task_id,
    serverTicketId: row.server_ticket_id ?? undefined,
    title: row.title,
    conversationId: row.conversation_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    ...(row.session_title ? { sessionTitle: row.session_title } : {}),
    prompt: row.prompt,
    permissionMode: row.permission_mode,
    model: row.model ?? undefined,
    thoughtLevel: row.thought_level ?? undefined,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    status: row.status,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    filesChanged: row.files_changed ?? undefined,
    settledAt: row.settled_at ?? undefined,
    historyDeletedAt: row.history_deleted_at ?? undefined,
    registeredAt: row.registered_at ?? undefined,
    schedulable: row.schedulable === 1,
    queuePosition: row.queue_position ?? undefined,
    nextPollAt: row.next_poll_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export { rowToAutomation, rowToRun, rowToTask };
