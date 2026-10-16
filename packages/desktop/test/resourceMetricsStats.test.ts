import { describe, expect, it } from "vitest";
import { appendBoundedSamples, computeAggregateStats } from "../src/main/resourceMetricsStats.js";

describe("resourceMetricsStats", () => {
  it("computes mean peak p95", () => {
    const stats = computeAggregateStats([10, 20, 30, 40, 50]);
    expect(stats.sample_count).toBe(5);
    expect(stats.mean).toBe(30);
    expect(stats.peak).toBe(50);
    expect(stats.p95).toBe(50);
  });

  it("bounds sample array", () => {
    const next = appendBoundedSamples([1, 2, 3], 4, 3);
    expect(next).toEqual([2, 3, 4]);
  });
});
