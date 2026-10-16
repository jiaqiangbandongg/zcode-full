export interface V4TurnCompletionSnapshot {
  canStop: boolean;
  sessionId: string | null;
  timelineText: string;
}

/**
 * 判断某一轮是否已完成业务投影。
 *
 * Bug 根因：发送后的 projection 在进入 running 前会短暂保持 canStop=false，
 * 只判断“没有 stop 按钮”会把这个启动前空闲帧误认为完成，导致后续切会话与发送互相竞态。
 */
export function isV4TurnCompleted(
  snapshot: V4TurnCompletionSnapshot,
  expectedAssistantReply: string,
) {
  return (
    snapshot.sessionId !== null &&
    snapshot.sessionId !== "draft" &&
    !snapshot.canStop &&
    snapshot.timelineText.includes(expectedAssistantReply)
  );
}
