import { describe, expect, it } from "vitest";

describe("WelcomeScreen", () => {
  it("已有用户不会完成新发起的 Provider 登录尝试", async () => {
    const { shouldCompleteLoginFromExistingUser, shouldCompleteProviderLoginAttempt } =
      await import("@/WelcomeScreen.js");
    const attempt = { id: 9, providerId: "bigmodel" as const };

    expect(shouldCompleteLoginFromExistingUser({ hasUser: true, attempt })).toBe(false);
    expect(shouldCompleteProviderLoginAttempt({ attempt, successProvider: "zai" })).toBe(false);
    expect(shouldCompleteProviderLoginAttempt({ attempt, successProvider: "bigmodel" })).toBe(true);
  });
});
