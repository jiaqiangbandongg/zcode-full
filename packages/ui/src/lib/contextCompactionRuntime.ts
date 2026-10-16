import type { ZCodeContextCompactionTimelineMeta } from "@zcode/shared";

const RUNNING_CONTEXT_COMPACTION_STATUSES = new Set(["started", "retrying"]);

export function isRunningContextCompactionTimeline(
  timeline: ZCodeContextCompactionTimelineMeta,
): boolean {
  return RUNNING_CONTEXT_COMPACTION_STATUSES.has(timeline.status);
}

export function shouldContextCompactionTimelineCompleteTask(
  timeline: ZCodeContextCompactionTimelineMeta,
): boolean {
  if (isRunningContextCompactionTimeline(timeline)) {
    return false;
  }

  if (timeline.phase === "standalone_turn") {
    return true;
  }

  // 修复原因：本地 `/compact` 失败兜底事件可能早于 agent 回填 phase。
  // 这类手动命令本身就是独立 turn，终态仍应收口 task。
  return timeline.trigger === "manual" && timeline.phase === undefined;
}
