import { describe, expect, it } from "vitest";
import { buttonVariants } from "../src/components/ui/button.js";
import { selectTriggerVariants } from "../src/components/ui/select.js";

describe("buttonVariants", () => {
  it("generates className for outline variant", () => {
    const className = buttonVariants({ variant: "outline" });
    expect(typeof className).toBe("string");
    expect(className.length).toBeGreaterThan(0);
  });

  it("limits button transitions to color-related properties", () => {
    const className = buttonVariants({ variant: "ghost" });

    expect(className).not.toContain("transition-all");
    expect(className).toContain("transition-colors");
  });

  it("limits select trigger transitions to color-related properties", () => {
    const className = selectTriggerVariants({ variant: "ghost" });

    expect(className).not.toContain("transition-all");
    expect(className).toContain("transition-colors");
  });
});
