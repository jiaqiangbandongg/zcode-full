import { describe, expect, it } from "vitest";

import { resolveAskUserQuestionClockScaleForWorker } from "./e2e/helpers/e2e-worker-environment.js";

describe("E2E worker environment resolution", () => {
  it("injects the accelerated clock only for the pending auto-resolution case", () => {
    expect(
      resolveAskUserQuestionClockScaleForWorker({
        specs: [
          "./test/e2e/conversation-session/manual-review/pending/conversation-session-ask-user-question-auto-resolution-setting.test.ts",
        ],
      }),
    ).toBe("20");
    expect(
      resolveAskUserQuestionClockScaleForWorker({
        specs: ["./test/e2e/conversation-session/conversation-session-v4-edit.test.ts"],
      }),
    ).toBeUndefined();
  });

  it("preserves an explicitly requested valid clock scale", () => {
    expect(
      resolveAskUserQuestionClockScaleForWorker({
        requestedScale: "25",
        specs: [
          "./test/e2e/conversation-session/manual-review/pending/conversation-session-ask-user-question-auto-resolution-setting.test.ts",
        ],
      }),
    ).toBe("25");
  });
});
