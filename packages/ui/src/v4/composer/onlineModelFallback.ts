import type { SessionConfigState, SessionModelTransition } from "@zcode/shared/zcode-protocol-v4";

export interface ModelConfigProjectionObservation {
  sessionId: string;
  config: Pick<SessionConfigState, "provider" | "model" | "thought">;
}

/**
 * 只确认当前目标 Session 的在线 fallback 已经落到权威投影。
 *
 * 旧实现同时生成一份全局字符串模型偏好，导致 Session 事实反向污染下一次 Workspace Draft。
 * App Recent 现在只在普通用户 Submission 被接受时写入结构化 ModelSelection；这里不再持久化选择。
 */
export function isOnlineModelFallbackAuthoritative(params: {
  targetSessionId: string | null;
  current: ModelConfigProjectionObservation | null;
  transition: SessionModelTransition;
  hasPendingExplicitIntent: boolean;
}): boolean {
  const { targetSessionId, current, transition, hasPendingExplicitIntent } = params;
  if (
    hasPendingExplicitIntent ||
    !targetSessionId ||
    !current ||
    current.sessionId !== targetSessionId ||
    !current.config.provider ||
    !current.config.model ||
    current.config.provider !== transition.to.provider ||
    current.config.model !== transition.to.model
  ) {
    return false;
  }
  return !(
    transition.from.provider === current.config.provider &&
    transition.from.model === current.config.model
  );
}
