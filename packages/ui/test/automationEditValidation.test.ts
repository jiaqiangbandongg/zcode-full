import { describe, expect, it } from "vitest";
import {
  clearAutomationEditRequiredFieldError,
  resolveAutomationEditRequiredFieldErrors,
} from "@/settings/automationEditValidation.js";

describe("automation edit validation", () => {
  it("reports required fields in a stable visual order", () => {
    expect(
      resolveAutomationEditRequiredFieldErrors({
        title: " ",
        cronExpr: "",
        prompt: "\n",
      }),
    ).toEqual(["title", "schedule", "prompt"]);
  });

  it("normal field edits only clear existing validation feedback", () => {
    const errors = new Set(["title", "schedule", "prompt"] as const);

    expect(clearAutomationEditRequiredFieldError(errors, "schedule")).toEqual(
      new Set(["title", "prompt"]),
    );
    expect(clearAutomationEditRequiredFieldError(new Set(), "schedule")).toEqual(new Set());
  });
});
