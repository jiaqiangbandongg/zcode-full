import { describe, expect, it } from "vitest";
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import {
  mergeEndedSubagentPages,
  resolveEndedSubagentRefreshTargetCount,
} from "@/hooks/useSessionSubagents.js";

function ended(childSessionId: string, endedAt: number): ZCodeSessionEndedSubagent {
  return {
    childSessionId,
    subagentType: "Explore",
    title: childSessionId,
    status: "success",
    endedAt,
  };
}

describe("useSessionSubagents pagination", () => {
  it("appends older cursor pages without reversing newest-first order", () => {
    expect(
      mergeEndedSubagentPages(
        [ended("newest", 30), ended("middle", 20)],
        [ended("middle", 20), ended("oldest", 10)],
      ).map((item) => item.childSessionId),
    ).toEqual(["newest", "middle", "oldest"]);
  });

  it("keeps already loaded ended items when a running Agent completes", () => {
    expect(
      resolveEndedSubagentRefreshTargetCount({
        loadedItemCount: 40,
        previousTotal: 92,
        nextTotal: 93,
        requestedCount: 40,
      }),
    ).toBe(41);
    expect(
      resolveEndedSubagentRefreshTargetCount({
        loadedItemCount: 0,
        previousTotal: 0,
        nextTotal: 92,
        requestedCount: 20,
      }),
    ).toBe(20);
  });
});
