import { describe, expect, it } from "vitest";
import { isOnlineModelFallbackAuthoritative } from "@/v4/composer/onlineModelFallback.js";

const transition = {
  from: { provider: "provider-a", model: "model-a" },
  to: { provider: "provider-b", model: "model-b" },
};

describe("isOnlineModelFallbackAuthoritative", () => {
  it("accepts only the target session projection matching the fallback destination", () => {
    expect(
      isOnlineModelFallbackAuthoritative({
        targetSessionId: "session-b",
        current: {
          sessionId: "session-b",
          config: { provider: "provider-b", model: "model-b", thought: "high" },
        },
        transition,
        hasPendingExplicitIntent: false,
      }),
    ).toBe(true);
  });

  it("rejects stale sessions and explicit user intents", () => {
    const current = {
      sessionId: "session-a",
      config: { provider: "provider-b", model: "model-b", thought: "high" },
    };
    expect(
      isOnlineModelFallbackAuthoritative({
        targetSessionId: "session-b",
        current,
        transition,
        hasPendingExplicitIntent: false,
      }),
    ).toBe(false);
    expect(
      isOnlineModelFallbackAuthoritative({
        targetSessionId: "session-a",
        current,
        transition,
        hasPendingExplicitIntent: true,
      }),
    ).toBe(false);
  });
});
