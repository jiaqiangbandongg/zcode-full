// Session 常驻池的真实事实适配与去激活执行面。

import type { SessionId } from "@zcode/contracts";
import type {
  SessionDeactivationDecision,
  SessionResidentPoolHost,
} from "./session-resident-pool.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

export interface SessionResidencyFinalizationOwner {
  residencyFinalizationCount?: number;
}

/**
 * residency lease 只覆盖 Bootstrap detached runner 的收尾窗口，避免 pool 回收仍在使用的
 * record。Prompt admission 的 busy/idle authority 已归 Core；activeAbortController 仅是旧命令
 * 路径的兼容取消句柄，不能再作为 prompt 调度锁。
 */
export function acquireSessionResidencyFinalization(
  record: SessionResidencyFinalizationOwner,
): () => void {
  record.residencyFinalizationCount = (record.residencyFinalizationCount ?? 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.residencyFinalizationCount = Math.max(0, (record.residencyFinalizationCount ?? 1) - 1);
  };
}

/** 同步登记 lease，再启动 detached runner；同步抛错和异步终态都保证释放。 */
export function runWithSessionResidencyFinalization<T>(
  record: SessionResidencyFinalizationOwner,
  run: () => Promise<T>,
): Promise<T> {
  const release = acquireSessionResidencyFinalization(record);
  try {
    return run().finally(release);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
}

/**
 * 只释放 resident runtime，不删除任何持久 session/task 事实。
 *
 * 若先 await app.close，再从 registry 摘除，新的 cold subscribe 会在 await
 * 窗口命中一个已进入 shutdown 的旧 runtime；若先删 record 但不设置 pool gate，新旧 app
 * 又会并发碰同一 session 资源。因此同步摘除与异步 close 必须由 pool 的 in-flight gate
 * 组合成一个生命周期事务。
 */
export async function deactivateSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<void> {
  const record = context.sessions.get(sessionId);
  if (!record) return;
  // CommandInbox pin 的拒绝曾发生在 unsubscribe 之后，异常会留下仍在 registry
  // 但收不到 runtime event 的半清 record。所有可预检拒绝必须早于第一个副作用。
  context.v4Gateway?.assertSessionRuntimeDeactivatable(sessionId);
  record.unsubscribe?.();
  context.v4Gateway?.deactivateSession(sessionId);
  context.sessions.delete(sessionId);
  await record.app.close?.();
  // 去激活后内存 event store 必须与“从未加载”等价。
  await record.eventStore.deleteSession(sessionId as SessionId);
}

export function createSessionResidentPoolHost(
  context: ZCodeProtocolAgentServerContext,
): SessionResidentPoolHost {
  return {
    deactivate: (sessionId) => deactivateSessionRecord(context, sessionId),
    listSessionIds: () => [...context.sessions.keys()],
    readResidencyFacts: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        hasPendingInteractions: context.v4Interactions.hasPendingForSession(sessionId),
        hasQueuedCommands: context.v4Gateway?.hasResidencyBlockingCommands(sessionId) ?? false,
        hasLegacySubscriber: record.legacyStreamSubscribed === true,
        // active/queue 与 registry background task 不能覆盖 title、MCP、memory
        // 等 detached work；统一查询由 runtime 维护，协议 finalization 只补协议所有权。
        hasResidencyBlockingWork:
          record.activeAbortController !== undefined ||
          (record.residencyFinalizationCount ?? 0) > 0 ||
          record.app.runtime.hasResidencyBlockingWork(),
        hasSubscribers: context.v4Gateway?.hasConversationSubscribers(sessionId) ?? false,
        lastActivityAt: record.updatedAt,
        persisted: record.persistence === "immediate",
      };
    },
    onDeactivated: (sessionId, decision) => {
      context.logger?.info("Session resident runtime deactivated", {
        ...deactivationLogContext(decision),
        event: "zcode_protocol.session.resident_deactivated",
        sessionId,
      });
    },
    onError: (sessionId, error, decision) => {
      context.logger?.warn("Session resident deactivation failed", {
        ...deactivationLogContext(decision),
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.resident_deactivation_failed",
        sessionId,
      });
    },
  };
}

function deactivationLogContext(
  decision: SessionDeactivationDecision,
): Record<string, number | string> {
  return {
    highWaterCount: decision.highWaterCount,
    idleMs: decision.idleMs,
    idleTimeoutMs: decision.idleTimeoutMs,
    reason: decision.reason,
    residentCountBefore: decision.residentCountBefore,
    targetCount: decision.targetCount,
  };
}
