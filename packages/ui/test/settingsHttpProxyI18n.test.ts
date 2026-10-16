import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

describe("settings HTTP proxy i18n", () => {
  it("中文显示不使用代理的地址标签且英文保持不变", () => {
    expect(zhCN["settings.httpProxyNoProxy"]).toBe("不使用代理的地址");
    expect(enUS["settings.httpProxyNoProxy"]).toBe("No proxy");
  });

  it("代理留空说明必须点明内置浏览器跟随系统代理", () => {
    // Bug 原因：文案曾统一写「留空时直连」，与内置浏览器实际跟随系统代理的行为漂移，
    // 用户会把「内置浏览器打不开需要代理的站点」当成产品缺陷而无从下手。
    expect(zhCN["settings.httpProxyDescription"]).toContain("内置浏览器则跟随系统代理");
    expect(enUS["settings.httpProxyDescription"]).toContain(
      "embedded browser follows your system proxy",
    );
  });
});
