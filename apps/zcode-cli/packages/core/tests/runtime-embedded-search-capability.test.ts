import { describe, expect, it } from "vitest";
import {
  evaluateEmbeddedSearchBranchCapability,
  resolveEmbeddedSearchBranchCapability,
} from "../src/embedded-search/capability.js";

describe("embedded search branch capability", () => {
  it("depends only on branch enablement and Bash availability", () => {
    expect(resolveEmbeddedSearchBranchCapability({ bashAvailable: true })).toEqual({
      reason: "supported",
      useEmbeddedSearchBranch: true,
    });
    expect(resolveEmbeddedSearchBranchCapability({ bashAvailable: false })).toEqual({
      reason: "bash_unavailable",
      useEmbeddedSearchBranch: false,
    });
  });

  it("lets the explicit global flag short-circuit the branch", () => {
    expect(
      evaluateEmbeddedSearchBranchCapability({
        bashAvailable: true,
        embeddedSearchBranchEnabled: false,
      }),
    ).toEqual({
      reason: "disabled_by_global_flag",
      useEmbeddedSearchBranch: false,
    });
  });
});
