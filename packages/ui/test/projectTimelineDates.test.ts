import { afterEach, describe, expect, it, vi } from "vitest";
import { timelineDateHeadings } from "@/project-sidebar/timelineDates.js";

const date = (month: number, day: number, hour = 12) =>
  new Date(2026, month - 1, day, hour).getTime();
afterEach(() => vi.unstubAllEnvs());

describe("SBV03: timeline calendar headings", () => {
  it("matches staging date buckets without reordering or counting headings as tasks", () => {
    const times = [
      date(9, 18),
      date(9, 17),
      date(9, 16),
      date(9, 15),
      date(9, 14),
      date(9, 10),
      date(9, 1),
      date(8, 1),
      date(7, 1),
    ];
    expect(timelineDateHeadings(times, date(9, 18, 23), "zh-CN").map((h) => h?.key)).toEqual([
      "today",
      "yesterday",
      "daysAgo:2",
      "daysAgo:3",
      "thisWeek",
      "lastWeek",
      "thisMonth",
      "lastMonth",
      "older",
    ]);
    expect(timelineDateHeadings([date(9, 16)], date(9, 18), "zh-CN")[0]).toMatchObject({
      id: "taskTimeline.daysAgo",
      values: { days: "2" },
    });
  });

  it("adds no duplicate heading when the next page continues the same date bucket", () => {
    const times = [...Array<number>(22).fill(date(9, 18)), date(9, 17)];
    const first = timelineDateHeadings(times.slice(0, 20), date(9, 18), "en-US");
    const expanded = timelineDateHeadings(times, date(9, 18), "en-US");
    expect(expanded.slice(0, 20)).toEqual(first);
    expect(expanded.filter(Boolean).map((h) => h?.key)).toEqual(["today", "yesterday"]);
    expect(expanded).toHaveLength(times.length);
  });

  it("derives new headings after an update moves a task to another day", () => {
    expect(
      timelineDateHeadings([date(9, 17), date(9, 17)], date(9, 18), "zh-CN").map((h) => h?.key),
    ).toEqual(["yesterday", undefined]);
    expect(
      timelineDateHeadings([date(9, 18), date(9, 17)], date(9, 18), "zh-CN").map((h) => h?.key),
    ).toEqual(["today", "yesterday"]);
  });

  it("uses the locale week boundary", () => {
    expect(timelineDateHeadings([date(9, 20)], date(9, 24), "en-US")[0]?.key).toBe("thisWeek");
    expect(timelineDateHeadings([date(9, 20)], date(9, 24), "zh-CN")[0]?.key).toBe("lastWeek");
  });

  it("uses calendar days across daylight saving and year boundaries", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(
      timelineDateHeadings(
        [new Date(2026, 2, 7, 23).getTime()],
        new Date(2026, 2, 9, 1).getTime(),
        "en-US",
      )[0]?.key,
    ).toBe("daysAgo:2");
    expect(
      timelineDateHeadings(
        [new Date(2025, 11, 31, 23).getTime()],
        new Date(2026, 0, 1, 1).getTime(),
        "en-US",
      )[0]?.key,
    ).toBe("yesterday");
    expect(timelineDateHeadings([], date(9, 18), "en-US")).toEqual([]);
  });
});
