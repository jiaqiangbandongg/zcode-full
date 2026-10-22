import { describe, expect, it } from "vitest";
import { createSourceServerRecoveryCloseEvent } from "../src/host/sourceServerRecoveryPolicy.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";

describe("Source Server recovery policy", () => {
  it("projects installation confirmation as a terminal logical close", () => {
    expect(
      createSourceServerRecoveryCloseEvent({
        profileId,
        state: "needs-install",
        errorCode: "source-server-install-required",
        retryable: false,
        updatedAt: 1,
      }),
    ).toEqual({
      exitCode: null,
      signal: null,
      recoverable: false,
      reasonCode: "source-server-install-required",
      retryable: false,
    });
  });

  it("preserves retry progress and budget exhaustion metadata", () => {
    expect(
      createSourceServerRecoveryCloseEvent({
        profileId,
        state: "retrying",
        recoveryAttempt: 2,
        recoveryLimit: 3,
        updatedAt: 1,
      }),
    ).toEqual({
      exitCode: null,
      signal: null,
      recoverable: true,
      recoveryAttempt: 2,
      recoveryLimit: 3,
    });
    expect(
      createSourceServerRecoveryCloseEvent({
        profileId,
        state: "offline",
        error: "network unavailable",
        errorCode: "remote-recovery-budget-exhausted",
        recoveryAttempt: 3,
        recoveryLimit: 3,
        recoveryBudgetExhausted: true,
        retryable: true,
        updatedAt: 2,
      }),
    ).toEqual({
      exitCode: null,
      signal: null,
      recoverable: false,
      error: "network unavailable",
      recoveryAttempt: 3,
      recoveryLimit: 3,
      recoveryBudgetExhausted: true,
      reasonCode: "remote-recovery-budget-exhausted",
      retryable: true,
    });
  });

  it("projects only non-retryable failures as terminal closes", () => {
    expect(
      createSourceServerRecoveryCloseEvent({
        profileId,
        state: "failed",
        error: "user action required",
        retryable: false,
        updatedAt: 1,
      }),
    ).toEqual({
      exitCode: null,
      signal: null,
      recoverable: false,
      error: "user action required",
      retryable: false,
    });
    expect(
      createSourceServerRecoveryCloseEvent({
        profileId,
        state: "failed",
        error: "transient",
        retryable: true,
        updatedAt: 2,
      }),
    ).toBeUndefined();
    expect(
      createSourceServerRecoveryCloseEvent({
        profileId,
        state: "online",
        updatedAt: 3,
      }),
    ).toBeUndefined();
  });
});
