import { OFF_PEAK_TERMINAL_STATUSES } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";

const terminalStatuses = OFF_PEAK_TERMINAL_STATUSES.map((status) => `'${status}'`).join(", ");

/** 在调用方的身份迁移写事务内执行，紧接着由调用方统一 rekey。 */
export function cancelConflictingOffPeakBindings(
  db: DatabaseSync,
  sourceKey: string,
  targetKey: string,
  now: number,
): void {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(off_peak_tasks)")
      .all()
      .map((row) => row.name),
  );
  if (!["workspace_key", "session_id", "status"].every((column) => columns.has(column))) return;

  // Bug 原因：两个 key 下各自合法的活跃绑定在 rekey 时会撞上部分唯一索引，导致整个
  // workspace 迁移回滚。先保留目标绑定、完整取消源冲突行，再在同一写事务内迁移全部历史。
  // 沿用 markTerminal 的取消字段，票据及 settled_at 保持原值，由既有核销 outbox 收口。
  db.prepare(`UPDATE off_peak_tasks
    SET status = 'cancelled', ended_at = ?, updated_at = ?, failure_reason = NULL,
        schedulable = 0, claim_running = 0, claimed_at = NULL
    WHERE workspace_key = ? AND session_id IS NOT NULL
      AND status NOT IN (${terminalStatuses})
      AND EXISTS (
        SELECT 1 FROM off_peak_tasks target
        WHERE target.workspace_key = ? AND target.session_id = off_peak_tasks.session_id
          AND target.status NOT IN (${terminalStatuses})
      )`).run(now, now, sourceKey, targetKey);
}
