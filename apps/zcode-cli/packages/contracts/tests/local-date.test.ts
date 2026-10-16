import { describe, expect, it } from "vitest";
import { formatLocalIsoDate } from "../src/index.js";

describe("local date helpers", () => {
  it("formats the local calendar date as YYYY-MM-DD", () => {
    expect(formatLocalIsoDate(new Date(2026, 4, 5, 2, 46, 0))).toBe("2026-05-05");
  });

  it("uses local date fields instead of UTC slicing", () => {
    expect(formatLocalIsoDate(new Date(2026, 0, 2, 0, 30, 0))).toBe("2026-01-02");
  });
});
