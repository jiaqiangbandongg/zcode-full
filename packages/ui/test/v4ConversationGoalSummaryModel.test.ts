import { describe, expect, it } from "vitest";
import type { GoalState } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationGoalIterationSummaries,
  getConversationGoalElapsedSeconds,
} from "@/v4/conversationGoalSummaryModel.js";

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    targetId: "goal-1",
    objective: "完成摘要",
    summaryTitle: "第一轮 action",
    timeUsedSeconds: 5,
    activeRunStartedAtMs: null,
    status: "active",
    iteration: 1,
    verifications: [],
    iterations: [],
    ...overrides,
  };
}

describe("conversationGoalSummaryModel", () => {
  it("uses verifier nextAction for the next round and sorts completed rounds first", () => {
    const rows = buildConversationGoalIterationSummaries(
      goal({
        verifications: [
          {
            iteration: 1,
            outcome: "notSatisfied",
            at: 100,
            anchorRowId: null,
            nextAction: "第二轮 action",
          },
        ],
        iterations: [
          {
            iteration: 1,
            updatedAt: 100,
            items: [{ id: "1", content: "完成", status: "completed" }],
          },
          {
            iteration: 2,
            updatedAt: 200,
            items: [{ id: "2", content: "继续", status: "inProgress" }],
          },
        ],
      }),
    );

    expect(rows.map((row) => row.iteration)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ title: "第一轮 action", completed: true });
    expect(rows[1]).toMatchObject({ title: "第二轮 action", completed: false });
  });

  it("keeps no-todo rounds visible and hides the internal verifier fallback action", () => {
    const rows = buildConversationGoalIterationSummaries(
      goal({
        verifications: [
          {
            iteration: 1,
            outcome: "notSatisfied",
            at: 100,
            anchorRowId: null,
            nextAction: "Continue verifying and completing the goal.",
          },
        ],
      }),
    );

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ iteration: 2, title: null, totalCount: 0, completed: false });
  });

  it("adds only the active run delta and freezes paused/verified elapsed", () => {
    expect(
      getConversationGoalElapsedSeconds(
        goal({ activeRunStartedAtMs: 10_000, status: "active", timeUsedSeconds: 5 }),
        13_900,
      ),
    ).toBe(8);
    expect(
      getConversationGoalElapsedSeconds(
        goal({ activeRunStartedAtMs: 10_000, status: "paused", timeUsedSeconds: 5 }),
        99_000,
      ),
    ).toBe(5);
    expect(
      getConversationGoalElapsedSeconds(
        goal({ activeRunStartedAtMs: 20_000, status: "active", timeUsedSeconds: 5 }),
        10_000,
      ),
    ).toBe(5);
  });
});
