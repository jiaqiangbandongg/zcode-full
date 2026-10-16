import { describe, expect, it } from "vitest";
import type { ZCodeContextCompactionTimelineMeta } from "@zcode/shared";
import {
  isRunningContextCompactionTimeline,
  shouldContextCompactionTimelineCompleteTask,
} from "../src/lib/contextCompactionRuntime.js";

function createTimeline(
  overrides: Partial<ZCodeContextCompactionTimelineMeta>,
): ZCodeContextCompactionTimelineMeta {
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId: "cmp-test",
    status: "completed",
    trigger: "manual",
    display: "separator",
    ...overrides,
  };
}

describe("context compaction runtime helpers", () => {
  it("keeps auto pre-request terminal compaction inside the running outer turn", () => {
    expect(
      shouldContextCompactionTimelineCompleteTask(
        createTimeline({
          trigger: "auto",
          phase: "pre_request",
          status: "completed",
        }),
      ),
    ).toBe(false);
  });

  it("completes manual standalone compaction terminal events", () => {
    expect(
      shouldContextCompactionTimelineCompleteTask(
        createTimeline({
          trigger: "manual",
          phase: "standalone_turn",
          status: "completed",
        }),
      ),
    ).toBe(true);
  });

  it("treats local manual compact failures without phase as standalone", () => {
    expect(
      shouldContextCompactionTimelineCompleteTask(
        createTimeline({
          trigger: "manual",
          status: "failed",
        }),
      ),
    ).toBe(true);
  });

  it("identifies running compaction timeline statuses", () => {
    expect(isRunningContextCompactionTimeline(createTimeline({ status: "started" }))).toBe(true);
    expect(isRunningContextCompactionTimeline(createTimeline({ status: "retrying" }))).toBe(true);
    expect(isRunningContextCompactionTimeline(createTimeline({ status: "completed" }))).toBe(false);
  });
});
