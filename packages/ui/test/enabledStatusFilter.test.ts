import { describe, expect, it } from "vitest";
import { matchesEnabledStatusFilter } from "@/settings/EnabledStatusFilterSelect.js";

describe("matchesEnabledStatusFilter", () => {
  it("returns true for all regardless of enabled", () => {
    expect(matchesEnabledStatusFilter(true, "all")).toBe(true);
    expect(matchesEnabledStatusFilter(false, "all")).toBe(true);
  });

  it("filters enabled and disabled", () => {
    expect(matchesEnabledStatusFilter(true, "enabled")).toBe(true);
    expect(matchesEnabledStatusFilter(false, "enabled")).toBe(false);
    expect(matchesEnabledStatusFilter(false, "disabled")).toBe(true);
    expect(matchesEnabledStatusFilter(true, "disabled")).toBe(false);
  });
});