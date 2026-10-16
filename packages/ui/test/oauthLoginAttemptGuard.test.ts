import { describe, expect, it } from "vitest";
import {
  shouldApplyOAuthPollingFailure,
} from "../src/root/oauthLoginAttemptGuard.js";

describe("OAuth login attempt guard", () => {
  it("ignores a polling failure after callback success", () => {
    expect(shouldApplyOAuthPollingFailure(true)).toBe(false);
    expect(shouldApplyOAuthPollingFailure(false)).toBe(true);
  });

  it("ignores a failure while the success callback is still completing", () => {
    expect(shouldApplyOAuthPollingFailure(false, true)).toBe(false);
  });
});
