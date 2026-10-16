import { describe, expect, it } from "vitest";
import { collectWebRemoteControlMobileDeviceInfo } from "../src/webRemoteControlDeviceInfo.js";

describe("collectWebRemoteControlMobileDeviceInfo", () => {
  it("collects stable browser device info without requiring mobile-only APIs", () => {
    const deviceInfo = collectWebRemoteControlMobileDeviceInfo({
      appVersion: "1.7.0",
      now: () => 123,
      navigatorLike: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        language: "zh-CN",
        languages: ["zh-CN", "en-US"],
        platform: "iPhone",
        onLine: true,
      },
      windowLike: {
        innerWidth: 390,
        innerHeight: 844,
        devicePixelRatio: 3,
        screen: {
          width: 390,
          height: 844,
        },
      },
      dateTimeFormat: () => ({
        resolvedOptions: () => ({ timeZone: "Asia/Shanghai" }),
      }),
    });

    expect(deviceInfo).toEqual({
      platform: "web",
      version: "1.7.0",
      name: "mobile-browser",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      language: "zh-CN",
      languages: ["zh-CN", "en-US"],
      browserPlatform: "iPhone",
      viewport: {
        width: 390,
        height: 844,
        devicePixelRatio: 3,
      },
      screen: {
        width: 390,
        height: 844,
      },
      timezone: "Asia/Shanghai",
      online: true,
      updatedAt: 123,
    });
  });
});
