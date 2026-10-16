import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "../src/share/conversationShareRoute.js";
import { resolveConversationShareRouteLocale } from "../src/share/conversationSharePreviewClient.js";

describe("conversation share route", () => {
  it("recognizes share paths without taking over remote routes", () => {
    expect(isConversationSharePath("/cn/share")).toBe(true);
    expect(isConversationSharePath("/cn/share/share-1")).toBe(true);
    expect(isConversationSharePath("/share")).toBe(true);
    expect(isConversationSharePath("/share/share-1")).toBe(true);
    expect(isConversationSharePath("/remote/v4")).toBe(false);
    expect(isConversationSharePath("/sharegate/x")).toBe(false);
  });

  it("英文站的裸 /share/ 不再被拒绝，两种前缀都能解析出 code", () => {
    // 此前 /share/<code> 走 isRejectedConversationSharePath，直接渲染 not_found，
    // 等于英文分享页根本不存在。
    expect(resolveConversationShareCodeFromPath("/cn/share/share-1")).toBe("share-1");
    expect(resolveConversationShareCodeFromPath("/share/share-1")).toBe("share-1");
    expect(resolveConversationShareCodeFromPath("/cn/share/share-1/extra")).toBeNull();
    expect(resolveConversationShareCodeFromPath("/share/")).toBeNull();
  });

  it("页面语言由路径前缀决定", () => {
    expect(resolveConversationShareRouteLocale("/cn/share/share-1")).toBe("zh-CN");
    expect(resolveConversationShareRouteLocale("/share/share-1")).toBe("en-US");
  });

  it("结果物计数跟随语言，不再中英混排", () => {
    // Bug 根因：原本硬编码英文 artifact/artifacts 且手写复数，中文页会渲染成
    // 「2026年9月3日 11:55 · 1 artifact」。
    const source = readFileSync("packages/web/src/share/ConversationShareLandingPage.tsx", "utf8");
    expect(source).toContain("artifactCountOne");
    expect(source).toContain("artifactCountOther");
    expect(source).toContain("{count} 个结果物");
    expect(source).not.toContain("artifact{artifactCount === 1");
  });

  it("英文分享 OAuth callback 与中文 callback 走同一回调页面", () => {
    const mainSource = readFileSync("packages/web/src/main.tsx", "utf8");
    const authSource = readFileSync("packages/web/src/auth/webAuthService.ts", "utf8");
    const stateSource = readFileSync("packages/web/src/auth/oauthStateCodec.ts", "utf8");
    expect(mainSource).toContain('"/share/callback"');
    expect(authSource).toContain('"/share/callback"');
    expect(stateSource).toContain('"/share/callback"');
    expect(stateSource).toContain("const SHARE_PATH_PATTERN");
    expect(stateSource).toContain("cn\\/share|share");
  });

  it("分享页同步 html lang 与浏览器标签标题", () => {
    // index.html 固定 lang="en"；不同步会让中文分享页对无障碍与浏览器翻译都报错语言。
    // 而 document.title 此前从未设置，标签只显示 index.html 的通用标题。
    const source = readFileSync("packages/web/src/main.tsx", "utf8");
    expect(source).toContain("document.documentElement.lang = routeLocale");
    expect(source).toMatch(/document\.title =\s*routeLocale === "zh-CN"/u);
  });

  it("dev server base 不能写死 /cn/share/，否则英文路由本地不可达", () => {
    // Bug 根因：dev 脚本写死 --base=/cn/share/，Vite 只服务该前缀，访问 /share/<code>
    // 会被 dev server 直接拒掉（"server is configured with a public base URL of /cn/share/"）。
    const source = readFileSync("scripts/dev-web-share-env.mjs", "utf8");
    expect(source).toContain('"--base=/"');
    expect(source).not.toContain('"--base=/cn/share/"');
  });

  it("continue-help 横幅与正文同宽，下载链接不带 /download", () => {
    const source = readFileSync("packages/web/src/share/ConversationShareLandingPage.tsx", "utf8");
    // Bug 根因一：横幅原本是 ShareContentRail 的直接子元素，没套 ShareContentInset，
    // 缺了 px-4 / @md:px-6，比上方时间行和下方正文都宽出一截。
    expect(source).toMatch(
      /showContinueHelp \? \(\s*(?:\/\/[^\n]*\n\s*)*<ShareContentInset>/u,
    );
    // Bug 根因二：站点首页本身就是下载入口，/download 这个 path 是 404。
    expect(source).toContain('const ZCODE_DOWNLOAD_URL = "https://zcode.z.ai"');
    expect(source).not.toContain("zcode.z.ai/download");
  });
});
