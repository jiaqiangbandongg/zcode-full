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

  it("dev server base 不能写死 /cn/share/，否则英文路由本地不可达", () => {
    // Bug 根因：dev 脚本写死 --base=/cn/share/，Vite 只服务该前缀，访问 /share/<code>
    // 会被 dev server 直接拒掉（"server is configured with a public base URL of /cn/share/"）。
    const source = readFileSync("scripts/dev-web-share-env.mjs", "utf8");
    expect(source).toContain('"--base=/"');
    expect(source).not.toContain('"--base=/cn/share/"');
  });
});
