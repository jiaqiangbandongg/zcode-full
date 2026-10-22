import type { SourceServerConnectionStateSnapshot } from "@zcode/shared";
import type { WindowRemoteConnectionCloseEvent } from "./windowRemoteConnectionRegistry.js";

export function isSourceServerAutomaticRecoveryTerminalState(
  state: SourceServerConnectionStateSnapshot | undefined,
): boolean {
  return (
    state?.state === "needs-install" ||
    state?.state === "needs-upgrade" ||
    state?.state === "identity-change-pending" ||
    (state?.state === "failed" && state.retryable === false)
  );
}

export function createSourceServerRecoveryCloseEvent(
  state: SourceServerConnectionStateSnapshot,
): WindowRemoteConnectionCloseEvent | undefined {
  if (
    state.state !== "retrying" &&
    state.state !== "offline" &&
    !isSourceServerAutomaticRecoveryTerminalState(state)
  ) {
    return undefined;
  }
  return {
    exitCode: null,
    signal: null,
    recoverable: state.state === "retrying",
    ...(state.error ? { error: state.error } : {}),
    ...(state.recoveryAttempt ? { recoveryAttempt: state.recoveryAttempt } : {}),
    ...(state.recoveryLimit ? { recoveryLimit: state.recoveryLimit } : {}),
    ...(state.recoveryBudgetExhausted !== undefined
      ? { recoveryBudgetExhausted: state.recoveryBudgetExhausted }
      : {}),
    ...(state.errorCode ? { reasonCode: state.errorCode } : {}),
    ...(state.retryable !== undefined ? { retryable: state.retryable } : {}),
  };
}
