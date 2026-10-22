import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import type { SessionSummary, SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";

export interface TaskWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}
export interface TaskFactTarget extends TaskWorkspace {
  taskId: string;
}
export type TaskFactMutation = { type: "rename"; title: string } | { type: "delete" };
export interface CliTaskFacts {
  meta: ZCodeTaskMeta;
  titleSource?: string;
  lastOutcome?: "completed" | "interrupted" | "error";
  deleted?: boolean;
}

/** 存储端口只接受 CLI 事实，不能据 Host 时钟或运行态推导会话事实。 */
export interface TaskFactStore {
  applyCliFacts(facts: CliTaskFacts): Promise<ZCodeTaskMeta>;
  applyCliDeletion(target: TaskFactTarget): Promise<void>;
  markCliOrphan(target: TaskFactTarget): Promise<void>;
  listReconciliationRows(
    target: TaskWorkspace,
  ): Promise<Array<{ meta: ZCodeTaskMeta; handoffPending: number }>>;
  getTaskMeta(target: TaskFactTarget): Promise<ZCodeTaskMeta | null>;
}
export interface TaskFactSource {
  reconcile(target: TaskWorkspace, sessionIds: string[]): Promise<SessionsIndexReconcileResult>;
  execute(target: TaskFactTarget, intent: TaskFactMutation): Promise<void>;
}
export interface TaskFactChange {
  target: TaskFactTarget;
  meta?: ZCodeTaskMeta;
  reason: ZCodeWorkspaceTaskListChanged["reason"];
}
export interface TaskFactsContract {
  ingest(target: TaskWorkspace, summary: SessionSummary): Promise<ZCodeTaskMeta>;
  removed(target: TaskFactTarget): Promise<void>;
  refresh(target: TaskFactTarget): Promise<ZCodeTaskMeta | null>;
  mutate(target: TaskFactTarget, intent: TaskFactMutation): Promise<ZCodeTaskMeta | null>;
  reconcile(
    target: TaskWorkspace,
    presentSessionIds: ReadonlySet<string>,
    stillCurrent: () => boolean,
  ): Promise<void>;
}

/** 冷恢复仅按 CLI 身份清理 child 派生索引，不创建运行时或改写会话正文。 */
export interface SubagentIndexRepair {
  target: TaskWorkspace;
  visibleSessionIds: ReadonlySet<string>;
  agentService: {
    listSessions(
      target: TaskWorkspace & { sessionIds: string[]; runtimePolicy: "existing-only" },
    ): Promise<Array<{ sessionId: string; sessionKind?: string; workspace: TaskWorkspace }>>;
  };
  taskIndexRepo: {
    listTaskMetas(target: TaskWorkspace): Promise<Array<{ taskId: string }>>;
    removeSubagentIndexRow(target: TaskFactTarget): Promise<unknown>;
  };
  isCurrent: () => boolean;
  onRemoved: () => void;
}
