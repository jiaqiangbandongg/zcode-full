import { describe, expect, it } from "vitest";
import { shouldReportLaunchToInput } from "@/lib/launchToInputReport.js";

describe("shouldReportLaunchToInput", () => {
  it("门禁已清除、非 welcome、未上报过 → 上报", () => {
    expect(
      shouldReportLaunchToInput({
        isStartupRenderBlocked: false,
        welcomeScreenOpen: false,
        alreadyReported: false,
      }),
    ).toBe(true);
  });

  it("门禁仍阻塞 → 不上报", () => {
    expect(
      shouldReportLaunchToInput({
        isStartupRenderBlocked: true,
        welcomeScreenOpen: false,
        alreadyReported: false,
      }),
    ).toBe(false);
  });

  it("WelcomeScreen 打开(未登录,无输入框) → 不上报", () => {
    expect(
      shouldReportLaunchToInput({
        isStartupRenderBlocked: false,
        welcomeScreenOpen: true,
        alreadyReported: false,
      }),
    ).toBe(false);
  });

  it("已上报过 → 不重复", () => {
    expect(
      shouldReportLaunchToInput({
        isStartupRenderBlocked: false,
        welcomeScreenOpen: false,
        alreadyReported: true,
      }),
    ).toBe(false);
  });
});
