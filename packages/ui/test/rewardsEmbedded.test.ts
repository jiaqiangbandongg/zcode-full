import { describe, expect, it } from "vitest";
import {
  buildRewardsUrl,
  isTrustedRewardsUrl,
  resolveRewardsOrigin,
  REWARDS_PARTITION,
  REWARDS_CONTEXT_EVENT,
} from "@zcode/shared";

describe("Rewards embedded contract", () => {
  it("直接使用新分区和事件，旧主页不再受信任", () => {
    expect(REWARDS_PARTITION).toBe("persist:zcode-rewards");
    expect(REWARDS_CONTEXT_EVENT).toBe("zcode-rewards-context");
    for (const lang of ["cn", "en"]) {
      expect(isTrustedRewardsUrl(`https://zcode.z.ai/${lang}/referrals?embedded=app`)).toBe(false);
      expect(
        isTrustedRewardsUrl(`http://localhost:3000/${lang}/referrals?embedded=app`, { dev: true }),
      ).toBe(false);
    }
  });
  it("解析三环境及 cn/en 和主题", () => {
    expect(resolveRewardsOrigin({ env: "test", dev: true })).toBe("https://zcode.z.ai");
    expect(resolveRewardsOrigin({ env: "production", dev: true })).toBe("https://zcode.z.ai");
    expect(resolveRewardsOrigin({ env: "test" })).toBe("https://zcode.z.ai");
    expect(resolveRewardsOrigin({ env: "production" })).toBe("https://zcode.z.ai");
    expect(buildRewardsUrl("https://zcode.z.ai", "zh-CN", "zai-light")).toBe(
      "https://zcode.z.ai/cn/rewards?embedded=app&theme=zai-light",
    );
    expect(buildRewardsUrl("https://zcode.z.ai", "en-US", "zai-dark")).toContain(
      "/en/rewards?",
    );
  });
  it("本地网页必须显式覆盖且仅开发模式允许", () => {
    for (const env of ["test", "production"] as const) {
      expect(resolveRewardsOrigin({ env, dev: true, override: "http://localhost:3000" })).toBe(
        "http://localhost:3000",
      );
      expect(resolveRewardsOrigin({ env, override: "http://localhost:3000" })).toBe(
        env === "test" ? "https://zcode.z.ai" : "https://zcode.z.ai",
      );
    }
  });
  it("只允许可信 origin 和精确 rewards 路径", () => {
    expect(resolveRewardsOrigin({ env: "production", override: "not-a-url" })).toBe(
      "https://zcode.z.ai",
    );
    expect(isTrustedRewardsUrl("https://zcode.z.ai/en/rewards?embedded=app")).toBe(true);
    for (const url of [
      "https://zcode.z.ai.evil.test/en/rewards?embedded=app",
      "https://user@zcode.z.ai/en/rewards?embedded=app",
      "https://zcode.z.ai/en/rewards-fake?embedded=app",
      "https://zcode.z.ai/en/rewards",
      "http://localhost:3000/en/rewards?embedded=app",
    ]) {
      expect(isTrustedRewardsUrl(url)).toBe(false);
    }
    expect(
      isTrustedRewardsUrl("http://localhost:3000/cn/rewards?embedded=app", { dev: true }),
    ).toBe(true);
  });
});
