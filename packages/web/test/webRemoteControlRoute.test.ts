import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlRoutePath } from "#src/web-remote-control/index.js";

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
});
