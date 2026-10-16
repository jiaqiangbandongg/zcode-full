import { describe, expect, it } from "vitest";
import { resolveOffPeakMenuHintSide } from "@/settings/OffPeakTaskList.js";

describe("resolveOffPeakMenuHintSide", () => {
  it("keeps the menu hint on the right when the viewport has enough room", () => {
    expect(resolveOffPeakMenuHintSide({ right: 800 }, 1200)).toBe("right");
  });

  it("moves the menu hint above the trigger when right-side room is insufficient", () => {
    expect(resolveOffPeakMenuHintSide({ right: 760 }, 960)).toBe("top");
  });

  it("uses the non-overlapping fallback before the trigger is measurable", () => {
    expect(resolveOffPeakMenuHintSide(null, 960)).toBe("top");
  });
});
