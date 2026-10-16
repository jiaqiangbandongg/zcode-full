import { describe, expect, it } from "vitest";
import { resolveOffPeakHistoryStatus } from "@/settings/OffPeakHistoryTab.js";

describe("idle-time task history status", () => {
  it.each([
    ["completed", "succeeded"],
    ["failed", "failed"],
    ["cancelled", "skipped"],
    ["running", "running"],
  ] as const)("%s 映射为 %s", (status, expected) => {
    expect(resolveOffPeakHistoryStatus({ status })).toBe(expected);
  });
});
