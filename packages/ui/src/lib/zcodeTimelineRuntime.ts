import type { ZCodeTimelineMeta } from "@zcode/shared";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";

const RUNNING_CONTEXT_COMPACTION_STATUSES = new Set(["started", "retrying"]);
const RUNNING_GOAL_VERIFICATION_STATUSES = new Set(["started"]);

export function isRunningGoalVerificationTimeline(
  timeline: ZCodeTimelineMeta | undefined,
): boolean {
  return (
    timeline?.type === "goal_verification" &&
    RUNNING_GOAL_VERIFICATION_STATUSES.has(timeline.status) &&
    // 修复原因：CI/快照恢复里可能出现 status 仍是 started、但 verification 已经带
    // passed/reason 的不一致横条。verification 结果是 verifier 已结束的权威信号，
    // 不能继续把会话判成 running，否则 completed 目标下新的 `/goal` 会被误排队。
    timeline.verification === undefined
  );
}

export function isRunningZCodeTimeline(timeline: ZCodeTimelineMeta | undefined): boolean {
  if (!timeline) {
    return false;
  }
  if (timeline.type === "context_compaction") {
    return RUNNING_CONTEXT_COMPACTION_STATUSES.has(timeline.status);
  }
  if (timeline.type === "goal_verification") {
    return isRunningGoalVerificationTimeline(timeline);
  }
  return false;
}

export function hasRunningZCodeTimeline(messages: readonly TaskChatMessage[]): boolean {
  return messages.some((message) => isRunningZCodeTimeline(message.syntheticTimeline));
}

export function hasRunningContextCompactionTimeline(
  messages: readonly TaskChatMessage[],
): boolean {
  return messages.some((message) => {
    const timeline = message.syntheticTimeline;
    return (
      timeline?.type === "context_compaction" &&
      RUNNING_CONTEXT_COMPACTION_STATUSES.has(timeline.status)
    );
  });
}

export function hasRunningGoalVerificationTimeline(
  messages: readonly TaskChatMessage[],
): boolean {
  return messages.some((message) =>
    isRunningGoalVerificationTimeline(message.syntheticTimeline),
  );
}

export function hasRunningGoalContinuationMessage(messages: readonly TaskChatMessage[]): boolean {
  // Bugfix: goal 正常续跑的 model-only 输入不会生成可见 user 气泡，也不会推进 goalIteration；
  // UI 只会留下带 streamGroupId 的 streaming assistant。队列“立即发送”拦截必须识别这个运行态，
  // 否则 target 元信息短暂缺失时会误允许抢占 active goal。
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.streaming === true &&
      !message.syntheticTimeline &&
      !message.uiTimeline &&
      typeof message.streamGroupId === "string" &&
      message.streamGroupId.length > 0,
  );
}

export function hasRunningGoalRuntimeSignal(messages: readonly TaskChatMessage[]): boolean {
  return (
    hasRunningGoalVerificationTimeline(messages) ||
    hasRunningGoalContinuationMessage(messages)
  );
}
