import { describe, expect, it } from "vitest";
import { resolveManualClaimFailureMessageId } from "@/components/manual-claim-plan/manualClaimFailureMessage.js";

describe("shared claim failure copy without legacy mock UI", () => {
  it("preserves unknown failure messages", () => {
    expect(resolveManualClaimFailureMessageId(9999)).toBe("manualClaimPlan.claim.failure.generic");
  });
});
