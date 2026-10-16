import { describe, expect, it } from "vitest";
import {
  getCommunityUrlFromConfig,
  getCommunityUrlFromConfigs,
  getFeedbackUrlFromConfig,
  getForceUpdateMinimalVersionFromConfig,
} from "../src/remoteAppConfig.js";

describe("remoteAppConfig", () => {
  it("读取 feedback_url", () => {
    expect(
      getFeedbackUrlFromConfig({
        feedback_url: "https://example.com/feedback",
      }),
    ).toBe("https://example.com/feedback");
  });

  it("中文界面只读取中文社群地址", () => {
    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "zh-CN": "https://example.com/zh-community",
            "en-US": "https://example.com/en-community",
          },
        },
        "zh-CN",
      ),
    ).toBe("https://example.com/zh-community");

    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "en-US": "https://example.com/en-community",
          },
        },
        "zh-CN",
      ),
    ).toBeUndefined();
  });

  it("英文界面只读取英文社群地址", () => {
    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "zh-CN": "https://example.com/zh-community",
            "en-US": "https://example.com/en-community",
          },
        },
        "en-US",
      ),
    ).toBe("https://example.com/en-community");

    expect(
      getCommunityUrlFromConfig(
        {
          community_urls: {
            "zh-CN": "https://example.com/zh-community",
          },
        },
        "en-US",
      ),
    ).toBeUndefined();
  });

  it("两个语言渠道都缺失时返回 undefined", () => {
    expect(getCommunityUrlFromConfig({}, "zh-CN")).toBeUndefined();
  });

  it("远端缺少当前语言时优先使用内置同语言入口", () => {
    expect(
      getCommunityUrlFromConfigs(
        {
          community_urls: {
            "zh-CN": "https://remote.example.com/feishu",
          },
        },
        {
          community_urls: {
            "zh-CN": "https://local.example.com/feishu",
            "en-US": "https://local.example.com/discord",
          },
        },
        "en-US",
      ),
    ).toBe("https://local.example.com/discord");
  });

  it("读取 forceUpdate minimalVersion", () => {
    expect(
      getForceUpdateMinimalVersionFromConfig({
        forceUpdate: {
          minimalVersion: " 4.0.0 ",
        },
      }),
    ).toBe("4.0.0");

    expect(getForceUpdateMinimalVersionFromConfig({})).toBeUndefined();
    expect(
      getForceUpdateMinimalVersionFromConfig({
        forceUpdate: {
          minimalVersion: "",
        },
      }),
    ).toBeUndefined();
  });
});
