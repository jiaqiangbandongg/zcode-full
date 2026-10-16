import { OffPeakPermanentDispatchError } from "@zcode/services/node";

/**
 * 闲时派发三分支：
 * - resume：conversation_id 已回填 = 已跑过，续跑同一 session 并发续跑提示词；
 * - bound-first-run：会话内创建绑定了 session_id 但尚未跑过，resume 绑定会话并发任务原 prompt
 *   （对齐 dispatchCronRun 的 targetTaskId 路径）；
 * - init：表单创建，新建专属 session。
 */
export type OffPeakDispatchKind = "resume" | "bound-first-run" | "init";

export function resolveOffPeakDispatchKind(request: {
  conversationId?: string;
  sessionId?: string;
}): OffPeakDispatchKind {
  if (request.conversationId?.trim()) return "resume";
  if (request.sessionId?.trim()) return "bound-first-run";
  return "init";
}

/** 绑定会话已被用户删除：重试无意义，permanent（否则会一直退避到票过期再重取号）。 */
export class OffPeakBoundSessionDeletedError extends OffPeakPermanentDispatchError {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session was deleted: ${sessionId}`);
    this.name = "OffPeakBoundSessionDeletedError";
  }
}

/**
 * 绑定会话正在跑用户 turn：transient，交给调度器退避重试。
 * 必须在写入会话 mode 之前抛出——CLI 的 session/send 会以 -32010 拒绝，
 * 但 setMode 没有活跃 turn 检查，先写配置再撞忙会把用户会话悄悄切成任务的权限模式。
 */
export class OffPeakBoundSessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session is busy: ${sessionId}`);
    this.name = "OffPeakBoundSessionBusyError";
  }
}

export function assertBoundSessionDispatchable(params: {
  sessionId: string;
  deleted: boolean;
  running: boolean;
}): void {
  if (params.deleted) throw new OffPeakBoundSessionDeletedError(params.sessionId);
  if (params.running) throw new OffPeakBoundSessionBusyError(params.sessionId);
}
