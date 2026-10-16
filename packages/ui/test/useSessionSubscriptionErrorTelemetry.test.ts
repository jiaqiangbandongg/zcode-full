// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  resolveSessionSubscriptionErrorCode,
  useSessionSubscriptionErrorTelemetry,
} from "@/v4/telemetry/useSessionSubscriptionErrorTelemetry.js";

describe("useSessionSubscriptionErrorTelemetry", () => {
  it("preserves a standalone structured subscription reason code", () => {
    expect(
      resolveSessionSubscriptionErrorCode("fault.subscription.recoveryFailed"),
    ).toBe("fault.subscription.recoveryFailed");
  });

  it("reports each visible subscription error once through chat_error_banner", () => {
    const reportVisibleChatError = vi.fn();
    const message =
      "Session is not active and not persisted: session-1 (fault.subscribe.sessionNotFound)";
    const { rerender } = renderHook(
      (props: { lastError: string | null; visible: boolean }) =>
        useSessionSubscriptionErrorTelemetry({
          supervisor: { reportVisibleChatError },
          sessionId: "session-1",
          lastError: props.lastError,
          visible: props.visible,
        }),
      {
        initialProps: {
          lastError: message,
          visible: true,
        },
      },
    );

    expect(reportVisibleChatError).toHaveBeenCalledTimes(1);
    expect(reportVisibleChatError).toHaveBeenCalledWith({
      surface: "session_subscription_error",
      errorKey: `session-1:fault.subscribe.sessionNotFound:${message}`,
      displayMessage: message,
      error: {
        code: "fault.subscribe.sessionNotFound",
        message,
        taskId: "session-1",
      },
    });

    rerender({ lastError: message, visible: true });
    expect(reportVisibleChatError).toHaveBeenCalledTimes(1);

    rerender({
      lastError: "Connection closed (fault.subscription.runtimeRestarted)",
      visible: true,
    });
    expect(reportVisibleChatError).toHaveBeenCalledTimes(2);
  });

  it("does not report hidden or draft subscription failures", () => {
    const reportVisibleChatError = vi.fn();
    const message = "Session is not active (fault.subscribe.sessionNotFound)";

    const { rerender } = renderHook(
      (props: { sessionId: string | null; visible: boolean }) =>
        useSessionSubscriptionErrorTelemetry({
          supervisor: { reportVisibleChatError },
          sessionId: props.sessionId,
          lastError: message,
          visible: props.visible,
        }),
      {
        initialProps: {
          sessionId: "session-1",
          visible: false,
        },
      },
    );

    expect(reportVisibleChatError).not.toHaveBeenCalled();
    rerender({ sessionId: null, visible: true });
    expect(reportVisibleChatError).not.toHaveBeenCalled();
  });
});
