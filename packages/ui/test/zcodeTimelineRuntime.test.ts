import { describe, expect, it } from "vitest";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";
import {
  hasRunningGoalContinuationMessage,
  hasRunningGoalRuntimeSignal,
} from "@/lib/zcodeTimelineRuntime.js";

describe("hasRunningGoalRuntimeSignal", () => {
  it("detects running goal verification timelines", () => {
    const message = {
      id: "goal-verification-started",
      role: "assistant",
      content: "",
      timestamp: 1,
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "goal_verification",
        display: "separator",
        targetId: "target-1",
        verificationId: "verification-1",
        status: "started",
        updatedAt: 1,
      },
    } satisfies TaskChatMessage;

    expect(hasRunningGoalRuntimeSignal([message])).toBe(true);
  });

  it("does not treat a started goal verification with a result as running", () => {
    const message = {
      id: "goal-verification-settled-started",
      role: "assistant",
      content: "",
      timestamp: 1,
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "goal_verification",
        display: "separator",
        targetId: "target-1",
        verificationId: "verification-1",
        status: "started",
        verification: {
          passed: true,
          reason: "目标已完成。",
        },
        updatedAt: 1,
      },
    } satisfies TaskChatMessage;

    expect(hasRunningGoalRuntimeSignal([message])).toBe(false);
  });

  it("detects goal continuation streaming boundaries without goalIteration", () => {
    const message = {
      id: "goal-continuation-stream",
      role: "assistant",
      content: "checkpoint 2",
      timestamp: 2,
      streaming: true,
      streamGroupId: "turn-goal-2",
    } satisfies TaskChatMessage;

    expect(hasRunningGoalContinuationMessage([message])).toBe(true);
    expect(hasRunningGoalRuntimeSignal([message])).toBe(true);
  });

  it("does not treat a normal streaming assistant as active goal runtime", () => {
    const message = {
      id: "normal-stream",
      role: "assistant",
      content: "正常回答",
      timestamp: 3,
      streaming: true,
    } satisfies TaskChatMessage;

    expect(hasRunningGoalRuntimeSignal([message])).toBe(false);
  });
});
