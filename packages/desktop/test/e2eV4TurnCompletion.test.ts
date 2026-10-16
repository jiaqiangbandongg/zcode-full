import { describe, expect, it } from "vitest";

import { isV4TurnCompleted } from "./e2e/helpers/v4-turn-completion.js";

describe("desktop e2e v4 turn completion", () => {
  it("does not treat the pre-run idle frame as turn completion", () => {
    expect(
      isV4TurnCompleted(
        {
          canStop: false,
          sessionId: "sess-a",
          timelineText: "only the submitted user prompt",
        },
        "I55_A_SEED_DONE",
      ),
    ).toBe(false);
  });

  it("requires both the expected assistant reply and an idle projection", () => {
    const completed = {
      canStop: false,
      sessionId: "sess-a",
      timelineText: "user prompt\nI55_A_SEED_DONE",
    };

    expect(isV4TurnCompleted(completed, "I55_A_SEED_DONE")).toBe(true);
    expect(isV4TurnCompleted({ ...completed, canStop: true }, "I55_A_SEED_DONE")).toBe(false);
    expect(isV4TurnCompleted({ ...completed, sessionId: "draft" }, "I55_A_SEED_DONE")).toBe(
      false,
    );
  });
});
