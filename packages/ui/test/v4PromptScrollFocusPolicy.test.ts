import { describe, expect, it } from "vitest";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";

describe("V4 prompt scroll focus policy", () => {
  it("focuses the latest content after draft and start-now sends", () => {
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: true,
        inputRoutingMode: null,
      }),
    ).toBe(true);
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: false,
        inputRoutingMode: "startNow",
      }),
    ).toBe(true);
  });

  it("preserves the reading position when the new prompt only enqueues", () => {
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: false,
        inputRoutingMode: "enqueue",
      }),
    ).toBe(false);
  });

  it("focuses after either held-queue choice because both start immediately", () => {
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: false,
        inputRoutingMode: "choice",
        heldQueueDisposition: "clearQueueAndSend",
      }),
    ).toBe(true);
    expect(
      shouldFocusTimelineAfterComposerSend({
        draftMode: false,
        inputRoutingMode: "choice",
        heldQueueDisposition: "keepQueueAndSend",
      }),
    ).toBe(true);
  });
});
