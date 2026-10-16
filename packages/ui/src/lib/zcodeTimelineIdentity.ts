import type { ZCodeTimelineMeta } from "@zcode/shared";

function addTimelineIdentityKey(
  keys: string[],
  prefix: string,
  value: string | undefined,
): void {
  if (value) {
    keys.push(`${prefix}:${value}`);
  }
}

export function getZCodeTimelineIdentityKeys(
  timeline: ZCodeTimelineMeta,
): string[] {
  const keys: string[] = [];
  if (timeline.type === "context_compaction") {
    addTimelineIdentityKey(
      keys,
      "synthetic:context_compaction:operation",
      timeline.operationId,
    );
    addTimelineIdentityKey(
      keys,
      "synthetic:context_compaction:input",
      timeline.inputId,
    );
    addTimelineIdentityKey(
      keys,
      "synthetic:context_compaction:boundary",
      timeline.boundaryId,
    );
    addTimelineIdentityKey(
      keys,
      "synthetic:context_compaction:summary",
      timeline.summaryMessageId,
    );
    return keys;
  }
  if (timeline.type === "goal_verification") {
    if (typeof timeline.goalIteration === "number") {
      keys.push(
        `synthetic:goal_verification:iteration:${timeline.targetId}:${timeline.goalIteration}`,
      );
    }
    addTimelineIdentityKey(
      keys,
      "synthetic:goal_verification:verification",
      timeline.verificationId,
    );
    return keys;
  }
  addTimelineIdentityKey(
    keys,
    "synthetic:session_fork:parent",
    timeline.parentSessionId,
  );
  if (timeline.targetMessageId) {
    keys.push(
      [
        "synthetic:session_fork:target",
        timeline.parentSessionId,
        timeline.targetMessageId,
        timeline.targetCheckpointId ?? "",
      ].join(":"),
    );
  }
  return keys;
}

export function hasSharedZCodeTimelineIdentity(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((key) => right.includes(key));
}

export function mergeZCodeTimelineMeta(
  previousTimeline: ZCodeTimelineMeta | undefined,
  nextTimeline: ZCodeTimelineMeta,
): ZCodeTimelineMeta {
  if (
    previousTimeline?.type === "context_compaction" &&
    nextTimeline.type === "context_compaction"
  ) {
    return {
      ...previousTimeline,
      ...nextTimeline,
      ...((nextTimeline.command ?? previousTimeline.command)
        ? { command: nextTimeline.command ?? previousTimeline.command }
        : {}),
      ...((nextTimeline.inputId ?? previousTimeline.inputId)
        ? { inputId: nextTimeline.inputId ?? previousTimeline.inputId }
        : {}),
    };
  }
  if (
    previousTimeline?.type === "goal_verification" &&
    nextTimeline.type === "goal_verification"
  ) {
    return {
      ...previousTimeline,
      ...nextTimeline,
      ...((nextTimeline.verification ?? previousTimeline.verification)
        ? {
            verification:
              nextTimeline.verification ?? previousTimeline.verification,
          }
        : {}),
      ...((nextTimeline.startedAt ?? previousTimeline.startedAt)
        ? { startedAt: nextTimeline.startedAt ?? previousTimeline.startedAt }
        : {}),
    };
  }
  return nextTimeline;
}
