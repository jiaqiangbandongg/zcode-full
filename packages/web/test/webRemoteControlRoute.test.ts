import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlRoutePath } from "../src/webRemoteControlRoute.js";

describe("resolveWebRemoteControlRoutePath", () => {
  it("注入路由变量时页面入口固定为 /remote/v4，资源 base 可以带版本目录", () => {
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "/remote/v4",
        BASE_URL: "/remote/v4/3.13.0/",
      }),
    ).toBe("/remote/v4");
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "/remote/v4/",
        BASE_URL: "/remote/v4/latest/",
      }),
    ).toBe("/remote/v4");
  });

  it("未注入或空白时沿用 BASE_URL 推导，保持 Docker、v3 与开发入口不变", () => {
    expect(resolveWebRemoteControlRoutePath({ BASE_URL: "/remote/v4/" })).toBe("/remote/v4");
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "   ",
        BASE_URL: "/remote/v3/",
      }),
    ).toBe("/remote/v3");
    expect(resolveWebRemoteControlRoutePath({ BASE_URL: "/" })).toBe("/remote");
  });

  it("源码保留发布脚本识别版本化 base 能力所依赖的变量引用", async () => {
    // remote-frontend-build-source.mjs 通过该文件是否引用此变量决定旧 tag 是否回退 legacy base。
    const source = await readFile(
      resolve(import.meta.dirname, "../src/webRemoteControlRoute.ts"),
      "utf8",
    );
    expect(source).toContain("VITE_WEB_REMOTE_CONTROL_ROUTE_PATH");
    const main = await readFile(resolve(import.meta.dirname, "../src/main.tsx"), "utf8");
    expect(main).toContain("resolveWebRemoteControlRoutePath(import.meta.env)");
  });
});
